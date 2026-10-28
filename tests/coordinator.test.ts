import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LifecycleCoordinator } from "../src/lifecycle/coordinator.js";
import { CaptionPipeline } from "../src/captions/pipeline.js";
import { YouTubeClient } from "../src/youtube/client.js";

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

  it("transitions broadcast from ready to live and complete", async () => {
    let broadcastState = "ready";

    const fakeFetch: typeof fetch = async (url, init) => {
      if (String(url).includes("/transition")) {
        const target = new URL(String(url)).searchParams.get("broadcastStatus");
        broadcastState = target || "ready";
        return new Response(
          JSON.stringify({
            id: "bc_1",
            snippet: { title: "Messu" },
            status: { lifeCycleStatus: broadcastState, privacyStatus: "public" },
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    };

    const client = new YouTubeClient({ fetchFn: fakeFetch });
    const pipeline = new CaptionPipeline();
    const coordinator = new LifecycleCoordinator({
      client,
      captionPipeline: pipeline,
      fallbackStreamKey: "dummy_key",
    });

    // Mock an active broadcast selection
    (coordinator as any).selectedBroadcast = {
      id: "bc_1",
      title: "Messu",
      privacy: "public",
      status: "ready",
      embedUrl: "https://www.youtube.com/embed/bc_1",
    };
    (coordinator as any).boundStreamKey = "dummy_key";

    // Go live
    const liveResult = await coordinator.startBroadcast();
    assert.equal(liveResult.status, "live");
    assert.equal(coordinator.getState(), "live");
    assert.equal(pipeline.running, true);

    // Stop broadcast
    const stopResult = await coordinator.stopBroadcast();
    assert.equal(stopResult.status, "complete");
    assert.equal(coordinator.getState(), "idle");
    assert.equal(pipeline.running, false);
  });
});
