# pitube Implementation Plan & Task List

`pitube` is the dedicated YouTube lifecycle coordinator and real-time caption sender for the `pi*` stack. It talks to **`pigateway` only** and outwards to Google's YouTube APIs.

---

## Architecture Overview

```
                      ┌────────────────────────────────────────────────────────┐
                      │                         pitube                         │
                      │                                                        │
┌──────────────────┐  │   ┌───────────────────────┐   ┌──────────────────────┐ │  REST
│    pigateway     │  │   │ Lifecycle Coordinator │◄─►│ YouTube Data API v3  │◄┼───────► YouTube Data API
│                  │  │   │ - list/select/create  │   │ - OAuth2 token mgmt  │ │         (liveBroadcasts,
│ 1. Broadcast API │  │   │ - transitions         │   │ - liveBroadcasts     │ │          liveStreams)
│    (routes/proxy)├──┼──►│ - stream health       │   │ - liveStreams        │ │
│                  │  │   └──────────┬────────────┘   └──────────────────────┘ │
│                  │  │              │ (stream key in memory)                  │
│ 2. SSE Bus       │  │              ▼                                         │
│    (transcripts) ├──┼──►┌───────────────────────┐   ┌──────────────────────┐ │  HTTP POST
│                  │  │   │ Caption Pipeline      ├──►│ lcyt Core Sender     ├─┼───────► YouTube Ingestion
│                  │  │   │ - delay sync          │   │ - timed text chunking│ │         (/closedcaption)
│ 3. Status Report │  │   │ - stale drop          │   │ - sequence/retries   │ │
│    PUT /status   │◄─┼───│ - active gate         │   └──────────────────────┘ │
└──────────────────┘  │   └───────────────────────┘                            │
                      └────────────────────────────────────────────────────────┘
```

---

## 1. Core Objectives

1. **Broadcast Selection & Ad-Hoc Creation:**
   - Query upcoming scheduled YouTube broadcasts on the channel.
   - Select a target broadcast manually or automatically based on scheduled time.
   - Create ad-hoc live broadcasts on demand when no event was pre-scheduled.
   - Bind stream and retrieve RTMP ingest credentials securely.

2. **Lifecycle State Management:**
   - Manage transitions: `ready` $\rightarrow$ `testing` $\rightarrow$ `live` $\rightarrow$ `complete`.
   - Monitor stream health via YouTube Data API (`good`, `ok`, `noData`).
   - Publish live status to `pigateway` (`PUT /api/v1/youtube/status`).

3. **Live Caption Pipeline:**
   - Subscribe to `pigateway`'s SSE bus (`GET /api/v1/events?types=transcript,pivoice-activity`).
   - Sync speech timestamps with YouTube video delay (`startedAt + youtubeDelayMs`). **Note:** Defaults to 30 s (`30000 ms`) for all caption-enabled broadcasts per YouTube's live captioning guidance.
   - Drop stale/overlapping transcripts (> 90 s old or received while offline).
   - Ingest captions via `@jsilvanus/lcyt` directly to YouTube's HTTP POST caption endpoint.

4. **Security & Boundary Isolation:**
   - Stream key and ingestion URL never leave `pitube` (no leakage in status, logs, or gateway events).
   - Authenticate with `pigateway` via bearer token.

---

## 2. API Contract Specification (pitube Local API)

These routes are exposed by `pitube` (and reverse-proxied or routed by `pigateway` for operator controls):

### Broadcast Management
- `GET /api/v1/broadcasts`
  - Query parameter: `?status=upcoming|all` (default `upcoming`).
  - Returns list of upcoming broadcasts:
    ```json
    {
      "selectedId": "bc_123",
      "items": [
        {
          "id": "bc_123",
          "title": "Jumalanpalvelus 1.11.2026",
          "scheduledStartTime": "2026-11-01T10:00:00Z",
          "privacy": "public",
          "status": "ready"
        }
      ]
    }
    ```
- `POST /api/v1/broadcasts/select`
  - Payload: `{ "broadcastId": "bc_123" | "auto" }`
  - Selects broadcast and binds stream key in memory. `"auto"` chooses the nearest upcoming broadcast within $\pm 60$ minutes.
- `POST /api/v1/broadcasts/create`
  - Ad-hoc broadcast creation when not pre-created.
  - Payload:
    ```json
    {
      "title": "Jumalanpalvelus (Ad-hoc) - 2026-11-01",
      "privacy": "public",
      "description": "Suora lähetys Riihimäen Keskuskirkosta.",
      "autoSelect": true
    }
    ```
  - Creates `liveBroadcast`, creates or binds reusable `liveStream`, and immediately marks it active/prepared if `autoSelect: true`.

### Broadcast Lifecycle Control
- `POST /api/v1/broadcasts/start`
  - Moves selected broadcast from `ready` $\rightarrow$ `testing` $\rightarrow$ `live`.
  - Activates caption sending.
- `POST /api/v1/broadcasts/stop`
  - Transitions broadcast to `complete`.
  - Shuts down caption sender, updates gateway status to `offline`.
- `GET /api/v1/broadcasts/current`
  - Returns current active broadcast metadata, health, and caption metrics:
    - `broadcastId`: YouTube video ID for embedding
    - `embedUrl`: `https://www.youtube.com/embed/{broadcastId}?autoplay=1&mute=1`
    - `monitorStreamEmbedHtml`: Broadcaster preview iframe (for testing phase)
    - `state`: `ready` | `testing` | `live` | `complete`
    - (Stream key and ingestion URL are never included).

---

## 3. Implementation Tasks

### Phase 1: Project Scaffolding & Configuration
- [ ] Initialize `package.json` with ESM (`"type": "module"`), TypeScript, Node 24 target.
- [ ] Add runtime dependencies: `@jsilvanus/lcyt`, `fastify` (or Node `http`).
- [ ] Configure environment variables:
  - `PITUBE_PORT` (default: 3105)
  - `PITUBE_GATEWAY_URL` (e.g., `http://127.0.0.1:3100`)
  - `PITUBE_GATEWAY_TOKEN`
  - `YOUTUBE_CLIENT_ID`
  - `YOUTUBE_CLIENT_SECRET`
  - `YOUTUBE_REFRESH_TOKEN`
  - `PITUBE_DELAY_MS` (default: 30000 — 30 s fixed sync delay per YouTube guidance for live captioning)
  - `PITUBE_STALE_CAPTION_MS` (default: 90000 — allows for 30 s delay buffer plus grace period)

### Phase 2: YouTube API Client & Authentication
- [ ] Implement OAuth2 token refresher (exchanging `refresh_token` for cached, auto-refreshing `access_token`).
- [ ] Implement `listBroadcasts(status: string)` wrapping `youtube.liveBroadcasts.list`.
- [ ] Implement `createBroadcast(params)`:
  - Inserts `liveBroadcast` with `contentDetails.closedCaptionsType = "httpPost"`, `latencyPreference = "lowLatency"`.
  - Binds or reuses the channel's standard RTMP `liveStream`.
- [ ] Implement `transitionBroadcast(broadcastId, targetState)` (`testing`, `live`, `complete`).
- [ ] Implement `getStreamStatus(streamId)` to check ingestion health (`good`, `ok`, `noData`).

### Phase 3: Lifecycle Coordinator & State Machine
- [ ] Implement state machine: `idle` $\rightarrow$ `prepared` $\rightarrow$ `testing` $\rightarrow$ `live` $\rightarrow$ `completing` $\rightarrow$ `idle`.
- [ ] Implement smart auto-selection logic (closest upcoming within time window).
- [ ] Implement ad-hoc creation flow with sensible defaults.
- [ ] Implement periodic heartbeat reporting to `pigateway`:
  - `PUT /api/v1/youtube/status` (`{ state: "live" | "offline" | "unknown", detail, checkedAt, ttlMs }`).

### Phase 4: Gateway SSE Integration & Caption Delivery
- [ ] Implement SSE client connecting to `pigateway/api/v1/events?types=transcript,pivoice-activity`.
  - Track `epoch` and send `Last-Event-ID`.
  - Handle gateway disconnects and 45s silence timeouts.
- [ ] Integrate `@jsilvanus/lcyt` `YoutubeLiveCaptionSender`.
- [ ] Implement transcript filtering & delay:
  - Drop if not `live`.
  - Drop if transcript age $> 60$ s or clock drift anomalous.
  - Dispatch with `startedAt + youtubeDelayMs`.
- [ ] Redact stream keys from all log outputs, exceptions, and error strings.

### Phase 5: Verification & Testing
- [ ] Unit tests for transcript filtering, clock math, and delay queuing.
- [ ] Mock YouTube API tests:
  - Mock OAuth2 refresh.
  - Mock broadcast list, create, and transition flows.
  - Verify secret stream keys are never emitted in API responses or logs.
- [ ] Integration test with simulated `pigateway` SSE bus.
