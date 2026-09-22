export interface CaptureBundleManifest {
  bundle_version: "1.0";
  session_id: string;
  student_id: string | null;
  participants: ParticipantRef[];
  started_at: string;
  ended_at: string;
  artifact_id?: string | null;
  project_group?: string | null;
  essay_name?: string;
  context?: string;
  files: {
    audio: AudioFileRef[];
    event_log: string;
    snapshot?: string;
  };
}

export interface ParticipantRef {
  user_id: string;
  display_name: string;
  role: "teacher" | "student";
  joined_at: string;
  left_at?: string | null;
}

export interface AudioFileRef {
  path: string;
  started_at: string;
  ended_at: string;
  mime_type: string;
  speaker_hint_user_id?: string | null;
}

export interface WhiteboardEvent {
  event_id: string;
  session_id: string;
  user_id: string;
  ts: string;
  action: "add" | "update" | "delete" | "erase" | "move";
  element_type: string;
  element_id: string;
  element_version: number;
}
