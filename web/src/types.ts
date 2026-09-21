export interface StatusResponse {
  sealed_count: number;
  unlocked_count: number;
  has_unlocked: boolean;
  seal_window: string;
}

export interface CaptureResponse {
  id: string;
  dedup: boolean;
}

export type TranscriptStatus = 'pending' | 'done' | 'failed';

export interface TranscriptResponse {
  status: TranscriptStatus;
  text: string;
}

export type Mode = 'idle' | 'recording';
