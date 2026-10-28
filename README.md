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
