/**
 * Schema for the scripted test conversations in `fixtures/`.
 *
 * A script (`fixtures/scripts/<name>.json`) is the source of truth: it drives
 * `fixtures/make_fixture.py`, which renders `fixtures/audio/<name>.wav` plus
 * `fixtures/audio/<name>.timing.json`, and it carries the planted moments the
 * eval harness measures Sotto against.
 *
 * All line references are 0-based indexes into `lines`.
 */
import { z } from "zod";

/** The kinds of thing Sotto is expected to notice. */
export const momentTypes = [
  "contradiction",
  "factual_error",
  "untested_assumption",
  "dropped_thread",
] as const;

/** Levels a planted moment can expect; `silent` is never an expectation. */
export const expectedLevels = ["glow", "interject"] as const;

const lineIndex = z.number().int().min(0);

/** One continuous utterance by one speaker, followed by a pause. */
export const FixtureLineSchema = z.object({
  speaker: z.enum(["A", "B"]),
  text: z.string().trim().min(1),
  /** Silence inserted after this line, in milliseconds. */
  pauseAfterMs: z.number().int().min(0).max(10_000),
});

/** A question addressed to Sotto by wake phrase, spoken in `line`. */
export const WakeQuestionSchema = z.object({
  line: lineIndex,
  question: z.string().trim().min(1),
});

/** A situation written into a script that Sotto should catch. */
export const PlantedMomentSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(momentTypes),
  /** Lines that set the moment up (e.g. where the constraint was stated). */
  setupLines: z.array(lineIndex).min(1),
  /** The line that makes the moment live; a catch only counts after it ends. */
  triggerLine: lineIndex,
  /** The last line a catch can land on and still count. */
  deadlineLine: lineIndex,
  expectedLevel: z.enum(expectedLevels),
  description: z.string().trim().min(1),
});

/**
 * A scripted conversation. The cross-field checks (indexes in range,
 * `setupLines` < `triggerLine` <= `deadlineLine`, unique moment ids) run here
 * so every reader gets them, not just `npm run fixtures:check`.
 */
export const FixtureScriptSchema = z
  .object({
    lines: z.array(FixtureLineSchema).min(1),
    wakeQuestions: z.array(WakeQuestionSchema).default([]),
    moments: z.array(PlantedMomentSchema).default([]),
  })
  .superRefine((script, ctx) => {
    const lastLine = script.lines.length - 1;
    const inRange = (index: number) => index <= lastLine;

    script.wakeQuestions.forEach((wake, i) => {
      if (!inRange(wake.line)) {
        ctx.addIssue({
          code: "custom",
          path: ["wakeQuestions", i, "line"],
          message: `line ${wake.line} does not exist (last line is ${lastLine})`,
        });
      }
    });

    const seenIds = new Set<string>();
    script.moments.forEach((moment, i) => {
      const at = (field: string, index?: number) =>
        index === undefined ? ["moments", i, field] : ["moments", i, field, index];

      if (seenIds.has(moment.id)) {
        ctx.addIssue({
          code: "custom",
          path: at("id"),
          message: `duplicate moment id ${JSON.stringify(moment.id)}`,
        });
      }
      seenIds.add(moment.id);

      moment.setupLines.forEach((setupLine, j) => {
        if (!inRange(setupLine)) {
          ctx.addIssue({
            code: "custom",
            path: at("setupLines", j),
            message: `line ${setupLine} does not exist (last line is ${lastLine})`,
          });
        } else if (setupLine >= moment.triggerLine) {
          ctx.addIssue({
            code: "custom",
            path: at("setupLines", j),
            message: `setup line ${setupLine} must come before triggerLine ${moment.triggerLine}`,
          });
        }
      });

      if (!inRange(moment.triggerLine)) {
        ctx.addIssue({
          code: "custom",
          path: at("triggerLine"),
          message: `line ${moment.triggerLine} does not exist (last line is ${lastLine})`,
        });
      }
      if (!inRange(moment.deadlineLine)) {
        ctx.addIssue({
          code: "custom",
          path: at("deadlineLine"),
          message: `line ${moment.deadlineLine} does not exist (last line is ${lastLine})`,
        });
      }
      if (moment.deadlineLine < moment.triggerLine) {
        ctx.addIssue({
          code: "custom",
          path: at("deadlineLine"),
          message: `deadlineLine ${moment.deadlineLine} must be at or after triggerLine ${moment.triggerLine}`,
        });
      }
    });
  });

/** Audio produced by `make_fixture.py` is always mono 16-bit PCM at this rate. */
export const FIXTURE_SAMPLE_RATE = 24_000;

/** Where each line landed in the rendered WAV. */
export const FixtureTimingSchema = z.object({
  name: z.string().trim().min(1),
  sampleRate: z.literal(FIXTURE_SAMPLE_RATE),
  durationMs: z.number().int().min(0),
  lines: z
    .array(
      z.object({
        index: lineIndex,
        speaker: z.enum(["A", "B"]),
        startMs: z.number().int().min(0),
        endMs: z.number().int().min(0),
      }),
    )
    .min(1),
});

export type MomentType = (typeof momentTypes)[number];
export type ExpectedLevel = (typeof expectedLevels)[number];
export type FixtureLine = z.infer<typeof FixtureLineSchema>;
export type WakeQuestion = z.infer<typeof WakeQuestionSchema>;
export type PlantedMoment = z.infer<typeof PlantedMomentSchema>;
export type FixtureScript = z.infer<typeof FixtureScriptSchema>;
export type FixtureTiming = z.infer<typeof FixtureTimingSchema>;
export type FixtureLineTiming = FixtureTiming["lines"][number];
