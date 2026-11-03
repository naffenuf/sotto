import type { CandidateLogLine, DecisionLogRecord, VerificationLogRecord } from "../../shared/candidates.js";
import { Markdown } from "./MarkdownView.js";

function label(value: string): string { return value.replaceAll("_", " "); }

/** The digest without its `# Digest` line: this panel has a title of its own. */
function withoutTitle(digest: string): string {
  return digest.replace(/^#\s+Digest\s*\n+/, "").trim();
}

export function Backstage({ log, digest }: { log: CandidateLogLine[]; digest: string }) {
  const candidates = log.filter((entry) => entry.kind === "candidate");
  return <>
    {/* `digest.md` as the session wrote it (V2-018), rendered through the
        same markdown the cards use: seven `##` sections, lists and links. */}
    {digest.trim() !== "" && <section className="backstage__digest" aria-label="Session digest">
      <h2 className="panel__title">Digest</h2>
      <div className="backstage__digest-body" data-testid="digest"><Markdown source={withoutTitle(digest)} /></div>
    </section>}
    <section className="backstage" aria-label="Backstage candidates">
    <h2 className="panel__title">What Sotto considered</h2>
    <p className="backstage__intro">Candidates Sotto generated, including those it held back. An empty list means none were recorded.</p>
    {candidates.length === 0 && <p className="backstage__empty">No candidates recorded for this discussion.</p>}
    {candidates.map(({ candidate }) => {
      const decisions = log.filter((entry): entry is DecisionLogRecord => entry.kind === "decision" && entry.candidateId === candidate.id);
      const checks = log.filter((entry): entry is VerificationLogRecord => entry.kind === "verification" && entry.candidateId === candidate.id);
      const last = decisions.at(-1);
      const outcome = candidate.duplicateOf ? "Duplicate" : last ? last.decision === "interject" ? "Interjected" : last.decision === "glow" ? "Quiet card" : last.decision === "silent" ? "Held back" : "Waiting" : checks.at(-1)?.outcome === "unverified" ? "Not verified" : checks.at(-1)?.outcome === "failed" ? "Verification failed" : "No decision recorded";
      return <article className="backstage__candidate" key={candidate.id}>
        <div className="backstage__meta"><span>{label(candidate.type)}</span><strong>{outcome}</strong></div>
        <h3>{candidate.headline}</h3>
        <p>{candidate.detail}</p>
        {candidate.whyNow && <p><b>Why then:</b> {candidate.whyNow}</p>}
        {candidate.duplicateOf && <p><b>Reason:</b> duplicates {candidate.duplicateOf}</p>}
        {candidate.evidence?.map((quote, index) => <blockquote key={index}>“{quote.quote}”{quote.speaker ? ` — ${quote.speaker}` : ""}</blockquote>)}
        {checks.map((check, index) => <p key={index}><b>Fact check:</b> {label(check.outcome)}{check.verification ? ` (${check.verification.verdict})` : ""}{check.error ? ` — ${check.error}` : ""}</p>)}
        {decisions.length > 0 && <details><summary>Decision history</summary><ol>{decisions.map((decision, index) => <li key={index}>{label(decision.decision)} · {label(decision.reason)} · score {decision.score.toFixed(2)}{decision.heldForMs > 0 ? ` · waited ${(decision.heldForMs / 1000).toFixed(1)}s` : ""}</li>)}</ol></details>}
      </article>;
    })}
    </section>
  </>;
}
