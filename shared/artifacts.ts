/**
 * HTML the model drew, on its way to the stage (PRD US-020).
 *
 * An answer is prose, but some answers are not sentences: a user flow, a
 * comparison table, a screen mockup. For those the answer agent offers the
 * model one function tool, {@link SHOW_HTML_TOOL}, whose argument is a
 * complete self-contained HTML document. The server writes it into the
 * session folder and the card renders it in a sandboxed iframe.
 *
 * Nothing here trusts the HTML. It is never parsed, rewritten or inspected
 * for external references — it is written to disk verbatim and served with
 * {@link ARTIFACT_CSP} into an iframe with no `allow-same-origin`, which is
 * what actually stops it reaching the network or the page around it. "Self
 * contained" is therefore a request in the prompt and a guarantee in the
 * headers, not a claim about the bytes.
 */
import { z } from "zod";
import type { CardArtifact } from "./cards.js";

/** The function tool's name, as the model sees it. */
export const SHOW_HTML_TOOL = "show_html";

/** Characters of title. It labels a frame, it does not explain it. */
export const ARTIFACT_TITLE_MAX_CHARS = 60;

/**
 * Bytes of HTML one artifact may be.
 *
 * Measured against the real model: a user-flow diagram with inline CSS and
 * SVG came back at 5.9–6.7 kB. 256 kB is room for something far more
 * elaborate and still small enough that a runaway reply is caught here rather
 * than in the session folder.
 */
export const ARTIFACT_HTML_MAX_BYTES = 256 * 1024;

/**
 * The header an artifact is served with, exactly as the PRD specifies it.
 *
 * `default-src 'none'` is the load-bearing part: no fetches, no fonts, no
 * frames, no images except `data:` ones the document carries itself. Inline
 * style and script are allowed because an artifact is *all* inline — and they
 * are harmless, since the iframe has no `allow-same-origin` and so no access
 * to this origin's storage, cookies or DOM.
 */
export const ARTIFACT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

/**
 * A name {@link artifactFileName} could have produced, and nothing else.
 *
 * The route reads a file name out of a URL, so this is a gate rather than a
 * description: no path separators, no leading dot, nothing but the characters
 * a slug is made of.
 */
export const ARTIFACT_FILE_PATTERN = /^[0-9]{2,}-[a-z0-9][a-z0-9-]*\.html$/;

/** One artifact, as the server records it. */
export interface Artifact extends CardArtifact {
  /** Where it was written, relative to the session folder. */
  path: string;
}

/**
 * The arguments of one {@link SHOW_HTML_TOOL} call.
 *
 * Validated by the answer agent, not by the model API: a strict function
 * schema makes the *shape* reliable, and nothing makes the contents so. A
 * title longer than a label is clipped rather than rejected, the same way an
 * observer candidate's headline is — losing a diagram over a long caption
 * would be absurd.
 */
export const ShowHtmlArgsSchema = z.object({
  title: z
    .string()
    .transform((title) => clipChars(title.replace(/\s+/g, " ").trim(), ARTIFACT_TITLE_MAX_CHARS)),
  html: z.string().trim().min(1).max(ARTIFACT_HTML_MAX_BYTES),
});
export type ShowHtmlArgs = z.infer<typeof ShowHtmlArgsSchema>;

/**
 * The function tool's parameter schema, in the subset strict function calling
 * accepts: a closed object, every property required, no length keywords.
 *
 * Written by hand next to {@link ShowHtmlArgsSchema} for the same reason
 * `boardOpsJsonSchema` is: `z.toJSONSchema` emits keywords strict mode
 * rejects. `shared/artifacts.test.ts` keeps the two in step. The limits the
 * model should respect live in the `description`s, where they are advice the
 * model reads rather than a validation error nobody sees.
 */
export const showHtmlJsonSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      description:
        "A short label for the frame, at most 60 characters. 'User flow', not 'Here is the user flow you asked for'.",
    },
    html: {
      type: "string",
      description:
        "A complete self-contained HTML document: doctype, inline <style>, inline SVG or <div> layout, inline <script> only if it is needed. No external requests of any kind — no stylesheet links, no fonts, no script tags with a src, no remote images. Images must be inline SVG or data: URLs. It is rendered in a sandboxed frame about 600 px wide on a dark page, so size it to fit and pick its own colours.",
    },
  },
  required: ["title", "html"],
  additionalProperties: false,
} as const;

/** `01-user-flow.html`: the `<nn>-<slug>.html` the PRD asks for. */
export function artifactFileName(index: number, title: string): string {
  const number = String(Math.max(1, Math.trunc(index))).padStart(2, "0");
  return `${number}-${artifactSlug(title)}.html`;
}

/** A title as a file-name slug: lowercase, dashed, never empty. */
export function artifactSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "artifact" : slug;
}

/** Where a browser reads one artifact. */
export function artifactUrl(sessionId: string, fileName: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(fileName)}`;
}

/** `text`, cut to `max` characters at a word boundary with an ellipsis. */
function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
