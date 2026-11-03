# Company tools over MCP

Sotto can reach a group's own systems — a CRM, a ticket tracker, a wiki, a
document store — through [Model Context Protocol](https://modelcontextprotocol.io)
servers, beside the knowledge folder (`KNOWLEDGE_DIR`). Each server's tools are
offered to the model as function tools in every answer, every background search
and every fact check, and a finding that came out of one is cited as
`mcp:<server>/<tool>` on the card, as a file is cited as `file: <name>`.

Nothing is configured by default, and a session with no servers behaves exactly
as before: no process is spawned, no connection is opened, no tool is declared.

## Configuring servers

`MCP_SERVERS` in `.env` is either a path to a JSON file (the default is
`mcp.json` in the repo root, git-ignored) or the JSON itself. The file has the
shape Claude Desktop and most editors write, so an existing one can be pointed
at:

```json
{
  "mcpServers": {
    "crm": {
      "command": "npx",
      "args": ["tsx", "scripts/mcp-demo-server.ts"],
      "env": { "CUSTOMERS_CSV": "fixtures/knowledge-demo/customers.csv" }
    },
    "wiki": {
      "url": "https://wiki.example.com/mcp",
      "headers": { "Authorization": "Bearer ${WIKI_TOKEN}" }
    }
  }
}
```

- A server with `command` is run as a child process and spoken to over
  **stdio**. `args`, `env` and `cwd` are optional. The child gets `PATH`,
  `HOME` and a few other safe variables plus whatever `env` names — never the
  whole of Sotto's environment, which holds every API key in `.env`.
- A server with `url` is reached over **Streamable HTTP**. `headers` is
  optional.
- A `${NAME}` anywhere in a header or env value expands from Sotto's own
  environment (`.env` included) when the config is read. That is how a token
  stays in `.env` while `mcp.json` holds none and can be shared.
- A server name is lowercase letters, digits, `_` or `-`, at most 32
  characters: it becomes half of every tool's function name.

The example above runs the fictional company's CRM that ships in this repo,
`scripts/mcp-demo-server.ts` — one `lookup_customer` tool and one
`list_customers` over `fixtures/knowledge-demo/customers.csv`. Everything in
that file is made up. It is also what `npm run test:integration` connects to.

## What happens in a session

1. **Connect, once.** At session start Sotto connects to every server, lists its
   tools and writes the outcome to `session.json` (`mcp`) and `timing.jsonl`
   (`mcp_connected`): each server's name, whether it connected, how many tools
   it listed and their names. A server that cannot be reached is **a warning in
   the server log, never an error** — the session goes on with whatever did
   connect. Connecting and listing has a ten-second limit per server.
2. **Offer the tools.** Each tool becomes a function tool named
   `<server>__<tool>` (characters outside `[A-Za-z0-9_-]` become `_`), with the
   server's own description and its own JSON Schema as the parameters. A schema
   inside the strict subset (closed objects, every property required, no
   length or range keywords) is declared strict; any other is declared as the
   server wrote it rather than dropped. The tools go beside `web_search`,
   `search_knowledge` and `show_html` in the answer agent, the research runner
   and the verifier's records check, and the prompts tell the model to prefer
   them over the web for anything about the group's own organisation.
3. **Route the calls.** A call has ten seconds. A timeout, a server error, a
   result the server marked as an error and a server that has gone away are
   all answered **to the model in words** ("… Answer in words instead."), never
   thrown, so an answer is never lost because a lookup failed. Every call is a
   `mcp_call` line in `timing.jsonl` with its latency and outcome.
4. **Cite only what ran.** A source the model names as
   `mcp:crm/lookup_customer` is kept only if that tool was actually called
   during that answer or search — the same rule a web page (it must be in the
   search results) and a file (it must have been returned by `search_knowledge`)
   are held to. The card renders it as text, since there is no page to open.
5. **Close when the next session starts.** A question typed after Stop is
   answered against the conversation that just ended, with its tools; the
   connections are closed when the next session supersedes it, exactly as the
   answer agent is retired.

Secrets never reach a log line: the client logs server names, tool names,
counts and latencies, and every error message is passed through a redactor built
from the config's own header values, env values and URLs before it is written.

## Trying it

```sh
cp docs/mcp.example.json mcp.json   # or write your own
MCP_SERVERS=mcp.json npm run dev
```

Start a session, then type into "Ask Sotto…": *when does the Harborview Clinic
contract renew?* The card's source line reads `crm: lookup_customer`, and
`sessions/<folder>/timing.jsonl` has the `mcp_connected` and `mcp_call` lines.

`npm run test:integration` runs `server/mcp/mcp.integration.test.ts`, which
spawns the demo server over stdio, replays an empty capture, asks that question
through `POST /api/ask` and asserts the finished answer cites
`mcp:crm/lookup_customer`. It needs `MODEL_API_KEY`.
