import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "/rapp-heir/",
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "peer-transport": ["peerjs"],
          "qr-tools": ["qrcode", "@zxing/browser"],
          "local-storage": ["idb"],
        },
      },
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      reporter: ["text", "json-summary"],
    },
  },
});
