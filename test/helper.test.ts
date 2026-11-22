import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { playback } from "../src/vitest";

const dir = mkdtempSync(join(tmpdir(), "pb-helper-"));
playback({ dir, mode: "auto" });

let server: Server;
let base = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => res.end('{"ok":true}'));
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  expect(files[0]).toContain("records-a-cassette-named-after-the-test");
  expect(readFileSync(join(dir, files[0]), "utf8")).toContain("/hello");
});

it("records a cassette named after the test", async () => {
  const r = await fetch(base + "/hello", { method: "POST", body: "{}" });
  expect(await r.json()).toEqual({ ok: true });
});
