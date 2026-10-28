/**
 * Lifecycle coordinator for YouTube broadcasts, stream key resolution, health monitoring, and caption gating.
 */

import { YouTubeClient } from "../youtube/client.js";
import { CaptionPipeline } from "../captions/pipeline.js";
import { LiveCaptionSender } from "../captions/sender.js";
import type {
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
  now?: () => number;
}

export class LifecycleCoordinator {
  private readonly client?: YouTubeClient;
  private readonly captionPipeline: CaptionPipeline;
  private readonly captionBaseUrl?: string;
  private readonly fallbackStreamKey?: string | null;
  private readonly now: () => number;

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
  async listUpcomingBroadcasts(): Promise<BroadcastSummary[]> {
    if (!this.client) {
      if (this.selectedBroadcast) return [this.selectedBroadcast];
      return [];
    }
    return await this.client.listUpcomingBroadcasts();
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

      if (!target && items.length > 0) {
        target = items[0] || null;
      }
      if (!target) {
        throw new Error("No upcoming broadcast found for auto-selection");
      }
    } else {
      target = await this.client.getBroadcast(idOrAuto);
      if (!target) {
        throw new Error(`Broadcast not found: ${idOrAuto}`);
      }
    }

    this.selectedBroadcast = target;
    this.state = target.status;

    // Resolve bound stream key
    await this.resolveStreamKey(target);

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
        privacy: input.privacy || "public",
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
      privacy: input.privacy || "public",
      description: input.description,
      scheduledStartTime: input.scheduledStartTime,
    });

    this.selectedBroadcast = created;
    this.state = created.status;

    // Bind a stream to the newly created broadcast
    await this.resolveStreamKey(created);

    return created;
  }

  /**
   * Start the live broadcast (transitions to 'testing' then 'live', enables caption sending).
   */
  async startBroadcast(): Promise<BroadcastSummary> {
    if (!this.selectedBroadcast) {
      throw new Error("Cannot start broadcast: No broadcast selected");
    }

    if (this.client) {
      try {
        // If ready, transition to testing first if required, or directly to live
        const updated = await this.client.transitionBroadcast(this.selectedBroadcast.id, "live");
        this.selectedBroadcast = updated;
      } catch (err: unknown) {
        // Some broadcast configurations go through testing first
        try {
          await this.client.transitionBroadcast(this.selectedBroadcast.id, "testing");
          const updated = await this.client.transitionBroadcast(this.selectedBroadcast.id, "live");
          this.selectedBroadcast = updated;
        } catch {
          throw err;
        }
      }
    }

    this.state = "live";
    if (this.selectedBroadcast) {
      this.selectedBroadcast.status = "live";
    }

    // Activate caption pipeline
    if (this.boundStreamKey) {
      this.setupCaptionSender(this.boundStreamKey);
    }

    this.startHealthPolling();
    return this.selectedBroadcast;
  }

  /**
   * Stop the live broadcast (transitions to 'complete', shuts down caption sender).
   */
  async stopBroadcast(): Promise<BroadcastSummary> {
    if (!this.selectedBroadcast) {
      this.state = "idle";
      this.captionPipeline.stop();
      return {
        id: "",
        title: "",
        privacy: "public",
        status: "complete",
        embedUrl: "",
      };
    }

    if (this.client) {
      try {
        const updated = await this.client.transitionBroadcast(this.selectedBroadcast.id, "complete");
        this.selectedBroadcast = updated;
      } catch {
        // Ignore completion errors if already complete
      }
    }

    this.state = "complete";
    if (this.selectedBroadcast) {
      this.selectedBroadcast.status = "complete";
    }

    this.captionPipeline.stop();
    this.stopHealthPolling();

    const result = this.selectedBroadcast;
    this.selectedBroadcast = null;
    this.boundStreamKey = null;
    this.state = "idle";
    return result;
  }

  private async resolveStreamKey(broadcast: BroadcastSummary): Promise<void> {
    if (!this.client) {
      this.boundStreamKey = this.fallbackStreamKey || "default_stream_key";
      return;
    }

    let streamId = broadcast.streamId;

    if (!streamId) {
      // Find existing stream on channel
      const streams = await this.client.listStreams(1);
      if (streams.length > 0 && streams[0]?.id) {
        streamId = streams[0].id;
        await this.client.bindBroadcast(broadcast.id, streamId);
        broadcast.streamId = streamId;
      }
    }

    if (streamId) {
      const stream = await this.client.getStream(streamId);
      const streamName = stream?.cdn?.ingestionInfo?.streamName;
      if (streamName) {
        this.boundStreamKey = streamName;
      }
    }

    if (!this.boundStreamKey && this.fallbackStreamKey) {
      this.boundStreamKey = this.fallbackStreamKey;
    }
  }

  private setupCaptionSender(streamKey: string): void {
    const sender = new LiveCaptionSender({
      streamKey,
      baseUrl: this.captionBaseUrl,
    });
    this.captionPipeline.setSender(sender);
  }

  private startHealthPolling(): void {
    this.stopHealthPolling();
    if (!this.client || !this.selectedBroadcast?.streamId) return;

    const streamId = this.selectedBroadcast.streamId;
    this.healthTimer = setInterval(async () => {
      try {
        if (this.client) {
          this.streamHealth = await this.client.getStreamHealth(streamId);
        }
      } catch {
        this.streamHealth = "unknown";
      }
    }, 15_000);
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
