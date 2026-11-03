/**
 * `/dev/cards`: every card variant and state, with sample data (US-011).
 *
 * The real stage only shows what a conversation happens to produce, and a
 * model will not reliably produce an error, a thinking card or a two-minute-old
 * glow on demand. This page is where those states are looked at — and what the
 * Playwright check (`npm run verify:cards`) drives, so the layout is checked
 * against the real component rather than a mock of it.
 */
import { useRef } from "react";
import { Card } from "./Card.js";
import { Now } from "./Now.js";
import { useRaisedHand } from "./RaisedHand.js";
import { Stage } from "./Stage.js";
import { QUIET_TRAY_MS, type StageCardView } from "./stageView.js";
import type { StageCard } from "../../shared/index.js";
import {
  RESEARCH_CONFIRMED_NOTE,
  RESEARCH_DISAGREES_NOTE,
} from "../../shared/research.js";

const DETAIL_MD = `Three vendors publish a **per-seat** price, and all three bundle analytics
into the top tier:

- Notely charges $14 a month, with a 2-seat minimum
- Huddleboard is $11, but analytics is a $4 add-on
- Scratchpad is free for two people, then $18

The cheapest *comparable* bundle is therefore about $15 a seat. See the
[pricing comparison](https://example.com/pricing) for the full table, or run
\`npm run pricing\` on the sheet we exported.`;

/** What Sotto said out loud for the same answer, behind "transcript of answer". */
const SPOKEN_TEXT =
  "Three of them publish a per-seat price, and they sit between eleven and" +
  " eighteen dollars. Notely is fourteen a month with a two-seat minimum," +
  " Huddleboard is eleven but charges four more for analytics, and Scratchpad" +
  " is free for two people and eighteen after that. So the cheapest comparable" +
  " bundle is about fifteen a seat.";

/** The sample cards, built fresh so the glow's age is relative to this load. */
function samples(now: number): { title: string; note: string; card: StageCard }[] {
  return [
    {
      title: "answer — ready",
      note:
        "Question and asker in small text, headline ≥ 28 px, details ▾," +
        " transcript of answer ▾, numbered sources.",
      card: {
        id: "a-ready",
        variant: "answer",
        state: "ready",
        createdAtMs: now,
        question: "Sotto, what do the main competitors charge per month?",
        askedBy: "Craig",
        headline: "Competitors sit between $11 and $18 a seat, bundling analytics at the top tier",
        detailMd: DETAIL_MD,
        spokenText: SPOKEN_TEXT,
        citations: [
          { url: "https://example.com/notely-pricing", title: "Notely — Pricing" },
          { url: "https://example.com/huddleboard", title: "Huddleboard pricing and add-ons" },
          { url: "https://example.com/scratchpad", title: "Scratchpad plans" },
        ],
      },
    },
    {
      title: "answer — thinking",
      note: "Pushed the moment the wake phrase lands, before the headline exists.",
      card: {
        id: "a-thinking",
        variant: "answer",
        state: "thinking",
        createdAtMs: now,
        question: "Sotto, how many teams churned last quarter?",
        askedBy: "typed",
        headline: "",
      },
    },
    {
      title: "answer — streaming headline",
      note: "Line 1 has arrived; the detail and the sources have not.",
      card: {
        id: "a-streaming",
        variant: "answer",
        state: "thinking",
        createdAtMs: now,
        question: "Sotto, is a weekly digest enough for the trial users?",
        askedBy: "Dana",
        headline: "Weekly digests hold trial users about as well as daily ones",
      },
    },
    {
      title: "answer — error",
      note: "A muted line in place of the answer. The session keeps running.",
      card: {
        id: "a-error",
        variant: "answer",
        state: "error",
        createdAtMs: now,
        question: "Sotto, what did the 2019 report say about retention?",
        askedBy: "Craig",
        headline: "",
        message: "The search tool did not answer in time. Ask again and it will retry.",
      },
    },
    {
      title: "interject — ready",
      note:
        "Accent border, “Sotto noticed…”, a why-now line and the evidence it" +
        " rests on. Held rather than said (V3-008), so it is one of the things" +
        " the header's raised hand counts (V3-017).",
      card: {
        id: "i-ready",
        variant: "interject",
        state: "ready",
        createdAtMs: now,
        raised: true,
        headline: "A $12 solo tier does not fit the $4,000 a month floor you set",
        whyNow: "the price is about to be written down",
        detailMd:
          "At $12 a seat you need **333 paying solos** to clear the floor, which is more than\nthe whole waitlist. The team tier gets there with 40 accounts.",
        evidence: [
          {
            turnId: "s1:4",
            quote: "We can't go below four thousand a month, that's the hosting bill.",
            speaker: "Craig",
          },
          { turnId: "s1:11", quote: "So solo is twelve dollars, done.", speaker: "Dana" },
        ],
        citations: [{ url: "https://example.com/unit-economics", title: "Unit economics sheet" }],
      },
    },
    {
      title: "interject — thinking",
      note: "The fact behind it is still being verified (US-013).",
      card: {
        id: "i-thinking",
        variant: "interject",
        state: "thinking",
        createdAtMs: now,
        headline: "That churn figure may be the 2019 one",
        whyNow: "it is being used to size the discount",
        evidence: [{ turnId: "s1:19", quote: "Churn was about nine percent.", speaker: "Dana" }],
      },
    },
    {
      title: "interject — error",
      note: "Verification failed, so the claim is not made.",
      card: {
        id: "i-error",
        variant: "interject",
        state: "error",
        createdAtMs: now,
        headline: "Could not check the churn figure",
        whyNow: "it is being used to size the discount",
        message: "Web search was unavailable, so this one is left unverified.",
      },
    },
    {
      title: "glow — collapsed",
      note: "One muted line. Click it and it becomes the full card.",
      card: {
        id: "g-ready",
        variant: "glow",
        state: "ready",
        createdAtMs: now,
        raised: true,
        headline: "Nobody has said who writes the digest copy",
        whyNow: "the digest was just decided",
        detailMd: "It has come up twice and been dropped twice, both times near a decision.",
        evidence: [
          { turnId: "s1:22", quote: "We'll figure out the copy later.", speaker: "Craig" },
        ],
      },
    },
    {
      title: "glow — thinking",
      note: "Still arriving, and still only one line.",
      card: {
        id: "g-thinking",
        variant: "glow",
        state: "thinking",
        createdAtMs: now,
        headline: "",
      },
    },
    {
      title: "glow — error",
      note: "Opened, with the muted message in place of the content.",
      card: {
        id: "g-error",
        variant: "glow",
        state: "error",
        createdAtMs: now,
        headline: "A dropped thread could not be checked",
        whyNow: "the thread came up three turns ago",
        message: "The observer's call failed; this thought is incomplete.",
      },
    },
    {
      title: "research — looking it up",
      note:
        "The room wondered something aloud and Sotto is searching (V3-003):" +
        " the question on the card, a thinking indicator, and the same card" +
        " fills in when the packet is ready.",
      card: {
        id: "r-looking",
        variant: "research",
        state: "thinking",
        createdAtMs: now,
        headline: "Looking up: How long is the drive from the city to the farmhouse venue?",
      },
    },
    {
      title: "research — nothing found",
      note:
        "The search came back with nothing the group could follow up, so the" +
        " spinner stops and says so rather than turning forever (V3-003).",
      card: {
        id: "r-nothing",
        variant: "research",
        state: "error",
        createdAtMs: now,
        headline: "",
        message: "Nothing solid on the drive time.",
      },
    },
    {
      title: "research — closed",
      note:
        "What a finished background search looks like before anybody opens it" +
        " (V2-014): \u201cResearch ready: \u2026\u201d, the teaser, and no feedback buttons.",
      card: {
        id: "r-ready",
        variant: "research",
        state: "ready",
        createdAtMs: now,
        raised: true,
        headline: "Research ready: Otter, Fireflies and Granola charge $8\u201319 a seat",
        teaser:
          "All three publish per-seat pricing with a free tier, and two of them" +
          " charge extra for the features you were describing.",
        detailMd:
          "- Otter Business is $20 a seat a month, $16 billed annually\n" +
          "- Fireflies Pro is $18 a seat, with an $10 annual tier\n" +
          "- Granola is $10 a seat a month for the team plan\n" +
          "- All three keep a free tier capped at 30\u2013800 minutes a month\n" +
          "- Only Granola prices a Mac-only desktop client separately",
        citations: [
          { url: "https://example.com/otter-pricing", title: "Otter.ai — Pricing" },
          { url: "https://example.com/fireflies-pricing", title: "Fireflies.ai pricing" },
          { url: "https://example.com/granola-pricing", title: "Granola pricing" },
        ],
      },
    },
    {
      title: "research — open",
      note: "One click: the key points, the visual the search drew, and the sources.",
      card: {
        id: "r-open",
        variant: "research",
        state: "ready",
        createdAtMs: now,
        headline: "Research ready: HIPAA lets you record a clinic visit with consent",
        teaser:
          "Recording is allowed under a business associate agreement; the" +
          " recording itself counts as PHI and has to be encrypted at rest.",
        detailMd:
          "- A BAA with the clinic is required before any recording is stored\n" +
          "- Recordings are PHI: encryption at rest and in transit is mandatory\n" +
          "- Patient consent is a state-law question, not a HIPAA one",
        artifacts: [{ title: "What a BAA has to cover", url: "/dev/sample-artifact.html" }],
        citations: [
          { url: "https://example.com/hhs-baa", title: "HHS — Business Associate Contracts" },
          { url: "https://example.com/state-consent", title: "Two-party consent by state" },
        ],
      },
    },
    {
      title: "research — the room answered it first",
      note:
        "V3-004: somebody in the room answered the question before Sotto could" +
        " say what it found, so nothing was said out loud and the card carries" +
        " the verdict instead. A replay will not reliably produce either half of" +
        " this pair.",
      card: {
        id: "r-confirmed",
        variant: "research",
        state: "ready",
        createdAtMs: now,
        headline: "Research ready: The drive is two hours ten without traffic",
        note: RESEARCH_CONFIRMED_NOTE,
        teaser:
          "The quickest route is two hours ten each way, which is what EJ said" +
          " before the search came back.",
        detailMd: [
          "- Two hours ten via the motorway, outside rush hour",
          "- Two hours forty on a Thursday afternoon",
        ].join("\n"),
        citations: [{ url: "https://example.com/route", title: "Route — two hours ten" }],
      },
    },
    {
      title: "research — and it disagrees",
      note:
        "The other half: the correction goes on screen, where it can be read" +
        " twice, rather than being argued with out loud.",
      card: {
        id: "r-disagrees",
        variant: "research",
        state: "ready",
        createdAtMs: now,
        headline: "Research ready: The drive is three hours, not an hour and a half",
        note: RESEARCH_DISAGREES_NOTE,
        teaser:
          "Every route planner puts it at two hours fifty to three hours ten" +
          " each way, against the hour and a half the room was working from.",
        detailMd: [
          "- Two hours fifty via the motorway, outside rush hour",
          "- Three hours ten on a Thursday afternoon",
        ].join("\n"),
        citations: [{ url: "https://example.com/route", title: "Route — two hours fifty" }],
      },
    },
    {
      title: "research — asked for",
      note:
        "The same card once somebody says \u201cSotto, what did you find?\u201d (V2-015):" +
        " it comes to the top of the stage, opens itself and is accented while Sotto" +
        " is briefing the room on it.",
      card: {
        id: "r-forward",
        variant: "research",
        state: "ready",
        createdAtMs: now,
        forward: true,
        headline: "Research ready: Otter, Fireflies and Granola charge $8\u201319 a seat",
        teaser:
          "All three publish per-seat pricing with a free tier, and two of them" +
          " charge extra for the features you were describing.",
        detailMd:
          "- Otter Business is $20 a seat a month, $16 billed annually\n" +
          "- Fireflies Pro is $18 a seat, with an $10 annual tier\n" +
          "- Granola is $10 a seat a month for the team plan",
        citations: [
          { url: "https://example.com/otter-pricing", title: "Otter.ai — Pricing" },
          { url: "https://example.com/fireflies-pricing", title: "Fireflies.ai pricing" },
        ],
      },
    },
    {
      title: "notice — hello",
      note:
        "What a muted session shows instead of saying hello (V2-009): no label," +
        " no feedback buttons, read at talking size.",
      card: {
        id: "n-hello",
        variant: "notice",
        state: "ready",
        createdAtMs: now,
        headline:
          "Hi, I'm Sotto. I'm listening in and keeping notes, and I'll only speak up" +
          " when I think it's worth it. If you want me, just say \u201cSotto\u201d and ask." +
          " Before you get going, would you each say your name, so I know who's here?",
      },
    },
    {
      title: "notice — names",
      note: "The one nudge, shown at a pause two minutes in if a speaker is unnamed.",
      card: {
        id: "n-names",
        variant: "notice",
        state: "ready",
        createdAtMs: now,
        headline: "I'd love to know who's here",
        detailMd:
          "Say \u201cHi, I'm \u2026\u201d and I'll pick the name up, or click a speaker" +
          " label in the transcript to set it.",
      },
    },
  ];
}

export function DevCards() {
  const now = useRef(Date.now()).current;
  const cases = samples(now);

  /**
   * The stage, as a group sees it: an answer, an interjection and a fresh glow
   * stacked newest first, plus two glows already past the two-minute mark so
   * the tray is on screen rather than described.
   */
  const stageCards: StageCardView[] = [
    { ...card("i-ready", cases), id: "stage-i", receivedAtMs: now - 4_000 },
    { ...card("a-ready", cases), id: "stage-a", receivedAtMs: now - 20_000 },
    { ...card("g-ready", cases), id: "stage-g", receivedAtMs: now - 1_000 },
    { ...card("r-ready", cases), id: "stage-r", receivedAtMs: now - 9_000 },
    {
      ...card("g-ready", cases),
      id: "stage-quiet-1",
      headline: "The mobile app was dropped without a reason",
      receivedAtMs: now - QUIET_TRAY_MS - 10_000,
    },
    {
      ...card("g-ready", cases),
      id: "stage-quiet-2",
      headline: "No one has named the launch date out loud",
      receivedAtMs: now - QUIET_TRAY_MS - 90_000,
    },
  ];

  /**
   * What the policy held back (V3-016). A real conversation produces these
   * only when it produces a candidate the policy turns down, which is exactly
   * the kind of state this page exists for.
   */
  const almostSaid = [
    {
      candidateId: "cand-7",
      headline: "Nobody has said who owns the migration",
      type: "unanswered_question" as const,
      score: 0.58,
      reason: "below threshold",
    },
    {
      candidateId: "cand-9",
      headline: "Two weeks plus four is six — the hard wall is three",
      type: "contradiction" as const,
      score: 0.71,
      reason: "cooldown",
    },
  ];

  const hand = useRaisedHand(stageCards);

  return (
    <div className="dev">
      <header className="header">
        <h1 className="brand">Sotto</h1>
        <p className="dev__title">/dev/cards — every variant and state</p>
        <a className="dev__back" href="/">
          back to the app
        </a>
      </header>
      <section className="dev__section">
        <h2 className="dev__heading">On the stage</h2>
        <p className="dev__note">
          Newest on top. Glows older than two minutes have collapsed into the tray,
          and what the policy held back is collapsed under both (V3-016).
        </p>
        <div className="dev__stage" data-testid="dev-stage">
          {/* V3-017: three of the stage's cards are held and not said, and
              two more have aged into the tray; they show in Holding. */}
          <Stage
            cards={stageCards}
            almostSaid={almostSaid}
            held={hand.cards}
            opened={hand.opened}
            onSeenAll={hand.openAll}
            onOpen={(card) => hand.open(card.id)}
            now={
              <Now
                state={{ kind: "listening", named: false, inConversation: false }}
                session={{ id: "dev", source: { kind: "events", fixture: "brainstorm" }, startedAtMs: 0 }}
                turnCount={12}
                live={{ turnId: "dev:1", speaker: "A", text: "so if we open fifty tickets the Bend people alone will take", final: false, startMs: 0, endMs: null, speakerMappingUncertain: false }}
                speakers={{ A: "Craig" }}
              />
            }
          />
        </div>
      </section>
      <section className="dev__section">
        <h2 className="dev__heading">Variants and states</h2>
        <div className="dev__grid">
          {cases.map((one) => (
            <div className="dev__case" data-testid="dev-case" data-case={one.card.id} key={one.card.id}>
              <h3 className="dev__case-title">{one.title}</h3>
              <p className="dev__note">{one.note}</p>
              {/* The expanded glows are shown too, since that is a state of
                  the card a reader reaches with one click. */}
              <Card
                card={one.card}
                defaultExpanded={one.card.id === "g-error" || one.card.id === "r-open"}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function card(id: string, cases: { card: StageCard }[]): StageCard {
  const found = cases.find((one) => one.card.id === id);
  if (found === undefined) throw new Error(`no sample card ${id}`);
  return found.card;
}
