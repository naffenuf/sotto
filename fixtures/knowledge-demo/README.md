# knowledge-demo — a fictional company's files

**Everything in this folder is fictional.** Northvane Labs does not exist, nor do its
customers, its prices or the people named in its notes. The files are here so that
V3-009's knowledge folder has something to read in a demo and in the integration test,
and so that no real customer list is ever committed to this repository.

To use it as a real knowledge folder, point `KNOWLEDGE_DIR` at it:

```sh
KNOWLEDGE_DIR=fixtures/knowledge-demo npm run dev
```

A live session's own folder is `knowledge/` (git-ignored) — the group's real files go
there and are never committed.

| File | What it holds |
| --- | --- |
| `customers.csv` | Eight accounts with plan, seats, annual value and renewal date |
| `prices.csv` | The price sheet: plans, list prices, the discounts sales may give |
| `notes.md` | Internal notes: what the team has agreed about pricing and renewals |
