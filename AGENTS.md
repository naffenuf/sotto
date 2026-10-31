# AGENTS.md — Codex working on Sotto

Codex picks up stories while the Claude Ralph loop is paused for usage limits. Both agents
work from the same loop state, so each one's work has to look like the other's. **Your
instructions are `ralph/ITERATION.md`. Follow it exactly**, with the additions and
translations below. `CLAUDE.md` holds the project's conventions and learnings; read it too.

## Before you start

- **Never run alongside the Ralph loop.** If `pgrep -f ralph/ralph.sh` finds anything, stop
  and say so. That includes a loop sleeping off a usage limit: it will wake up and start
  editing. The developer stops it (Ctrl-C) before handing over to you.
- **A dirty tree is normal at handover.** It means Claude hit its limit partway through a story.
  Follow ITERATION.md step 3: work out which story the changes belong to (usually the
  lowest-priority failing one), continue from them rather than starting over, and say in
  progress.txt what you found.
- Do **one** story: the lowest-`priority` story in `ralph/prd.json` with `passes: false`.
  If it has a `checkpoint` field and that file doesn't exist, **stop**: it's a human checkpoint.
- If a dev server is already listening on 5173/8787, it's the developer's. Use it, don't kill it.
  If you start one, stop it when you're done.

## Translations from ITERATION.md

- "auto mode" and "webapp-testing skill" are Claude Code terms. For browser verification,
  write or extend a Playwright script in `scripts/verify-*.mjs` (see `scripts/verify-voice.mjs`).
  Run it against `npm run dev`, take a screenshot and look at it.
- Real network calls (Meta Model API, ElevenLabs) are allowed only where ITERATION.md allows them.

## Code style: what review keeps fixing

Match the surrounding code. In practice that means:

- **Every new file opens with a doc comment** saying what it is, which story it serves, and
  *why* it is shaped the way it is. Models: `server/voice/Speaker.ts`,
  `web/src/audio/micCapture.ts`, `server/voice/VoiceHub.ts`.
- Exported classes, functions and non-obvious fields get a `/** ... */` comment. Comments
  explain why, not what.
- **One statement per line.** No `{ a; b; c; }` bodies on one line. No `if (x) { ...; return; }`
  one-liners with several statements, and no long chains of `;` inside arrow functions. Keep
  lines under about 110 characters, and break JSX across lines the way neighbouring JSX is.
- Follow the file's existing patterns:
  - React handlers in `App.tsx` are `useCallback`s with the same error handling
    (`error instanceof ApiCallError ? ...`), not inline lambdas.
  - New `/ws/events` events are named, commented interfaces in `shared/events.ts`.
  - Routes in `server/app.ts` get a comment naming their story, and their responses use
    `satisfies` with the shared types.
- **Expected conditions are return values, not exceptions.** Examples: muted, nothing
  attached, nothing to do. Callers shouldn't need `try/catch` for normal operation. Throw
  for real failures.
- Tests sit next to the code (`*.test.ts`) and read as a description of the behaviour.

## Bookkeeping: the exact shape

- Two commits, as ITERATION.md says: `feat: [Story ID] - [Story Title]`, then
  `ralph: [Story ID] bookkeeping`. Leave the working tree **clean**. The next agent treats a
  dirty tree as an interrupted iteration.
- `ralph/prd.json`: change **only** that story's `passes` and `notes`, with a targeted edit.
  Don't re-serialize or reformat the file: the diff should touch that story alone.
- `ralph/progress.txt`: append one entry in the existing format. Include what the **next**
  story needs to know.
- `CLAUDE.md`: durable learnings go at the **end of `## Learnings`**, as a bullet with a
  bold lead sentence, like the others. Never put anything above the intro paragraph.
- In `notes` and progress.txt, say which agent did the story ("Codex").
