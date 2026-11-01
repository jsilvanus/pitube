# pitube

YouTube lifecycle handler and live caption sender for the `pi*` stack.

`pitube` interacts with **pigateway only** within the local stack, and connects outward to Google's YouTube APIs:
1. **YouTube Data API v3**: Authenticates with OAuth 2.0 (auto-refreshing token), lists upcoming broadcasts, creates ad-hoc broadcasts, and drives lifecycle state transitions (`ready` $\rightarrow$ `testing` $\rightarrow$ `live` $\rightarrow$ `complete`).
2. **YouTube Live Caption Ingestion (`lcyt`)**: Consumes live speech-to-text transcripts from `pigateway`'s SSE event bus (`GET /api/v1/events`), synchronizes them with the mandatory 30-second live video delay, and streams timed captions via HTTP POST.
3. **Gateway Status Reporting**: Periodically reports `{ state: "live" | "offline", detail, checkedAt, ttlMs }` to `PUT /api/v1/youtube/status` on `pigateway`.

Secrets (stream keys and ingestion URLs) remain strictly isolated inside `pitube` and are never exposed over status endpoints, gateway reports, or logs.

---

## Getting Started

### Installation & Build

```bash
pnpm install
pnpm run build
pnpm test
```

### Running the Service

```bash
pnpm run dev     # tsx watch src/main.ts
# or
pnpm start       # node dist/main.js
```

---

## Configuration

Set via environment variables or a `.env` file (see `.env.example`):

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PITUBE_PORT` | HTTP port for pitube API | `3105` |
| `PITUBE_HOST` | Host address | `0.0.0.0` |
| `PITUBE_API_KEY` | Optional bearer token for mutation endpoints | *(none / open on loopback)* |
| `PITUBE_GATEWAY_URL` | Base URL of pigateway | `http://127.0.0.1:3100` |
| `PITUBE_GATEWAY_TOKEN`| Bearer token for pigateway API | *(optional)* |
| `YOUTUBE_CLIENT_ID` | Google OAuth2 Client ID | *(required for live API)* |
| `YOUTUBE_CLIENT_SECRET`| Google OAuth2 Client Secret | *(required for live API)* |
| `YOUTUBE_REFRESH_TOKEN`| Persistent Google OAuth2 Refresh Token | *(required for live API)* |
| `PITUBE_OAUTH_REDIRECT_URI` | Redirect URI registered in Google Cloud for the one-time consent | `http://localhost:<PITUBE_PORT>/oauth/callback` |
| `PITUBE_ENV_FILE` | Env file that receives `YOUTUBE_REFRESH_TOKEN` after consent | `.env` |
| `YOUTUBE_STREAM_KEY` | Optional fallback stream key | *(none)* |
| `PITUBE_STREAM_ID` | liveStream id to bind to every broadcast (list with `GET /api/v1/streams`). Without it: the stream already bound, else the first on the channel, else one is created | *(none)* |
| `PITUBE_STATE_FILE` | Keeps the caption sequence number and active broadcast id over a restart (never the stream key). Empty disables | `./pitube-state.json` |
| `PITUBE_ENCODER_URL` | piencoder base URL for `POST /api/v1/ingest/apply` (unset disables) | *(none)* |
| `PITUBE_ENCODER_TOKEN` / `PITUBE_ENCODER_UNIT` / `PITUBE_ENCODER_CHANNEL` | piencoder bearer token, encoder unit and channel (1 or 2) | *(none)* / `1` / `1` |
| `PITUBE_REQUIRE_STOP_CONFIRM` | `1` makes ending a broadcast two steps: `POST /broadcasts/stop/request` returns a `confirmToken`, then `POST /broadcasts/stop {confirmToken}`. Off until picontrol and picontrol-mcp send the token. | off |
| `PITUBE_AUTH_CHECK_MS` | Interval of the sign-in check (0 disables) | `86400000` (24 h) |
| `PITUBE_DELAY_MS` | Video delay compensation for captions | `30000` (30 s, YouTube guidance) |
| `PITUBE_STALE_CAPTION_MS`| Max age before dropping stale transcripts | `90000` (90 s) |

---

## HTTP API

- `GET /health` — Simple health check (`{ ok: true, service: "pitube" }`).
- `GET /api/v1/status` — Current service state, selected broadcast, gateway connection, and caption delivery metrics.
- `GET /api/v1/broadcasts?status=upcoming|active|completed|all` — List broadcasts on the YouTube channel (default `upcoming`).
- `POST /api/v1/broadcasts/select` — Select target broadcast (`{ "broadcastId": "<id>" | "auto" }`). `auto` only accepts a broadcast within 60 minutes of now. Stream health is polled from selection on.
- `POST /api/v1/broadcasts/create` — Create a broadcast (`{ "title": "...", "privacy": "unlisted"(default)|"public"|"private", "autoSelect": true }`).
- `POST /api/v1/broadcasts/start` — Refuses until the stream receives data. Goes ready → testing (waits for YouTube) → live and starts captions. `{ "to": "testing" }` stops at testing.
- `POST /api/v1/broadcasts/stop` — Complete the broadcast and stop captions. A failed transition is an error and keeps the selection.
- `PATCH /api/v1/broadcasts/:id` — Change `title`, `description`, `scheduledStartTime` or `privacy`.
- `POST /api/v1/broadcasts/stop/request` — Ending step 1: returns a short-lived `confirmToken`, changes nothing.
- `GET /api/v1/events` — Server-Sent Events: `status` (level changes), `broadcast.status`, `broadcast.transition`, `stream.health`, `auth.health`. `GET /status` has `level`: `idle|upcoming|testing|live|unhealthy|ended`.
- `GET /api/v1/auth/health` — Sign-in state (`unchecked|ok|revoked|refresh_failed`), never secrets. `POST /api/v1/auth/check` refreshes the token now; it also runs daily.
- `POST /api/v1/broadcasts/privacy` — `{ "privacy": "public"|"unlisted"|"private", "broadcastId"? }` (default: selected broadcast).
- `GET /api/v1/broadcasts/url?broadcastId=` — `watchUrl`, `embedUrl`, privacy, status.
- `POST /api/v1/broadcasts/thumbnail?broadcastId=` — Raw image body (`Content-Type: image/jpeg|png|gif`, max 2 MB). Uses `thumbnails.set`; the YouTube channel must be verified.
- `GET /api/v1/streams` — liveStreams with status and health. Never contains the stream key or ingestion address.
- `POST /api/v1/streams/create` — `{ "title"? }` creates a reusable RTMP stream.
- `POST /api/v1/ingest/apply` — Pushes the selected broadcast's RTMP URL and key to piencoder (`PUT /api/v1/encoder/:unit/rtmp/:channel`). The key never leaves the Pi network.
- `GET /api/v1/broadcasts/current` — Details of the active broadcast with `embedUrl` for preview player.

---

### OpenAPI and CLI
`openapi/openapi.json` is built from `scripts/build-openapi.mjs` (`pnpm run openapi`); a test checks that every documented operation is a registered route. The `pitube` CLI makes one command per operationId from that file: `pitube help`, `pitube broadcasts-update <id> --title "..."`, `pitube broadcasts-thumbnail --file cover.png`. Env: `PITUBE_URL`, `PITUBE_API_KEY`.

### Restart during a service
On start pitube looks for a broadcast that is still `live` or `testing` on YouTube, adopts it and restarts the caption sender at the sequence number saved in `PITUBE_STATE_FILE` (only if the saved broadcast id matches). Without the state file the sequence starts at 0.

## Architecture & Integration Contract

See [CONTRACT.md](CONTRACT.md) for the contract between `pitube` and `pigateway`.
See [TODO.md](TODO.md) for the task roadmap.

---

## Pi Ecosystem Integration & Status Updates

This project is an integral component of the [Pi Production Ecosystem](file:///d:/piecosystem).

> [!IMPORTANT]
> Any changes to this repository's architectural role, API routes, communication protocols, exposed ports, dependencies, or runtime status **must be documented in the central `piecosystem` coordination repository** (`docs/projects-catalog.md` and `docs/inter-service-matrix.md`).
> Always verify cross-system health with `pnpm run status` in `D:\piecosystem`.

## Getting the YouTube refresh token (one time)

pitube can fetch `YOUTUBE_REFRESH_TOKEN` itself. It needs `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` and a running pitube. The consent routes answer only requests that arrive from localhost on the Pi, so use an ssh tunnel; nothing is exposed.

1. In Google Cloud (APIs & Services > Credentials > your OAuth client, type "Web application") add the authorised redirect URI `http://localhost:3105/oauth/callback` (use the port you run pitube on). Enable the YouTube Data API v3 and add yourself as a test user if the consent screen is in testing mode.
2. On your own computer: `ssh -L 3105:localhost:3105 pi@kirkonpi.local`
3. In the browser on that computer open `http://localhost:3105/auth/youtube`, sign in with the YouTube account and approve. The scope is `https://www.googleapis.com/auth/youtube`; the request is `access_type=offline&prompt=consent`.
4. The token is written to `PITUBE_ENV_FILE` (mode 600). Under systemd, set `PITUBE_ENV_FILE` to the unit's `EnvironmentFile` (on kirkonpi `/home/pi/apps/pitube.env`); the default `./.env` is a file the service never loads as `YOUTUBE_REFRESH_TOKEN=...`. It is never logged or shown. Restart pitube to use it.

`pitube auth youtube` (`pnpm run pitube -- auth youtube`) prints these steps and the URL for the current settings. No broadcast is created or started. Not verified against real Google.
