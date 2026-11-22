import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts", vitest: "src/vitest.ts" },
    format: ["esm", "cjs"],
    dts: true,
    target: "node20",
  },
  { entry: { cli: "src/cli.ts" }, format: ["esm"], target: "node20" },
]);
