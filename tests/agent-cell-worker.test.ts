import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  PINNED_AGENT_DIRECTORY,
  PINNED_AGENT_MANIFEST_URL,
} from "../src/agent-cell";

const root = process.cwd();
const html = readFileSync(join(root, "public", "agent-cell.html"), "utf8");
const workerStart = html.indexOf("function workerMain()");
const workerEnd = html.indexOf("\n        function post(message)", workerStart);
const workerSource = html.slice(workerStart, workerEnd).trim();
const manifestBytes = readFileSync(join(root, "public", "agents", "manifest.json"));
const questMasterBytes = readFileSync(
  join(root, "public", "agents", "quest_master_agent.py"),
);

function response(
  bytes: Uint8Array,
  url: string,
  options: {
    status?: number;
    type?: string;
    redirected?: boolean;
    declaredLength?: number;
  } = {},
): Response {
  const body = new Uint8Array(bytes).buffer;
  const value = new Response(body, {
    status: options.status ?? 200,
    headers: {
      "Content-Type": options.type ?? "text/plain; charset=utf-8",
      "Content-Length": String(options.declaredLength ?? bytes.byteLength),
    },
  });
  Object.defineProperties(value, {
    url: { value: url },
    redirected: { value: options.redirected ?? false },
  });
  return value;
}

async function execute(
  request: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let handler: ((event: { data: unknown }) => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const globals = new Map<string, unknown>();
  const self = {
    addEventListener(type: string, callback: (event: { data: unknown }) => void) {
      if (type === "message") handler = callback;
    },
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
    },
    loadPyodide: undefined as unknown,
  };
  const context = {
    self,
    fetch: fetchImpl,
    crypto,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Object,
    Array,
    Set,
    JSON,
    Error,
    Number,
    String,
    Boolean,
    RegExp,
    Promise,
    importScripts() {
      self.loadPyodide = async () => ({
        globals: {
          set: (key: string, value: unknown) => globals.set(key, value),
          delete: (key: string) => globals.delete(key),
        },
        runPythonAsync: async () =>
          JSON.stringify({
            output: JSON.stringify({
              context_class: "park",
              member_count: 2,
              minutes_per_leg: "5-10",
              premise: "A harmless proposal.",
              source: "offline-bundled-agent",
              title: "A Quiet Door",
              weather_band: "wind",
            }),
            metadata: { name: "QuestMaster" },
          }),
      });
    },
  };
  runInNewContext(`${workerSource}\nworkerMain();`, context);
  expect(handler).toBeTypeOf("function");
  handler?.({ data: request });
  await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
  return posted.at(-1)!;
}

function validFetch(overrides: {
  manifest?: Response;
  source?: Response;
} = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === PINNED_AGENT_MANIFEST_URL) {
      return (
        overrides.manifest ??
        response(manifestBytes, PINNED_AGENT_MANIFEST_URL, {
          type: "application/json",
        })
      );
    }
    if (url === `${PINNED_AGENT_DIRECTORY}/quest_master_agent.py`) {
      return (
        overrides.source ??
        response(questMasterBytes, url)
      );
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
}

const runRequest = {
  type: "run-agent",
  requestId: "agent_request_123",
  agent: "QuestMaster",
  args: { context_class: "park", weather_band: "wind", member_count: 2 },
};

describe("agent-cell worker verify-before-execute", () => {
  it("verifies exact local copies of the pinned manifest and source before a typed result", async () => {
    const result = await execute(runRequest, validFetch());
    expect(result).toMatchObject({
      type: "worker-result",
      requestId: runRequest.requestId,
      result: {
        agent: "QuestMaster",
        manifestHash:
          "ac249a9ddfddc9661d3f9093dc3b5149cb947bbba1556312d94f0fcd283bdc98",
        sourceHash:
          "5a155774b590d2127fda09b563fb04611b525082829b1da6c1ad7a0e28fd1e5d",
      },
    });
  });

  it("fails closed on manifest or source hash changes", async () => {
    const changedManifest = new Uint8Array([...manifestBytes, 0x20]);
    const manifestFailure = await execute(
      runRequest,
      validFetch({
        manifest: response(changedManifest, PINNED_AGENT_MANIFEST_URL),
      }),
    );
    expect(manifestFailure).toMatchObject({
      type: "worker-error",
      message: "Pinned manifest hash mismatch",
    });

    const changedSource = new Uint8Array(questMasterBytes);
    changedSource[0] = (changedSource[0] ?? 0) ^ 1;
    const sourceFailure = await execute(
      runRequest,
      validFetch({
        source: response(
          changedSource,
          `${PINNED_AGENT_DIRECTORY}/quest_master_agent.py`,
        ),
      }),
    );
    expect(sourceFailure).toMatchObject({
      type: "worker-error",
      message: "Pinned agent source hash mismatch",
    });
  });

  it("rejects redirect/final-URL drift, wrong MIME, status, and oversize bodies", async () => {
    const sourceUrl = `${PINNED_AGENT_DIRECTORY}/quest_master_agent.py`;
    const cases = [
      response(questMasterBytes, `${sourceUrl}?drift=1`, { redirected: true }),
      response(questMasterBytes, sourceUrl, { type: "text/html" }),
      response(questMasterBytes, sourceUrl, { status: 404 }),
      response(questMasterBytes, sourceUrl, { declaredLength: 64 * 1024 + 1 }),
    ];
    for (const candidate of cases) {
      const result = await execute(
        runRequest,
        validFetch({ source: candidate }),
      );
      expect(result.type).toBe("worker-error");
      expect(String(result.message)).toMatch(
        /exact URL and status|MIME type|byte limit/u,
      );
    }
  });

  it("has no path/source operation and rejects non-allowlisted names before fetch", async () => {
    const fetch = vi.fn();
    const result = await execute(
      { ...runRequest, agent: "../peer_agent.py" },
      fetch as typeof globalThis.fetch,
    );
    expect(result).toMatchObject({
      type: "worker-error",
      message: "Agent name is not allowlisted",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(workerSource).toContain('message.type !== "run-agent"');
    expect(workerSource).toContain("AGENTS[entry.name] !== entry.path");
    expect(workerSource).not.toContain("eval(");
  });
});
