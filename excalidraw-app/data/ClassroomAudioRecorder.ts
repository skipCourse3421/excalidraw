import type { AudioFileRef } from "@excalidraw/common";

const AUDIO_CHUNK_MS = 30_000;

type RecordingWindow = Window &
  typeof globalThis & {
    MediaRecorder: typeof MediaRecorder;
  };

const getAudioExtension = (mimeType: string) => {
  if (mimeType.includes("ogg")) {
    return "ogg";
  }
  if (mimeType.includes("mp4") || mimeType.includes("mpeg")) {
    return "mp4";
  }
  return "webm";
};

const getSupportedMimeType = (ownerWindow: Window) => {
  const recordingWindow = ownerWindow as RecordingWindow;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];

  return candidates.find((mimeType) =>
    recordingWindow.MediaRecorder?.isTypeSupported?.(mimeType),
  );
};

export class ClassroomAudioRecorder {
  private readonly ownerWindow: RecordingWindow;
  private readonly onSegment: (file: AudioFileRef, blob: Blob) => Promise<void>;
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private currentSegmentStartedAt: string | null = null;
  private segmentIndex = 0;
  private pendingUploads = new Set<Promise<void>>();
  private speakerHintUserId: string | null = null;

  constructor(opts: {
    ownerWindow: Window;
    onSegment: (file: AudioFileRef, blob: Blob) => Promise<void>;
  }) {
    this.ownerWindow = opts.ownerWindow as RecordingWindow;
    this.onSegment = opts.onSegment;
  }

  get status() {
    return this.mediaRecorder?.state ?? "inactive";
  }

  setSpeakerHintUserId = (speakerHintUserId: string | null) => {
    this.speakerHintUserId = speakerHintUserId;
  };

  start = async () => {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      return;
    }

    const stream = await this.ownerWindow.navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    const mimeType = getSupportedMimeType(this.ownerWindow);
    const mediaRecorder = mimeType
      ? new this.ownerWindow.MediaRecorder(stream, { mimeType })
      : new this.ownerWindow.MediaRecorder(stream);

    this.stream = stream;
    this.mediaRecorder = mediaRecorder;
    this.currentSegmentStartedAt = new Date().toISOString();

    mediaRecorder.addEventListener("dataavailable", (event: BlobEvent) => {
      if (!event.data.size || !this.currentSegmentStartedAt) {
        return;
      }

      const startedAt = this.currentSegmentStartedAt;
      const endedAt = new Date().toISOString();
      const path = `audio/segment-${this.segmentIndex++}.${getAudioExtension(
        event.data.type || mediaRecorder.mimeType || "audio/webm",
      )}`;
      const file: AudioFileRef = {
        path,
        started_at: startedAt,
        ended_at: endedAt,
        mime_type: event.data.type || mediaRecorder.mimeType || "audio/webm",
        speaker_hint_user_id: this.speakerHintUserId,
      };

      this.currentSegmentStartedAt = endedAt;

      const uploadPromise = this.onSegment(file, event.data).finally(() => {
        this.pendingUploads.delete(uploadPromise);
      });
      this.pendingUploads.add(uploadPromise);
    });

    mediaRecorder.start(AUDIO_CHUNK_MS);
  };

  pause = () => {
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.requestData();
      this.mediaRecorder.pause();
    }
  };

  resume = () => {
    if (this.mediaRecorder?.state === "paused") {
      this.currentSegmentStartedAt = new Date().toISOString();
      this.mediaRecorder.resume();
    }
  };

  stop = async () => {
    if (!this.mediaRecorder) {
      return;
    }

    const mediaRecorder = this.mediaRecorder;
    const stopPromise = new Promise<void>((resolve) => {
      mediaRecorder.addEventListener(
        "stop",
        () => {
          resolve();
        },
        { once: true },
      );
    });

    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }

    await stopPromise;
    await Promise.allSettled(this.pendingUploads);

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.mediaRecorder = null;
    this.currentSegmentStartedAt = null;
  };
}
