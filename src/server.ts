/**
 * Fastify app factory and service wiring for pitube.
 */

import fastify, { type FastifyInstance } from "fastify";
import { type PitubeConfig } from "./config.js";
import { YouTubeAuth } from "./youtube/auth.js";
import { YouTubeClient } from "./youtube/client.js";
import { CaptionPipeline } from "./captions/pipeline.js";
import { GatewaySSEClient } from "./gateway/client.js";
import { GatewayStatusReporter } from "./gateway/reporter.js";
import { LifecycleCoordinator } from "./lifecycle/coordinator.js";
import { registerRoutes } from "./routes.js";

export interface PitubeApp {
  server: FastifyInstance;
  coordinator: LifecycleCoordinator;
  captionPipeline: CaptionPipeline;
  gatewayClient: GatewaySSEClient;
  statusReporter: GatewayStatusReporter;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export function buildApp(config: PitubeConfig): PitubeApp {
  const server = fastify({
    logger: false,
  });

  // 1. YouTube Client setup
  let ytAuth: YouTubeAuth | undefined;
  let ytClient: YouTubeClient | undefined;

  if (config.youtubeClientId && config.youtubeClientSecret && config.youtubeRefreshToken) {
    ytAuth = new YouTubeAuth({
      clientId: config.youtubeClientId,
      clientSecret: config.youtubeClientSecret,
      refreshToken: config.youtubeRefreshToken,
    });
    ytClient = new YouTubeClient({ auth: ytAuth });
  }

  // 2. Caption Pipeline
  const captionPipeline = new CaptionPipeline({
    youtubeDelayMs: config.youtubeDelayMs,
    staleCaptionMs: config.staleCaptionMs,
  });

  // 3. Lifecycle Coordinator
  const coordinator = new LifecycleCoordinator({
    client: ytClient,
    captionPipeline,
    captionBaseUrl: config.captionBaseUrl,
    fallbackStreamKey: config.youtubeStreamKey,
  });

  // 4. Gateway SSE Client
  const gatewayClient = new GatewaySSEClient({
    gatewayUrl: config.gatewayUrl,
    gatewayToken: config.gatewayToken,
    onTranscript: (event) => {
      captionPipeline.handleTranscript(event).catch(() => {});
    },
    onActivity: (activityState) => {
      // Future: auto-lifecycle trigger if enabled
    },
  });

  // 5. Gateway Status Reporter
  const statusReporter = new GatewayStatusReporter({
    gatewayUrl: config.gatewayUrl,
    gatewayToken: config.gatewayToken,
    intervalMs: config.statusIntervalMs,
    ttlMs: config.statusTtlMs,
    getStatus: () => {
      const state = coordinator.getState();
      const current = coordinator.getSelectedBroadcast();
      const mappedState = state === "live" ? "live" : "offline";
      const detail = current
        ? `Broadcast: ${current.title} (${state}, health: ${coordinator.getStreamHealth()})`
        : `Idle (${state})`;
      return { state: mappedState, detail };
    },
  });

  // 6. Routes
  registerRoutes(server, {
    coordinator,
    gatewayClient,
    apiKey: config.apiKey,
  });

  const start = async () => {
    gatewayClient.start();
    statusReporter.start();
    await server.listen({ port: config.port, host: config.host });
  };

  const stop = async () => {
    statusReporter.stop();
    gatewayClient.stop();
    coordinator.stop();
    await server.close();
  };

  return {
    server,
    coordinator,
    captionPipeline,
    gatewayClient,
    statusReporter,
    start,
    stop,
  };
}
