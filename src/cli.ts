#!/usr/bin/env node
/**
 * pitube CLI. `pitube auth youtube` prints the steps and the URL for the one-time YouTube consent.
 */

import { loadConfig } from "./config.js";

const [group, action] = process.argv.slice(2);
const config = loadConfig();

if (group === "auth" && action === "youtube") {
  const base = `http://localhost:${config.port}`;
  const missing = [
    !config.youtubeClientId && "YOUTUBE_CLIENT_ID",
    !config.youtubeClientSecret && "YOUTUBE_CLIENT_SECRET",
  ].filter(Boolean);
  console.log("YouTube consent (one time, gives YOUTUBE_REFRESH_TOKEN)\n");
  if (missing.length > 0) console.log(`Set ${missing.join(" and ")} in pitube's environment first, then restart pitube.\n`);
  console.log(`1. In Google Cloud (APIs & Services > Credentials > your OAuth client) add this authorised redirect URI:\n   ${config.oauthRedirectUri}`);
  console.log(`2. On your own computer open a tunnel to the Pi (pitube must be running there):\n   ssh -L ${config.port}:localhost:${config.port} pi@kirkonpi.local`);
  console.log(`3. Open this URL in the browser on that computer and approve:\n   ${base}/auth/youtube`);
  console.log(`4. The token is saved to ${config.envFile} (mode 600), never printed. Restart pitube afterwards.`);
  process.exit(missing.length > 0 ? 1 : 0);
}

console.log("Usage: pitube auth youtube");
process.exit(group === undefined ? 0 : 1);
