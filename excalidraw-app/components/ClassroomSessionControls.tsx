import React, { useEffect, useMemo, useState } from "react";

import type { CollabAPI, ClassroomCaptureState } from "../collab/Collab";

const formatElapsed = (startedAt: string | null, now: number) => {
  if (!startedAt) {
    return "00:00";
  }

  const elapsedMs = Math.max(0, now - new Date(startedAt).getTime());
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours
    ? [hours, minutes, seconds]
        .map((value) => `${value}`.padStart(2, "0"))
        .join(":")
    : [minutes, seconds].map((value) => `${value}`.padStart(2, "0")).join(":");
};

export const ClassroomSessionControls = React.memo(
  ({
    collabAPI,
    captureState,
    isCollaborating,
    compact = false,
  }: {
    collabAPI: CollabAPI;
    captureState: ClassroomCaptureState;
    isCollaborating: boolean;
    compact?: boolean;
  }) => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
      if (!captureState.startedAt) {
        return;
      }

      const intervalId = window.setInterval(() => {
        setNow(Date.now());
      }, 1000);

      return () => {
        window.clearInterval(intervalId);
      };
    }, [captureState.startedAt]);

    const timerLabel = useMemo(
      () => formatElapsed(captureState.startedAt, now),
      [captureState.startedAt, now],
    );

    const buttonStyle: React.CSSProperties = {
      border: "1px solid var(--color-border-primary)",
      borderRadius: 8,
      padding: compact ? "0.25rem 0.5rem" : "0.4rem 0.75rem",
      background: "var(--color-surface-lowest)",
      cursor: "pointer",
      fontSize: compact ? 12 : 13,
    };

    if (!isCollaborating) {
      return (
        <button
          type="button"
          style={buttonStyle}
          onClick={() => void collabAPI.startClassroomSession()}
        >
          Start classroom session
        </button>
      );
    }

    return (
      <div
        style={{
          display: "flex",
          flexDirection: compact ? "column" : "row",
          alignItems: compact ? "stretch" : "center",
          gap: compact ? "0.35rem" : "0.5rem",
          minWidth: compact ? 0 : 260,
        }}
      >
        <strong style={{ minWidth: compact ? 0 : 56 }}>{timerLabel}</strong>
        {captureState.role === "teacher" &&
          !captureState.isRecording &&
          !captureState.isPaused && (
            <button
              type="button"
              style={buttonStyle}
              onClick={() => void collabAPI.startClassroomRecording()}
            >
              Start recording
            </button>
          )}
        {captureState.role === "teacher" && captureState.isRecording && (
          <button
            type="button"
            style={buttonStyle}
            onClick={() => collabAPI.pauseClassroomRecording()}
          >
            Pause recording
          </button>
        )}
        {captureState.role === "teacher" && captureState.isPaused && (
          <button
            type="button"
            style={buttonStyle}
            onClick={() => collabAPI.resumeClassroomRecording()}
          >
            Resume recording
          </button>
        )}
        {captureState.role === "teacher" &&
          (captureState.isRecording || captureState.isPaused) && (
            <button
              type="button"
              style={buttonStyle}
              onClick={() => void collabAPI.stopClassroomRecording()}
            >
              Stop recording
            </button>
          )}
        {captureState.role === "teacher" && (
          <button
            type="button"
            style={buttonStyle}
            disabled={captureState.exportInProgress}
            onClick={() => void collabAPI.exportClassroomSession()}
          >
            {captureState.exportInProgress ? "Exporting..." : "Save & export"}
          </button>
        )}
      </div>
    );
  },
);
