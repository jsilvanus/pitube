/**
 * Lifecycle coordinator for YouTube broadcasts, stream key resolution, health monitoring, and caption gating.
 */

import { YouTubeClient } from "../youtube/client.js";
import { CaptionPipeline } from "../captions/pipeline.js";
import { LiveCaptionSender } from "../captions/sender.js";
import type { StateStore } from "../state.js";
import type { EncoderClient } from "../encoder/client.js";
import type { LiveStreamResource } from "../youtube/types.js";
import type {
  BroadcastPrivacy,
  StreamSummary,
  AdHocBroadcastInput,
  BroadcastState,
  BroadcastSummary,
  CaptionStats,
  PitubeStatus,
  StreamHealth,
} from "../types.js";

const SIXTY_MINUTES_MS = 60 * 60 * 1000;

export interface LifecycleCoordinatorOptions {
  client?: YouTubeClient;
  captionPipeline: CaptionPipeline;
  captionBaseUrl?: string;
  fallbackStreamKey?: string | null;
  /** liveStream id to use for every broadcast (PITUBE_STREAM_ID). */
  streamId?: string | null;
  stateStore?: StateStore;
  encoder?: EncoderClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for YouTube to report the testing state (default 90 s). */
  testingTimeoutMs?: number;
  pollMs?: number;
}

export type StartTarget = "testing" | "live";

export class LifecycleCoordinator {
  private readonly client?: YouTubeClient;
  private readonly captionPipeline: CaptionPipeline;
  private readonly captionBaseUrl?: string;
  private readonly fallbackStreamKey?: string | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly configuredStreamId: string | null;
  private readonly stateStore?: StateStore;
  private readonly encoder?: EncoderClient;
  private readonly testingTimeoutMs: number;
  private readonly pollMs: number;
  private ingestAddress: string | null = null;

  private state: BroadcastState = "idle";
  private selectedBroadcast: BroadcastSummary | null = null;
  private boundStreamKey: string | null = null;
  private streamHealth: StreamHealth = "unknown";
  private healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: LifecycleCoordinatorOptions) {
    this.client = options.client;
    this.captionPipeline = options.captionPipeline;
    this.captionBaseUrl = options.captionBaseUrl;
    this.fallbackStreamKey = options.fallbackStreamKey;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.configuredStreamId = options.streamId ?? null;
    this.stateStore = options.stateStore;
    this.encoder = options.encoder;
    this.testingTimeoutMs = options.testingTimeoutMs ?? 90_000;
    this.pollMs = options.pollMs ?? 2_000;
  }

  getState(): BroadcastState {
    return this.state;
  }

  getSelectedBroadcast(): BroadcastSummary | null {
    return this.selectedBroadcast;
  }

  getStreamHealth(): StreamHealth {
    return this.streamHealth;
  }

  getCaptionsStats(): CaptionStats {
    return this.captionPipeline.getStats();
  }

  /**
   * List upcoming broadcasts on the channel.
   */
  async listUpcomingBroadcasts(
    status: "upcoming" | "active" | "completed" | "all" = "upcoming"
  ): Promise<BroadcastSummary[]> {
    if (!this.client) {
      if (this.selectedBroadcast) return [this.selectedBroadcast];
      return [];
    }
    return await this.client.listBroadcasts(status);
  }

  /** List the channel's liveStreams (ingests). The key and ingestion address are never included. */
  async listStreams(): Promise<StreamSummary[]> {
    if (!this.client) return [];
    const streams = await this.client.listStreams();
    const selectedId = this.selectedBroadcast?.streamId ?? this.configuredStreamId;
    return streams.map((stream) => ({
      id: stream.id,
      title: stream.snippet?.title ?? "",
      ingestionType: stream.cdn?.ingestionType,
      resolution: stream.cdn?.resolution,
      streamStatus: stream.status?.streamStatus,
      health: this.healthOf(stream),
      selected: stream.id === selectedId,
    }));
  }

  async createStream(title: string): Promise<StreamSummary> {
    if (!this.client) throw new Error("YouTube is not configured");
    const stream = await this.client.createStream(title);
    return {
      id: stream.id,
      title: stream.snippet?.title ?? title,
      ingestionType: stream.cdn?.ingestionType,
      resolution: stream.cdn?.resolution,
      streamStatus: stream.status?.streamStatus,
      health: this.healthOf(stream),
      selected: false,
    };
  }

  private healthOf(stream: LiveStreamResource): StreamHealth {
    const health = stream.status?.healthStatus?.status;
    if (health) return health;
    if (stream.status?.streamStatus === "active") return "good";
    if (stream.status?.streamStatus === "inactive" || stream.status?.streamStatus === "ready") return "noData";
    return "unknown";
  }

  /**
   * Select a broadcast by ID or "auto" (finds nearest broadcast within 60 minutes).
   */
  async selectBroadcast(idOrAuto: string): Promise<BroadcastSummary> {
    if (!this.client) {
      // Mock / fallback mode with static stream key
      const mock: BroadcastSummary = {
        id: idOrAuto === "auto" ? "fallback_live" : idOrAuto,
        title: "Default Live Stream",
        privacy: "public",
        status: "ready",
        embedUrl: `https://www.youtube.com/embed/${idOrAuto}`,
      };
      this.selectedBroadcast = mock;
      this.state = "ready";
      this.setupCaptionSender(this.fallbackStreamKey || "default_stream_key");
      return mock;
    }

    let target: BroadcastSummary | null = null;

    if (idOrAuto === "auto") {
      const items = await this.client.listUpcomingBroadcasts();
      const currentTime = this.now();

      // Find closest broadcast within 60 minutes
      let closestDiff = Infinity;
      for (const item of items) {
        if (!item.scheduledStartTime) continue;
        const time = new Date(item.scheduledStartTime).getTime();
        const diff = Math.abs(time - currentTime);
        if (diff <= SIXTY_MINUTES_MS && diff < closestDiff) {
          closestDiff = diff;
          target = item;
        }
      }

      if (!target) {
        throw new Error("No upcoming broadcast within 60 minutes of now; select one by id");
      }
    } else {
      target = await this.client.getBroadcast(idOrAuto);
      if (!target) {
        throw new Error(`Broadcast not found: ${idOrAuto}`);
      }
    }

    this.adopt(target);
    await this.resolveStreamKey(target);
    this.afterAdopt(target);

    return target;
  }

  /**
   * Create an ad-hoc live broadcast and select it immediately.
   */
  async createAdHocBroadcast(input: AdHocBroadcastInput): Promise<BroadcastSummary> {
    if (!this.client) {
      const mock: BroadcastSummary = {
        id: `adhoc_${Date.now()}`,
        title: input.title,
        privacy: input.privacy || "unlisted",
        status: "ready",
        embedUrl: `https://www.youtube.com/embed/adhoc_${Date.now()}`,
      };
      this.selectedBroadcast = mock;
      this.state = "ready";
      this.setupCaptionSender(this.fallbackStreamKey || "default_stream_key");
      return mock;
    }

    const created = await this.client.createBroadcast({
      title: input.title,
      privacy: input.privacy || "unlisted",
      description: input.description,
      scheduledStartTime: input.scheduledStartTime,
    });

    if (input.autoSelect === false) {
      return created;
    }

    this.adopt(created);
    // Bind a stream to the newly created broadcast
    await this.resolveStreamKey(created);
    this.afterAdopt(created);

    return created;
  }

  /**
   * Take a broadcast as the selected one. A different broadcast than before resets the key and health.
   */
  private adopt(target: BroadcastSummary): void {
    if (this.selectedBroadcast?.id !== target.id) {
      this.boundStreamKey = null;
      this.ingestAddress = null;
      this.captionPipeline.stop();
      this.stopHealthPolling();
    }
    this.selectedBroadcast = target;
    this.state = target.status;
  }

  /** Health is polled from selection on, so the operator sees the encoder before going live. */
  private afterAdopt(target: BroadcastSummary): void {
    if (target.status === "live") {
      if (this.boundStreamKey) this.setupCaptionSender(this.boundStreamKey);
    }
    this.startHealthPolling();
  }

  /**
   * Move the selected broadcast towards live. With the monitor stream on (the default for broadcasts
   * pitube creates) YouTube requires ready -> testing -> live; pitube waits for testing to be reported.
   * `to: "testing"` stops there so the operator can check the preview first.
   * Refuses while the stream is not receiving data.
   */
  async startBroadcast(to: StartTarget = "live"): Promise<BroadcastSummary> {
    if (!this.selectedBroadcast) {
      throw new Error("Cannot start broadcast: No broadcast selected");
    }

    if (this.client) {
      const id = this.selectedBroadcast.id;
      let current = (await this.client.getBroadcast(id)) ?? this.selectedBroadcast;
      this.selectedBroadcast = { ...current, streamId: current.streamId ?? this.selectedBroadcast.streamId };

      if (current.status === "complete") {
        throw new Error("Broadcast is already complete");
      }

      if (current.status === "ready") {
        const streamId = this.selectedBroadcast.streamId;
        if (!streamId) throw new Error("No stream is bound to this broadcast");
        const stream = await this.client.getStream(streamId);
        if (stream?.status?.streamStatus !== "active") {
          throw new Error(
            `Stream is not receiving data (status: ${stream?.status?.streamStatus ?? "unknown"}). Start the encoder first.`
          );
        }
        if (current.monitorStream) {
          current = await this.client.transitionBroadcast(id, "testing");
          this.keepStream(current);
          current = await this.waitForLifecycle(id, "testing", current);
          this.keepStream(current);
        }
      }

      this.state = this.selectedBroadcast.status;
      if (to === "testing") {
        this.startHealthPolling();
        return this.selectedBroadcast;
      }

      if (current.status !== "live") {
        const updated = await this.client.transitionBroadcast(id, "live");
        this.keepStream(updated);
      }
    }

    this.state = "live";
    this.selectedBroadcast.status = "live";

    // Activate caption pipeline
    if (this.boundStreamKey) {
      this.setupCaptionSender(this.boundStreamKey);
    }

    this.startHealthPolling();
    return this.selectedBroadcast;
  }

  private keepStream(updated: BroadcastSummary): void {
    const streamId = updated.streamId ?? this.selectedBroadcast?.streamId;
    this.selectedBroadcast = { ...updated, ...(streamId ? { streamId } : {}) };
    this.state = updated.status;
  }

  private async waitForLifecycle(
    id: string,
    wanted: BroadcastState,
    initial: BroadcastSummary
  ): Promise<BroadcastSummary> {
    if (!this.client) return initial;
    let current = initial;
    const deadline = this.now() + this.testingTimeoutMs;
    while (current.status !== wanted) {
      if (this.now() >= deadline) {
        throw new Error(`Timed out waiting for the broadcast to reach ${wanted} (still ${current.status})`);
      }
      await this.sleep(this.pollMs);
      current = (await this.client.getBroadcast(id)) ?? current;
    }
    return current;
  }

  /**
   * Stop the live broadcast (transitions to 'complete', shuts down caption sender).
   * A failed transition is an error and keeps the selection, so the operator can retry.
   */
  async stopBroadcast(): Promise<BroadcastSummary> {
    if (!this.selectedBroadcast) {
      throw new Error("Cannot stop broadcast: No broadcast selected");
    }

    if (this.client) {
      try {
        const updated = await this.client.transitionBroadcast(this.selectedBroadcast.id, "complete");
        this.selectedBroadcast = updated;
      } catch (err: unknown) {
        // Already complete on YouTube is fine; anything else must be reported.
        const check = await this.client.getBroadcast(this.selectedBroadcast.id).catch(() => null);
        if (check?.status !== "complete") throw err;
        this.selectedBroadcast = check;
      }
    }

    this.selectedBroadcast.status = "complete";

    this.captionPipeline.stop();
    this.stopHealthPolling();
    this.stateStore?.clear();

    const result = this.selectedBroadcast;
    this.selectedBroadcast = null;
    this.boundStreamKey = null;
    this.ingestAddress = null;
    this.state = "idle";
    return result;
  }

  /**
   * Change privacy (public, unlisted, private) of a broadcast; defaults to the selected one.
   */
  async setPrivacy(privacy: BroadcastPrivacy, broadcastId?: string): Promise<BroadcastSummary> {
    const id = broadcastId || this.selectedBroadcast?.id;
    if (!id) throw new Error("No broadcast selected");
    if (!this.client) throw new Error("YouTube is not configured");
    const updated = await this.client.setPrivacy(id, privacy);
    if (this.selectedBroadcast?.id === id) {
      this.selectedBroadcast = { ...this.selectedBroadcast, privacy: updated.privacy };
    }
    return updated;
  }

  /** Watch and embed URLs plus privacy for a broadcast; defaults to the selected one. */
  async getUrls(broadcastId?: string): Promise<{
    id: string;
    title: string;
    privacy: BroadcastPrivacy;
    status: BroadcastState;
    watchUrl: string;
    embedUrl: string;
  }> {
    const id = broadcastId || this.selectedBroadcast?.id;
    if (!id) throw new Error("No broadcast selected");
    let item: BroadcastSummary | null = this.selectedBroadcast?.id === id ? this.selectedBroadcast : null;
    if (this.client) item = (await this.client.getBroadcast(id)) ?? item;
    if (!item) throw new Error(`Broadcast not found: ${id}`);
    return {
      id: item.id,
      title: item.title,
      privacy: item.privacy,
      status: item.status,
      watchUrl: item.watchUrl ?? `https://www.youtube.com/watch?v=${item.id}`,
      embedUrl: item.embedUrl,
    };
  }

  async setThumbnail(image: Uint8Array, contentType: string, broadcastId?: string): Promise<{ id: string }> {
    const id = broadcastId || this.selectedBroadcast?.id;
    if (!id) throw new Error("No broadcast selected");
    if (!this.client) throw new Error("YouTube is not configured");
    await this.client.setThumbnail(id, image, contentType);
    return { id };
  }

  /** Push the YouTube RTMP target of the selected broadcast to piencoder. Nothing secret is returned. */
  async applyIngestToEncoder(target?: { unit?: number; channel?: 1 | 2 }): Promise<{ unit: number; channel: number }> {
    if (!this.encoder) throw new Error("PITUBE_ENCODER_URL is not configured");
    if (!this.selectedBroadcast) throw new Error("No broadcast selected");
    if (!this.boundStreamKey || !this.ingestAddress) throw new Error("No stream key resolved for this broadcast");
    await this.encoder.setRtmp(this.ingestAddress, this.boundStreamKey, target);
    return { unit: target?.unit ?? this.encoder.unit, channel: target?.channel ?? this.encoder.channel };
  }

  /**
   * After a restart: adopt a broadcast that is still testing or live on YouTube, so the caption
   * sender, health polling and gateway status come back by themselves.
   */
  async recover(): Promise<BroadcastSummary | null> {
    if (!this.client) return null;
    const active = await this.client.listBroadcasts("active");
    const target = active.find((item) => item.status === "live") ?? active.find((item) => item.status === "testing");
    if (!target) return null;
    this.adopt(target);
    await this.resolveStreamKey(target);
    this.afterAdopt(target);
    return target;
  }

  private async resolveStreamKey(broadcast: BroadcastSummary): Promise<void> {
    if (!this.client) {
      this.boundStreamKey = this.fallbackStreamKey || "default_stream_key";
      return;
    }

    let streamId = this.configuredStreamId ?? broadcast.streamId;

    if (!streamId) {
      // Reuse the first stream on the channel, or create one.
      const streams = await this.client.listStreams(1);
      streamId = streams[0]?.id;
      if (!streamId) {
        streamId = (await this.client.createStream("pitube")).id;
      }
    }

    if (streamId && broadcast.streamId !== streamId) {
      await this.client.bindBroadcast(broadcast.id, streamId);
      broadcast.streamId = streamId;
    }

    if (streamId) {
      const stream = await this.client.getStream(streamId);
      const streamName = stream?.cdn?.ingestionInfo?.streamName;
      if (streamName) {
        this.boundStreamKey = streamName;
      }
      this.ingestAddress = stream?.cdn?.ingestionInfo?.ingestionAddress ?? null;
    }

    if (!this.boundStreamKey && this.fallbackStreamKey) {
      this.boundStreamKey = this.fallbackStreamKey;
    }
  }

  private setupCaptionSender(streamKey: string): void {
    if (this.captionPipeline.running) return;
    const broadcastId = this.selectedBroadcast?.id ?? null;
    const saved = this.stateStore?.load();
    // Continue the sequence after a crash, but only for the same broadcast.
    const sequence = saved && saved.broadcastId === broadcastId ? saved.sequence : 0;
    this.stateStore?.save({ broadcastId, sequence });
    const sender = new LiveCaptionSender({
      streamKey,
      baseUrl: this.captionBaseUrl,
      sequence,
      onSequence: (next) => this.stateStore?.save({ broadcastId, sequence: next }),
    });
    this.captionPipeline.setSender(sender);
  }

  private startHealthPolling(): void {
    this.stopHealthPolling();
    if (!this.client || !this.selectedBroadcast?.streamId) return;

    const streamId = this.selectedBroadcast.streamId;
    const poll = async () => {
      try {
        if (this.client) {
          this.streamHealth = await this.client.getStreamHealth(streamId);
        }
      } catch {
        this.streamHealth = "unknown";
      }
    };
    void poll();
    this.healthTimer = setInterval(poll, 15_000);
    this.healthTimer.unref?.();
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    this.streamHealth = "unknown";
  }

  getStatus(gatewayConnected = false, lastEventAt: number | null = null, epoch: string | null = null): PitubeStatus {
    return {
      service: "pitube",
      state: this.state,
      selectedBroadcast: this.selectedBroadcast,
      streamHealth: this.streamHealth,
      captions: this.captionPipeline.getStats(),
      gateway: {
        connected: gatewayConnected,
        lastEventAt,
        epoch,
      },
    };
  }

  stop(): void {
    this.stopHealthPolling();
    this.captionPipeline.stop();
  }
}
