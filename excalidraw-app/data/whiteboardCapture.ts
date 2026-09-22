import type {
  AudioFileRef,
  CaptureBundleManifest,
  ParticipantRef,
  WhiteboardEvent,
} from "@excalidraw/common";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

const WHITEBOARD_EVENT_LOG_PATH = "events/whiteboard_events.jsonl";

const WHITEBOARD_MOVE_KEYS = new Set([
  "x",
  "y",
  "updated",
  "version",
  "versionNonce",
  "index",
]);

const normalizeChangedKeys = (
  previous: OrderedExcalidrawElement,
  current: OrderedExcalidrawElement,
) => {
  const changedKeys = new Set<string>();

  const valuesMatch = (
    previousValue: OrderedExcalidrawElement[keyof OrderedExcalidrawElement],
    currentValue: OrderedExcalidrawElement[keyof OrderedExcalidrawElement],
  ) => {
    if (Array.isArray(previousValue) && Array.isArray(currentValue)) {
      return (
        previousValue.length === currentValue.length &&
        previousValue.every((value, index) => value === currentValue[index])
      );
    }

    return previousValue === currentValue;
  };

  for (const key of Object.keys(current) as Array<
    keyof OrderedExcalidrawElement
  >) {
    if (!valuesMatch(previous[key], current[key])) {
      changedKeys.add(key);
    }
  }

  return changedKeys;
};

export const isClassroomModeEnabled = (url: string) => {
  const searchParams = new URL(url).searchParams;
  const value = searchParams.get("classroom");
  return value === "1" || value === "true";
};

export const getClassroomSessionMetadata = (url: string) => {
  const searchParams = new URL(url).searchParams;

  return {
    artifact_id: searchParams.get("artifact_id"),
    project_group: searchParams.get("project_group"),
    essay_name: searchParams.get("essay_name") ?? undefined,
    context: searchParams.get("context") ?? undefined,
  };
};

export const buildCaptureBundleManifest = ({
  sessionId,
  studentId,
  participants,
  startedAt,
  endedAt,
  audioFiles,
  artifactId,
  projectGroup,
  essayName,
  context,
  snapshot,
}: {
  sessionId: string;
  studentId: string | null;
  participants: ParticipantRef[];
  startedAt: string;
  endedAt: string;
  audioFiles: AudioFileRef[];
  artifactId?: string | null;
  projectGroup?: string | null;
  essayName?: string;
  context?: string;
  snapshot?: string;
}): CaptureBundleManifest => ({
  bundle_version: "1.0",
  session_id: sessionId,
  student_id: studentId,
  participants,
  started_at: startedAt,
  ended_at: endedAt,
  artifact_id: artifactId,
  project_group: projectGroup,
  essay_name: essayName,
  context,
  files: {
    audio: audioFiles,
    event_log: WHITEBOARD_EVENT_LOG_PATH,
    snapshot,
  },
});

const getWhiteboardEventAction = (
  previous: OrderedExcalidrawElement | undefined,
  current: OrderedExcalidrawElement,
): WhiteboardEvent["action"] => {
  if (!previous || previous.isDeleted) {
    return "add";
  }

  if (!previous.isDeleted && current.isDeleted) {
    return current.type === "freedraw" ? "erase" : "delete";
  }

  const changedKeys = normalizeChangedKeys(previous, current);
  if (
    changedKeys.size > 0 &&
    [...changedKeys].every((key) => WHITEBOARD_MOVE_KEYS.has(key))
  ) {
    return "move";
  }

  return "update";
};

export const deriveWhiteboardEvents = ({
  previousElements,
  nextElements,
  sessionId,
  userId,
  timestamp,
}: {
  previousElements: readonly OrderedExcalidrawElement[];
  nextElements: readonly OrderedExcalidrawElement[];
  sessionId: string;
  userId: string;
  timestamp: string;
}): WhiteboardEvent[] => {
  const previousElementsById = new Map(
    previousElements.map((element) => [element.id, element]),
  );

  return nextElements.reduce<WhiteboardEvent[]>((events, element) => {
    const previous = previousElementsById.get(element.id);

    if (
      previous?.version === element.version &&
      previous.isDeleted === element.isDeleted
    ) {
      return events;
    }

    const action = getWhiteboardEventAction(previous, element);

    events.push({
      event_id: `${sessionId}:${element.id}:${element.version}:${action}`,
      session_id: sessionId,
      user_id: userId,
      ts: timestamp,
      action,
      element_type: element.type,
      element_id: element.id,
      element_version: element.version,
    });

    return events;
  }, []);
};

export const serializeWhiteboardEvents = (events: readonly WhiteboardEvent[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");

export { WHITEBOARD_EVENT_LOG_PATH };
