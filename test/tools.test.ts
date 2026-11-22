import { existsSync } from "node:fs";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findCassettes, pruneCassettes, scanCassettes, scanText } from "../src/tools";

const cassette = (text: string) =>
  JSON.stringify({
    version: 1,
    entries: [{ key: "a", method: "POST", url: "http://x/y", response: { status: 200, statusText: "OK", headers: {}, chunks: [text] } }],
  });

describe("tools", () => {
  it("finds only real cassettes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-tools-"));
    await writeFile(join(dir, "good.json"), cassette("hello"));
    await writeFile(join(dir, "other.json"), '{"x":1}');
    await writeFile(join(dir, "broken.json"), "not json");
    const found = await findCassettes(dir);
    expect(found).toHaveLength(1);
    expect(found[0].entries).toBe(1);
  });

  it("scan detects keys and tokens without printing them in full", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-scan-"));
    await writeFile(join(dir, "leak.json"), cassette("oops sk-abcdefghijklmnopqrstuvwxyz123456"));
    await writeFile(join(dir, "clean.json"), cassette("nothing here"));
    const res = await scanCassettes(dir);
    expect(res).toHaveLength(1);
    expect(res[0].findings[0].name).toMatch(/API key/);
    expect(res[0].findings[0].preview.length).toBeLessThan(10);
    expect(scanText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toHaveLength(1);
    expect(scanText("plain text")).toHaveLength(0);
  });

  it("prune honours --dry-run and age", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pb-prune-"));
    const old = join(dir, "old.json");
    const fresh = join(dir, "fresh.json");
    await writeFile(old, cassette("a"));
    await writeFile(fresh, cassette("b"));
    const past = new Date(Date.now() - 60 * 86_400_000);
    await utimes(old, past, past);
    expect(await pruneCassettes(dir, 30, true)).toEqual([old]);
    expect(existsSync(old)).toBe(true);
    await pruneCassettes(dir, 30, false);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});
