/**
 * Caption processing pipeline: validation, time-sync delay, staleness filtering, and sequencing.
 */

import { LiveCaptionSender } from "./sender.js";
import type { CaptionStats, GatewayTranscriptEvent } from "../types.js";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export interface CaptionPipelineOptions {
  youtubeDelayMs?: number;
  staleCaptionMs?: number;
  now?: () => number;
}

export class CaptionPipeline {
  private sender: LiveCaptionSender | null = null;
  private readonly youtubeDelayMs: number;
  private readonly staleCaptionMs: number;
  private readonly now: () => number;

  private currentEpoch: string | null = null;
  private lastSeq: number = -1;
  private droppedCount: number = 0;
  private recentFingerprints: Set<string> = new Set();

  constructor(options: CaptionPipelineOptions = {}) {
    this.youtubeDelayMs = options.youtubeDelayMs ?? 30000;
    this.staleCaptionMs = options.staleCaptionMs ?? 90000;
    this.now = options.now ?? Date.now;
  }

  setSender(sender: LiveCaptionSender | null): void {
    if (this.sender && this.sender !== sender) {
      this.sender.stop();
    }
    this.sender = sender;
    if (this.sender && !this.sender.running) {
      this.sender.start();
    }
  }

  get running(): boolean {
    return Boolean(this.sender?.running);
  }

  /**
   * Process an incoming transcript event from pigateway.
   * Returns true if queued or dispatched, false if dropped.
   */
  async handleTranscript(transcript: GatewayTranscriptEvent): Promise<boolean> {
    const currentTime = this.now();

    // 1. Gate: Discard if not currently live / sending
    if (!this.sender || !this.sender.running) {
      this.droppedCount++;
      return false;
    }

    // 2. Epoch & sequence handling
    if (transcript.epoch !== this.currentEpoch) {
      this.currentEpoch = transcript.epoch;
      this.lastSeq = -1;
      this.recentFingerprints.clear();
    }

    // If sequence went backwards within same epoch, drop
    if (transcript.seq <= this.lastSeq) {
      this.recordDrop();
      return false;
    }

    // 3. Clock sanity check: reject if > 5m in future or > 24h in past
    if (
      transcript.startedAt > currentTime + FIVE_MINUTES_MS ||
      transcript.startedAt < currentTime - TWENTY_FOUR_HOURS_MS
    ) {
      this.recordDrop();
      return false;
    }

    // 4. Stale check: reject if endedAt is older than staleCaptionMs
    if (currentTime - transcript.endedAt > this.staleCaptionMs) {
      this.recordDrop();
      return false;
    }

    // 5. De-duplication fingerprint
    const fingerprint = `${transcript.session}:${transcript.startedAt}:${transcript.text}`;
    if (this.recentFingerprints.has(fingerprint)) {
      this.recordDrop();
      return false;
    }
    this.recentFingerprints.add(fingerprint);
    if (this.recentFingerprints.size > 200) {
      const first = this.recentFingerprints.values().next().value;
      if (first) this.recentFingerprints.delete(first);
    }

    // 6. Calculate synced timestamp matching video latency
    const targetVideoTime = transcript.startedAt + this.youtubeDelayMs;

    this.lastSeq = transcript.seq;
    return await this.sender.send(transcript.text, targetVideoTime);
  }

  private recordDrop(): void {
    this.droppedCount++;
    this.sender?.recordDropped();
  }

  getStats(): CaptionStats {
    if (this.sender) {
      return this.sender.getStats();
    }
    return {
      sent: 0,
      dropped: this.droppedCount,
      lastSentAt: null,
      lastError: null,
    };
  }

  stop(): void {
    if (this.sender) {
      this.sender.stop();
      this.sender = null;
    }
  }
}
