import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CassetteMissError, withCassette } from "../src/index";

let server: Server;
let base = "";
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "s=1" });
        res.write('data: {"t":"Hel"}\n\n');
        setTimeout(() => {
          res.write('data: {"t":"lo"}\n\n');
          res.end("data: [DONE]\n\n");
        }, 20);
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echo: JSON.parse(body || "{}"), n: hits }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("llm-playback", () => {
  it("records once, then replays without hitting the network", async () => {
    const f = join(await mkdtemp(join(tmpdir(), "cas-")), "a.json");
    hits = 0;
    const first = await withCassette(f, async () => (await post("/chat", { q: 1 })).json(), { mode: "auto" });
    const second = await withCassette(f, async () => (await post("/chat", { q: 1 })).json(), { mode: "replay" });
    expect(second).toEqual(first);
    expect(hits).toBe(1);
  });

  it("ignores key order and ignoreFields, never stores auth headers", async () => {
    const f = join(await mkdtemp(join(tmpdir(), "cas-")), "b.json");
    hits = 0;
    await withCassette(f, async () => post("/chat", { a: 1, b: 2, user: "x" }, { authorization: "Bearer SECRET" }).then((r) => r.text()), { mode: "auto", ignoreFields: ["user"] });
    await withCassette(f, async () => post("/chat", { b: 2, a: 1, user: "y" }).then((r) => r.text()), { mode: "replay", ignoreFields: ["user"] });
    expect(hits).toBe(1);
    expect(await readFile(f, "utf8")).not.toContain("SECRET");
  });

  it("replays streams chunk by chunk and drops set-cookie", async () => {
    const f = join(await mkdtemp(join(tmpdir(), "cas-")), "c.json");
    const run = async () => {
      const res = await post("/stream", {});
      const out: string[] = [];
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(dec.decode(value));
      }
      return out;
    };
    const live = await withCassette(f, run, { mode: "record" });
    const replay = await withCassette(f, run, { mode: "replay" });
    expect(replay.join("")).toBe(live.join(""));
    expect(replay.length).toBeGreaterThan(1);
    expect(await readFile(f, "utf8")).not.toContain("set-cookie");
  });

  it("returns identical requests in recorded order", async () => {
    const f = join(await mkdtemp(join(tmpdir(), "cas-")), "d.json");
    const two = async () => [(await (await post("/chat", { q: 1 })).json()).n, (await (await post("/chat", { q: 1 })).json()).n];
    const live = await withCassette(f, two, { mode: "record" });
    const replay = await withCassette(f, two, { mode: "replay" });
    expect(live[0]).not.toBe(live[1]);
    expect(replay).toEqual(live);
  });

  it("throws a clear error on a miss in replay mode and restores fetch", async () => {
    const f = join(await mkdtemp(join(tmpdir(), "cas-")), "e.json");
    const original = globalThis.fetch;
    await expect(withCassette(f, () => post("/chat", { nope: true }), { mode: "replay" })).rejects.toBeInstanceOf(CassetteMissError);
    expect(globalThis.fetch).toBe(original);
  });

  it("matchOn ignores unrelated body fields", async () => {
    const f = join(await mkdtemp(join(tmpdir(), "cas-")), "f.json");
    hits = 0;
    const opts = { matchOn: (b: any) => ({ messages: b.messages }) };
    await withCassette(f, () => post("/chat", { messages: ["hi"], temperature: 0.2 }).then((r) => r.text()), { mode: "auto", ...opts });
    await withCassette(f, () => post("/chat", { messages: ["hi"], temperature: 0.9 }).then((r) => r.text()), { mode: "replay", ...opts });
    expect(hits).toBe(1);
  });

  it("scrubs URL params from matching and from the file", async () => {
    const f = join(await mkdtemp(join(tmpdir(), "cas-")), "g.json");
    hits = 0;
    const opts = { scrubUrlParams: ["key"] };
    await withCassette(f, () => post("/chat?key=SECRET1&v=1", { q: 1 }).then((r) => r.text()), { mode: "auto", ...opts });
    await withCassette(f, () => post("/chat?key=OTHER&v=1", { q: 1 }).then((r) => r.text()), { mode: "replay", ...opts });
    expect(hits).toBe(1);
    expect(await readFile(f, "utf8")).not.toContain("SECRET1");
  });

  it("redact rewrites what is stored but not what the caller sees", async () => {
    const f = join(await mkdtemp(join(tmpdir(), "cas-")), "h.json");
    const opts = { redact: (t: string) => t.replace(/a@b\.com/g, "[email]") };
    const live = await withCassette(f, () => post("/chat", { who: "a@b.com" }).then((r) => r.text()), { mode: "record", ...opts });
    expect(live).toContain("a@b.com");
    expect(await readFile(f, "utf8")).not.toContain("a@b.com");
  });
});
