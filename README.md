# Sotto — the AI that knows when to speak

Sotto is a local web app that listens to a group brainstorm, keeps a living board of the
discussion, and contributes to the **whole group** only when it really matters: a contradiction
with an earlier constraint, a factual error, an untested assumption, a dropped thread. It scores
each candidate and chooses to stay silent, glow quietly, or interject — only at a natural pause,
and rarely. It also answers when addressed by wake phrase ("Sotto, what do competitors charge?").

This repo was built during the **Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026)**.

Full spec: [`tasks/prd-sotto-core.md`](tasks/prd-sotto-core.md).

## Stack

- **`server/`** — Node 22 + Fastify + `@fastify/websocket`, bound to `127.0.0.1` only. Holds the
  API key, talks to Meta's APIs, runs tools, writes session files.
- **`web/`** — React 18 + Vite browser UI.
- **`shared/`** — types used by both.
- **`fixtures/`** — scripted test conversations plus rendered audio, so every feature is testable
  without live speakers. See [`fixtures/README.md`](fixtures/README.md).

Meta APIs: `muse-voice-transcribe-1.0` for realtime diarized transcription,
`muse-spark-1.3` for board updates, interjection candidates, answers and eval judging.

## Setup

Requires Node 22+.

```sh
npm install
cp .env.example .env    # then set MODEL_API_KEY to your Meta Model API key
```

`MODEL_API_KEY` is read by the server only and never reaches the browser bundle.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Server (`127.0.0.1:8787`) and Vite (`127.0.0.1:5173`) together; Vite proxies `/api` and `/ws` to the server. Open http://127.0.0.1:5173 |
| `npm run build` | Compiles the server to `dist/server` and bundles the UI to `dist/web` |
| `npm run typecheck` | `tsc --noEmit` across `server/`, `web/` and `shared/` |
| `npm test` | Vitest unit tests. Makes no network calls |
| `npm run test:integration` | Vitest tests that call the real Meta APIs. Skipped with a message if `MODEL_API_KEY` is missing |
| `npm run fixtures:check` | Validates the fixture scripts in `fixtures/scripts/` against their rendered audio and timings |
| `npm run verify:ui` | Playwright check of the running UI; writes a screenshot. Needs `npm run dev` already up |
| `npm run verify:mic` | Playwright check of the microphone, with Chromium's fake capture device: a refused permission and a live session. Needs `npm run dev` already up |
| `npm run verify:answer` | Playwright check of the answer agent: replays `ask-search` and watches the answer card arrive. Calls the real model. Needs `npm run dev` already up |
