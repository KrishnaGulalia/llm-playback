import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CassetteFile } from "./index";

export interface CassetteInfo {
  path: string;
  entries: number;
  bytes: number;
  mtimeMs: number;
}

export async function findCassettes(dir: string): Promise<CassetteInfo[]> {
  const out: CassetteInfo[] = [];
  async function walk(d: string) {
    let items;
    try {
      items = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (it.name === "node_modules" || it.name === ".git") continue;
      const p = join(d, it.name);
      if (it.isDirectory()) await walk(p);
      else if (it.name.endsWith(".json")) {
        try {
          const text = await readFile(p, "utf8");
          const j = JSON.parse(text) as CassetteFile;
          if (j && j.version === 1 && Array.isArray(j.entries)) {
            const s = await stat(p);
            out.push({ path: p, entries: j.entries.length, bytes: s.size, mtimeMs: s.mtimeMs });
          }
        } catch {
          /* not a cassette */
        }
      }
    }
  }
  await walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export const SECRET_PATTERNS: [string, RegExp][] = [
  ["OpenAI/Anthropic-style API key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/],
  ["Bearer token", /Bearer\s+[A-Za-z0-9._~+/-]{20,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}/],
  ["Private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

export function scanText(text: string): { name: string; preview: string }[] {
  const found: { name: string; preview: string }[] = [];
  for (const [name, re] of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) found.push({ name, preview: `${m[0].slice(0, 6)}…` });
  }
  return found;
}

export async function scanCassettes(dir: string) {
  const results: { path: string; findings: { name: string; preview: string }[] }[] = [];
  for (const c of await findCassettes(dir)) {
    const findings = scanText(await readFile(c.path, "utf8"));
    if (findings.length) results.push({ path: c.path, findings });
  }
  return results;
}

export async function pruneCassettes(dir: string, olderThanDays: number, dryRun: boolean): Promise<string[]> {
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const stale = (await findCassettes(dir)).filter((c) => c.mtimeMs < cutoff).map((c) => c.path);
  if (!dryRun) await Promise.all(stale.map((p) => unlink(p)));
  return stale;
}
