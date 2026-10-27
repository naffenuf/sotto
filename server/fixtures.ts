/**
 * Which fixtures this checkout actually has, for the UI's source selector.
 *
 * A fixture only shows up as a WAV source once `make_fixture.py` has rendered
 * it, and only as an events source once `npm run capture` has recorded it, so
 * the list is read off the filesystem rather than hard-coded.
 */
import { readdirSync } from "node:fs";
import type { FixtureListResponse } from "../shared/session.js";
import { FIXTURE_EVENTS_DIR } from "./asr/EventReplaySource.js";
import { FIXTURE_AUDIO_DIR } from "./audio/WavReplaySource.js";

/** Fixture names in `dir` with the given extension, sorted. */
function stems(dir: string, extension: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // A checkout without rendered audio or captures is not an error; the
    // selector simply has fewer options.
    return [];
  }
  return entries
    .filter((name) => name.endsWith(extension))
    .map((name) => name.slice(0, -extension.length))
    .sort();
}

/** The fixture names each source kind can take. */
export function listFixtures(): FixtureListResponse {
  return {
    wav: stems(FIXTURE_AUDIO_DIR, ".wav"),
    events: stems(FIXTURE_EVENTS_DIR, ".jsonl"),
  };
}
