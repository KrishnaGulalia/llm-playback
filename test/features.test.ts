import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useCassette, withCassette } from "../src/index";

let server: Server;
let base = "";
let counter = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/bin") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0, 255, 128, 10, 200]));
      } else if (req.url === "/fail") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end('{"error":"overloaded"}');
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ n: ++counter }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const tmpFile = async (name: string) => join(await mkdtemp(join(tmpdir(), "pb-")), name);
const post = (path: string, body: unknown = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });

describe("features", () => {
  it("reports drift when a re-recorded response differs", async () => {
    const f = await tmpFile("drift.json");
    const first = await useCassette(f, { mode: "record" });
    await (await post("/chat", { q: 1 })).text();
    await first.eject();
    expect(first.drift).toHaveLength(0);

    const second = await useCassette(f, { mode: "record" });
    await (await post("/chat", { q: 1 })).text();
    await second.eject();
    expect(second.drift).toHaveLength(1);
    expect(second.drift[0].url).toContain("/chat");
  });

  it("round-trips binary bodies byte for byte", async () => {
    const f = await tmpFile("bin.json");
    const get = async () => new Uint8Array(await (await post("/bin")).arrayBuffer());
    const live = await withCassette(f, get, { mode: "record" });
    const replay = await withCassette(f, get, { mode: "replay" });
    expect([...replay]).toEqual([...live]);
    expect([...live]).toEqual([0, 255, 128, 10, 200]);
  });

  it("does not record 5xx responses by default", async () => {
    const f = await tmpFile("fail.json");
    const res = await withCassette(f, async () => (await post("/fail")).status, { mode: "record" });
    expect(res).toBe(503);
    expect(existsSync(f)).toBe(false);
  });

  it("records errors when recordErrors is set", async () => {
    const f = await tmpFile("fail2.json");
    await withCassette(f, async () => (await post("/fail")).text(), { mode: "record", recordErrors: true });
    const replayed = await withCassette(f, async () => (await post("/fail")).status, { mode: "replay" });
    expect(replayed).toBe(503);
  });

  it("exposes a fetch for SDKs that capture fetch at construction", async () => {
    const f = await tmpFile("fetch.json");
    const before = globalThis.fetch;
    const c = await useCassette(f, { mode: "record" });
    await c.eject();
    expect(globalThis.fetch).toBe(before);
    const live = await useCassette(f, { mode: "auto" });
    await live.eject();
    const viaProp = await (await live.fetch(base + "/chat", { method: "POST", body: "{}" })).json();
    expect(typeof viaProp.n).toBe("number");
  });
});
