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
});
