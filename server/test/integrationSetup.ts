import { config as loadDotenv } from "dotenv";

/**
 * Runs once before the integration suite, outside Vitest's per-file console
 * capture, so the "no key" messages are always visible.
 */
export default function setup(): void {
  loadDotenv({ quiet: true });
  if ((process.env.MODEL_API_KEY ?? "").trim() === "") {
    process.stderr.write(
      "\nSkipping integration tests: MODEL_API_KEY is missing.\n" +
        "These tests call the real Meta APIs. Copy .env.example to .env and set\n" +
        "MODEL_API_KEY to your Meta Model API key, then rerun npm run test:integration.\n\n",
    );
  }
  if ((process.env.ELEVENLABS_API_KEY ?? "").trim() === "") {
    process.stderr.write(
      "\nSkipping the voice integration tests: ELEVENLABS_API_KEY is missing.\n" +
        "Set it in .env to cover fixture rendering and Sotto's voice.\n\n",
    );
  }
}
