/**
 * The shadow run (PRD V3-016).
 *
 *   npm run shadow -- <session folder>        # a folder name under sessions/
 *   npm run shadow -- --list                  # the mic sessions worth running
 *   npm run shadow -- <folder> --frequency often --boldness bold
 *   npm run shadow -- <folder> --report       # rewrite the report, no replay
 *
 * One real conversation from `sessions/` goes back through the whole v3
 * pipeline at `max` speed, and everything Sotto would have contributed is
 * written to `tasks/shadow-<session>.md` for a person to mark up before the
 * V3-011 live checkpoint.
 *
 * It calls the real APIs: the board, the observer, the question classifier,
 * the research planner and its searches all run, so a ten-minute meeting costs
 * what ten minutes of meeting would have cost. The voice is V2-021's null sink
 * — the real ElevenLabs socket with the audio thrown away — so the lines are
 * really synthesized and nothing comes out of a speaker.
 *
 * Every run is also written to `shadow/runs/<session>.json`, so `--report`
 * rebuilds the markdown from a past run for nothing — the same split the eval
 * harness makes between a run and its report, and for the same reason: the
 * wording of a report is changed far more often than the run is worth repeating.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoldnessSchema,
  FrequencySchema,
  defaultPolicySettings,
  type PolicySettings,
} from "../shared/policy.js";
import type { SessionRecord } from "../shared/session.js";
import { loadConfig, loadSottoVoiceId } from "../server/config.js";
import { UsageMeter, estimateCostUsd, formatUsd } from "../server/eval/cost.js";
import { glimmerFromEnv } from "../server/model/GlimmerClient.js";
import { MuseClient } from "../server/model/client.js";
import { SESSION_FILES } from "../server/session/SessionStore.js";
import { renderShadowReport, shadowReportPath } from "../server/shadow/report.js";
import { SHADOW_SOURCE, runShadow, type ShadowRunRecord } from "../server/shadow/shadow.js";
import { Speaker } from "../server/voice/Speaker.js";
import { meteredVoice, nullSinkVoice } from "../server/voice/voiceOut.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const SESSIONS_DIR = join(repoRoot, "sessions");
const SHADOW_SESSIONS_DIR = join(repoRoot, "shadow/sessions");
const SHADOW_RUNS_DIR = join(repoRoot, "shadow/runs");

const USAGE = `usage: npm run shadow -- <session folder> [--frequency <f>] [--boldness <b>]
       npm run shadow -- <session folder> --report
       npm run shadow -- --list

A session folder is a name under sessions/, e.g. 2026-10-30_0919-mic.`;

interface Args {
  session?: string;
  list: boolean;
  /** Rebuild the markdown from `shadow/runs/<session>.json` and replay nothing. */
  report: boolean;
  settings: PolicySettings;
}

function parseArgs(argv: readonly string[]): Args | { error: string } {
  const args: Args = { list: false, report: false, settings: defaultPolicySettings() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--list") {
      args.list = true;
      continue;
    }
    if (arg === "--report") {
      args.report = true;
      continue;
    }
    if (arg === "--frequency" || arg === "--boldness") {
      const value = argv[index + 1] ?? "";
      index += 1;
      const parsed =
        arg === "--frequency" ? FrequencySchema.safeParse(value) : BoldnessSchema.safeParse(value);
      if (!parsed.success) return { error: `${arg}: ${value} is not one of its three values` };
      args.settings =
        arg === "--frequency"
          ? { ...args.settings, frequency: parsed.data as PolicySettings["frequency"] }
          : { ...args.settings, boldness: parsed.data as PolicySettings["boldness"] };
      continue;
    }
    if (arg.startsWith("--")) return { error: `unknown option ${arg}` };
    if (args.session !== undefined) return { error: "one session folder at a time" };
    args.session = arg;
  }
  return args;
}

/** The `mic` sessions in `sessions/` that have frames to replay, newest first. */
function micSessions(): { folder: string; turns: number; startedAt: string | null }[] {
  let folders: string[];
  try {
    folders = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  const found: { folder: string; turns: number; startedAt: string | null }[] = [];
  for (const folder of folders) {
    const record = readRecord(folder);
    if (record?.source.kind !== SHADOW_SOURCE) continue;
    found.push({
      folder,
      turns: countLines(join(SESSIONS_DIR, folder, SESSION_FILES.transcript)),
      startedAt: record.startedAt,
    });
  }
  return found.sort((a, b) => b.folder.localeCompare(a.folder));
}

function readRecord(folder: string): SessionRecord | null {
  try {
    return JSON.parse(
      readFileSync(join(SESSIONS_DIR, folder, SESSION_FILES.session), "utf8"),
    ) as SessionRecord;
  } catch {
    return null;
  }
}

function countLines(path: string): number {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "").length;
  } catch {
    return 0;
  }
}

/** The commit the report belongs to; a dirty tree gets a `+` after it. */
function gitCommit(): string | null {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return dirty === "" ? head : `${head}+`;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const sessions = micSessions();
  if (parsed.list || parsed.session === undefined) {
    if (!parsed.list) console.error(`${USAGE}\n`);
    console.log(`mic sessions in sessions/ (longest conversations are the best shadow runs):`);
    for (const one of sessions) {
      console.log(`  ${one.folder}  ${one.turns} transcript line(s)  ${one.startedAt ?? ""}`);
    }
    if (sessions.length === 0) console.log("  (none — record one with the microphone first)");
    if (!parsed.list) process.exitCode = 1;
    return;
  }

  const session = parsed.session;
  const runPath = join(SHADOW_RUNS_DIR, `${session}.json`);
  if (parsed.report) {
    let past: ShadowRunRecord;
    try {
      past = JSON.parse(readFileSync(runPath, "utf8")) as ShadowRunRecord;
    } catch {
      console.error(`no past run to report on: ${runPath} is missing or unreadable`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(join(repoRoot, shadowReportPath(session)), renderShadowReport(past));
    console.log(`[shadow] report  ${shadowReportPath(session)} (rebuilt from ${runPath})`);
    return;
  }

  const record = readRecord(session);
  if (record === null) {
    console.error(`sessions/${session} is not a session folder (no ${SESSION_FILES.session})`);
    process.exitCode = 1;
    return;
  }
  if (record.source.kind !== SHADOW_SOURCE) {
    // A `wav` or `events` folder is a fixture being played back, not a
    // conversation a group had, and shadowing one would only re-measure the
    // eval. `npm run eval` is the check for those.
    console.error(
      `sessions/${session} is a \`${record.source.kind}\` session, not a \`${SHADOW_SOURCE}\` one:` +
        ` a shadow run is about a conversation real people had.`,
    );
    process.exitCode = 1;
    return;
  }

  let apiKey: string;
  try {
    apiKey = loadConfig().modelApiKey;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const voiceKey = (process.env["ELEVENLABS_API_KEY"] ?? "").trim();
  const meter = new UsageMeter();
  // The real socket with the audio discarded (V2-021), so the speech path is
  // the live one and nothing is heard. Without a key the run still goes
  // ahead — the decisions are what the report is about — and says so.
  const voice =
    voiceKey === ""
      ? null
      : meteredVoice(
          nullSinkVoice(() => new Speaker({ apiKey: voiceKey, voiceId: loadSottoVoiceId() })),
        );
  if (voice === null) {
    console.warn(
      "[shadow] ELEVENLABS_API_KEY is missing: running with no voice, so every line" +
        " will be recorded as unheard. Add the key for a report worth marking up.",
    );
  }

  mkdirSync(SHADOW_SESSIONS_DIR, { recursive: true });
  mkdirSync(SHADOW_RUNS_DIR, { recursive: true });
  console.log(
    `[shadow] ${session}: ${record.startedAt} — replaying ${countLines(join(SESSIONS_DIR, session, SESSION_FILES.events))} frame(s)` +
      ` at max speed through the real APIs`,
  );

  const run = await runShadow({
    session,
    sessionsRoot: SESSIONS_DIR,
    sessionRoot: SHADOW_SESSIONS_DIR,
    apiKey,
    settings: parsed.settings,
    createModel: () => new MuseClient({ apiKey, onUsage: meter.record }),
    // Where judgment runs in a real session (V2-010): Glimmer on this Mac when
    // it is up, Muse Spark when it is not.
    createGlimmer: () => glimmerFromEnv(),
    ...(voice === null ? {} : { createVoice: () => voice }),
  });
  run.gitCommit = gitCommit();

  writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(repoRoot, shadowReportPath(session)), renderShadowReport(run));

  if (run.error !== undefined) {
    console.error(`[shadow] the replay failed: ${run.error}`);
    process.exitCode = 1;
  }
  const said = run.spoken.filter((one) => one.record.spoken).length;
  console.log(
    `[shadow] ${run.finalTurns} turn(s), ${run.questions.length} classification(s), ` +
      `${run.spoken.length} unprompted line(s) (${said} said), ${run.cards.length} card(s), ` +
      `${run.suppressed.length} held back`,
  );
  console.log(
    `[shadow] ${meter.total().calls} model call(s), about ${formatUsd(estimateCostUsd(meter.total()))}` +
      (voice === null ? "" : `, ${voice.spent().characters} character(s) of speech`),
  );
  console.log(`[shadow] report  ${shadowReportPath(session)}`);
  console.log(`[shadow] run     ${runPath}`);
  console.log(`[shadow] session ${run.sessionDir ?? "none"}`);
}

await main();
