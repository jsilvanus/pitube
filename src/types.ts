/**
 * Core domain types for pitube.
 */

export type BroadcastPrivacy = "public" | "unlisted" | "private";

export type BroadcastState = "ready" | "testing" | "live" | "complete" | "idle";

export type StreamHealth = "good" | "ok" | "bad" | "noData" | "unknown";

export interface BroadcastSummary {
  id: string;
  title: string;
  description?: string;
  scheduledStartTime?: string;
  actualStartTime?: string;
  privacy: BroadcastPrivacy;
  status: BroadcastState;
  embedUrl: string;
  streamId?: string;
}

export interface AdHocBroadcastInput {
  title: string;
  privacy?: BroadcastPrivacy;
  description?: string;
  scheduledStartTime?: string;
}

/** Transcript payload received from pigateway SSE */
export interface GatewayTranscriptEvent {
  epoch: string;
  seq: number;
  session: string;
  language: string;
  text: string;
  startedAt: number;
  endedAt: number;
  source: string;
}

/** Status record sent to pigateway PUT /api/v1/youtube/status */
export interface GatewayYoutubeStatusPayload {
  state: "live" | "offline" | "unknown";
  detail?: string;
  broadcastId?: string | null;
  title?: string | null;
  lifecycleState?: BroadcastState;
  checkedAt: number;
  ttlMs: number;
}

export interface CaptionStats {
  sent: number;
  dropped: number;
  lastSentAt: number | null;
  lastError: string | null;
}

export interface PitubeStatus {
  service: "pitube";
  state: BroadcastState;
  selectedBroadcast: BroadcastSummary | null;
  streamHealth: StreamHealth;
  captions: CaptionStats;
  gateway: {
    connected: boolean;
    lastEventAt: number | null;
    epoch: string | null;
  };
}
