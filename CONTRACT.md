# pitube integration contract

pitube is the YouTube lifecycle handler and caption sender of the pi* stack. This file is the contract
between pitube and the rest of the system. It describes what pitube may rely on. pitube itself is not
implemented yet; another agent owns that work.

pitube talks to **pigateway only**. pigateway is the single reachable service. pitube never talks to
pivoice, liturgos-auditor or web-radio-relay directly.

```
pivoice ──UDP telemetry──► pigateway ◄── transcripts (SSE pull or HTTP push) ── liturgos-auditor
                              │
                              ├── SSE  GET /api/v1/events ──► web-radio-relay (captions for the web)
                              └── SSE  GET /api/v1/events ──► pitube (YouTube lifecycle + captions)
```

## 1. Transport: gateway SSE bus

`GET {PIGATEWAY}/api/v1/events` is `text/event-stream`. Events pitube cares about:

| `event:`            | `id:`            | `data:` (JSON)                                      |
|---------------------|------------------|-----------------------------------------------------|
| `ready`             | none             | `{ "status": "connected", "time": ISO }`            |
| `transcript`        | `<epoch>:<seq>`  | a **transcript event**, defined below               |
| `pivoice`           | none             | capture telemetry (classification, meter, state)    |
| `pivoice-activity`  | none             | session state: `closed/starting/open/stopping/error`|
| `youtube`           | none             | pigateway's own YouTube state (separate concern)    |

A comment line `: keep-alive` arrives every 15 s. Treat 45 s of silence as a dead connection and
reconnect.

Query parameter `?types=transcript,pivoice-activity` limits the stream to the named event types.
`ready` is always sent.

### Reconnecting and replay

- Send `Last-Event-ID: <epoch>:<seq>` on reconnect. pigateway replays buffered transcripts newer than
  that id, then continues live.
- `epoch` identifies one pigateway process run. If the epoch in your `Last-Event-ID` differs from the
  current one (the gateway restarted), nothing is replayed and `seq` starts over. Treat a new epoch as
  a fresh stream and do not assume anything about the numbers.
- The gateway keeps only a bounded window (default the latest 500 transcripts). Anything older is gone.
  A consumer that was offline longer than the window misses captions. That is acceptable for live
  captions; do not replay stale captions to YouTube.
- Catch-up without SSE: `GET {PIGATEWAY}/api/v1/transcripts?after=<epoch>:<seq>&limit=200`
  returns `{ "epoch": "...", "transcripts": [ ... ] }`.

## 2. Transcript event

```json
{
  "epoch": "k3j2h1",
  "seq": 42,
  "session": "live_9f2c",
  "language": "fi",
  "text": "Herra olkoon teidän kanssanne.",
  "startedAt": 1761666000123,
  "endedAt": 1761666002456,
  "source": "auditor"
}
```

- `startedAt` / `endedAt` are **epoch milliseconds of the spoken audio** (wall clock of the capture,
  anchored at pivoice and carried through liturgos-auditor). They are not the time the transcript was
  produced and not the time it reached the gateway.
- `text` is non-empty and at most 500 characters.
- `seq` increases by 1 for every accepted transcript within one `epoch`. Duplicates from the STT engine
  (same session and engine sequence) are dropped by the gateway before they get a `seq`.
- Transcripts are final. There are no interim or revised transcripts.

## 3. What pitube must do with them

1. **Delay.** The video YouTube receives is behind live. A caption must be sent with a timestamp that
   matches the video. Send each caption stamped with `startedAt + youtubeDelayMs`, where
   `youtubeDelayMs` is pitube configuration. pitube must not shift the audio clock in any other way.
2. **Drop stale captions.** If a transcript's `endedAt` is older than a configured maximum age (default
   60 s) when pitube is ready to send it, drop it and count it. Never replay old captions as if live.
3. **Batching and sending.** Use the `lcyt` core from `jsilvanus/live-captions-yt` (package `lcyt`,
   `packages/lcyt`). It provides batching, sequence handling and the sync offset. Do not reimplement
   them. The YouTube caption ingestion URL contains the stream key.
4. **Secrets.** The stream key and ingestion URL never leave pitube: not in logs, not in status output,
   not back to the gateway. Redact them in error messages.
5. **Ordering.** Captions go out in `seq` order within an epoch.
6. **Lifecycle.** pitube decides when it sends. It may use `pivoice-activity` and `youtube` events and
   its own YouTube broadcast state as input. Transcripts arriving while pitube is not in a sending
   state are discarded, not queued.

## 4. What pitube must not assume

- That the gateway has any caption for a given moment. Silence and music produce no transcripts.
- That `startedAt` values are strictly increasing. Two transcripts may overlap slightly.
- That the same transcript is never delivered twice across a reconnect with a changed epoch. Compare
  `(session, text, startedAt)` if exact de-duplication matters.
- That the gateway is trustworthy about the clock. Captions with `startedAt` more than 5 minutes in the
  future or 24 hours in the past should be dropped.

## 5. Authentication

The gateway is exposed through a forwarded port with its own authentication in front of it. pitube
sends `Authorization: Bearer <token>` on every request. The token is pitube configuration
(`PITUBE_GATEWAY_URL`, `PITUBE_GATEWAY_TOKEN`).

## 6. Open items for the pitube owner

- The YouTube session lifecycle (create broadcast, go live, end, recover) and where its state lives.
- Exposing a small status endpoint that the gateway can show (sending, dropped, last error, never the
  stream key).
- Whether pitube reports its YouTube state back to the gateway's `youtube` event. If so, the contract
  for that direction needs adding here.
