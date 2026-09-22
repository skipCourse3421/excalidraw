import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  collection,
  getFirestore,
  doc,
  getDoc,
  runTransaction,
  Bytes,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { getStorage, ref, uploadBytes } from "firebase/storage";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import type {
  AudioFileRef,
  CaptureBundleManifest,
  ParticipantRef,
  WhiteboardEvent,
} from "@excalidraw/common";

import { FILE_CACHE_MAX_AGE_SEC } from "../app_constants";

import {
  buildCaptureBundleManifest,
  WHITEBOARD_EVENT_LOG_PATH,
} from "./whiteboardCapture";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// private
// -----------------------------------------------------------------------------

let FIREBASE_CONFIG: Record<string, any>;
try {
  FIREBASE_CONFIG = JSON.parse(import.meta.env.VITE_APP_FIREBASE_CONFIG);
} catch (error: any) {
  console.warn(
    `Error JSON parsing firebase config. Supplied value: ${
      import.meta.env.VITE_APP_FIREBASE_CONFIG
    }`,
  );
  FIREBASE_CONFIG = {};
}

let firebaseApp: ReturnType<typeof initializeApp> | null = null;
let firestore: ReturnType<typeof getFirestore> | null = null;
let firebaseStorage: ReturnType<typeof getStorage> | null = null;
let firebaseAuth: ReturnType<typeof getAuth> | null = null;

const _initializeFirebase = () => {
  if (!firebaseApp) {
    firebaseApp = initializeApp(FIREBASE_CONFIG);
  }
  return firebaseApp;
};

const _getFirestore = () => {
  if (!firestore) {
    firestore = getFirestore(_initializeFirebase());
  }
  return firestore;
};

const _getStorage = () => {
  if (!firebaseStorage) {
    firebaseStorage = getStorage(_initializeFirebase());
  }
  return firebaseStorage;
};

const _getAuth = () => {
  if (!firebaseAuth) {
    firebaseAuth = getAuth(_initializeFirebase());
  }
  return firebaseAuth;
};

// -----------------------------------------------------------------------------

export const loadFirebaseStorage = async () => {
  return _getStorage();
};

export const loadFirebaseAuth = async () => {
  return _getAuth();
};

export const getFirebaseIdToken = async () => {
  const user = _getAuth().currentUser;
  if (!user) {
    return null;
  }
  return user.getIdToken();
};

export const getFirebaseUser = () => _getAuth().currentUser;

type FirebaseStoredScene = {
  sceneVersion: number;
  iv: Bytes;
  ciphertext: Bytes;
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: FirebaseStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = data.ciphertext.toUint8Array() as Uint8Array<ArrayBuffer>;
  const iv = data.iv.toUint8Array() as Uint8Array<ArrayBuffer>;

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  const storage = await loadFirebaseStorage();

  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const storageRef = ref(storage, `${prefix}/${id}`);
        await uploadBytes(storageRef, buffer, {
          cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
        });
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

export const saveBlobToFirebase = async ({
  path,
  blob,
  contentType,
}: {
  path: string;
  blob: Blob;
  contentType?: string;
}) => {
  const storage = await loadFirebaseStorage();
  const storageRef = ref(storage, path);
  await uploadBytes(storageRef, blob, {
    contentType: contentType || blob.type,
    cacheControl: "private, max-age=0",
  });
};

const getWhiteboardSessionDocRef = (sessionId: string) =>
  doc(_getFirestore(), "whiteboard_sessions", sessionId);

const mergeParticipant = (
  participants: ParticipantRef[],
  participant: ParticipantRef,
) => {
  const nextParticipants = [...participants];
  const index = nextParticipants.findIndex(
    (existingParticipant) =>
      existingParticipant.user_id === participant.user_id,
  );

  if (index >= 0) {
    nextParticipants[index] = {
      ...nextParticipants[index],
      ...participant,
    };
  } else {
    nextParticipants.push(participant);
  }

  return nextParticipants;
};

const appendAudioFile = (
  audioFiles: AudioFileRef[],
  audioFile: AudioFileRef,
) => {
  if (
    audioFiles.some(
      (existingAudioFile) => existingAudioFile.path === audioFile.path,
    )
  ) {
    return audioFiles;
  }

  return [...audioFiles, audioFile];
};

const getManifestFromSnapshot = (
  sessionId: string,
  snapshotData:
    | {
        manifest?: CaptureBundleManifest;
      }
    | undefined,
  defaults: {
    startedAt: string;
    studentId: string | null;
    artifactId?: string | null;
    projectGroup?: string | null;
    essayName?: string;
    context?: string;
  },
) => {
  return (
    snapshotData?.manifest ??
    buildCaptureBundleManifest({
      sessionId,
      studentId: defaults.studentId,
      participants: [],
      startedAt: defaults.startedAt,
      endedAt: defaults.startedAt,
      audioFiles: [],
      artifactId: defaults.artifactId,
      projectGroup: defaults.projectGroup,
      essayName: defaults.essayName,
      context: defaults.context,
    })
  );
};

export const createOrJoinWhiteboardSession = async ({
  sessionId,
  participant,
  startedAt,
  studentId,
  artifactId,
  projectGroup,
  essayName,
  context,
}: {
  sessionId: string;
  participant: ParticipantRef;
  startedAt: string;
  studentId: string | null;
  artifactId?: string | null;
  projectGroup?: string | null;
  essayName?: string;
  context?: string;
}) => {
  const firestore = _getFirestore();
  const sessionDocRef = getWhiteboardSessionDocRef(sessionId);

  return runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(sessionDocRef);
    const manifest = getManifestFromSnapshot(
      sessionId,
      snapshot.data() as { manifest?: CaptureBundleManifest } | undefined,
      {
        startedAt,
        studentId,
        artifactId,
        projectGroup,
        essayName,
        context,
      },
    );

    const nextManifest: CaptureBundleManifest = {
      ...manifest,
      student_id: manifest.student_id ?? studentId,
      artifact_id: manifest.artifact_id ?? artifactId,
      project_group: manifest.project_group ?? projectGroup,
      essay_name: manifest.essay_name ?? essayName,
      context: manifest.context ?? context,
      participants: mergeParticipant(manifest.participants, participant),
      ended_at: manifest.ended_at || startedAt,
      files: {
        ...manifest.files,
        event_log: manifest.files.event_log || WHITEBOARD_EVENT_LOG_PATH,
      },
    };

    transaction.set(
      sessionDocRef,
      {
        manifest: nextManifest,
        updated_at: new Date().toISOString(),
      },
      { merge: true },
    );

    return nextManifest;
  });
};

export const markWhiteboardSessionParticipantLeft = async ({
  sessionId,
  userId,
  leftAt,
}: {
  sessionId: string;
  userId: string;
  leftAt: string;
}) => {
  const firestore = _getFirestore();
  const sessionDocRef = getWhiteboardSessionDocRef(sessionId);

  return runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(sessionDocRef);
    if (!snapshot.exists()) {
      return null;
    }

    const snapshotData = snapshot.data() as {
      manifest?: CaptureBundleManifest;
    };
    const manifest = snapshotData.manifest;
    if (!manifest) {
      return null;
    }

    const participants = manifest.participants.map((participant) =>
      participant.user_id === userId
        ? { ...participant, left_at: leftAt }
        : participant,
    );

    const nextManifest = {
      ...manifest,
      participants,
      ended_at: leftAt,
    };

    transaction.set(
      sessionDocRef,
      {
        manifest: nextManifest,
        updated_at: leftAt,
      },
      { merge: true },
    );

    return nextManifest;
  });
};

export const appendAudioFileToWhiteboardSession = async ({
  sessionId,
  audioFile,
}: {
  sessionId: string;
  audioFile: AudioFileRef;
}) => {
  const firestore = _getFirestore();
  const sessionDocRef = getWhiteboardSessionDocRef(sessionId);

  return runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(sessionDocRef);
    if (!snapshot.exists()) {
      return null;
    }

    const snapshotData = snapshot.data() as {
      manifest?: CaptureBundleManifest;
    };
    const manifest = snapshotData.manifest;
    if (!manifest) {
      return null;
    }

    const nextManifest = {
      ...manifest,
      files: {
        ...manifest.files,
        audio: appendAudioFile(manifest.files.audio, audioFile),
      },
    };

    transaction.set(
      sessionDocRef,
      {
        manifest: nextManifest,
        updated_at: new Date().toISOString(),
      },
      { merge: true },
    );

    return nextManifest;
  });
};

export const updateWhiteboardSessionManifest = async ({
  sessionId,
  updates,
}: {
  sessionId: string;
  updates: Partial<CaptureBundleManifest>;
}) => {
  const sessionDocRef = getWhiteboardSessionDocRef(sessionId);
  const snapshot = await getDoc(sessionDocRef);
  if (!snapshot.exists()) {
    return null;
  }

  const manifest = (snapshot.data() as { manifest?: CaptureBundleManifest })
    .manifest;
  if (!manifest) {
    return null;
  }

  const nextManifest: CaptureBundleManifest = {
    ...manifest,
    ...updates,
    files: {
      ...manifest.files,
      ...updates.files,
      audio: updates.files?.audio ?? manifest.files.audio,
    },
  };

  await setDoc(
    sessionDocRef,
    {
      manifest: nextManifest,
      updated_at: new Date().toISOString(),
    },
    { merge: true },
  );

  return nextManifest;
};

export const flushWhiteboardEventsToFirebase = async ({
  sessionId,
  events,
}: {
  sessionId: string;
  events: readonly WhiteboardEvent[];
}) => {
  if (!events.length) {
    return;
  }

  const firestore = _getFirestore();
  const batch = writeBatch(firestore);
  const eventsCollectionRef = collection(
    firestore,
    "whiteboard_sessions",
    sessionId,
    "events",
  );

  for (const event of events) {
    batch.set(doc(eventsCollectionRef, event.event_id), event, { merge: true });
  }

  await batch.commit();
};

const createFirebaseSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: Bytes.fromUint8Array(new Uint8Array(ciphertext)),
    iv: Bytes.fromUint8Array(iv),
  } as FirebaseStoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  const firestore = _getFirestore();
  const docRef = doc(firestore, "scenes", roomId);

  const storedScene = await runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(docRef);

    if (!snapshot.exists()) {
      const storedScene = await createFirebaseSceneDocument(elements, roomKey);

      transaction.set(docRef, storedScene);

      return storedScene;
    }

    const prevStoredScene = snapshot.data() as FirebaseStoredScene;
    const prevStoredElements = getSyncableElements(
      restoreElements(await decryptElements(prevStoredScene, roomKey), null),
    );
    const reconciledElements = getSyncableElements(
      reconcileElements(
        elements,
        prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
        appState,
      ),
    );

    const storedScene = await createFirebaseSceneDocument(
      reconciledElements,
      roomKey,
    );

    transaction.update(docRef, storedScene);

    // Return the stored elements as the in memory `reconciledElements` could have mutated in the meantime
    return storedScene;
  });

  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  FirebaseSceneVersionCache.set(socket, storedElements);

  return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const firestore = _getFirestore();
  const docRef = doc(firestore, "scenes", roomId);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    return null;
  }
  const storedScene = docSnap.data() as FirebaseStoredScene;
  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    FirebaseSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const url = `https://firebasestorage.googleapis.com/v0/b/${
          FIREBASE_CONFIG.storageBucket
        }/o/${encodeURIComponent(prefix.replace(/^\//, ""))}%2F${id}`;
        const response = await fetch(`${url}?alt=media`);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
