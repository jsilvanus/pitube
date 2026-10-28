/**
 * YouTube Data API v3 client for live streaming operations.
 */

import { YouTubeAuth } from "./auth.js";
import type {
  LiveBroadcastListResponse,
  LiveBroadcastResource,
  LiveStreamListResponse,
  LiveStreamResource,
} from "./types.js";
import type { BroadcastPrivacy, BroadcastState, BroadcastSummary, StreamHealth } from "../types.js";

const DEFAULT_API_BASE = "https://youtube.googleapis.com/youtube/v3";

export interface YouTubeClientOptions {
  auth?: YouTubeAuth;
  apiBase?: string;
  fetchFn?: typeof fetch;
}

export class YouTubeClient {
  private readonly auth?: YouTubeAuth;
  private readonly apiBase: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: YouTubeClientOptions = {}) {
    this.auth = options.auth;
    this.apiBase = (options.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers || {});
    if (this.auth) {
      const token = await this.auth.getAccessToken();
      headers.set("Authorization", `Bearer ${token}`);
    }
    headers.set("Accept", "application/json");

    const url = `${this.apiBase}${path}`;
    const response = await this.fetchFn(url, { ...init, headers });

    if (response.status === 401 && this.auth) {
      this.auth.invalidate();
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`YouTube API request failed [${response.status}] ${path}: ${errorText.slice(0, 300)}`);
    }

    return (await response.json()) as T;
  }

  /**
   * List upcoming broadcasts on the channel.
   */
  async listUpcomingBroadcasts(maxResults: number = 10): Promise<BroadcastSummary[]> {
    const path = `/liveBroadcasts?part=snippet,status,contentDetails&broadcastStatus=upcoming&broadcastType=all&maxResults=${maxResults}`;
    const data = await this.request<LiveBroadcastListResponse>(path);
    return (data.items || []).map((item) => this.mapBroadcast(item));
  }

  /**
   * Get a specific broadcast by ID.
   */
  async getBroadcast(id: string): Promise<BroadcastSummary | null> {
    const path = `/liveBroadcasts?part=snippet,status,contentDetails&id=${encodeURIComponent(id)}`;
    const data = await this.request<LiveBroadcastListResponse>(path);
    const item = data.items?.[0];
    return item ? this.mapBroadcast(item) : null;
  }

  /**
   * Create an ad-hoc live broadcast with low latency and caption ingestion enabled.
   */
  async createBroadcast(params: {
    title: string;
    privacy?: BroadcastPrivacy;
    description?: string;
    scheduledStartTime?: string;
  }): Promise<BroadcastSummary> {
    const scheduledStartTime = params.scheduledStartTime || new Date().toISOString();
    const privacy = params.privacy || "public";

    const body = {
      snippet: {
        title: params.title,
        description: params.description || "Live broadcast",
        scheduledStartTime,
      },
      status: {
        privacyStatus: privacy,
        selfDeclaredMadeForKids: false,
      },
      contentDetails: {
        enableClosedCaptions: true,
        closedCaptionsType: "httpPost",
        latencyPreference: "lowLatency",
        enableEmbed: true,
        monitorStream: {
          enableMonitorStream: true,
        },
      },
    };

    const path = `/liveBroadcasts?part=snippet,status,contentDetails`;
    const item = await this.request<LiveBroadcastResource>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return this.mapBroadcast(item);
  }

  /**
   * Transition a broadcast to a target lifecycle state ('testing', 'live', 'complete').
   */
  async transitionBroadcast(
    broadcastId: string,
    targetState: "testing" | "live" | "complete"
  ): Promise<BroadcastSummary> {
    const path = `/liveBroadcasts/transition?broadcastStatus=${targetState}&id=${encodeURIComponent(broadcastId)}&part=snippet,status,contentDetails`;
    const item = await this.request<LiveBroadcastResource>(path, {
      method: "POST",
    });
    return this.mapBroadcast(item);
  }

  /**
   * Bind a live broadcast to a stream.
   */
  async bindBroadcast(broadcastId: string, streamId: string): Promise<BroadcastSummary> {
    const path = `/liveBroadcasts/bind?id=${encodeURIComponent(broadcastId)}&streamId=${encodeURIComponent(streamId)}&part=snippet,status,contentDetails`;
    const item = await this.request<LiveBroadcastResource>(path, {
      method: "POST",
    });
    return this.mapBroadcast(item);
  }

  /**
   * List live streams on the channel to find default or reusable streams.
   */
  async listStreams(maxResults: number = 5): Promise<LiveStreamResource[]> {
    const path = `/liveStreams?part=snippet,cdn,status&mine=true&maxResults=${maxResults}`;
    const data = await this.request<LiveStreamListResponse>(path);
    return data.items || [];
  }

  /**
   * Get a live stream's details (including CDN ingestion info and stream key).
   */
  async getStream(streamId: string): Promise<LiveStreamResource | null> {
    const path = `/liveStreams?part=snippet,cdn,status&id=${encodeURIComponent(streamId)}`;
    const data = await this.request<LiveStreamListResponse>(path);
    return data.items?.[0] || null;
  }

  /**
   * Get the ingestion health status of a live stream.
   */
  async getStreamHealth(streamId: string): Promise<StreamHealth> {
    const stream = await this.getStream(streamId);
    if (!stream?.status) return "unknown";

    if (stream.status.healthStatus?.status) {
      return stream.status.healthStatus.status;
    }

    if (stream.status.streamStatus === "active") return "good";
    if (stream.status.streamStatus === "ready") return "ok";
    if (stream.status.streamStatus === "inactive") return "noData";
    return "unknown";
  }

  private mapBroadcast(item: LiveBroadcastResource): BroadcastSummary {
    const lifeCycle = item.status.lifeCycleStatus;
    let status: BroadcastState = "ready";
    if (lifeCycle === "testing") status = "testing";
    else if (lifeCycle === "live") status = "live";
    else if (lifeCycle === "complete" || lifeCycle === "revoked") status = "complete";
    else status = "ready";

    return {
      id: item.id,
      title: item.snippet.title,
      description: item.snippet.description,
      scheduledStartTime: item.snippet.scheduledStartTime,
      actualStartTime: item.snippet.actualStartTime,
      privacy: item.status.privacyStatus,
      status,
      embedUrl: `https://www.youtube.com/embed/${item.id}`,
      streamId: item.contentDetails?.boundStreamId,
    };
  }
}
