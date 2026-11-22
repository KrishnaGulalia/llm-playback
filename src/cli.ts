#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { CassetteFile } from "./index";
import { findCassettes, pruneCassettes, scanCassettes } from "./tools";

const HELP = `llm-playback <command>

  list [dir]                         list cassettes (default dir: .)
  inspect <file>                     show every recorded request in a cassette
  scan [dir]                         look for API keys and tokens in cassettes (exit 1 if found)
  prune [dir] --older-than <days>    delete cassettes not modified for N days (add --dry-run to preview)
  help                               show this message
`;

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const days = (ms: number) => `${Math.floor((Date.now() - ms) / 86_400_000)}d`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : (rest[i + 1] ?? "");
  };
  const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--older-than");
  const dir = positional[0] ?? ".";

  switch (cmd) {
    case "list": {
      const cs = await findCassettes(dir);
      if (cs.length === 0) return console.log("No cassettes found."), 0;
      for (const c of cs) console.log(`${relative(process.cwd(), c.path)}  ${c.entries} entries  ${kb(c.bytes)}  ${days(c.mtimeMs)} old`);
      console.log(`\n${cs.length} cassette(s)`);
      return 0;
    }
    case "inspect": {
      if (!positional[0]) return console.error("usage: llm-playback inspect <file>"), 2;
      const f = JSON.parse(await readFile(positional[0], "utf8")) as CassetteFile;
      f.entries.forEach((e, i) => {
        const size = e.response.chunks.reduce((n, c) => n + c.length, 0);
        console.log(`${i + 1}. ${e.method} ${e.url} -> ${e.response.status}  ${e.response.chunks.length} chunk(s), ${size} chars${e.response.binary ? " (binary)" : ""}`);
      });
      return 0;
    }
    case "scan": {
      const bad = await scanCassettes(dir);
      if (bad.length === 0) return console.log("No secrets found."), 0;
      for (const b of bad) for (const f of b.findings) console.log(`${relative(process.cwd(), b.path)}: ${f.name} (${f.preview})`);
      console.error(`\n${bad.length} cassette(s) contain possible secrets. Use the redact option and re-record.`);
      return 1;
    }
    case "prune": {
      const n = Number(flag("--older-than"));
      if (!Number.isFinite(n) || n < 0 || flag("--older-than") === undefined) return console.error("usage: llm-playback prune [dir] --older-than <days> [--dry-run]"), 2;
      const dry = rest.includes("--dry-run");
      const gone = await pruneCassettes(dir, n, dry);
      for (const p of gone) console.log(`${dry ? "would delete" : "deleted"} ${relative(process.cwd(), p)}`);
      console.log(`${gone.length} cassette(s) ${dry ? "would be " : ""}removed`);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return console.log(HELP), 0;
    default:
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => void (process.exitCode = code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
