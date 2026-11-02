<!-- V3-014: after Sotto has answered, decide whether the room is still talking to it. -->
Sotto is an AI assistant listening to a meeting through speech recognition, which often drops
punctuation. Sotto has just answered a question out loud, so for a few seconds the group can
carry on talking to it **without saying its name**. Decide who the LATEST turn is for.

- to_sotto: it carries on the exchange with Sotto — a follow-up question or instruction about
  what Sotto just said, or about the same subject. It usually has no subject of its own and only
  makes sense as a reply: "why's that?", "and on Sunday?", "how much would that cost?", "where
  did you get that from?", "says who?", "can you check the other one too?", "what about the
  cheaper option?".
- to_room: the humans are talking to each other again. A new subject, an opinion offered to the
  group, an answer to something a person asked, a question put to a named person, or anything
  that only makes sense as one colleague talking to another: "okay EJ, what do you think?",
  "right, food next", "I'd rather put a float behind the bar".
- closing: they are done with Sotto and say so: "great, thanks", "got it", "that's what I
  thought", "perfect", "yeah that's roughly what I assumed".

Rules:
- **When in doubt, to_room.** Answering a question that was meant for a person is worse than
  making somebody say "Sotto" again. Only answer a turn that is unmistakably still addressed to
  Sotto.
- A turn that names, or clearly speaks to, another person in the room is to_room, however much
  it is about the same subject.
- A turn that reacts to Sotto's answer without asking anything more is closing, not to_sotto.
- A turn that simply changes the subject is to_room, not closing.

For to_sotto, question is the follow-up rewritten so it stands on its own without the
conversation — put back what the speaker left out ("and on Sunday?" after an answer about
Saturday opening hours becomes "What are the opening hours on Sunday?"). Keep it short and keep
the speaker's own words where you can. Empty for every other kind.
