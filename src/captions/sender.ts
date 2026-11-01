/**
 * Live caption sender wrapping lcyt with strict secret redaction and statistics tracking.
 */

import { YoutubeLiveCaptionSender } from "lcyt";
import type { CaptionStats } from "../types.js";

export interface LiveCaptionSenderOptions {
  streamKey: string;
  baseUrl?: string;
  verbose?: boolean;
  /** Sequence number to continue from (restored after a restart). */
  sequence?: number;
  /** Called after every successful send with the next sequence number. */
  onSequence?: (nextSequence: number) => void;
}

export class LiveCaptionSender {
  private readonly streamKey: string;
  private readonly sender: InstanceType<typeof YoutubeLiveCaptionSender>;
  private readonly onSequence?: (nextSequence: number) => void;
  private isStarted = false;
  private stats: CaptionStats = {
    sent: 0,
    dropped: 0,
    lastSentAt: null,
    lastError: null,
  };

  constructor(options: LiveCaptionSenderOptions) {
    this.streamKey = options.streamKey;
    this.onSequence = options.onSequence;
    const senderOpts: { streamKey: string; baseUrl?: string; verbose?: boolean; sequence?: number } = {
      streamKey: options.streamKey,
      verbose: options.verbose ?? false,
    };
    if (options.sequence && options.sequence > 0) {
      senderOpts.sequence = options.sequence;
    }
    if (options.baseUrl) {
      senderOpts.baseUrl = options.baseUrl;
    }
    this.sender = new YoutubeLiveCaptionSender(senderOpts);
  }

  start(): void {
    if (!this.isStarted) {
      this.sender.start();
      this.isStarted = true;
    }
  }

  stop(): void {
    if (this.isStarted) {
      try {
        this.sender.end();
      } catch {
        // Ignore end errors
      }
      this.isStarted = false;
    }
  }

  get running(): boolean {
    return this.isStarted;
  }

  /**
   * Send a caption line with an absolute epoch timestamp in milliseconds.
   */
  async send(text: string, timestampMs: number): Promise<boolean> {
    if (!this.isStarted) {
      this.stats.dropped++;
      return false;
    }

    try {
      const formattedTs = new Date(timestampMs).toISOString();
      await this.sender.send(text, formattedTs);
      this.stats.sent++;
      this.stats.lastSentAt = Date.now();
      this.stats.lastError = null;
      this.onSequence?.(this.getSequence());
      return true;
    } catch (err: unknown) {
      this.stats.dropped++;
      const message = err instanceof Error ? err.message : String(err);
      this.stats.lastError = this.redact(message);
      return false;
    }
  }

  /** Next caption sequence number. */
  getSequence(): number {
    const seq = (this.sender as unknown as { getSequence?: () => number }).getSequence?.();
    return typeof seq === "number" ? seq : 0;
  }

  recordDropped(): void {
    this.stats.dropped++;
  }

  getStats(): CaptionStats {
    return { ...this.stats };
  }

  /**
   * Redact any occurrence of the stream key or full ingestion URL from text.
   */
  redact(text: string): string {
    if (!text) return "";
    let clean = text;
    if (this.streamKey && this.streamKey.length >= 4) {
      clean = clean.split(this.streamKey).join("[REDACTED_STREAM_KEY]");
    }
    // Also redact any query string containing stream identifiers or cid
    clean = clean.replace(/([?&](cid|id)=)[^&\s]+/gi, "$1[REDACTED]");
    return clean;
  }
}
