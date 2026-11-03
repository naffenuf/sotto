# After the V3-011 checkpoint: sidebar and session robustness

Agreed 2026-11-01 while preparing the live checkpoint. Not ralph stories yet; do after
`tasks/checkpoint-speaking.md` is written, before the demo video.

1. ~~DONE 2026-11-01~~ **Same-speaker merge, display only.** `mergeRuns(turns)` in `shared/`, used by
   `SessionStore`'s transcript writer and `TranscriptPanel`: consecutive final turns from the
   same speaker with a short gap render as one paragraph with the first timestamp. A merged
   row carries every turn id so a cited quote still highlights. Sotto's lines break a run.
   The pipeline's turns are untouched (classifier, board cadence, expiry, `sourceTurnIds`).
2. ~~DONE 2026-11-01~~ **Stacked sidebar.** Transcript on top (flexible, scrolls, keeps "jump to live"), notes
   beneath as a collapsible section open by default, "Previous discussions" as a disclosure
   collapsed while a session runs. No tabs for the current discussion. Widen the column to
   about a third for the demo recording and check the stage.
3. ~~DONE 2026-11-01~~ **Remembered collapse states** per browser in `localStorage`.
4. ~~DONE 2026-11-01~~ **Search** box above the transcript and the notes: client-side filter, highlight, next/prev.
   Cross-discussion search is out of scope.
5. ~~DONE 2026-11-01~~ **Audio-socket grace period.** Closing `/ws/audio` currently ends the mic session
   (`socket.on("close", () => mic.endInput())` in `server/app.ts`; `MicSource.attach()` refuses
   after `inputEnded`). Hold the session ~60 s and allow a re-attach so a refresh or a sleeping
   laptop doesn't end the meeting. The hackathon-sized version of "resume"; resume from disk
   (seeding board, packets, budget, names) is post-hackathon.
