/**
 * One-time OAuth consent to obtain YOUTUBE_REFRESH_TOKEN.
 * Routes are only for loopback requests (use an ssh -L tunnel from your own computer).
 * The refresh token is written to an env file (mode 600) and never logged or returned.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";

export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 10 * 60 * 1000;

export interface YouTubeOAuthOptions {
  clientId: string | null;
  clientSecret: string | null;
  /** Must match an authorised redirect URI of the OAuth client in Google Cloud. */
  redirectUri: string;
  /** File that receives YOUTUBE_REFRESH_TOKEN=... */
  envFile: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: YOUTUBE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Replaces or appends YOUTUBE_REFRESH_TOKEN in an env file; written atomically with mode 600. */
export function saveRefreshToken(envFile: string, token: string): void {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
  } catch {
    lines = [];
  }
  const entry = `YOUTUBE_REFRESH_TOKEN=${token}`;
  const index = lines.findIndex((line) => /^\s*(export\s+)?YOUTUBE_REFRESH_TOKEN\s*=/.test(line));
  if (index >= 0) lines[index] = entry;
  else lines.push(entry);
  fs.mkdirSync(path.dirname(path.resolve(envFile)), { recursive: true });
  const temp = `${envFile}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, envFile);
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;max-width:40em;margin:3em auto"><h1>${title}</h1><p>${body}</p></body>`;
}

export function registerYouTubeOAuthRoutes(app: FastifyInstance, options: YouTubeOAuthOptions): void {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const pending = new Map<string, number>();

  const guard = (ip: string): boolean => isLoopback(ip);

  app.get("/auth/youtube", async (request, reply) => {
    if (!guard(request.ip)) return reply.code(403).send({ error: "OAuth setup is only available from localhost (use ssh -L)" });
    if (!options.clientId || !options.clientSecret) {
      return reply.code(503).send({ error: "YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET must be set first" });
    }
    for (const [state, at] of pending) if (now() - at > STATE_TTL_MS) pending.delete(state);
    const state = randomBytes(16).toString("hex");
    pending.set(state, now());
    return reply.redirect(buildAuthUrl(options.clientId, options.redirectUri, state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>("/oauth/callback", async (request, reply) => {
    if (!guard(request.ip)) return reply.code(403).send({ error: "OAuth setup is only available from localhost" });
    const { code, state, error } = request.query;
    reply.type("text/html");
    const startedAt = state ? pending.get(state) : undefined;
    if (state) pending.delete(state);
    if (startedAt === undefined || now() - startedAt > STATE_TTL_MS) {
      return reply.code(400).send(page("Not accepted", "Unknown or expired state. Start again from /auth/youtube."));
    }
    if (error) return reply.code(400).send(page("Consent not given", `Google answered: ${error.replace(/[^\w.-]/g, "")}.`));
    if (!code || !options.clientId || !options.clientSecret) {
      return reply.code(400).send(page("Not accepted", "The answer from Google had no code."));
    }
    let res: Response;
    try {
      res = await doFetch(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          redirect_uri: options.redirectUri,
          grant_type: "authorization_code",
        }).toString(),
      });
    } catch {
      return reply.code(502).send(page("Google unreachable", "Could not reach the Google token endpoint."));
    }
    const data = (await res.json().catch(() => ({}))) as { refresh_token?: string; error?: string };
    if (!res.ok) {
      return reply.code(502).send(page("Token exchange failed", `Google answered: ${String(data.error ?? res.status).replace(/[^\w. -]/g, "")}.`));
    }
    if (!data.refresh_token) {
      return reply.code(502).send(page("No refresh token", "Google returned no refresh token. Remove pitube's access at https://myaccount.google.com/permissions and start again."));
    }
    saveRefreshToken(options.envFile, data.refresh_token);
    return reply.send(page("Done", `The refresh token was saved to ${path.resolve(options.envFile)} (mode 600). Restart pitube to use it. You can close this tab.`));
  });
}
