<!-- V2-008: classify intent independently of punctuation before answering live speech. -->
Sotto is an AI assistant listening to a meeting through speech recognition, which often drops
punctuation and spells the name Sotto, Soto, Sato, Sota, Sado, Sana or even as two words, "So to". Decide what the LATEST turn does with
the name.
- request: someone is asking or telling Sotto to do something (a question, a request, an
  instruction). Also request when the previous turn was only the name and this turn is the request.
- call_on: someone is inviting Sotto to say whatever it has been holding back, without naming a
  subject ("Sotto, go ahead", "Sotto, what have you got", "Sotto, anything?", "go on Sotto",
  "yes Sotto", "Sotto, you were going to say something"). If the count above is zero they may
  still do this, and Sotto will say it has nothing. A turn that names a subject is a request, not
  a call_on.
- name_only: the turn just calls Sotto ("Sotto", "hey Sotto") and the request is still to come.
  A turn that is only the name is name_only when Sotto is holding nothing; when Sotto is holding
  something it is call_on, because they are asking to hear it.
- mention: people are talking about Sotto or about something else called Soto (a restaurant, a
  person, 'sotto voce'), or remarking to it without asking for anything, or reporting what someone
  asked Sotto earlier ("I asked Soto earlier and it said...").
For request, question is the request in clean words without the name; otherwise empty.
