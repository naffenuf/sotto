# Ralph iteration — Sotto

You are one iteration of an autonomous coding loop. Complete **exactly one** user story, then stop. A fresh instance handles the next one.

## Project context

Sotto is a local web app (Node server on 127.0.0.1 + React UI) that listens to a group conversation through Meta's realtime transcription, keeps a living board, and contributes when it matters. The core build (archived loop) delivered transcription, the board, on-screen interjections with an eval harness, and wake-word answers with web search and HTML artifacts. **v2** adds a voice (ElevenLabs, interruptible), background research, a local Muse Glimmer judgment gate, frequency/boldness controls and a digest.

- `tasks/prd-sotto-v2.md`: the spec for this loop. **It wins wherever it disagrees with the core PRD.**
- `tasks/prd-sotto-core.md`: the original spec, still valid where v2 doesn't change it (read its "Changes since this PRD" section too)
- `tasks/decisions.md`: decisions made after the PRDs
- `CLAUDE.md`: stack, conventions and learnings
- `fixtures/`: test conversations (scripts, audio, captured events, `events/NOTES.md` with real API event shapes)
- `ralph/prd.json`, `ralph/progress.txt`: loop state

## Your task

1. Read `ralph/prd.json` and `ralph/progress.txt`.
2. Make sure you're on the branch in `branchName`. If it doesn't exist, create it from the current branch.
3. If the working tree is dirty, a previous iteration was cut off mid-story (often by a usage limit). If the changes belong to the story you're about to do, **continue from them** rather than starting over; discard only what's broken or unrelated. Note what you found in progress.txt.
4. Pick the story with the **lowest `priority` number** where `passes` is false. If its notes say it's blocked and you can't fix the blocker, pick the next one.
5. Read the matching story in `tasks/prd-sotto-v2.md` (same ID).
6. Implement it, meeting every acceptance criterion. Match surrounding code style.
7. Run every check the criteria name:
   - `npm run typecheck`, `npm test` (unit tests, no network)
   - `npm run test:integration` for criteria marked "Integration test" (real APIs)
   - "Verify in browser using webapp-testing skill": start `npm run dev`, drive the page with Playwright, take a screenshot and look at it, then stop the dev server
   Never weaken a criterion to make it pass; if a criterion is wrong or impossible, leave `passes` false and explain in `notes`.
8. Commit all story changes as one commit: `feat: [Story ID] - [Story Title]`. Don't commit unrelated files or secrets.
9. Set the story's `passes` to true in `ralph/prd.json` (or leave false with notes), append to `ralph/progress.txt` (`[YYYY-MM-DD HH:MM] V2-0XX — completed|blocked — <one line>` plus context the next iteration needs), put durable patterns in `CLAUDE.md`, and commit: `ralph: [Story ID] bookkeeping`.
10. If every story now passes, reply with <promise>COMPLETE</promise>. Otherwise stop.

## Rules

- You run in Claude Code **auto mode** on the developer's Mac: a safety classifier reviews each action. Prefer clearly scoped, reversible commands inside this repo. Don't touch files outside the repo except tool caches, don't install system software, don't change system settings, and **never download models**. If a needed tool or service is missing, mark the story blocked with the fix in `notes`.
- **Human checkpoints:** a story with a `checkpoint` field is done by a human first. `ralph.sh` won't start it until that file exists. When you do start it, follow its acceptance criteria exactly (PASS → mark passing; FAIL → fix the listed problems, then rename the file as the criteria say so the loop stops for a retest).
- Don't use the real microphone or speakers, or anything that triggers a macOS permission prompt, in automated checks. Use WAV/event replay, Playwright's fake media flags for mic stories, and a null audio sink for speech. Note any human-only verification as pending in `notes` and progress.txt.
- ONE story per iteration. Don't add features not in the PRDs. Don't refactor unrelated code.
- `MODEL_API_KEY` and `ELEVENLABS_API_KEY` live only in `.env` (git-ignored); server and script code read them via dotenv. Never copy them into code, logs, commits, the browser bundle or other files. Never `export` or `source` `.env` into your shell.
- Unit tests (`npm test`) never call real APIs. Real calls only in `test:integration`, `capture`, `fixture:render`, `eval` and `e2e`.
- Never edit fixture scripts, moment annotations, the judge prompt or the eval scoring code to make an eval pass. (Creating NEW fixtures in V2-002 is fine.)
- API facts come from the docs (https://dev.meta.ai/docs/, https://elevenlabs.io/docs) and `fixtures/events/NOTES.md`. Check them rather than guessing, and record anything new in NOTES.md or CLAUDE.md.
- Max 3 attempts per story; if stuck, write what you tried in `notes` and move on.
