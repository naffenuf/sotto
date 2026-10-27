# CLAUDE.md

Sotto: a local web app that listens to a group brainstorm and contributes only when it matters. Built during the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026). Full spec: `tasks/prd-sotto-core.md`. Loop state: `ralph/prd.json`, `ralph/progress.txt`.

## Stack

Node 22 + TypeScript (strict), Fastify + `@fastify/websocket` in `server/`, React 18 + Vite in `web/`, shared types in `shared/`, Vitest. Meta Model API via the `openai` SDK with `baseURL: "https://api.meta.ai/v1"` and `MODEL_API_KEY` from `.env` (server only).

## Conventions

- All time-based server code uses the injected `Clock`, never `Date.now()`.
- Model prompts live in `server/prompts/*.md`.
- Model output is validated with zod.
- `npm test` makes no network calls; real-API tests go in `test:integration`.

## Learnings

(Iterations append durable patterns and gotchas here.)

- **`muse-spark-1.3` is a reasoning model.** It spends completion tokens on hidden reasoning before
  emitting any text, so `max_tokens` is a budget for *reasoning + output*. A trivial prompt
  ("Reply with exactly: PONG") still burned ~150–210 `usage.completion_tokens_details.reasoning_tokens`.
  Too small a budget returns `finish_reason: "length"` with `message.content: null` and **no error** —
  so always check `finish_reason === "stop"` before trusting the content. Budget generously
  (512+ for short answers, more for structured output). `reasoning_effort` (`low`/`medium`/`high`) is
  accepted but did not meaningfully move reasoning-token count on a trivial prompt.
- **Server wiring.** `server/config.ts` owns `HOST` (`127.0.0.1`, never anything else), `DEFAULT_PORT`
  (8787) and `loadConfig()`, which throws `MissingApiKeyError` when `MODEL_API_KEY` is blank.
  `server/app.ts` exports `buildApp()` (routes only, no socket) so tests use `app.inject()`;
  `server/index.ts` is the only place that listens and exits.
- **Browser verification.** Playwright is a devDependency; `npm run verify:ui` drives the running UI.
  Drive it with the webapp-testing helper, which starts and stops the dev server:
  `python3 ~/.claude/skills/webapp-testing/scripts/with_server.py --server "npm run dev" --port 5173 -- node scripts/verify-ui.mjs /tmp/shot.png`.
  The helper runs the command from the repo root, so Playwright scripts must live in the repo.
- **Integration-test skip message.** Per-file `console.log` is swallowed when Vitest skips the file.
  The "MODEL_API_KEY is missing" notice is printed from a `globalSetup`
  (`server/test/integrationSetup.ts`), which runs outside that capture.
- **Generating fixture audio.** `~/Developer/Chatterbox/venv/bin/python fixtures/make_fixture.py
  fixtures/scripts/<name>.json --device mps`. Without `--device mps` it falls back per
  `pick_device`, which already prefers MPS, so the flag is just explicit. It runs at roughly
  **2.5x real time** (a 2-minute fixture takes ~13 min wall clock), so start the render early and
  do other checks while it works — and don't pipe it through `tail`, which buffers the whole run
  and hides progress. For script length, speech runs at **~3.8 words/second**:
  `words / 3.8 + sum(pauseAfterMs) / 1000` predicts the rendered duration within a second or two.
- **Fixture invariants live in the schema, not the checker.** `FixtureScriptSchema` in
  `shared/fixtures.ts` carries the cross-field rules (`setupLines` < `triggerLine` <=
  `deadlineLine`, line indexes in range, unique moment ids) in a `superRefine`, so every reader
  gets them. `scripts/check-fixtures.ts` (`npm run fixtures:check`) adds only what needs the
  filesystem: WAV format and timing/script agreement. Add new script rules to the schema.
