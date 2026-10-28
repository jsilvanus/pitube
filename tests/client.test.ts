import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { YouTubeClient } from "../src/youtube/client.js";

describe("YouTubeClient", () => {
  it("lists upcoming broadcasts and maps fields correctly", async () => {
    const fakeFetch: typeof fetch = async (url) => {
      assert.match(String(url), /broadcastStatus=upcoming/);
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "bc_upcoming_1",
              snippet: {
                title: "Jumalanpalvelus 1.11.2026",
                description: "Suora lahetys",
                scheduledStartTime: "2026-11-01T10:00:00Z",
              },
              status: {
                lifeCycleStatus: "ready",
                privacyStatus: "public",
              },
              contentDetails: {
                boundStreamId: "stream_123",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const client = new YouTubeClient({ fetchFn: fakeFetch });
    const broadcasts = await client.listUpcomingBroadcasts();

    assert.equal(broadcasts.length, 1);
    const first = broadcasts[0]!;
    assert.equal(first.id, "bc_upcoming_1");
    assert.equal(first.title, "Jumalanpalvelus 1.11.2026");
    assert.equal(first.privacy, "public");
    assert.equal(first.status, "ready");
    assert.equal(first.embedUrl, "https://www.youtube.com/embed/bc_upcoming_1");
    assert.equal(first.streamId, "stream_123");
  });

  it("creates an ad-hoc broadcast with closed caption ingestion", async () => {
    let sentBody: Record<string, any> = {};

    const fakeFetch: typeof fetch = async (url, init) => {
      assert.equal(init?.method, "POST");
      sentBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "bc_adhoc_new",
          snippet: sentBody.snippet,
          status: {
            lifeCycleStatus: "ready",
            privacyStatus: sentBody.status.privacyStatus,
          },
          contentDetails: sentBody.contentDetails,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const client = new YouTubeClient({ fetchFn: fakeFetch });
    const created = await client.createBroadcast({
      title: "Ad-hoc Messu",
      privacy: "unlisted",
      description: "Test description",
    });

    assert.equal(created.id, "bc_adhoc_new");
    assert.equal(created.title, "Ad-hoc Messu");
    assert.equal(created.privacy, "unlisted");
    assert.equal(sentBody.contentDetails.enableClosedCaptions, true);
    assert.equal(sentBody.contentDetails.closedCaptionsType, "httpPost");
    assert.equal(sentBody.contentDetails.latencyPreference, "lowLatency");
    assert.equal(sentBody.contentDetails.enableEmbed, true);
  });

  it("transitions broadcast to target state", async () => {
    const fakeFetch: typeof fetch = async (url) => {
      assert.match(String(url), /broadcastStatus=live/);
      assert.match(String(url), /id=bc_123/);
      return new Response(
        JSON.stringify({
          id: "bc_123",
          snippet: { title: "Live broadcast" },
          status: { lifeCycleStatus: "live", privacyStatus: "public" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const client = new YouTubeClient({ fetchFn: fakeFetch });
    const res = await client.transitionBroadcast("bc_123", "live");
    assert.equal(res.status, "live");
  });
});
