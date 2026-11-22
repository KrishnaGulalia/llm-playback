# llm-playback

[![npm](https://img.shields.io/npm/v/llm-playback)](https://www.npmjs.com/package/llm-playback)
[![CI](https://github.com/KrishnaGulalia/llm-playback/actions/workflows/ci.yml/badge.svg)](https://github.com/KrishnaGulalia/llm-playback/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/llm-playback)](LICENSE)

Record and replay LLM API calls in tests. The first run hits the real API and saves the response to a file. Every later run replays it: **free, instant, deterministic, offline.**

```
first run   (live Gemini call)   1.2 s
second run  (replayed)           4 ms     identical output
```

- Zero runtime dependencies, about 9 KB
- Works with anything built on `fetch`: OpenAI, Anthropic, Gemini, Vercel AI SDK, plain `fetch`
- Streaming (SSE) is recorded and replayed chunk by chunk
- Secrets stay out of cassettes: request headers are never stored, URL params and response text can be scrubbed, and a CLI scanner checks for leaks
- Drift reports tell you when a model's answer changed since the last recording
- Server outages (5xx/429) are never recorded, so a bad moment at the provider can't become your "expected" answer

Verified against Gemini's live API (REST and the OpenAI-compatible streaming endpoint), and in the test suite with the official OpenAI and Anthropic SDKs.

## Why

LLM tests are slow, cost money and give different answers every run, so teams either skip them or mock responses by hand. `llm-playback` records real responses once and replays them, so your tests exercise real response shapes at zero cost.

## Install

```bash
npm i -D llm-playback
```

Requires Node 20 or newer.

## Quick start

```ts
import OpenAI from "openai";
import { withCassette } from "llm-playback";

it("summarizes", async () => {
  const out = await withCassette("./cassettes/summarize.json", async () => {
    const client = new OpenAI(); // create SDK clients inside the scope
    const r = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize: ..." }],
    });
    return r.choices[0].message.content;
  });
  expect(out).toContain("summary");
});
```

Run it once with your real API key (it records). Commit the cassette. From then on it replays with no network and no cost.

> Many SDKs capture `fetch` when the client is constructed. Create the client **after** the cassette is active, or pass the intercepting fetch explicitly:
> `const c = await useCassette(path); new OpenAI({ fetch: c.fetch })`

### Gemini (API key in the URL)

Gemini's REST API puts the key in the query string. Scrub it so it never reaches the cassette:

```ts
await withCassette(
  "./cassettes/gemini.json",
  async () => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) },
    );
    return res.json();
  },
  { scrubUrlParams: ["key"] },
);
```

## Vitest helper

One line gives every test its own cassette, named after the test:

```ts
import { playback } from "llm-playback/vitest";

playback(); // cassettes go in ./__playback__ next to this test file

it("answers questions", async () => {
  /* your code that calls an LLM */
});
```

Run these tests sequentially (the default within a file), because global `fetch` is patched while a test runs. With Jest or any other runner, use `withCassette` directly.

## Modes

| Mode | Behaviour |
|---|---|
| `auto` (default locally) | replay on hit, record on miss |
| `record` | always hit the network and overwrite |
| `replay` (default when `CI` is set) | fail on miss, never touches the network |
| `passthrough` | do nothing |

Set with the `mode` option or the environment: `CASSETTE_MODE=record npm test`.

## Options

| Option | What it does |
|---|---|
| `ignoreFields` | body fields excluded from matching, e.g. `["user", "metadata"]` |
| `matchOn(body)` | choose what is hashed, e.g. `(b) => ({ model: b.model, messages: b.messages })` |
| `scrubUrlParams` | query params removed before matching and saving, e.g. `["key"]` |
| `redact(text)` | rewrite response text before saving (applied per stream chunk) |
| `replayDelayMs` | delay between replayed stream chunks |
| `recordErrors` | also record 5xx/429 responses (off by default) |

## Drift report

Model answers change over time. Re-record and see what moved:

```ts
const c = await useCassette(path, { mode: "record" });
await runMyCode();
await c.eject();
console.log(c.drift); // [{ method, url, key, index }] for responses that changed
```

LLM output is not deterministic, so some drift on every re-record is normal. Use it to spot meaningful changes, not as a failure condition.

## CLI

```bash
npx llm-playback list [dir]                      # cassettes, entries, size, age
npx llm-playback inspect <file>                  # every recorded request
npx llm-playback scan [dir]                      # find API keys/tokens (exit 1 if found)
npx llm-playback prune [dir] --older-than 30 --dry-run
```

## CI

`CI=true` switches the default mode to `replay`, so a missing cassette fails the build instead of making a paid API call. Add the scanner to catch leaked keys before they are merged:

```yaml
- run: npm test
- run: npx llm-playback scan .
```

## Security

Cassettes contain full model responses and request URLs. Before committing one:

- Run `npx llm-playback scan` (it looks for common API key and token formats).
- Use `scrubUrlParams` for keys in URLs and `redact` for personal data in responses.
- Request headers, including `Authorization`, are never written to disk, and `set-cookie` is dropped from responses.

## How matching works

A request's key is a hash of method + URL + JSON body, with object keys sorted so ordering never matters. Identical requests in one run replay in the order they were recorded.

## Troubleshooting

**`CassetteMissError` in replay mode.** The request doesn't match anything recorded. Re-run with `CASSETTE_MODE=record`, or use `matchOn`/`ignoreFields` if a volatile field (timestamp, user id) is changing the key.

**Real network calls still happen.** The SDK captured `fetch` before the cassette started. Create the client inside the cassette scope or pass `c.fetch`.

**A recorded error keeps replaying after you fixed the cause.** Client errors (4xx, such as a wrong model name) are recorded, because tests of error handling may need them. Delete that cassette file and record again.

## Limits

- Intercepts global `fetch` only, not SDKs that bring their own HTTP client.
- Matching is exact unless you use `matchOn` or `ignoreFields`.
- Responses are read to the end even if the caller stops early, so cassettes are complete. `eject()` waits for that to finish.

## License

MIT