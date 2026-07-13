import { canonicalStringify, utf8 } from "./canonical";

export const PYODIDE_VERSION = "0.26.4";
export const PINNED_AGENT_COMMIT = "dd583a19c86414f98ae6c2c6d482f409c55679a4";
export const PINNED_AGENT_MANIFEST_HASH =
  "ac249a9ddfddc9661d3f9093dc3b5149cb947bbba1556312d94f0fcd283bdc98";
export const PINNED_AGENT_DIRECTORY =
  `https://raw.githubusercontent.com/kody-w/rapp-heir/${PINNED_AGENT_COMMIT}/public/agents`;
export const PINNED_AGENT_MANIFEST_URL = `${PINNED_AGENT_DIRECTORY}/manifest.json`;
export const MAX_AGENT_ARGS_BYTES = 16 * 1_024;
export const MAX_AGENT_RESULT_BYTES = 32 * 1_024;
export const DEFAULT_AGENT_BOOT_TIMEOUT_MS = 65_000;
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 20_000;

export const PINNED_AGENT_SOURCES = {
  QuestMaster: {
    path: "quest_master_agent.py",
    sha256: "5a155774b590d2127fda09b563fb04611b525082829b1da6c1ad7a0e28fd1e5d",
  },
  QuestTurn: {
    path: "quest_turn_agent.py",
    sha256: "1d65187f700bf72bc133b4bb697544dbf79bcdaad12c31a6a181729cf6142a6d",
  },
  PartyMemory: {
    path: "party_memory_agent.py",
    sha256: "fcf9c3495a308d12bbae0ab2e96c7eac3d6563c362124bd02905e9310f4b03df",
  },
  QuestSafety: {
    path: "quest_safety_agent.py",
    sha256: "0310826a85b5ff9ba0d3e5cbee76f42997ec2667dd824e6a975ba83a6abefb17",
  },
} as const;

export type BuiltInAgentName = keyof typeof PINNED_AGENT_SOURCES;

export interface AgentCellResult {
  agent: BuiltInAgentName;
  manifestHash: typeof PINNED_AGENT_MANIFEST_HASH;
  sourceHash: string;
  output: string;
  metadata: Record<string, unknown>;
}

interface PortLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent<unknown>) => void): void;
  start(): void;
  close(): void;
}

interface ChannelLike {
  port1: PortLike;
  port2: PortLike;
}

export interface AgentCellFrame {
  readonly loaded: Promise<void>;
  transfer(port: PortLike, nonce: string): void;
  destroy(): void;
}

export interface AgentCellEnvironment {
  createFrame(url: string, nonce: string): AgentCellFrame;
  createChannel(): ChannelLike;
  randomNonce(): string;
  setTimer(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

export interface AgentCellClientOptions {
  cellUrl?: string;
  bootTimeoutMs?: number;
  runTimeoutMs?: number;
  environment?: AgentCellEnvironment;
}

interface PendingRun {
  generation: number;
  agent: BuiltInAgentName;
  resolve(result: AgentCellResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
  cleanupAbort(): void;
}

function abortError(message = "Verified agent request was cancelled"): DOMException {
  return new DOMException(message, "AbortError");
}

function timeoutError(message: string): DOMException {
  return new DOMException(message, "TimeoutError");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJson(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error("Agent arguments exceed the nesting limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Agent arguments contain a non-finite number");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error("Agent arguments contain an oversized array");
    value.forEach((item) => assertJson(item, depth + 1));
    return;
  }
  if (!isPlainObject(value)) throw new Error("Agent arguments must use plain JSON objects");
  const entries = Object.entries(value);
  if (entries.length > 256) throw new Error("Agent arguments contain too many fields");
  for (const [key, child] of entries) {
    if (!key || key.length > 128) throw new Error("Agent argument key is invalid");
    assertJson(child, depth + 1);
  }
}

function validateArgs(args: Record<string, unknown>): Record<string, unknown> {
  assertJson(args);
  if (utf8(canonicalStringify(args)).byteLength > MAX_AGENT_ARGS_BYTES) {
    throw new Error("Agent arguments exceed 16 KiB");
  }
  return structuredClone(args);
}

function validateResult(
  value: unknown,
  expectedAgent: BuiltInAgentName,
): AgentCellResult {
  if (!isPlainObject(value)) throw new Error("Verified agent returned an invalid result");
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 5 ||
    keys.join(",") !== "agent,manifestHash,metadata,output,sourceHash"
  ) {
    throw new Error("Verified agent result schema is invalid");
  }
  if (
    value.agent !== expectedAgent ||
    value.manifestHash !== PINNED_AGENT_MANIFEST_HASH ||
    value.sourceHash !== PINNED_AGENT_SOURCES[expectedAgent].sha256 ||
    typeof value.output !== "string" ||
    !isPlainObject(value.metadata)
  ) {
    throw new Error("Verified agent result does not match the pinned request");
  }
  assertJson(value.metadata);
  if (utf8(canonicalStringify(value)).byteLength > MAX_AGENT_RESULT_BYTES) {
    throw new Error("Verified agent result exceeds 32 KiB");
  }
  return structuredClone(value) as unknown as AgentCellResult;
}

function browserEnvironment(): AgentCellEnvironment {
  return {
    createFrame(url, nonce) {
      const frame = document.createElement("iframe");
      frame.hidden = true;
      frame.title = "Verified local RAPP agent bytecode cell";
      frame.referrerPolicy = "no-referrer";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("aria-hidden", "true");
      const loaded = new Promise<void>((resolve, reject) => {
        frame.addEventListener("load", () => resolve(), { once: true });
        frame.addEventListener(
          "error",
          () => reject(new Error("Verified agent cell could not load")),
          { once: true },
        );
      });
      frame.src = `${url}#${nonce}`;
      document.body.append(frame);
      return {
        loaded,
        transfer(port, expectedNonce) {
          if (!frame.contentWindow) throw new Error("Verified agent cell has no window");
          frame.contentWindow.postMessage(
            { type: "agent-cell-init", nonce: expectedNonce },
            "*",
            [port as MessagePort],
          );
        },
        destroy() {
          frame.remove();
        },
      };
    },
    createChannel() {
      return new MessageChannel() as unknown as ChannelLike;
    },
    randomNonce() {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (handle) => clearTimeout(handle),
  };
}

export class AgentCellClient {
  readonly #cellUrl: string;
  readonly #bootTimeoutMs: number;
  readonly #runTimeoutMs: number;
  readonly #environment: AgentCellEnvironment;
  #generation = 0;
  #requestSequence = 0;
  #frame: AgentCellFrame | undefined;
  #port: PortLike | undefined;
  #bootPromise: Promise<void> | undefined;
  #ready = false;
  #pending = new Map<string, PendingRun>();
  #resolveReady: (() => void) | undefined;
  #rejectBoot: ((error: Error) => void) | undefined;

  constructor(options: AgentCellClientOptions = {}) {
    this.#cellUrl = options.cellUrl ?? `${import.meta.env.BASE_URL}agent-cell.html`;
    this.#bootTimeoutMs = options.bootTimeoutMs ?? DEFAULT_AGENT_BOOT_TIMEOUT_MS;
    this.#runTimeoutMs = options.runTimeoutMs ?? DEFAULT_AGENT_RUN_TIMEOUT_MS;
    this.#environment = options.environment ?? browserEnvironment();
  }

  get generation(): number {
    return this.#generation;
  }

  get active(): boolean {
    return Boolean(this.#frame);
  }

  async boot(): Promise<void> {
    if (this.#ready && this.#frame && this.#port) return;
    if (this.#bootPromise) return this.#bootPromise;
    const generation = ++this.#generation;
    const nonce = this.#environment.randomNonce();
    if (!/^[a-f0-9]{32}$/u.test(nonce)) {
      throw new Error("Verified agent cell nonce source is invalid");
    }
    const frame = this.#environment.createFrame(this.#cellUrl, nonce);
    const channel = this.#environment.createChannel();
    this.#frame = frame;
    this.#port = channel.port1;
    channel.port1.addEventListener("message", this.#onMessage);
    channel.port1.start();
    const cellReady = new Promise<void>((resolve) => {
      this.#resolveReady = resolve;
    });
    const interrupted = new Promise<never>((_resolve, reject) => {
      this.#rejectBoot = reject;
    });
    void interrupted.catch(() => undefined);
    let bootPromise!: Promise<void>;
    bootPromise = (async () => {
      const timer = this.#environment.setTimer(() => {
        if (generation !== this.#generation) return;
        this.teardown(timeoutError("Verified agent cell boot timed out"));
      }, this.#bootTimeoutMs);
      try {
        await Promise.race([frame.loaded, interrupted]);
        if (generation !== this.#generation || frame !== this.#frame) throw abortError();
        frame.transfer(channel.port2, nonce);
        await Promise.race([cellReady, interrupted]);
        if (generation !== this.#generation || frame !== this.#frame) throw abortError();
        this.#ready = true;
      } catch (error) {
        if (generation === this.#generation) {
          this.teardown(
            error instanceof Error
              ? error
              : new Error("Verified agent cell boot failed"),
          );
        }
        throw error;
      } finally {
        this.#environment.clearTimer(timer);
        if (this.#bootPromise === bootPromise) {
          this.#resolveReady = undefined;
          this.#rejectBoot = undefined;
          this.#bootPromise = undefined;
        }
      }
    })();
    this.#bootPromise = bootPromise;
    void bootPromise.catch(() => undefined);
    return bootPromise;
  }

  async runAgent(
    agent: BuiltInAgentName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentCellResult> {
    if (!Object.hasOwn(PINNED_AGENT_SOURCES, agent)) {
      throw new Error("Agent name is not allowlisted");
    }
    const frozenArgs = validateArgs(args);
    if (signal?.aborted) throw abortError();
    if (signal) {
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const abortBoot = (): void => {
        const error = abortError();
        this.teardown(error);
        rejectAbort(error);
      };
      signal.addEventListener("abort", abortBoot, { once: true });
      try {
        await Promise.race([this.boot(), aborted]);
      } finally {
        signal.removeEventListener("abort", abortBoot);
      }
    } else {
      await this.boot();
    }
    if (signal?.aborted) {
      this.teardown(abortError());
      throw abortError();
    }
    if (!this.#port || !this.#ready) throw new Error("Verified agent cell is not ready");
    if (this.#pending.size > 0) {
      throw new Error("Another verified agent request is already running");
    }
    const generation = this.#generation;
    const requestId = `agent_${generation}_${++this.#requestSequence}_${this.#environment
      .randomNonce()
      .slice(0, 16)}`;
    return new Promise<AgentCellResult>((resolve, reject) => {
      const abort = (): void => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#port?.postMessage({ type: "cancel", generation, requestId });
        pending.cleanupAbort();
        this.#environment.clearTimer(pending.timer);
        this.#pending.delete(requestId);
        const error = abortError();
        reject(error);
        this.teardown(error);
      };
      signal?.addEventListener("abort", abort, { once: true });
      const timer = this.#environment.setTimer(() => {
        const pending = this.#pending.get(requestId);
        if (!pending || pending.generation !== this.#generation) return;
        this.#port?.postMessage({ type: "cancel", generation, requestId });
        pending.cleanupAbort();
        this.#pending.delete(requestId);
        const error = timeoutError("Verified agent execution timed out");
        reject(error);
        this.teardown(error);
      }, this.#runTimeoutMs);
      this.#pending.set(requestId, {
        generation,
        agent,
        resolve,
        reject,
        timer,
        cleanupAbort: () => signal?.removeEventListener("abort", abort),
      });
      this.#port?.postMessage({
        type: "run-agent",
        generation,
        requestId,
        agent,
        args: frozenArgs,
      });
    });
  }

  teardown(reason: Error = abortError("Verified agent cell was closed")): void {
    this.#generation += 1;
    this.#ready = false;
    this.#rejectBoot?.(reason);
    this.#resolveReady = undefined;
    this.#rejectBoot = undefined;
    this.#bootPromise = undefined;
    for (const pending of this.#pending.values()) {
      pending.cleanupAbort();
      this.#environment.clearTimer(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    if (this.#port) {
      this.#port.removeEventListener("message", this.#onMessage);
      this.#port.close();
    }
    this.#port = undefined;
    this.#frame?.destroy();
    this.#frame = undefined;
  }

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    const message = event.data;
    if (!isPlainObject(message)) return;
    if (message.type === "cell-ready") {
      this.#resolveReady?.();
      return;
    }
    if (
      typeof message.requestId !== "string" ||
      typeof message.generation !== "number"
    ) {
      if (message.type === "cell-error" && message.phase === "boot") {
        const error = new Error(
          typeof message.message === "string"
            ? message.message.slice(0, 400)
            : "Verified agent cell boot failed",
        );
        this.#rejectBoot?.(error);
      }
      return;
    }
    const pending = this.#pending.get(message.requestId);
    if (
      !pending ||
      pending.generation !== message.generation ||
      pending.generation !== this.#generation
    ) {
      return;
    }
    pending.cleanupAbort();
    this.#environment.clearTimer(pending.timer);
    this.#pending.delete(message.requestId);
    if (message.type === "agent-result") {
      try {
        pending.resolve(validateResult(message.result, pending.agent));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error("Verified agent result failed"));
      }
      return;
    }
    if (message.type === "agent-cancelled") {
      pending.reject(abortError());
      return;
    }
    if (message.type === "cell-error") {
      const error = new Error(
        typeof message.message === "string"
          ? message.message.slice(0, 400)
          : "Verified agent execution failed",
      );
      pending.reject(error);
      if (/timed out/iu.test(error.message)) this.teardown(error);
    }
  };
}
