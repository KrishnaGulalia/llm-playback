import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withCassette } from "../src/index";

let server: Server;
let base = "";
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      hits++;
      const body = raw ? JSON.parse(raw) : {};
      if (req.url === "/v1/chat/completions" && body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const part = (content: string, finish: string | null = null) =>
          `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
        res.write(part("Hel"));
        res.write(part("lo "));
        res.write(part("world", "stop"));
        res.end("data: [DONE]\n\n");
      } else if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 1, model: "gpt-test", choices: [{ index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }));
      } else if (req.url === "/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "m1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: "Hi from Claude" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 2 } }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const tmpFile = async (name: string) => join(await mkdtemp(join(tmpdir(), "pb-sdk-")), name);

describe("real SDKs", () => {
  it("OpenAI: non-streaming and streaming replay", async () => {
    const f = await tmpFile("openai.json");
    const run = async () => {
      const client = new OpenAI({ apiKey: "sk-test-not-real", baseURL: `${base}/v1`, maxRetries: 0 });
      const a = await client.chat.completions.create({ model: "gpt-test", messages: [{ role: "user", content: "hi" }] });
      const stream = await client.chat.completions.create({ model: "gpt-test", stream: true, messages: [{ role: "user", content: "hi" }] });
      let text = "";
      for await (const p of stream) text += p.choices[0]?.delta?.content ?? "";
      return { full: a.choices[0].message.content, streamed: text };
    };
    hits = 0;
    const live = await withCassette(f, run, { mode: "record" });
    expect(hits).toBe(2);
    const replay = await withCassette(f, run, { mode: "replay" });
    expect(hits).toBe(2);
    expect(replay).toEqual(live);
    expect(live.streamed).toBe("Hello world");
  });

  it("Anthropic: message replay", async () => {
    const f = await tmpFile("anthropic.json");
    const run = async () => {
      const client = new Anthropic({ apiKey: "sk-ant-test-not-real", baseURL: base, maxRetries: 0 });
      const m = await client.messages.create({ model: "claude-test", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
      return m.content[0].type === "text" ? m.content[0].text : "";
    };
    hits = 0;
    const live = await withCassette(f, run, { mode: "record" });
    const replay = await withCassette(f, run, { mode: "replay" });
    expect(hits).toBe(1);
    expect(replay).toBe("Hi from Claude");
    expect(live).toBe(replay);
  });
});
