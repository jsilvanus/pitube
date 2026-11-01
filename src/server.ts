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
import { EventBus } from "./events.js";
import { StateStore } from "./state.js";
import { EncoderClient } from "./encoder/client.js";
import { registerRoutes } from "./routes.js";
import { registerYouTubeOAuthRoutes } from "./youtube/oauth.js";

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

  const events = new EventBus();
  if (ytAuth) {
    ytAuth.onHealthChange = (health) => events.publish("auth.health", { ...health });
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
    streamId: config.streamId,
    events,
    requireStopConfirm: config.requireStopConfirm,
    stateStore: new StateStore(config.stateFile),
    ...(config.encoderUrl
      ? {
          encoder: new EncoderClient({
            baseUrl: config.encoderUrl,
            token: config.encoderToken,
            unit: config.encoderUnit,
            channel: config.encoderChannel,
          }),
        }
      : {}),
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
      return {
        state: mappedState,
        detail,
        broadcastId: current?.id ?? null,
        title: current?.title ?? null,
        lifecycleState: state,
      };
    },
  });

  // 6. Routes
  registerRoutes(server, {
    coordinator,
    gatewayClient,
    apiKey: config.apiKey,
    events,
    auth: ytAuth,
  });
  registerYouTubeOAuthRoutes(server, {
    clientId: config.youtubeClientId,
    clientSecret: config.youtubeClientSecret,
    redirectUri: config.oauthRedirectUri,
    envFile: config.envFile,
  });

  let authTimer: ReturnType<typeof setInterval> | null = null;

  const start = async () => {
    await server.listen({ port: config.port, host: config.host });
    gatewayClient.start();
    statusReporter.start();
    if (ytAuth && config.authCheckIntervalMs > 0) {
      void ytAuth.check();
      authTimer = setInterval(() => void ytAuth.check(), config.authCheckIntervalMs);
      authTimer.unref?.();
    }
    // Pick up a broadcast that is still live after a restart. Failure must not stop the service.
    coordinator.recover().catch((err: unknown) => {
      console.error("[pitube] Recovery failed:", err instanceof Error ? err.message : String(err));
    });
  };

  const stop = async () => {
    if (authTimer) clearInterval(authTimer);
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
