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
npm install
npm run build
npm test
```

### Running the Service

```bash
npm run dev     # tsx watch src/main.ts
# or
npm start       # node dist/main.js
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
| `PITUBE_DELAY_MS` | Video delay compensation for captions | `30000` (30 s, YouTube guidance) |
| `PITUBE_STALE_CAPTION_MS`| Max age before dropping stale transcripts | `90000` (90 s) |

---

## HTTP API

- `GET /health` — Simple health check (`{ ok: true, service: "pitube" }`).
- `GET /api/v1/status` — Current service state, selected broadcast, gateway connection, and caption delivery metrics.
- `GET /api/v1/broadcasts` — List upcoming broadcasts on the YouTube channel.
- `POST /api/v1/broadcasts/select` — Select target broadcast (`{ "broadcastId": "<id>" | "auto" }`).
- `POST /api/v1/broadcasts/create` — Create an ad-hoc broadcast (`{ "title": "...", "privacy": "public"|"unlisted"|"private" }`).
- `POST /api/v1/broadcasts/start` — Transition broadcast to live and activate caption sender.
- `POST /api/v1/broadcasts/stop` — Complete broadcast and stop caption sender.
- `GET /api/v1/broadcasts/current` — Details of the active broadcast with `embedUrl` for preview player.

---

## Architecture & Integration Contract

See [CONTRACT.md](CONTRACT.md) for the contract between `pitube` and `pigateway`.
See [TODO.md](TODO.md) for the task roadmap.

---

## Pi Ecosystem Integration & Status Updates

This project is an integral component of the [Pi Production Ecosystem](file:///d:/piecosystem).

> [!IMPORTANT]
> Any changes to this repository's architectural role, API routes, communication protocols, exposed ports, dependencies, or runtime status **must be documented in the central `piecosystem` coordination repository** (`docs/projects-catalog.md` and `docs/inter-service-matrix.md`).
> Always verify cross-system health with `npm run status` in `D:\piecosystem`.

## Getting the YouTube refresh token (one time)

pitube can fetch `YOUTUBE_REFRESH_TOKEN` itself. It needs `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET` and a running pitube. The consent routes answer only requests that arrive from localhost on the Pi, so use an ssh tunnel; nothing is exposed.

1. In Google Cloud (APIs & Services > Credentials > your OAuth client, type "Web application") add the authorised redirect URI `http://localhost:3105/oauth/callback` (use the port you run pitube on). Enable the YouTube Data API v3 and add yourself as a test user if the consent screen is in testing mode.
2. On your own computer: `ssh -L 3105:localhost:3105 pi@kirkonpi.local`
3. In the browser on that computer open `http://localhost:3105/auth/youtube`, sign in with the YouTube account and approve. The scope is `https://www.googleapis.com/auth/youtube`; the request is `access_type=offline&prompt=consent`.
4. The token is written to `PITUBE_ENV_FILE` (mode 600). Under systemd, set `PITUBE_ENV_FILE` to the unit's `EnvironmentFile` (on kirkonpi `/home/pi/apps/pitube.env`); the default `./.env` is a file the service never loads as `YOUTUBE_REFRESH_TOKEN=...`. It is never logged or shown. Restart pitube to use it.

`pitube auth youtube` (`npm run pitube -- auth youtube`) prints these steps and the URL for the current settings. No broadcast is created or started. Not verified against real Google.
