import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LifecycleCoordinator } from "../src/lifecycle/coordinator.js";
import { CaptionPipeline } from "../src/captions/pipeline.js";
import { YouTubeClient } from "../src/youtube/client.js";
import { StateStore } from "../src/state.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Stateful fake of the YouTube endpoints pitube uses. */
function fakeYouTube(opts: { streamStatus?: string; monitor?: boolean; testingAfterPolls?: number } = {}) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const bc = {
    id: "bc_1",
    snippet: { title: "Messu", scheduledStartTime: "2026-11-01T08:00:00Z" },
    status: { lifeCycleStatus: "ready", privacyStatus: "unlisted" },
    contentDetails: { boundStreamId: "st_1", monitorStream: { enableMonitorStream: opts.monitor ?? true } },
  };
  const stream = {
    id: "st_1",
    snippet: { title: "Kirkko" },
    cdn: { ingestionType: "rtmp", ingestionInfo: { streamName: "SECRETKEY-1234", ingestionAddress: "rtmp://a.rtmp.youtube.com/live2" } },
    status: { streamStatus: opts.streamStatus ?? "active", healthStatus: { status: "good" } },
  };
  let pendingTesting = -1;
  const fetchFn: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}${u.searchParams.get("broadcastStatus") ? "?" + u.searchParams.get("broadcastStatus") : ""}`);
    if (init?.body && typeof init.body === "string") bodies.push(JSON.parse(init.body));
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (u.pathname.endsWith("/liveBroadcasts/transition")) {
      const target = u.searchParams.get("broadcastStatus")!;
      if (target === "testing") {
        pendingTesting = opts.testingAfterPolls ?? 1;
      } else {
        bc.status.lifeCycleStatus = target;
      }
      return json(bc);
    }
    if (u.pathname.endsWith("/liveBroadcasts/bind")) {
      bc.contentDetails.boundStreamId = u.searchParams.get("streamId")!;
      return json(bc);
    }
    if (u.pathname.endsWith("/liveBroadcasts") && method === "PUT") {
      const body = JSON.parse(String(init!.body));
      bc.status.privacyStatus = body.status.privacyStatus;
      return json({ ...bc, contentDetails: undefined });
    }
    if (u.pathname.endsWith("/liveBroadcasts")) {
      if (pendingTesting > 0 && --pendingTesting === 0) bc.status.lifeCycleStatus = "testing";
      const listStatus = u.searchParams.get("broadcastStatus");
      if (listStatus === "active") {
        return json({ items: ["live", "testing"].includes(bc.status.lifeCycleStatus) ? [bc] : [] });
      }
      return json({ items: [bc] });
    }
    if (u.pathname.endsWith("/liveStreams") && method === "POST") return json({ ...stream, id: "st_new" });
    if (u.pathname.endsWith("/liveStreams")) return json({ items: [stream] });
    if (u.pathname.endsWith("/thumbnails/set")) return json({ items: [] });
    return json({});
  };
  return { fetchFn, calls, bodies, bc, stream };
}

const noSleep = async () => {};

describe("LifecycleCoordinator", () => {
  const fixedNow = 1_700_000_000_000;

  it("selects upcoming broadcast via 'auto' based on nearest scheduled time", async () => {
    const fakeFetch: typeof fetch = async (url) => {
      if (String(url).includes("/liveBroadcasts")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "bc_far_away",
                snippet: {
                  title: "Ensi viikko",
                  scheduledStartTime: new Date(fixedNow + 7 * 24 * 3600 * 1000).toISOString(),
                },
                status: { lifeCycleStatus: "ready", privacyStatus: "public" },
              },
              {
                id: "bc_today_near",
                snippet: {
                  title: "Tanaan lahella",
                  scheduledStartTime: new Date(fixedNow + 15 * 60 * 1000).toISOString(), // 15 mins away
                },
                status: { lifeCycleStatus: "ready", privacyStatus: "public" },
                contentDetails: { boundStreamId: "stream_live_1" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (String(url).includes("/liveStreams")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "stream_live_1",
                cdn: { ingestionInfo: { streamName: "key_abc123" } },
                status: { streamStatus: "ready" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    };

    const client = new YouTubeClient({ fetchFn: fakeFetch });
    const pipeline = new CaptionPipeline({ now: () => fixedNow });
    const coordinator = new LifecycleCoordinator({
      client,
      captionPipeline: pipeline,
      now: () => fixedNow,
    });

    const selected = await coordinator.selectBroadcast("auto");
    assert.equal(selected.id, "bc_today_near");
    assert.equal(coordinator.getState(), "ready");
  });

  it("creates ad-hoc broadcast and marks it selected", async () => {
    const fakeFetch: typeof fetch = async (url, init) => {
      const urlStr = String(url);
      if (init?.method === "POST" && urlStr.includes("/liveBroadcasts/bind")) {
        return new Response(
          JSON.stringify({
            id: "bc_adhoc_1",
            snippet: { title: "Ad-hoc iltakirkko" },
            status: { lifeCycleStatus: "ready", privacyStatus: "public" },
            contentDetails: { boundStreamId: "str_default" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (init?.method === "POST" && urlStr.includes("/liveBroadcasts")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return new Response(
          JSON.stringify({
            id: "bc_adhoc_1",
            snippet: body.snippet || { title: "Ad-hoc" },
            status: { lifeCycleStatus: "ready", privacyStatus: body.status?.privacyStatus || "public" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (String(url).includes("/liveStreams")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "str_default",
                cdn: { ingestionInfo: { streamName: "stream_key_default" } },
                status: { streamStatus: "ready" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("{}", { status: 200 });
    };

    const client = new YouTubeClient({ fetchFn: fakeFetch });
    const pipeline = new CaptionPipeline();
    const coordinator = new LifecycleCoordinator({
      client,
      captionPipeline: pipeline,
      fallbackStreamKey: "fallback_key",
    });

    const created = await coordinator.createAdHocBroadcast({
      title: "Ad-hoc iltakirkko",
      privacy: "public",
    });

    assert.equal(created.id, "bc_adhoc_1");
    assert.equal(coordinator.getSelectedBroadcast()?.title, "Ad-hoc iltakirkko");
    assert.equal(coordinator.getState(), "ready");
  });

  it("goes ready -> testing (waits) -> live and then complete", async () => {
    const yt = fakeYouTube({ testingAfterPolls: 2 });
    const pipeline = new CaptionPipeline();
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: pipeline,
      sleep: noSleep,
      pollMs: 1,
    });
    await coordinator.selectBroadcast("bc_1");
    const live = await coordinator.startBroadcast();
    assert.equal(live.status, "live");
    assert.equal(coordinator.getState(), "live");
    assert.equal(pipeline.running, true);
    const transitions = yt.calls.filter((c) => c.includes("transition"));
    assert.deepEqual(transitions, [
      "POST /youtube/v3/liveBroadcasts/transition?testing",
      "POST /youtube/v3/liveBroadcasts/transition?live",
    ]);

    const stopped = await coordinator.stopBroadcast();
    assert.equal(stopped.status, "complete");
    assert.equal(coordinator.getState(), "idle");
    assert.equal(pipeline.running, false);
    coordinator.stop();
  });

  it("refuses to start while the stream receives no data", async () => {
    const yt = fakeYouTube({ streamStatus: "inactive" });
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: new CaptionPipeline(),
      sleep: noSleep,
    });
    await coordinator.selectBroadcast("bc_1");
    await assert.rejects(() => coordinator.startBroadcast(), /not receiving data/);
    assert.equal(yt.calls.filter((c) => c.includes("transition")).length, 0);
    coordinator.stop();
  });

  it("start with to=testing stops at testing and sends no captions", async () => {
    const yt = fakeYouTube();
    const pipeline = new CaptionPipeline();
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: pipeline,
      sleep: noSleep,
    });
    await coordinator.selectBroadcast("bc_1");
    const result = await coordinator.startBroadcast("testing");
    assert.equal(result.status, "testing");
    assert.equal(coordinator.getState(), "testing");
    assert.equal(pipeline.running, false);
    coordinator.stop();
  });

  it("polls stream health from selection, before going live", async () => {
    const yt = fakeYouTube();
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: new CaptionPipeline(),
    });
    await coordinator.selectBroadcast("bc_1");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(coordinator.getStreamHealth(), "good");
    coordinator.stop();
  });

  it("auto does not select a broadcast outside the 60 minute window", async () => {
    const yt = fakeYouTube();
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: new CaptionPipeline(),
      now: () => new Date("2026-11-08T08:00:00Z").getTime(),
    });
    await assert.rejects(() => coordinator.selectBroadcast("auto"), /within 60 minutes/);
  });

  it("a failed complete transition is an error and keeps the selection", async () => {
    const yt = fakeYouTube();
    const failing: typeof fetch = async (url, init) => {
      if (String(url).includes("broadcastStatus=complete")) return new Response("boom", { status: 500 });
      return yt.fetchFn(url, init);
    };
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: failing }),
      captionPipeline: new CaptionPipeline(),
      sleep: noSleep,
    });
    await coordinator.selectBroadcast("bc_1");
    await coordinator.startBroadcast();
    await assert.rejects(() => coordinator.stopBroadcast(), /500/);
    assert.equal(coordinator.getSelectedBroadcast()?.id, "bc_1");
    coordinator.stop();
  });

  it("stop with nothing selected is an error", async () => {
    const coordinator = new LifecycleCoordinator({ captionPipeline: new CaptionPipeline() });
    await assert.rejects(() => coordinator.stopBroadcast(), /No broadcast selected/);
  });

  it("binds the configured stream id when it differs from the bound one", async () => {
    const yt = fakeYouTube();
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: new CaptionPipeline(),
      streamId: "st_other",
    });
    await coordinator.selectBroadcast("bc_1");
    assert.ok(yt.calls.some((c) => c.includes("/liveBroadcasts/bind")));
    coordinator.stop();
  });

  it("listStreams never contains the stream key or ingestion address", async () => {
    const yt = fakeYouTube();
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: new CaptionPipeline(),
    });
    const streams = await coordinator.listStreams();
    assert.equal(streams.length, 1);
    assert.equal(streams[0]?.health, "good");
    const text = JSON.stringify(streams);
    assert.ok(!text.includes("SECRETKEY"));
    assert.ok(!text.includes("a.rtmp.youtube.com"));
  });

  it("changes privacy through liveBroadcasts.update and returns the watch url", async () => {
    const yt = fakeYouTube();
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: new CaptionPipeline(),
    });
    await coordinator.selectBroadcast("bc_1");
    const updated = await coordinator.setPrivacy("public");
    assert.equal(updated.privacy, "public");
    const put = yt.bodies.find((b: any) => b.status?.privacyStatus) as any;
    assert.equal(put.snippet.title, "Messu");
    assert.equal(put.snippet.scheduledStartTime, "2026-11-01T08:00:00Z");
    const urls = await coordinator.getUrls();
    assert.equal(urls.watchUrl, "https://www.youtube.com/watch?v=bc_1");
    coordinator.stop();
  });

  it("uploads a thumbnail with the image content type", async () => {
    const yt = fakeYouTube();
    let seen: { url: string; type: string | null; size: number } | null = null;
    const spy: typeof fetch = async (url, init) => {
      if (String(url).includes("/thumbnails/set")) {
        seen = { url: String(url), type: new Headers(init?.headers).get("content-type"), size: (init!.body as Uint8Array).length };
      }
      return yt.fetchFn(url, init);
    };
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: spy }),
      captionPipeline: new CaptionPipeline(),
    });
    await coordinator.selectBroadcast("bc_1");
    await coordinator.setThumbnail(new Uint8Array([1, 2, 3]), "image/png");
    assert.deepEqual(seen, {
      url: "https://youtube.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=bc_1",
      type: "image/png",
      size: 3,
    });
    coordinator.stop();
  });

  it("recovers a live broadcast after a restart and continues the caption sequence", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitube-state-"));
    const file = path.join(dir, "state.json");
    new StateStore(file).save({ broadcastId: "bc_1", sequence: 42 });

    const yt = fakeYouTube();
    yt.bc.status.lifeCycleStatus = "live";
    const pipeline = new CaptionPipeline();
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: pipeline,
      stateStore: new StateStore(file),
    });
    const recovered = await coordinator.recover();
    assert.equal(recovered?.id, "bc_1");
    assert.equal(coordinator.getState(), "live");
    assert.equal(pipeline.running, true);
    // The restored sender continues at 42 (state file keeps the number)
    assert.equal(new StateStore(file).load()?.sequence, 42);
    coordinator.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not reuse a saved sequence for another broadcast", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitube-state-"));
    const file = path.join(dir, "state.json");
    new StateStore(file).save({ broadcastId: "old_broadcast", sequence: 99 });
    const yt = fakeYouTube();
    yt.bc.status.lifeCycleStatus = "live";
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: new CaptionPipeline(),
      stateStore: new StateStore(file),
    });
    await coordinator.recover();
    const saved = new StateStore(file).load();
    assert.equal(saved?.broadcastId, "bc_1");
    assert.equal(saved?.sequence, 0);
    coordinator.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pushes the RTMP target to piencoder without exposing it", async () => {
    const yt = fakeYouTube();
    const sent: { url: string; body: any }[] = [];
    const { EncoderClient } = await import("../src/encoder/client.js");
    const encoder = new EncoderClient({
      baseUrl: "http://127.0.0.1:3109",
      unit: 1,
      channel: 1,
      fetchFn: async (url, init) => {
        sent.push({ url: String(url), body: JSON.parse(String(init!.body)) });
        return new Response(null, { status: 204 });
      },
    });
    const coordinator = new LifecycleCoordinator({
      client: new YouTubeClient({ fetchFn: yt.fetchFn }),
      captionPipeline: new CaptionPipeline(),
      encoder,
    });
    await coordinator.selectBroadcast("bc_1");
    const result = await coordinator.applyIngestToEncoder();
    assert.deepEqual(result, { unit: 1, channel: 1 });
    assert.equal(sent[0]?.url, "http://127.0.0.1:3109/api/v1/encoder/1/rtmp/1");
    assert.deepEqual(sent[0]?.body, { url: "rtmp://a.rtmp.youtube.com/live2", streamName: "SECRETKEY-1234" });
    coordinator.stop();
  });
});
