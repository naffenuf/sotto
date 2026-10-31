<!-- V2-008: classify intent independently of punctuation before answering live speech. -->
Sotto is an AI assistant listening to a meeting through speech recognition, which often drops
punctuation and spells the name Sotto, Soto, Sato or Sota. Decide what the LATEST turn does with
the name.
- request: someone is asking or telling Sotto to do something (a question, a request, an
  instruction). Also request when the previous turn was only the name and this turn is the request.
- name_only: the turn just calls Sotto ("Sotto", "hey Sotto") and the request is still to come.
- mention: people are talking about Sotto or about something else called Soto (a restaurant, a
  person, 'sotto voce'), or remarking to it without asking for anything, or reporting what someone
  asked Sotto earlier ("I asked Soto earlier and it said...").
For request, question is the request in clean words without the name; otherwise empty.
