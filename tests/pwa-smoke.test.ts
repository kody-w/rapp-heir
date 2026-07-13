import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const root = process.cwd();

function text(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function filesUnder(path: string): string[] {
  const full = join(root, path);
  return readdirSync(full).flatMap((entry) => {
    const relative = join(path, entry);
    return statSync(join(root, relative)).isDirectory() ? filesUnder(relative) : [relative];
  });
}

describe("PWA and repository smoke checks", () => {
  it("pins required local runtime dependencies and the Pages base", () => {
    const packageJson = JSON.parse(text("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies).toMatchObject({
      peerjs: "1.5.5",
      idb: "8.0.3",
      qrcode: "1.5.4",
      "@zxing/browser": "0.1.5",
    });
    expect(text("vite.config.ts")).toContain('const base = "/rapp-heir/"');
  });

  it("ships a scoped manifest, custom service worker, and Apple touch metadata", () => {
    const manifest = JSON.parse(text("public/manifest.webmanifest")) as {
      start_url: string;
      scope: string;
      orientation?: string;
      icons: Array<{ src: string; sizes: string }>;
    };
    expect(manifest.start_url).toBe("/rapp-heir/");
    expect(manifest.scope).toBe("/rapp-heir/");
    expect(manifest.orientation).toBeUndefined();
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
    expect(text("index.html")).toContain('rel="apple-touch-icon"');
    expect(text("src/main.ts")).toContain("serviceWorker.register");
    expect(text("public/sw.js")).toContain('const BASE = "/rapp-heir/"');
    expect(text("public/sw.js")).toContain('key.startsWith("rapp-heir-")');
    expect(text("public/sw.js")).toContain("rapp-heir-shell-v3");
    expect(text("public/sw.js")).toContain("rapp-auth.kwildfeuer.workers.dev");
    expect(text("public/sw.js")).toContain("api.githubcopilot.com");
    expect(text("public/sw.js")).toContain("raw.githubusercontent.com");
    expect(text("public/sw.js")).toContain("cdn.jsdelivr.net");
    expect(text("public/sw.js")).toContain("agent-cell.html");
    expect(text("public/sw.js")).toContain("asset-manifest.json");
  });

  it("keeps accessibility focus, safe areas, and push-to-talk release behavior explicit", () => {
    const app = text("src/app.ts");
    const styles = text("src/styles.css");
    expect(app).toContain('<main id="main" tabindex="-1">');
    expect(app).toContain('event.preventDefault();\n      document.querySelector<HTMLElement>("main")?.focus()');
    expect(app).toContain("if (routeChanged)");
    expect(app).toContain('aria-pressed="false"');
    for (const release of ["pointerup", "pointercancel", "keyup", "visibilitychange", "pagehide"]) {
      expect(app).toContain(`"${release}"`);
    }
    expect(app).not.toContain("setTimeout(() => this.#voice.stopListening()");
    expect(app).toContain("orbShortcutSurfaceOwnsFocus(event.target)");
    expect(app).toContain("event.code === \"Space\" && this.#orbShortcutMode");
    expect(app).toContain('this.#focusAfterRender = "#device-code-title"');
    expect(app).toContain('this.#focusAfterRender = "#ai-draft-output"');
    expect(app).not.toContain('id="ai-draft-output" aria-live');
    expect(app).not.toContain('await import("./orb-sensor")');
    expect(app).toContain('import { CameraAssist } from "./orb-sensor"');
    expect(styles).toContain("env(safe-area-inset-top)");
    expect(styles).toContain("env(safe-area-inset-right)");
    expect(styles).toContain("env(safe-area-inset-bottom)");
    expect(styles).toContain("linear-gradient(135deg, #765fd8, #4e3cad)");
    expect(styles).toContain("width: min(100%, 20rem)");
    expect(styles).toContain("overflow-wrap: anywhere");
  });

  it("keeps Adaptive Orb display, speech, and AI authority channels separate", () => {
    const app = text("src/app.ts");
    const stageStart = app.indexOf("async #stageAiOffering");
    const stageEnd = app.indexOf("async #logoutMind", stageStart);
    const stage = app.slice(stageStart, stageEnd);
    expect(app).toContain("this.#aiDraft = result.text;");
    expect(app).toContain("this.#aiVoice = result.voice;");
    expect(app).toContain('this.#voiceOutput = "Untrusted Copilot draft ready for review below."');
    expect(app).toContain("(voice) => this.#voice.speak(voice)");
    expect(app).not.toContain("this.#voice.speak(result.text)");
    expect(app).toContain("<summary>Spoken version</summary>");
    expect(app).toContain("Spoken version unavailable");
    expect(stage).toContain("const draft = this.#aiDraft");
    expect(stage).toContain("text: draft");
    expect(stage).not.toContain("#aiVoice");
    expect(app).toContain("assertMemberCanOffer(events, quest.questId, memberId)");
    expect(app).toContain("appendLocalEventExpectedRoot");
    expect(app).toContain("#routeGeneration");
    const downstream = ["src/peer.ts", "src/storage.ts", "src/heirloom.ts"]
      .map(text)
      .join("\n");
    expect(downstream).not.toContain("VOICE_RESPONSE_MARKER");
    expect(downstream).not.toContain("aiVoice");
  });

  it("invalidates Circle-scoped async UI and camera work across routes", () => {
    const app = text("src/app.ts");
    const disposeStart = app.indexOf("  #disposeRouteState(): void");
    const dispose = app.slice(
      disposeStart,
      app.indexOf("  #navigate", disposeStart),
    );
    for (const phrase of [
      "this.#routeGeneration += 1",
      'this.#voiceOutput = ""',
      "this.#clearAiState()",
      "this.#clearAgentState()",
      "this.#proposalGate.cancel()",
      "this.#invalidateCamera()",
    ]) {
      expect(dispose).toContain(phrase);
    }
    expect(app).toContain("pendingCandidate?.circleId === groupId");
    expect(app).toContain("#playReservationIsCurrent(groupId, routeGeneration)");
    expect(app).toContain("#proposalGate.stageReservationIsCurrent(reservation)");
    expect(app).toContain("generation !== this.#cameraEnableGeneration");
    expect(app).toContain("routeGeneration !== this.#routeGeneration");
  });

  it("uses explicit signaling with no TURN credential and keeps practice on-device", () => {
    const peer = text("src/peer.ts");
    const app = text("src/app.ts");
    expect(peer).toContain('host: "0.peerjs.com"');
    expect(peer).toContain("port: 443");
    expect(peer).toContain('urls: "stun:');
    expect(peer).not.toMatch(/turns?:/iu);
    expect(app).toContain("Simulation: both on-device demo keys approved");
    expect(app).toContain("Offline practice never opens PeerJS");
  });

  it("ships complete generated production dependency notices", () => {
    const notices = text("public/THIRD_PARTY_LICENSES.txt");
    const lock = JSON.parse(text("package-lock.json")) as {
      packages: Record<string, { dev?: boolean }>;
    };
    const production = Object.entries(lock.packages)
      .filter(([path, metadata]) => path.startsWith("node_modules/") && !metadata.dev)
      .map(([path]) => {
        const manifest = JSON.parse(text(`${path}/package.json`)) as { name: string; version: string };
        return `${manifest.name}@${manifest.version}`;
      });
    expect(production.length).toBeGreaterThan(4);
    for (const dependency of production) expect(notices).toContain(dependency);
    expect(text("public/sw.js")).toContain("THIRD_PARTY_LICENSES.txt");
    expect(text("package.json")).toContain("scripts/verify-build.mjs");
  });

  it.each([
    ["public/icons/apple-touch-icon.png", 180],
    ["public/icons/icon-192.png", 192],
    ["public/icons/icon-512.png", 512],
  ])("ships a real %ipx PNG at %s", (path, size) => {
    const png = readFileSync(join(root, path));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  });

  it("keeps normal runtime local and isolates the exact pinned Pyodide exception", () => {
    const runtimeFiles = ["index.html", ...filesUnder("src"), "public/manifest.webmanifest", "public/sw.js"];
    const runtime = runtimeFiles.map(text).join("\n");
    expect(runtime).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=["']https?:/iu);
    expect(runtime).not.toMatch(/@import\s+url\(["']?https?:/iu);
    expect(runtime).not.toMatch(/from\s+["']https?:/u);
    const cell = text("public/agent-cell.html");
    expect(text("src/agent-cell.ts")).toContain(
      'frame.setAttribute("sandbox", "allow-scripts")',
    );
    expect(cell).toContain(
      "script-src 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
    );
    expect(cell).toContain('const PYODIDE_VERSION = "0.26.4"');
    expect(cell).toContain("dd583a19c86414f98ae6c2c6d482f409c55679a4");
    expect(cell).toContain("ac249a9ddfddc9661d3f9093dc3b5149cb947bbba1556312d94f0fcd283bdc98");
    expect(cell).toContain("event.ports.length !== 1");
    expect(cell).toContain('window.removeEventListener("message", initialize)');
    expect(cell).not.toMatch(/allow-same-origin|allow-forms|allow-popups|allow-downloads/iu);
  });

  it("indexes four hash-matched BasicAgent-compatible Python sources that execute", () => {
    const manifest = JSON.parse(text("public/agents/manifest.json")) as {
      agents: Array<{ name: string; path: string; sha256: string }>;
    };
    expect(manifest.agents).toHaveLength(4);
    for (const agent of manifest.agents) {
      const path = join(root, "public/agents", agent.path);
      const source = readFileSync(path);
      expect(createHash("sha256").update(source).digest("hex")).toBe(agent.sha256);
      expect(source.toString("utf8")).toContain("def perform(self, **kwargs) -> str:");
      expect(source.toString("utf8")).toContain("self.metadata =");
      const script = [
        "import importlib.util, json, sys",
        "spec=importlib.util.spec_from_file_location('agent_under_test', sys.argv[1])",
        "module=importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "print(json.dumps({'name': module.AGENT.metadata['name'], 'result': module.AGENT.perform()}))",
      ].join("; ");
      const run = spawnSync("python3", ["-c", script, path], { encoding: "utf8" });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ name: agent.name });
    }
  });

  it("runs test, type-check, build, upload, and deploy in the Pages workflow", () => {
    const workflow = text(".github/workflows/pages.yml");
    for (const phrase of [
      "npm ci",
      "npm test",
      "npm run typecheck",
      "npm run build",
      "actions/upload-pages-artifact@v3",
      "actions/deploy-pages@v4",
    ]) {
      expect(workflow).toContain(phrase);
    }
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("github.event_name != 'pull_request'");
  });

  it("ships legal documents and generates a complete JS/CSS precache manifest", () => {
    const config = text("vite.config.ts");
    const serviceWorker = text("public/sw.js");
    for (const file of [
      "NOTICE.md",
      "LICENSE",
      "ROADMAP.md",
      "SECURITY.md",
      "PRIVACY.md",
      "PROTOCOL.md",
    ]) {
      expect(config).toContain(`"${file}"`);
      expect(serviceWorker).toContain(file);
    }
    expect(config).toContain('fileName: "asset-manifest.json"');
    expect(text("scripts/verify-build.mjs")).toContain(
      "does not list every built JS/CSS chunk",
    );
    expect(text("NOTICE.md")).not.toContain("/tmp/");
    expect(text("NOTICE.md")).toContain("kody-w/rapp-moonshots");
  });

  it("never replaces the cached navigation shell with an online 404", async () => {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const put = vi.fn(async () => undefined);
    const cache = {
      put,
      match: vi.fn(async () => undefined),
      addAll: vi.fn(async () => undefined),
    };
    const context = {
      self: {
        location: { origin: "https://example.test" },
        addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
          listeners.set(type, listener);
        },
      },
      caches: {
        open: vi.fn(async () => cache),
        match: vi.fn(async () => undefined),
        keys: vi.fn(async () => []),
        delete: vi.fn(async () => true),
      },
      fetch: vi.fn(async () => new Response("not found", { status: 404 })),
      URL,
      Set,
      Promise,
      Response,
      Error,
    };
    runInNewContext(text("public/sw.js"), context);
    let responsePromise: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: {
        method: "GET",
        mode: "navigate",
        url: "https://example.test/rapp-heir/",
      },
      respondWith(value: Promise<Response>) {
        responsePromise = value;
      },
    });
    expect((await responsePromise)?.status).toBe(404);
    expect(put).not.toHaveBeenCalled();
  });

  it("uses Pocket Quest Master rather than the avoided public product term", () => {
    const publicProduct = ["index.html", ...filesUnder("src"), "README.md"].map(text).join("\n");
    expect(publicProduct).not.toContain("Dungeon Master");
    expect(publicProduct).toContain("Pocket Quest Master");
  });
});
