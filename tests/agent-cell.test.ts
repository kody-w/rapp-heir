import { describe, expect, it, vi } from "vitest";
import {
  AgentCellClient,
  MAX_AGENT_ARGS_BYTES,
  PINNED_AGENT_MANIFEST_HASH,
  PINNED_AGENT_SOURCES,
  type AgentCellEnvironment,
} from "../src/agent-cell";
import {
  parseQuestMasterOutput,
  parseQuestSafetyOutput,
  questSafetyCandidate,
} from "../src/agent-proposals";

class FakePort {
  peer?: FakePort;
  closed = false;
  listeners = new Set<(event: MessageEvent<unknown>) => void>();

  postMessage(message: unknown): void {
    if (this.closed) return;
    queueMicrotask(() => {
      if (this.peer?.closed) return;
      for (const listener of this.peer?.listeners ?? []) {
        listener({ data: structuredClone(message) } as MessageEvent<unknown>);
      }
    });
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.delete(listener);
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }
}

function channel(): { port1: FakePort; port2: FakePort } {
  const port1 = new FakePort();
  const port2 = new FakePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

function environment(
  onTransfer: (port: FakePort) => void,
  loaded: Promise<void> = Promise.resolve(),
): AgentCellEnvironment & { destroyed: ReturnType<typeof vi.fn>; urls: string[] } {
  const destroyed = vi.fn();
  const urls: string[] = [];
  let nonce = 0;
  return {
    destroyed,
    urls,
    createFrame(url, frameNonce) {
      urls.push(`${url}#${frameNonce}`);
      return {
        loaded,
        transfer(port) {
          onTransfer(port as unknown as FakePort);
        },
        destroy: destroyed,
      };
    },
    createChannel: () => channel() as never,
    randomNonce: () => (++nonce).toString(16).padStart(32, "0"),
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (handle) => clearTimeout(handle),
  };
}

function validResult(agent: "QuestMaster" | "QuestSafety") {
  return {
    agent,
    manifestHash: PINNED_AGENT_MANIFEST_HASH,
    sourceHash: PINNED_AGENT_SOURCES[agent].sha256,
    output:
      agent === "QuestMaster"
        ? JSON.stringify({
            context_class: "park",
            member_count: 2,
            minutes_per_leg: "5-10",
            premise: "A harmless hidden threshold appears.",
            source: "offline-bundled-agent",
            title: "The Quiet Threshold",
            weather_band: "wind",
          })
        : JSON.stringify({
            allowed: true,
            note: "The TypeScript reducer must still validate before commit.",
            reasons: [],
            safe_text: "{}",
          }),
    metadata: { name: agent },
  };
}

describe("private verified agent cell client", () => {
  it("boots over one transferred port and accepts a fully pinned typed result", async () => {
    const env = environment((port) => {
      port.addEventListener("message", (event) => {
        const message = event.data as Record<string, unknown>;
        if (message.type === "run-agent") {
          port.postMessage({
            type: "agent-result",
            generation: message.generation,
            requestId: message.requestId,
            result: validResult("QuestMaster"),
          });
        }
      });
      port.postMessage({ type: "cell-ready", generation: 1 });
    });
    const client = new AgentCellClient({
      environment: env,
      cellUrl: "/rapp-heir/agent-cell.html",
    });
    const result = await client.runAgent("QuestMaster", {
      context_class: "park",
      weather_band: "wind",
      member_count: 2,
    });
    expect(result).toEqual(validResult("QuestMaster"));
    expect(env.urls[0]).toMatch(
      /^\/rapp-heir\/agent-cell\.html#[a-f0-9]{32}$/u,
    );
    client.teardown();
    expect(env.destroyed).toHaveBeenCalledOnce();
  });

  it("ignores stale IDs/generations and rejects wrong pinned hashes", async () => {
    let staleSent = false;
    const env = environment((port) => {
      port.addEventListener("message", (event) => {
        const message = event.data as Record<string, unknown>;
        if (message.type !== "run-agent") return;
        port.postMessage({
          type: "agent-result",
          generation: Number(message.generation) - 1,
          requestId: message.requestId,
          result: validResult("QuestMaster"),
        });
        staleSent = true;
        queueMicrotask(() =>
          port.postMessage({
            type: "agent-result",
            generation: message.generation,
            requestId: message.requestId,
            result: {
              ...validResult("QuestMaster"),
              sourceHash: "0".repeat(64),
            },
          }),
        );
      });
      port.postMessage({ type: "cell-ready" });
    });
    const client = new AgentCellClient({ environment: env });
    await expect(client.runAgent("QuestMaster", {})).rejects.toThrow(
      "does not match the pinned request",
    );
    expect(staleSent).toBe(true);
    client.teardown();
  });

  it("destroys the iframe on timeout, abort, and explicit teardown", async () => {
    const timeoutEnv = environment((port) => {
      port.postMessage({ type: "cell-ready" });
    });
    const timeoutClient = new AgentCellClient({
      environment: timeoutEnv,
      runTimeoutMs: 5,
    });
    await expect(timeoutClient.runAgent("QuestMaster", {})).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(timeoutEnv.destroyed).toHaveBeenCalledOnce();

    const abortEnv = environment((port) => {
      port.postMessage({ type: "cell-ready" });
    });
    const abortClient = new AgentCellClient({ environment: abortEnv });
    const controller = new AbortController();
    const running = abortClient.runAgent("QuestMaster", {}, controller.signal);
    await vi.waitFor(() => expect(abortClient.active).toBe(true));
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(abortEnv.destroyed).toHaveBeenCalledOnce();

    const teardownEnv = environment((port) => {
      port.postMessage({ type: "cell-ready" });
    });
    const teardownClient = new AgentCellClient({ environment: teardownEnv });
    await teardownClient.boot();
    teardownClient.teardown();
    expect(teardownClient.active).toBe(false);
    expect(teardownEnv.destroyed).toHaveBeenCalledOnce();
  });

  it("times out and destroys a fake iframe whose load never settles", async () => {
    const neverLoaded = new Promise<void>(() => undefined);
    const env = environment(() => undefined, neverLoaded);
    const client = new AgentCellClient({
      environment: env,
      bootTimeoutMs: 5,
    });

    await expect(client.boot()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(client.active).toBe(false);
    expect(env.destroyed).toHaveBeenCalledOnce();
  });

  it("aborts and destroys the iframe while its load is still pending", async () => {
    const transfer = vi.fn();
    const env = environment(transfer, new Promise<void>(() => undefined));
    const client = new AgentCellClient({ environment: env });
    const controller = new AbortController();
    const running = client.runAgent("QuestMaster", {}, controller.signal);
    await vi.waitFor(() => expect(client.active).toBe(true));

    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(client.active).toBe(false);
    expect(transfer).not.toHaveBeenCalled();
    expect(env.destroyed).toHaveBeenCalledOnce();
  });

  it("rejects non-allowlisted names and bounded-JSON violations before transfer", async () => {
    const env = environment(() => undefined);
    const client = new AgentCellClient({ environment: env });
    await expect(
      client.runAgent("PeerSupplied" as "QuestMaster", {}),
    ).rejects.toThrow("not allowlisted");
    await expect(
      client.runAgent("QuestMaster", {
        text: "x".repeat(MAX_AGENT_ARGS_BYTES + 1),
      }),
    ).rejects.toThrow("16 KiB");
    expect(env.urls).toEqual([]);
  });
});

describe("typed QuestMaster and QuestSafety output", () => {
  it("accepts only the complete bounded QuestMaster schema", () => {
    const parsed = parseQuestMasterOutput(validResult("QuestMaster").output);
    expect(parsed).toMatchObject({
      contextClass: "park",
      weatherBand: "wind",
      memberCount: 2,
      source: "offline-bundled-agent",
    });
    expect(() =>
      parseQuestMasterOutput(
        JSON.stringify({
          ...JSON.parse(validResult("QuestMaster").output),
          peerCode: "print('never execute me')",
        }),
      ),
    ).toThrow("unexpected field");
  });

  it("requires a coherent optional safety decision", () => {
    const proposal = parseQuestMasterOutput(validResult("QuestMaster").output);
    const candidate = questSafetyCandidate(proposal);
    expect(
      parseQuestSafetyOutput(
        JSON.stringify({
          allowed: true,
          reasons: [],
          safe_text: candidate,
          note: "The TypeScript reducer must still validate before commit.",
        }),
      ),
    ).toMatchObject({ allowed: true, safeText: candidate });
    expect(() =>
      parseQuestSafetyOutput(
        JSON.stringify({
          allowed: false,
          reasons: ["credentials"],
          safe_text: candidate,
          note: "Rejected",
        }),
      ),
    ).toThrow("must not provide");
  });
});
