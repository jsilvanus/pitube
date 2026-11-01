import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fastify from "fastify";
import { buildAuthUrl, registerYouTubeOAuthRoutes, saveRefreshToken, YOUTUBE_SCOPE } from "../src/youtube/oauth.js";

const REDIRECT = "http://localhost:3105/oauth/callback";

function tempEnv(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pitube-")), ".env");
}

function setup(fetchImpl: typeof fetch, envFile: string) {
  const app = fastify();
  registerYouTubeOAuthRoutes(app, { clientId: "cid", clientSecret: "csec", redirectUri: REDIRECT, envFile, fetchImpl });
  return app;
}

describe("YouTube OAuth consent", () => {
  it("builds an offline, consent-forcing URL for the youtube scope", () => {
    const url = new URL(buildAuthUrl("cid", REDIRECT, "st"));
    assert.equal(url.searchParams.get("scope"), YOUTUBE_SCOPE);
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("prompt"), "consent");
    assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
  });

  it("saveRefreshToken replaces or appends the line, mode 600", () => {
    const file = tempEnv();
    fs.writeFileSync(file, "A=1\nYOUTUBE_REFRESH_TOKEN=old\nB=2\n");
    saveRefreshToken(file, "new");
    assert.equal(fs.readFileSync(file, "utf8"), "A=1\nYOUTUBE_REFRESH_TOKEN=new\nB=2\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const fresh = tempEnv();
    saveRefreshToken(fresh, "t");
    assert.equal(fs.readFileSync(fresh, "utf8"), "YOUTUBE_REFRESH_TOKEN=t\n");
  });

  it("full flow: redirect, callback exchanges the code and saves the token without echoing it", async () => {
    const file = tempEnv();
    let body = "";
    const app = setup((async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ refresh_token: "SECRET-RT", access_token: "x" }), { status: 200 });
    }) as typeof fetch, file);
    const start = await app.inject({ method: "GET", url: "/auth/youtube", remoteAddress: "127.0.0.1" });
    assert.equal(start.statusCode, 302);
    const location = new URL(String(start.headers.location));
    const state = location.searchParams.get("state")!;
    const cb = await app.inject({ method: "GET", url: `/oauth/callback?code=abc&state=${state}`, remoteAddress: "127.0.0.1" });
    assert.equal(cb.statusCode, 200);
    assert.ok(!cb.payload.includes("SECRET-RT"));
    assert.ok(body.includes("code=abc") && body.includes("grant_type=authorization_code"));
    assert.ok(fs.readFileSync(file, "utf8").includes("YOUTUBE_REFRESH_TOKEN=SECRET-RT"));
    // state is single-use
    const again = await app.inject({ method: "GET", url: `/oauth/callback?code=abc&state=${state}`, remoteAddress: "127.0.0.1" });
    assert.equal(again.statusCode, 400);
  });

  it("refuses non-loopback callers and unknown state", async () => {
    const file = tempEnv();
    const app = setup((async () => new Response("{}")) as typeof fetch, file);
    assert.equal((await app.inject({ method: "GET", url: "/auth/youtube", remoteAddress: "192.168.1.5" })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: "/oauth/callback?code=a&state=nope", remoteAddress: "127.0.0.1" })).statusCode, 400);
    assert.equal(fs.existsSync(file), false);
  });

  it("reports a missing refresh token instead of saving", async () => {
    const file = tempEnv();
    const app = setup((async () => new Response(JSON.stringify({ access_token: "x" }), { status: 200 })) as typeof fetch, file);
    const start = await app.inject({ method: "GET", url: "/auth/youtube", remoteAddress: "127.0.0.1" });
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const cb = await app.inject({ method: "GET", url: `/oauth/callback?code=abc&state=${state}`, remoteAddress: "127.0.0.1" });
    assert.equal(cb.statusCode, 502);
    assert.equal(fs.existsSync(file), false);
  });
});
