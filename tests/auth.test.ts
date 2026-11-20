import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { YouTubeAuth } from "../src/youtube/auth.js";

describe("YouTubeAuth", () => {
  it("exchanges refresh token for access token", async () => {
    let calledUrl = "";
    let calledBody = "";

    const fakeFetch: typeof fetch = async (url, init) => {
      calledUrl = String(url);
      calledBody = String(init?.body);
      return new Response(
        JSON.stringify({
          access_token: "mock_access_token_123",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const auth = new YouTubeAuth(
      {
        clientId: "client_abc",
        clientSecret: "secret_xyz",
        refreshToken: "refresh_789",
      },
      fakeFetch
    );

    const token = await auth.getAccessToken();
    assert.equal(token, "mock_access_token_123");
    assert.match(calledUrl, /oauth2\.googleapis\.com\/token/);
    assert.match(calledBody, /client_id=client_abc/);
    assert.match(calledBody, /grant_type=refresh_token/);
  });

  it("caches valid token and does not re-fetch before expiry", async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          access_token: `token_${callCount}`,
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const auth = new YouTubeAuth(
      {
        clientId: "client_abc",
        clientSecret: "secret_xyz",
        refreshToken: "refresh_789",
      },
      fakeFetch
    );

    const t1 = await auth.getAccessToken();
    const t2 = await auth.getAccessToken();
    assert.equal(t1, "token_1");
    assert.equal(t2, "token_1");
    assert.equal(callCount, 1);
  });

  it("re-fetches when invalidate() is called", async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          access_token: `token_${callCount}`,
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const auth = new YouTubeAuth(
      {
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
      },
      fakeFetch
    );

    const t1 = await auth.getAccessToken();
    assert.equal(t1, "token_1");
    auth.invalidate();
    const t2 = await auth.getAccessToken();
    assert.equal(t2, "token_2");
    assert.equal(callCount, 2);
  });

  it("stops calling token endpoint after invalid_grant until check() is called", async () => {
    let callCount = 0;
    const fakeFetch: typeof fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    };

    const auth = new YouTubeAuth(
      { clientId: "c", clientSecret: "s", refreshToken: "r" },
      fakeFetch
    );

    await assert.rejects(() => auth.getAccessToken(), /400/);
    assert.equal(auth.health().state, "revoked");
    assert.equal(callCount, 1);

    // Subsequent calls fail fast without hitting Google's token endpoint
    await assert.rejects(() => auth.getAccessToken(), /revoked/);
    await assert.rejects(() => auth.getAccessToken(), /revoked/);
    assert.equal(callCount, 1);

    // Explicit check() still tests the endpoint
    const health = await auth.check();
    assert.equal(health.state, "revoked");
    assert.equal(callCount, 2);
  });

  it("applies exponential backoff on transient refresh failures and resets on success", async () => {
    let now = 1_000_000;
    let callCount = 0;
    let shouldFail = true;

    const fakeFetch: typeof fetch = async () => {
      callCount++;
      if (shouldFail) {
        return new Response("upstream error", { status: 500 });
      }
      return new Response(JSON.stringify({ access_token: "recovered", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const auth = new YouTubeAuth(
      { clientId: "c", clientSecret: "s", refreshToken: "r" },
      fakeFetch,
      () => now
    );

    await assert.rejects(() => auth.getAccessToken(), /500/);
    assert.equal(auth.health().state, "refresh_failed");
    assert.equal(callCount, 1);

    // Within 30s backoff window: does not hit fetch
    now += 15_000;
    await assert.rejects(() => auth.getAccessToken(), /backing off/);
    assert.equal(callCount, 1);

    // After 30s backoff expires: retries once, then backs off for 60s
    now += 16_000;
    await assert.rejects(() => auth.getAccessToken(), /500/);
    assert.equal(callCount, 2);

    now += 45_000;
    await assert.rejects(() => auth.getAccessToken(), /backing off/);
    assert.equal(callCount, 2);

    // After 60s backoff expires and upstream recovers: succeeds and clears backoff
    now += 20_000;
    shouldFail = false;
    const token = await auth.getAccessToken();
    assert.equal(token, "recovered");
    assert.equal(auth.health().state, "ok");
    assert.equal(callCount, 3);
  });
});
