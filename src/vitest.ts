import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { useCassette, type Cassette, type CassetteOptions } from "./index";

export interface PlaybackOptions extends CassetteOptions {
  /** Where cassettes live. Default: `__playback__` next to the test file. */
  dir?: string;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "test";

/**
 * Call once at the top of a test file (or in a setup file). Every test then gets its own cassette,
 * named after the test, and global fetch is intercepted for the duration of the test.
 * Create SDK clients inside the test (or pass `fetch`), and run these tests sequentially.
 */
export function playback(options: PlaybackOptions = {}): void {
  let current: Cassette | undefined;
  beforeEach(async () => {
    const { currentTestName, testPath } = expect.getState();
    const dir = options.dir ?? join(dirname(testPath ?? process.cwd()), "__playback__");
    current = await useCassette(join(dir, `${slug(currentTestName ?? "test")}.json`), options);
  });
  afterEach(async () => {
    await current?.eject();
    current = undefined;
  });
}
