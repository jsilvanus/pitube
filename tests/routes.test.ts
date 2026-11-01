import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/server.js";
import { loadConfig } from "../src/config.js";

describe("HTTP Routes", () => {
  const config = loadConfig({
    PITUBE_PORT: "3199",
    PITUBE_API_KEY: "secret-pitube-key",
    YOUTUBE_STREAM_KEY: "test-key-123",
  });

  it("responds to /health", async () => {
    const app = buildApp(config);
    const res = await app.server.inject({
      method: "GET",
      url: "/health",
    });

    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.payload);
    assert.equal(json.ok, true);
    assert.equal(json.service, "pitube");
  });

  it("returns status on GET /api/v1/status without auth", async () => {
    const app = buildApp(config);
    const res = await app.server.inject({
      method: "GET",
      url: "/api/v1/status",
    });

    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.payload);
    assert.equal(json.service, "pitube");
    assert.equal(json.state, "idle");
  });

  it("requires API key on POST endpoints when key is configured", async () => {
    const app = buildApp(config);
    const unauthRes = await app.server.inject({
      method: "POST",
      url: "/api/v1/broadcasts/select",
      payload: { broadcastId: "test_bc" },
    });
    assert.equal(unauthRes.statusCode, 401);

    const authRes = await app.server.inject({
      method: "POST",
      url: "/api/v1/broadcasts/select",
      headers: {
        authorization: "Bearer secret-pitube-key",
      },
      payload: { broadcastId: "test_bc" },
    });
    assert.equal(authRes.statusCode, 200);
  });

  it("creates an ad-hoc broadcast via POST /api/v1/broadcasts/create", async () => {
    const app = buildApp(config);
    const res = await app.server.inject({
      method: "POST",
      url: "/api/v1/broadcasts/create",
      headers: {
        authorization: "Bearer secret-pitube-key",
      },
      payload: {
        title: "Test Ad-Hoc Service",
        privacy: "unlisted",
      },
    });

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.payload);
    assert.equal(body.title, "Test Ad-Hoc Service");
    assert.equal(body.privacy, "unlisted");
  });

  it("returns current broadcast details via GET /api/v1/broadcasts/current", async () => {
    const app = buildApp(config);
    // First select
    await app.server.inject({
      method: "POST",
      url: "/api/v1/broadcasts/select",
      headers: { authorization: "Bearer secret-pitube-key" },
      payload: { broadcastId: "active_bc" },
    });

    const res = await app.server.inject({
      method: "GET",
      url: "/api/v1/broadcasts/current",
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.broadcast.id, "active_bc");
    assert.equal(body.broadcast.embedUrl, "https://www.youtube.com/embed/active_bc");
  });

  describe("new routes", () => {
    const headers = { authorization: "Bearer secret-pitube-key" };

    it("validates privacy values", async () => {
      const app = buildApp(config);
      const res = await app.server.inject({
        method: "POST",
        url: "/api/v1/broadcasts/privacy",
        headers,
        payload: { privacy: "everyone" },
      });
      assert.equal(res.statusCode, 400);
    });

    it("rejects thumbnails that are not images", async () => {
      const app = buildApp(config);
      const res = await app.server.inject({
        method: "POST",
        url: "/api/v1/broadcasts/thumbnail",
        headers: { ...headers, "content-type": "application/json" },
        payload: { x: 1 },
      });
      assert.equal(res.statusCode, 400);
    });

    it("accepts a raw image body and fails only because YouTube is not configured", async () => {
      const app = buildApp(config);
      const res = await app.server.inject({
        method: "POST",
        url: "/api/v1/broadcasts/thumbnail?broadcastId=abc",
        headers: { ...headers, "content-type": "image/jpeg" },
        payload: Buffer.from([0xff, 0xd8, 0xff]),
      });
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.payload).error, /not configured/);
    });

    it("rejects an unknown broadcast status filter and a bad start target", async () => {
      const app = buildApp(config);
      const list = await app.server.inject({ method: "GET", url: "/api/v1/broadcasts?status=foo" });
      assert.equal(list.statusCode, 400);
      const start = await app.server.inject({
        method: "POST",
        url: "/api/v1/broadcasts/start",
        headers,
        payload: { to: "later" },
      });
      assert.equal(start.statusCode, 400);
    });

    it("stop while idle is a 400", async () => {
      const app = buildApp(config);
      const res = await app.server.inject({ method: "POST", url: "/api/v1/broadcasts/stop", headers });
      assert.equal(res.statusCode, 400);
    });

    it("ingest apply without an encoder configured is a 400", async () => {
      const app = buildApp(config);
      const res = await app.server.inject({ method: "POST", url: "/api/v1/ingest/apply", headers, payload: {} });
      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.payload).error, /PITUBE_ENCODER_URL/);
    });

    it("GET /api/v1/streams is empty without YouTube credentials", async () => {
      const app = buildApp(config);
      const res = await app.server.inject({ method: "GET", url: "/api/v1/streams" });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(JSON.parse(res.payload), { items: [] });
    });

    it("PATCH validates input", async () => {
      const app = buildApp(config);
      const empty = await app.server.inject({ method: "PATCH", url: "/api/v1/broadcasts/abc", headers, payload: {} });
      assert.equal(empty.statusCode, 400);
      const bad = await app.server.inject({ method: "PATCH", url: "/api/v1/broadcasts/abc", headers, payload: { privacy: "x" } });
      assert.equal(bad.statusCode, 400);
      const noYt = await app.server.inject({ method: "PATCH", url: "/api/v1/broadcasts/abc", headers, payload: { title: "T" } });
      assert.equal(noYt.statusCode, 400);
      assert.match(JSON.parse(noYt.payload).error, /not configured/);
    });

    it("status has a level and auth health reports missing without credentials", async () => {
      const app = buildApp(config);
      const status = JSON.parse((await app.server.inject({ method: "GET", url: "/api/v1/status" })).payload);
      assert.equal(status.level, "idle");
      const auth = JSON.parse((await app.server.inject({ method: "GET", url: "/api/v1/auth/health" })).payload);
      assert.equal(auth.state, "missing");
    });

    it("stop/request without a selection is a 400", async () => {
      const app = buildApp(config);
      const res = await app.server.inject({ method: "POST", url: "/api/v1/broadcasts/stop/request", headers });
      assert.equal(res.statusCode, 400);
    });
  });
});
