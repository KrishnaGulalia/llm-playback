# llm-playback

Record and replay LLM API calls in tests. The first run hits the real API and saves the response to a file. Every later run replays it: **free, instant, deterministic, offline.**

- Zero runtime dependencies, about 9 KB
- Works with anything built on `fetch`: OpenAI, Anthropic, Gemini, Vercel AI SDK, plain `fetch`
- Streaming (SSE) is recorded and replayed chunk by chunk
- Secrets stay out of cassettes: headers are never stored, URL params and response text can be scrubbed, and a CLI scanner checks for leaks
- Drift reports tell you when a model's answer changed since the last recording

## Install

```bash
npm i -D llm-playback
```

## Quick start

```ts
import { withCassette } from "llm-playback";

it("summarizes", async () => {
  const out = await withCassette("./cassettes/summarize.json", async () => {
    const client = new OpenAI(); // create SDK clients inside the scope
    const r = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [...] });
    return r.choices[0].message.content;
  });
  expect(out).toContain("summary");
});
```

Run it once with your real API key (it records). Commit the cassette. From then on it replays with no network and no cost.

> Many SDKs capture `fetch` when the client is constructed. Create the client **after** the cassette is active, or pass the intercepting fetch explicitly: `const c = await useCassette(path); new OpenAI({ fetch: c.fetch })`.

## Vitest helper

One line gives every test its own cassette, named after the test:

```ts
import { playback } from "llm-playback/vitest";

playback(); // cassettes go in ./__playback__ next to this test file

it("answers questions", async () => {
  /* your code that calls an LLM */
});
```

Run these tests sequentially (the default within a file), because global `fetch` is patched while a test runs.

## Modes

| Mode | Behaviour |
|---|---|
| `auto` (default locally) | replay on hit, record on miss |
| `record` | always hit the network and overwrite |
| `replay` (default when `CI` is set) | fail on miss, never touches the network |
| `passthrough` | do nothing |

Set with the `mode` option or `CASSETTE_MODE=record npm test`.

## Options

| Option | What it does |
|---|---|
| `ignoreFields` | body fields excluded from matching, e.g. `["user", "metadata"]` |
| `matchOn(body)` | choose what is hashed, e.g. `(b) => ({ model: b.model, messages: b.messages })` |
| `scrubUrlParams` | query params removed before matching and saving, e.g. `["key"]` |
| `redact(text)` | rewrite response text before saving (per stream chunk) |
| `replayDelayMs` | delay between replayed stream chunks |
| `recordErrors` | also record 5xx/429 responses (off by default so outages don't poison cassettes) |

## Drift report

```ts
const c = await useCassette(path, { mode: "record" });
await runMyCode();
await c.eject();
console.log(c.drift); // [{ method, url, key, index }] for responses that changed
```

## CLI

```bash
npx llm-playback list [dir]                      # cassettes, entries, size, age
npx llm-playback inspect <file>                  # every recorded request
npx llm-playback scan [dir]                      # find API keys/tokens (exit 1 if found), use in CI
npx llm-playback prune [dir] --older-than 30 --dry-run
```

## How matching works

A request's key is a hash of method + URL + JSON body, with object keys sorted so ordering never matters. Identical requests in one run replay in the order they were recorded.

## Limits

- Intercepts global `fetch` only (not SDKs that bring their own HTTP client).
- Consume responses before the test ends, or let `eject()` finish reading them.
- Matching is exact unless you use `matchOn`/`ignoreFields`.

## License

MIT
