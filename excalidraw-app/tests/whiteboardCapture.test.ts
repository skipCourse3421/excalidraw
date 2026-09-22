import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import {
  buildCaptureBundleManifest,
  deriveWhiteboardEvents,
  serializeWhiteboardEvents,
} from "../data/whiteboardCapture";

const createElement = (
  overrides: Partial<OrderedExcalidrawElement>,
): OrderedExcalidrawElement =>
  ({
    id: "element-1",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: "#000000",
    backgroundColor: "transparent",
    fillStyle: "hachure",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    index: "a0",
    ...overrides,
  } as OrderedExcalidrawElement);

describe("whiteboardCapture", () => {
  it("builds the capture bundle manifest with the shared event log path", () => {
    expect(
      buildCaptureBundleManifest({
        sessionId: "session-1",
        studentId: "student-1",
        participants: [
          {
            user_id: "student-1",
            display_name: "Student One",
            role: "student",
            joined_at: "2026-09-22T17:00:00.000Z",
          },
        ],
        startedAt: "2026-09-22T17:00:00.000Z",
        endedAt: "2026-09-22T17:10:00.000Z",
        audioFiles: [
          {
            path: "audio/segment-0.webm",
            started_at: "2026-09-22T17:00:00.000Z",
            ended_at: "2026-09-22T17:01:00.000Z",
            mime_type: "audio/webm",
          },
        ],
        artifactId: "artifact-1",
        projectGroup: "group-a",
        essayName: "Essay",
        context: "Context",
      }),
    ).toEqual({
      bundle_version: "1.0",
      session_id: "session-1",
      student_id: "student-1",
      participants: [
        {
          user_id: "student-1",
          display_name: "Student One",
          role: "student",
          joined_at: "2026-09-22T17:00:00.000Z",
        },
      ],
      started_at: "2026-09-22T17:00:00.000Z",
      ended_at: "2026-09-22T17:10:00.000Z",
      artifact_id: "artifact-1",
      project_group: "group-a",
      essay_name: "Essay",
      context: "Context",
      files: {
        audio: [
          {
            path: "audio/segment-0.webm",
            started_at: "2026-09-22T17:00:00.000Z",
            ended_at: "2026-09-22T17:01:00.000Z",
            mime_type: "audio/webm",
          },
        ],
        event_log: "events/whiteboard_events.jsonl",
      },
    });
  });

  it("derives attributed add, move, update and delete events from element versions", () => {
    const previousElements = [
      createElement({ id: "moved", version: 1, x: 0, y: 0 }),
      createElement({ id: "updated", version: 1, width: 100 }),
      createElement({ id: "deleted", version: 1 }),
      createElement({ id: "erased", version: 1, type: "freedraw" }),
    ];
    const nextElements = [
      createElement({ id: "added", version: 1 }),
      createElement({ id: "moved", version: 2, x: 40, y: 25 }),
      createElement({ id: "updated", version: 2, width: 120 }),
      createElement({ id: "deleted", version: 2, isDeleted: true }),
      createElement({
        id: "erased",
        version: 2,
        type: "freedraw",
        isDeleted: true,
      }),
    ];

    expect(
      deriveWhiteboardEvents({
        previousElements,
        nextElements,
        sessionId: "session-1",
        userId: "user-1",
        timestamp: "2026-09-22T17:00:00.000Z",
      }),
    ).toEqual([
      {
        event_id: "session-1:user-1:2026-09-22T17:00:00.000Z:0:added:1:add",
        session_id: "session-1",
        user_id: "user-1",
        ts: "2026-09-22T17:00:00.000Z",
        action: "add",
        element_type: "rectangle",
        element_id: "added",
        element_version: 1,
      },
      {
        event_id: "session-1:user-1:2026-09-22T17:00:00.000Z:1:moved:2:move",
        session_id: "session-1",
        user_id: "user-1",
        ts: "2026-09-22T17:00:00.000Z",
        action: "move",
        element_type: "rectangle",
        element_id: "moved",
        element_version: 2,
      },
      {
        event_id:
          "session-1:user-1:2026-09-22T17:00:00.000Z:2:updated:2:update",
        session_id: "session-1",
        user_id: "user-1",
        ts: "2026-09-22T17:00:00.000Z",
        action: "update",
        element_type: "rectangle",
        element_id: "updated",
        element_version: 2,
      },
      {
        event_id:
          "session-1:user-1:2026-09-22T17:00:00.000Z:3:deleted:2:delete",
        session_id: "session-1",
        user_id: "user-1",
        ts: "2026-09-22T17:00:00.000Z",
        action: "delete",
        element_type: "rectangle",
        element_id: "deleted",
        element_version: 2,
      },
      {
        event_id: "session-1:user-1:2026-09-22T17:00:00.000Z:4:erased:2:erase",
        session_id: "session-1",
        user_id: "user-1",
        ts: "2026-09-22T17:00:00.000Z",
        action: "erase",
        element_type: "freedraw",
        element_id: "erased",
        element_version: 2,
      },
    ]);
  });

  it("treats mixed move and resize changes as updates", () => {
    expect(
      deriveWhiteboardEvents({
        previousElements: [
          createElement({ id: "mixed", version: 1, width: 100 }),
        ],
        nextElements: [
          createElement({ id: "mixed", version: 2, x: 30, width: 120 }),
        ],
        sessionId: "session-1",
        userId: "user-1",
        timestamp: "2026-09-22T17:00:00.000Z",
      }),
    ).toEqual([
      expect.objectContaining({
        event_id: "session-1:user-1:2026-09-22T17:00:00.000Z:0:mixed:2:update",
        action: "update",
        element_id: "mixed",
        element_version: 2,
      }),
    ]);
  });

  it("serializes event batches as jsonl", () => {
    expect(
      serializeWhiteboardEvents([
        {
          event_id: "event-1",
          session_id: "session-1",
          user_id: "user-1",
          ts: "2026-09-22T17:00:00.000Z",
          action: "add",
          element_type: "rectangle",
          element_id: "rect-1",
          element_version: 1,
        },
        {
          event_id: "event-2",
          session_id: "session-1",
          user_id: "user-1",
          ts: "2026-09-22T17:00:01.000Z",
          action: "move",
          element_type: "rectangle",
          element_id: "rect-1",
          element_version: 2,
        },
      ]),
    ).toBe(
      [
        '{"event_id":"event-1","session_id":"session-1","user_id":"user-1","ts":"2026-09-22T17:00:00.000Z","action":"add","element_type":"rectangle","element_id":"rect-1","element_version":1}',
        '{"event_id":"event-2","session_id":"session-1","user_id":"user-1","ts":"2026-09-22T17:00:01.000Z","action":"move","element_type":"rectangle","element_id":"rect-1","element_version":2}',
      ].join("\n"),
    );
  });
});
