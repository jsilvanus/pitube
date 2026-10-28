/**
 * YouTube Data API v3 schemas and types.
 */

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export interface LiveBroadcastSnippet {
  title: string;
  description?: string;
  scheduledStartTime?: string;
  actualStartTime?: string;
}

export interface LiveBroadcastStatus {
  lifeCycleStatus: "created" | "ready" | "testing" | "live" | "complete" | "revoked";
  privacyStatus: "public" | "unlisted" | "private";
  recordingStatus?: string;
}

export interface LiveBroadcastContentDetails {
  boundStreamId?: string;
  enableClosedCaptions?: boolean;
  closedCaptionsType?: "closedCaptionsHttpPost" | "httpPost" | "closedCaptionsEmbedded";
  latencyPreference?: "ultraLowLatency" | "lowLatency" | "normal";
  enableEmbed?: boolean;
  monitorStream?: {
    enableMonitorStream?: boolean;
    embedHtml?: string;
  };
}

export interface LiveBroadcastResource {
  kind: "youtube#liveBroadcast";
  id: string;
  snippet: LiveBroadcastSnippet;
  status: LiveBroadcastStatus;
  contentDetails?: LiveBroadcastContentDetails;
}

export interface LiveBroadcastListResponse {
  kind: "youtube#liveBroadcastListResponse";
  items?: LiveBroadcastResource[];
  nextPageToken?: string;
}

export interface LiveStreamCdn {
  ingestionType?: string;
  ingestionInfo?: {
    streamName?: string;
    ingestionAddress?: string;
    backupIngestionAddress?: string;
  };
}

export interface LiveStreamStatus {
  streamStatus: "active" | "created" | "error" | "inactive" | "ready";
  healthStatus?: {
    status: "good" | "ok" | "bad" | "noData";
  };
}

export interface LiveStreamResource {
  kind: "youtube#liveStream";
  id: string;
  snippet?: {
    title: string;
  };
  cdn?: LiveStreamCdn;
  status?: LiveStreamStatus;
}

export interface LiveStreamListResponse {
  kind: "youtube#liveStreamListResponse";
  items?: LiveStreamResource[];
}
