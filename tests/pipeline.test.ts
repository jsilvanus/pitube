import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CaptionPipeline } from "../src/captions/pipeline.js";
import { LiveCaptionSender } from "../src/captions/sender.js";
import type { GatewayTranscriptEvent } from "../src/types.js";

class MockSender extends LiveCaptionSender {
  public sentItems: Array<{ text: string; timestampMs: number }> = [];

  constructor() {
    super({ streamKey: "mock-key" });
  }

  override start() {
    (this as any).isStarted = true;
  }

  override get running() {
    return true;
  }

  override async send(text: string, timestampMs: number): Promise<boolean> {
    this.sentItems.push({ text, timestampMs });
    return true;
  }
}

describe("CaptionPipeline", () => {
  const fixedNow = 1_700_000_000_000;

  it("applies 30s delay to audio timestamp", async () => {
    const pipeline = new CaptionPipeline({
      youtubeDelayMs: 30000,
      staleCaptionMs: 90000,
      now: () => fixedNow,
    });

    const mockSender = new MockSender();
    pipeline.setSender(mockSender);

    const event: GatewayTranscriptEvent = {
      epoch: "epoch1",
      seq: 1,
      session: "session1",
      language: "fi",
      text: "Herra olkoon teidän kanssanne",
      startedAt: fixedNow - 10000, // 10s ago
      endedAt: fixedNow - 8000,
      source: "auditor",
    };

    const handled = await pipeline.handleTranscript(event);
    assert.equal(handled, true);
    assert.equal(mockSender.sentItems.length, 1);
    // Synced timestamp should be startedAt + 30000
    assert.equal(mockSender.sentItems[0]?.timestampMs, event.startedAt + 30000);
  });

  it("drops transcripts when no active sender is attached", async () => {
    const pipeline = new CaptionPipeline({ now: () => fixedNow });
    const event: GatewayTranscriptEvent = {
      epoch: "epoch1",
      seq: 1,
      session: "session1",
      language: "fi",
      text: "Dropped because offline",
      startedAt: fixedNow - 5000,
      endedAt: fixedNow - 3000,
      source: "auditor",
    };

    const handled = await pipeline.handleTranscript(event);
    assert.equal(handled, false);
    assert.equal(pipeline.getStats().dropped, 1);
  });

  it("drops stale transcripts exceeding staleCaptionMs", async () => {
    const pipeline = new CaptionPipeline({
      youtubeDelayMs: 30000,
      staleCaptionMs: 90000,
      now: () => fixedNow,
    });

    const mockSender = new MockSender();
    pipeline.setSender(mockSender);

    const staleEvent: GatewayTranscriptEvent = {
      epoch: "epoch1",
      seq: 1,
      session: "session1",
      language: "fi",
      text: "Very old text",
      startedAt: fixedNow - 120_000,
      endedAt: fixedNow - 95_000, // 95s ago > 90s threshold
      source: "auditor",
    };

    const handled = await pipeline.handleTranscript(staleEvent);
    assert.equal(handled, false);
    assert.equal(mockSender.sentItems.length, 0);
  });

  it("drops transcripts with invalid clock drift (>5m future)", async () => {
    const pipeline = new CaptionPipeline({ now: () => fixedNow });
    const mockSender = new MockSender();
    pipeline.setSender(mockSender);

    const futureEvent: GatewayTranscriptEvent = {
      epoch: "epoch1",
      seq: 1,
      session: "session1",
      language: "fi",
      text: "From the future",
      startedAt: fixedNow + 400_000, // 6.6 min in future
      endedAt: fixedNow + 402_000,
      source: "auditor",
    };

    const handled = await pipeline.handleTranscript(futureEvent);
    assert.equal(handled, false);
  });

  it("enforces sequence ordering within an epoch", async () => {
    const pipeline = new CaptionPipeline({ now: () => fixedNow });
    const mockSender = new MockSender();
    pipeline.setSender(mockSender);

    const ev1: GatewayTranscriptEvent = {
      epoch: "epoch1",
      seq: 10,
      session: "s1",
      language: "fi",
      text: "Tervehdys",
      startedAt: fixedNow - 5000,
      endedAt: fixedNow - 3000,
      source: "auditor",
    };

    const ev2Outdated: GatewayTranscriptEvent = {
      epoch: "epoch1",
      seq: 8, // Outdated sequence number
      session: "s1",
      language: "fi",
      text: "Vanha",
      startedAt: fixedNow - 4000,
      endedAt: fixedNow - 2000,
      source: "auditor",
    };

    assert.equal(await pipeline.handleTranscript(ev1), true);
    assert.equal(await pipeline.handleTranscript(ev2Outdated), false);
    assert.equal(mockSender.sentItems.length, 1);
  });
});
