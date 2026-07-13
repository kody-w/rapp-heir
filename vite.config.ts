import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const base = "/rapp-heir/";
const publicDocuments = [
  "NOTICE.md",
  "LICENSE",
  "ROADMAP.md",
  "SECURITY.md",
  "PRIVACY.md",
  "PROTOCOL.md",
] as const;

export default defineConfig({
  base,
  plugins: [
    {
      name: "rapp-heir-release-assets",
      generateBundle(_options, bundle) {
        const assets = Object.values(bundle)
          .map((entry) => entry.fileName)
          .filter((fileName) => /\.(?:css|js)$/u.test(fileName))
          .map((fileName) => `${base}${fileName}`)
          .sort();
        this.emitFile({
          type: "asset",
          fileName: "asset-manifest.json",
          source: `${JSON.stringify({ version: 1, assets }, null, 2)}\n`,
        });
        for (const fileName of publicDocuments) {
          this.emitFile({
            type: "asset",
            fileName,
            source: readFileSync(new URL(fileName, import.meta.url)),
          });
        }
      },
    },
  ],
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
