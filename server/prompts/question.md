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
