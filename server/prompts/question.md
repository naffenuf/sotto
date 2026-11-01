<!-- V3-002: tell a question the room needs looked up from one it is only thinking out loud. -->
Sotto is an AI assistant listening to a meeting through speech recognition, which often drops
punctuation. It can search the web. Decide what the LATEST turn does, so Sotto knows whether to
go and look something up.

Pick exactly one kind:
- open_question: somebody asked or wondered aloud, to the room rather than to Sotto, something a
  lookup can answer — a drive time, a price, opening hours, a market size, a definition, a date, a
  number about the world. Nobody present knows it, and nobody has answered it yet.
- to_group: a question only the people in the room can answer — who is doing something, what
  somebody thinks, what happened inside this team ("who's handling food?", "did we ever sort out
  the projector?").
- rhetorical: asked to make a point, not to get an answer ("who even uses fax anymore?", "what's
  the worst that happens?", "how hard can it be?").
- decision: the group deciding or choosing something ("should we do it?", "do we go Thursday or
  Friday?", "where should it live?"). A choice between options this group owns is a decision even
  when it is phrased as a question.
- answered: a question that somebody present already answered, in this turn or the previous one
  ("how many are on the list again?" right after someone said forty-one).
- none: not a question at all, a request addressed to Sotto by name, or a *reply* to a question
  somebody else just asked — "no idea, I haven't looked at their pricing in a year" is an answer to
  the question before it, which was already noticed when it was asked. Only the turn that asks
  something is a question.

Examples of open_question:
- "Is it an hour and a half to the farmhouse? I might be remembering summer traffic."
- "What does Loom actually charge per seat these days?"
- "I have no idea whether that place is even open on a Thursday."
- "Does anyone know how big the UK market for this is?"

Examples that are NOT open_question:
- "Where do we want to start with this idea?" — decision.
- "How good does the recognition have to be before it feels like a toy?" — no source can say;
  this group has to decide what good enough means, so decision.
- "Who's handling food?" — to_group.
- "Who even reads a weekly status email anymore?" — rhetorical.
- "Sotto, what do the competitors charge?" — none: that is a request to Sotto, handled elsewhere.
- "No idea at all. I haven't looked at their pricing since last year." — none: a reply saying
  nobody present knows, to a question that has already been noticed.

For open_question: question is the thing to look up, cleaned into one plain sentence that stands
on its own without the conversation (resolve "it", "that place", "they" from the previous turns),
and topic is three to five words naming it, as it would be said out loud in "I'll check the drive
time". For every other kind, question and topic are empty.

Two more fields, for a decision only (V3-013). closing is true when the turn *settles* something
rather than weighing it: "OK, let's go with six gardens", "so we're agreed on Saturday", "let's
lock that in", "right, booking it then". It is false when the turn is still asking which way to go
("do we go Thursday or Friday?", "should we do it at all?"), when somebody is only leaning one way
("I'd probably say Saturday"), and for every kind that is not a decision. When closing is true,
decision is what was settled in a few words, as a note-taker would write it down — "six gardens,
Saturday", "May launch", "cancel the Monday meeting" — and nothing else: no lead-in, no "we
decided", no full sentence. When closing is false, decision is empty.

Examples of a closing decision:
- "OK, let's go with six gardens then." — closing, decision "six gardens".
- "So we're agreed, Saturday the fourteenth, and I'll send the invite." — closing, decision
  "Saturday the fourteenth".
- "Right, let's lock that in. Flash for the voice." — closing, decision "Flash for the voice".
- "Fine, we kill the Monday meeting and try the Friday note instead." — closing, decision "kill
  the Monday meeting, try a Friday note".

Examples that are a decision but NOT closing:
- "Do we go Thursday or Friday?" — the question is still open.
- "Should we even do six gardens, or start with two?" — still weighing it.
- "I think Saturday works better for me, personally." — one person leaning, nothing settled.
- "We could lock it in now, or wait for Alex." — still weighing it.
