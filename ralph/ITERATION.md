# Ralph iteration — Sotto

You are one iteration of an autonomous coding loop. Complete **exactly one** user story, then stop. A fresh instance handles the next one.

## Project context

Sotto is a local web app (Node server on 127.0.0.1 + React UI) that listens to a group brainstorm through Meta's realtime transcription, keeps a living board, and contributes only when it matters: scored, pause-timed interjections measured by an eval harness, plus wake-word answers with web search and HTML artifacts.

- `tasks/prd-sotto-core.md`: full spec (story titles reference the PRD story, e.g. "PRD US-012")
- `CLAUDE.md`: stack, conventions and learnings
- `fixtures/`: test conversations (scripts, audio, captured events, `events/NOTES.md` with real API event shapes)
- `ralph/prd.json`, `ralph/progress.txt`: loop state

## Your task

1. Read `ralph/prd.json` and `ralph/progress.txt`.
2. Make sure you're on the branch in `branchName`. If it doesn't exist, create it from the current branch.
3. If the working tree is dirty, a previous iteration was cut off mid-story (often by a usage limit). If the changes belong to the story you're about to do, **continue from them** rather than starting over; discard only what's broken or unrelated. Note what you found in progress.txt.
4. Pick the story with the **lowest `priority` number** where `passes` is false. If its notes say it's blocked and you can't fix the blocker, pick the next one.
5. Read the matching PRD section in `tasks/prd-sotto-core.md`.
6. Implement it, meeting every acceptance criterion. Match surrounding code style.
7. Run every check the criteria name:
   - `npm run typecheck`, `npm test` (unit tests, no network)
   - `npm run test:integration` for criteria marked "Integration test" (real Meta APIs)
   - "Verify in browser using webapp-testing skill": start `npm run dev`, drive the page with Playwright, take a screenshot and look at it, then stop the dev server
   - Fixture audio: `~/Developer/Chatterbox/venv/bin/python fixtures/make_fixture.py <script>`
   Never weaken a criterion to make it pass; if a criterion is wrong or impossible, leave `passes` false and explain in `notes`.
8. Commit all story changes as one commit: `feat: [Story ID] - [Story Title]`. Don't commit unrelated files or secrets.
9. Set the story's `passes` to true in `ralph/prd.json` (or leave false with notes), append to `ralph/progress.txt` (`[YYYY-MM-DD HH:MM] US-0XX — completed|blocked — <one line>` plus context the next iteration needs), put durable patterns in `CLAUDE.md`, and commit: `ralph: [Story ID] bookkeeping`.
10. If every story now passes, reply with <promise>COMPLETE</promise>. Otherwise stop.

## Rules

- You run in Claude Code **auto mode** on the developer's Mac: a safety classifier reviews each action. Prefer clearly scoped, reversible commands inside this repo. Don't touch files outside the repo except tool caches and running the Chatterbox venv's python, don't install system software, don't change system settings. If a needed tool is missing, mark the story blocked with the install command in `notes`.
- Don't use the real microphone or anything that triggers a macOS permission prompt in automated checks; use WAV/event replay, and Playwright's fake media flags for mic stories. Note any human-only verification as pending in `notes` and progress.txt.
- ONE story per iteration. Don't add features not in the PRD. Don't refactor unrelated code.
- `MODEL_API_KEY` lives only in `.env` (git-ignored); the server reads it via dotenv. Never copy it into code, logs, commits, the browser bundle or other files. Never `export` or `source` `.env` into your shell.
- Unit tests (`npm test`) never call real APIs. Real calls only in `test:integration`, `capture`, `eval` and `e2e`.
- Never edit fixture scripts, moment annotations, the judge prompt or the eval scoring code to make an eval pass.
- Meta API facts (endpoints, event shapes, model IDs) come from https://dev.meta.ai/docs/ and `fixtures/events/NOTES.md`. Check them rather than guessing, and record anything new in NOTES.md.
- Max 3 attempts per story; if stuck, write what you tried in `notes` and move on.
