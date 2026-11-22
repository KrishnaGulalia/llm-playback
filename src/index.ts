import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Mode = "auto" | "record" | "replay" | "passthrough";

export interface CassetteOptions {
  /** auto: replay on hit, record on miss. record: always hit the network and overwrite.
   *  replay: fail on miss. passthrough: do nothing.
   *  Default: $CASSETTE_MODE, else "replay" when $CI is set, else "auto". */
  mode?: Mode;
  /** Top-level JSON body fields excluded from matching (e.g. "user", "metadata"). */
  ignoreFields?: string[];
  /** Delay between replayed stream chunks, in ms. Default 0. */
  replayDelayMs?: number;
  /** Query-string params removed from the URL before matching and storing (e.g. ["key"] for ?key=SECRET). */
  scrubUrlParams?: string[];
  /** Rewrite recorded response text before it is saved (e.g. mask emails). Applied per stream chunk. */
  redact?: (text: string) => string;
  /** Customize what is hashed: receives the parsed JSON body and returns the value to match on
   *  (e.g. `(b) => ({ messages: b.messages })` to ignore temperature, max_tokens, ...). */
  matchOn?: (body: any, req: { method: string; url: string }) => unknown;
  /** Also record 5xx and 429 responses. Default false, so a transient outage never poisons a cassette. */
  recordErrors?: boolean;
}

export interface StoredResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Text chunks, or base64 chunks when `binary` is true. */
  chunks: string[];
  binary?: boolean;
}
export interface Entry {
  key: string;
  method: string;
  url: string;
  response: StoredResponse;
}
export interface CassetteFile {
  version: 1;
  entries: Entry[];
}
export interface DriftItem {
  method: string;
  url: string;
  key: string;
  /** Which occurrence of this identical request changed (0-based). */
  index: number;
}
export interface Cassette {
  /** Restore global fetch and write the cassette file if anything was recorded. */
  eject(): Promise<void>;
  /** The intercepting fetch. Pass it to SDKs that capture fetch at construction: `new OpenAI({ fetch: c.fetch })`. */
  readonly fetch: typeof fetch;
  readonly stats: { replayed: number; recorded: number };
  /** Responses that differ from the previous recording (record mode only). */
  readonly drift: DriftItem[];
}

export class CassetteMissError extends Error {
  constructor(method: string, url: string, key: string) {
    super(
      `llm-playback: no recorded response for ${method} ${url} (key ${key}). ` +
        `Re-run with CASSETTE_MODE=record (or "auto") to record it.`,
    );
    this.name = "CassetteMissError";
  }
}

const DROP_RESPONSE_HEADERS = new Set(["set-cookie", "content-encoding", "content-length", "transfer-encoding"]);
const TEXTUAL = /^text\/|json|xml|event-stream|javascript|x-www-form-urlencoded|graphql/i;
const isTextual = (contentType: string | null) => !contentType || TEXTUAL.test(contentType);

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, x]) => [k, stable(x)]),
    );
  }
  return v;
}

function cleanUrl(url: string, params: string[]): string {
  if (params.length === 0) return url;
  try {
    const u = new URL(url);
    for (const p of params) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}

function keyFor(
  method: string,
  url: string,
  bodyText: string,
  ignore: string[],
  matchOn?: CassetteOptions["matchOn"],
): string {
  let body = bodyText;
  try {
    let json = JSON.parse(bodyText);
    if (json && typeof json === "object" && !Array.isArray(json)) for (const f of ignore) delete json[f];
    if (matchOn) json = matchOn(json, { method, url });
    body = JSON.stringify(stable(json));
  } catch {
    /* non-JSON body: hash as-is */
  }
  return createHash("sha256").update(`${method}\n${url}\n${body}`).digest("hex").slice(0, 16);
}

function toResponse(r: StoredResponse, delayMs: number): Response {
  const enc = new TextEncoder();
  const nullBody = r.status === 204 || r.status === 205 || r.status === 304;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of r.chunks) {
        if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
        controller.enqueue(r.binary ? new Uint8Array(Buffer.from(chunk, "base64")) : enc.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(nullBody ? null : stream, {
    status: r.status,
    statusText: r.statusText,
    headers: r.headers,
  });
}

/**
 * Wrap an upstream body so every chunk is observed. If the consumer cancels early (OpenAI's SDK
 * does this right after `[DONE]`), the rest is still read in the background so the recording is
 * complete. `drain()` forces that, and is also used when the cassette is ejected.
 */
function tee(body: ReadableStream<Uint8Array>, onChunk: (c: Uint8Array) => void, onEnd: () => void) {
  const reader = body.getReader();
  let ended = false;
  let draining: Promise<void> | undefined;
  const finish = () => {
    if (!ended) {
      ended = true;
      onEnd();
    }
  };
  const drain = () =>
    (draining ??= (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return finish();
          onChunk(value);
        }
      } catch {
        /* upstream failed mid-stream: leave the entry unsaved */
      }
    })());
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else {
          onChunk(value);
          controller.enqueue(value);
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel() {
      void drain();
    },
  });
  return { stream, drain };
}

export async function useCassette(path: string, options: CassetteOptions = {}): Promise<Cassette> {
  const mode: Mode =
    options.mode ?? (process.env.CASSETTE_MODE as Mode | undefined) ?? (process.env.CI ? "replay" : "auto");
  const ignore = options.ignoreFields ?? [];
  const delay = options.replayDelayMs ?? 0;
  const scrub = options.scrubUrlParams ?? [];
  const redact = options.redact ?? ((t: string) => t);

  let file: CassetteFile = { version: 1, entries: [] };
  try {
    file = JSON.parse(await readFile(path, "utf8"));
  } catch {
    /* no cassette yet */
  }

  const realFetch = globalThis.fetch;
  const used = new Map<string, number>();
  const stats = { replayed: 0, recorded: 0 };
  const drift: DriftItem[] = [];
  const fresh: { order: number; entry: Entry }[] = [];
  let order = 0;
  const recorders: (() => Promise<void>)[] = [];
  let ejected = false;

  const patched = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (mode === "passthrough") return realFetch(input, init);

    const req = new Request(input, init);
    const bodyText = await req.clone().text();
    const url = cleanUrl(req.url, scrub);
    const key = keyFor(req.method, url, bodyText, ignore, options.matchOn);
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const myOrder = order++;

    const previous = file.entries.filter((e) => e.key === key);
    if (mode !== "record") {
      const hit = previous[n] ?? previous[previous.length - 1];
      if (hit) {
        stats.replayed++;
        return toResponse(hit.response, delay);
      }
      if (mode === "replay") throw new CassetteMissError(req.method, url, key);
    }

    const res = await realFetch(req);
    if (!options.recordErrors && (res.status >= 500 || res.status === 429)) return res;

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) headers[k] = v;
    });
    const binary = !isTextual(res.headers.get("content-type"));
    const chunks: string[] = [];
    const dec = new TextDecoder();

    const save = () => {
      const entry: Entry = {
        key,
        method: req.method,
        url,
        response: { status: res.status, statusText: res.statusText, headers, chunks, ...(binary ? { binary } : {}) },
      };
      fresh.push({ order: myOrder, entry });
      stats.recorded++;
      const old = previous[n];
      if (old && (old.response.status !== res.status || old.response.chunks.join("") !== chunks.join(""))) {
        drift.push({ method: req.method, url, key, index: n });
      }
    };

    if (!res.body) {
      save();
      return new Response(null, { status: res.status, statusText: res.statusText, headers });
    }
    const { stream, drain } = tee(
      res.body,
      (chunk) => {
        chunks.push(binary ? Buffer.from(chunk).toString("base64") : redact(dec.decode(chunk, { stream: true })));
      },
      () => {
        if (!binary) {
          const tail = dec.decode();
          if (tail) chunks.push(redact(tail));
        }
        save();
      },
    );
    recorders.push(drain);
    return new Response(stream, { status: res.status, statusText: res.statusText, headers });
  }) as typeof fetch;

  globalThis.fetch = patched;

  return {
    fetch: patched,
    stats,
    drift,
    async eject() {
      if (ejected) return;
      ejected = true;
      globalThis.fetch = realFetch;
      await Promise.all(recorders.map((drain) => drain()));
      if (fresh.length === 0) return;
      const keys = new Set(fresh.map((f) => f.entry.key));
      const entries = [
        ...file.entries.filter((e) => !keys.has(e.key)),
        ...fresh.sort((a, b) => a.order - b.order).map((f) => f.entry),
      ];
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, entries } satisfies CassetteFile, null, 2) + "\n");
      await rename(tmp, path);
    },
  };
}

/** Run `fn` with a cassette active, ejecting afterwards even if it throws. */
export async function withCassette<T>(
  path: string,
  fn: (cassette: Cassette) => Promise<T>,
  options?: CassetteOptions,
): Promise<T> {
  const c = await useCassette(path, options);
  try {
    return await fn(c);
  } finally {
    await c.eject();
  }
}
