/**
 * Main entry point for pitube service.
 */

import { loadConfig } from "./config.js";
import { buildApp } from "./server.js";

const config = loadConfig();
const app = buildApp(config);

async function main() {
  const shutdown = async (signal: string) => {
    console.log(`[pitube] Received ${signal}, shutting down...`);
    try {
      await app.stop();
      process.exit(0);
    } catch (err) {
      console.error("[pitube] Error during shutdown:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await app.start();
    console.log(`[pitube] Listening on ${config.host}:${config.port}`);
    console.log(`[pitube] Connected to gateway at ${config.gatewayUrl}`);
    console.log(`[pitube] Video delay for captions: ${config.youtubeDelayMs} ms`);
  } catch (err) {
    console.error("[pitube] Failed to start:", err);
    process.exit(1);
  }
}

main();
