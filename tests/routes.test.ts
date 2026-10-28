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
});
