# pitube

The Pi's only YouTube connection. It monitors the broadcast, makes guarded start/stop transitions, manages broadcast config and is the caption gateway. It never touches video (the stream stays with pimatrix or the encoder), and YouTube OAuth tokens live only here.

Node >= 20, ESM. Contract: `openapi/openapi.json` (built by `node scripts/build-openapi.js`). CLI `pitube` is generated from it at run time (`pitube help`).

## What it does

1. **Monitor.** Polls the active (else next upcoming) broadcast, its bound stream health and viewers. `GET /api/v1/status` has `level`: `idle|upcoming|testing|live|unhealthy|ended`. `GET /api/v1/events` (SSE) publishes `status`, `broadcast.status`, `stream.health`, `stream.status`, `auth.health`, `monitor.error`. Polling is adaptive (15 s while testing/live, 5 min otherwise) to stay far below the 10 000 units/day quota.
2. **Guarded start/stop.** `testing` and `go-live` are refused unless YouTube reports the stream `active`; `go-live` also refuses bad health unless `force`. Ending is two calls: `end/request` returns a short-lived `confirmToken`, `end/confirm` completes.
3. **Config.** Create/update/bind broadcasts, create reusable streams (fixed key). The stream key is returned only by `GET /streams/{id}/ingest`.
4. **Caption gateway.** pivoice posts `POST /api/v1/captions {captions:[{text,timestamp?}]}`; pitube sends them with the `lcyt` sender (sequence numbers and timestamps). While the broadcast exists but is not live they are held (up to 50, 30 s) and flushed when it goes live (202); with no broadcast: 409.
5. **Token health.** `GET /api/v1/auth/health`, `POST /api/v1/auth/check` (also run daily) report `ok|revoked|refresh_failed`, sign-in age and a warning at 5 days (Google apps in testing mode lose refresh tokens after 7 days). Sign-in is the OAuth device flow: `auth-device-start` shows a URL and code, then `auth-device-poll`.

6. **Status to pigateway.** With `PITUBE_GATEWAY_URL` (and `PITUBE_GATEWAY_API_KEY`) set, every poll is pushed to `PUT /api/v1/youtube/status` as `live` (live or unhealthy), `offline` (idle, upcoming, testing, ended) or `unknown` (monitor error, not polled), with a ttl of three poll intervals so the gateway shows `unknown` if pitube stops. pilight reads it from the gateway.

## Run

```sh
npm install
YOUTUBE_CLIENT_ID=... YOUTUBE_CLIENT_SECRET=... PITUBE_API_TOKEN=... npm start
PITUBE_API_TOKEN=... bin/pitube.js status
npm test
```

Settings: `PITUBE_HOST` (127.0.0.1), `PITUBE_PORT` (3200), `PITUBE_API_TOKEN` (required unless `PITUBE_MODE=development`), `PITUBE_DATA_DIR` / `PITUBE_TOKEN_FILE` (tokens, mode 0600), `YOUTUBE_CLIENT_ID/SECRET`, `YOUTUBE_REFRESH_TOKEN` (optional), `PITUBE_BROADCAST_ID` (pin), `PITUBE_STREAM_KEY` (override), `PITUBE_POLL_ACTIVE_MS`, `PITUBE_POLL_IDLE_MS`, `PITUBE_TOKEN_WARN_DAYS`, `PITUBE_CAPTION_HOLD_MAX/MS`, `PITUBE_CONFIRM_TTL_MS`.

## Notes

- Everything here is unverified against the real YouTube API; tests use fakes.
- Intended backend was `lcyt-core`, which does not exist on npm or in live-captions-yt yet. The npm `lcyt` package supplies the caption sender; the Data API client is local (`src/youtube/api.js`) and can move behind `lcyt-core` later.
- Later: church-year titles, VOD link for Saarnavideo, chat moderation.
