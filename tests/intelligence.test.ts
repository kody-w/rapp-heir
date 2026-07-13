import { describe, expect, it, vi } from "vitest";
import {
  AiVoicePlaybackGate,
  approveRemoteContext,
  buildRemoteContextPreview,
  displayTextFromVoiceStream,
  IntelligenceService,
  isAllowedCopilotEndpoint,
  isAllowedGitHubVerificationUrl,
  MAX_AI_TEXT_CHARACTERS,
  MAX_AI_VOICE_CHARACTERS,
  MAX_REMOTE_CONTEXT_BYTES,
  parseBufferedChatResponse,
  parseIntelligenceResult,
  parseSseStream,
  REMOTE_RECIPIENT_CHAIN,
  safeLocalLegForProjection,
  VBRAINSTEM_WORKER,
  VOICE_RESPONSE_MARKER,
} from "../src/intelligence";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const device = {
  device_code: "device-code-123",
  user_code: "ABCD-EFGH",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 1,
};

const copilot = {
  token: "copilot-temporary-token",
  endpoints: { api: "https://api.githubcopilot.com" },
  expires_at: 9_999_999_999,
};

function nonSimpleRequestHeaders(init: RequestInit | undefined): string[] {
  const headers = new Headers(init?.headers);
  const nonSimple: string[] = [];
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (["accept", "accept-language", "content-language"].includes(lower)) return;
    if (lower === "content-type") {
      const mime = value.split(";", 1)[0]?.trim().toLowerCase();
      if (
        mime === "application/x-www-form-urlencoded" ||
        mime === "multipart/form-data" ||
        mime === "text/plain"
      ) return;
    }
    nonSimple.push(lower);
  });
  return nonSimple.sort();
}

async function connectedService(
  chatResponse?: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = String(request);
    calls.push({ url, init });
    if (url.endsWith("/api/auth/device")) return json(device);
    if (url.endsWith("/api/auth/device/poll")) return json({ access_token: "github-access-token" });
    if (url.endsWith("/api/copilot/token")) return json(copilot);
    if (chatResponse) return chatResponse(url, init);
    return json({
      choices: [
        {
          message: {
            content: `A bounded narrator draft.${VOICE_RESPONSE_MARKER}Here is the short spoken draft.`,
          },
        },
      ],
    });
  });
  const service = new IntelligenceService({
    fetch: fetch as typeof globalThis.fetch,
    sleep: async () => undefined,
    now: () => 1_000,
  });
  const session = await service.startDeviceLogin();
  expect(await session.completion).toEqual({ status: "authenticated" });
  return { service, calls, fetch };
}

describe("vBrainstem GitHub device login", () => {
  it("makes no automatic greeting or background request", () => {
    const fetch = vi.fn();
    const service = new IntelligenceService({ fetch: fetch as typeof globalThis.fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(service.authenticated).toBe(false);
    expect(service.chatHistory).toEqual([]);
  });

  it("uses only the fixed worker contract and keeps tokens out of browser storage", async () => {
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    const { service, calls } = await connectedService();
    expect(service.authenticated).toBe(true);
    expect(calls.slice(0, 3).map((call) => call.url)).toEqual([
      `${VBRAINSTEM_WORKER}/api/auth/device`,
      `${VBRAINSTEM_WORKER}/api/auth/device/poll`,
      `${VBRAINSTEM_WORKER}/api/copilot/token`,
    ]);
    expect(calls[0]?.init?.body).toBe("{}");
    expect(String(calls[0]?.init?.body)).not.toMatch(/circle|quest|member/iu);
    for (const call of calls.slice(0, 3)) {
      expect(call.init?.cache).toBe("no-store");
      expect(call.init?.credentials).toBe("omit");
      expect(call.init?.referrerPolicy).toBe("no-referrer");
      expect(new Headers(call.init?.headers).get("Cache-Control")).toBeNull();
    }
    expect(calls.slice(0, 3).map((call) => nonSimpleRequestHeaders(call.init))).toEqual([
      ["content-type"],
      ["content-type"],
      ["authorization"],
    ]);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    service.logout();
    expect(service.authenticated).toBe(false);
    vi.unstubAllGlobals();
  });

  it("honors slow_down before succeeding", async () => {
    const waits: number[] = [];
    let polls = 0;
    const fetch = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith("/api/auth/device")) return json({ ...device, interval: 2 });
      if (url.endsWith("/api/auth/device/poll")) {
        polls += 1;
        return polls === 1
          ? json({ error: "slow_down" })
          : json({ access_token: "github-access-token" });
      }
      return json(copilot);
    });
    const service = new IntelligenceService({
      fetch: fetch as typeof globalThis.fetch,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
      now: () => 1_000,
    });
    const session = await service.startDeviceLogin();
    expect(await session.completion).toEqual({ status: "authenticated" });
    expect(waits).toEqual([2_000, 7_000]);
  });

  it("handles denial, expiry, cancellation, and stale poll responses", async () => {
    const deniedFetch = vi.fn(async (request: RequestInfo | URL) =>
      String(request).endsWith("/api/auth/device")
        ? json(device)
        : json({ error: "access_denied" }),
    );
    const denied = new IntelligenceService({
      fetch: deniedFetch as typeof globalThis.fetch,
      sleep: async () => undefined,
      now: () => 1_000,
    });
    expect(await (await denied.startDeviceLogin()).completion).toEqual({ status: "denied" });

    let now = 1_000;
    const expired = new IntelligenceService({
      fetch: (async (request: RequestInfo | URL) =>
        String(request).endsWith("/api/auth/device")
          ? json({ ...device, expires_in: 1 })
          : json({ error: "authorization_pending" })) as typeof globalThis.fetch,
      sleep: async () => {
        now += 1_000;
      },
      now: () => now,
    });
    expect(await (await expired.startDeviceLogin()).completion).toEqual({ status: "expired" });

    let resolvePoll!: (response: Response) => void;
    const staleFetch = vi.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith("/api/auth/device")) return Promise.resolve(json(device));
      return new Promise<Response>((resolve) => {
        resolvePoll = resolve;
      });
    });
    const stale = new IntelligenceService({
      fetch: staleFetch as typeof globalThis.fetch,
      sleep: async () => undefined,
      now: () => 1_000,
    });
    const session = await stale.startDeviceLogin();
    await Promise.resolve();
    session.cancel();
    resolvePoll(json({ access_token: "stale-token" }));
    expect(await session.completion).toEqual({ status: "cancelled" });
    expect(stale.authenticated).toBe(false);
  });

  it("does not commit a staged GitHub token when cancelled during Copilot exchange", async () => {
    let resolveExchange!: (response: Response) => void;
    const exchange = new Promise<Response>((resolve) => {
      resolveExchange = resolve;
    });
    const fetch = vi.fn((request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith("/api/auth/device")) return Promise.resolve(json(device));
      if (url.endsWith("/api/auth/device/poll")) {
        return Promise.resolve(json({ access_token: "staged-github-token" }));
      }
      return exchange;
    });
    const service = new IntelligenceService({
      fetch: fetch as typeof globalThis.fetch,
      sleep: async () => undefined,
      now: () => 1_000,
    });
    const session = await service.startDeviceLogin();
    await vi.waitFor(() =>
      expect(
        fetch.mock.calls.some(([request]) =>
          String(request).endsWith("/api/copilot/token"),
        ),
      ).toBe(true),
    );
    session.cancel();
    resolveExchange(json(copilot));
    await expect(session.completion).resolves.toEqual({ status: "cancelled" });
    expect(service.authenticated).toBe(false);
  });
});

describe("bounded Copilot context and endpoints", () => {
  it("allows only HTTPS GitHub verification and Copilot hosts", () => {
    expect(isAllowedGitHubVerificationUrl("https://github.com/login/device")).toBe(true);
    expect(isAllowedGitHubVerificationUrl("http://github.com/login/device")).toBe(false);
    expect(isAllowedGitHubVerificationUrl("https://github.com.evil.test/login/device")).toBe(false);
    expect(isAllowedCopilotEndpoint("https://api.githubcopilot.com")).toBe(true);
    expect(isAllowedCopilotEndpoint("https://api.individual.githubcopilot.com/chat")).toBe(true);
    expect(isAllowedCopilotEndpoint("http://api.githubcopilot.com")).toBe(false);
    expect(isAllowedCopilotEndpoint("https://githubcopilot.com.evil.test")).toBe(false);
  });

  it("omits forbidden canaries and produces exact approved bytes under 4 KiB", async () => {
    const canary = "FORBIDDEN-CANARY-9c72";
    const input = {
      draft: "Please plan a tiny safe next step.",
      quest: {
        title: "Lantern",
        premise: "A local premise",
        contextClass: "park",
        weatherBand: "wind",
        localRole: "Scout",
        minutes: 7,
        safeLocalLeg: "Notice a harmless texture.",
      },
      organism: {
        aura: 0.7,
        motion: 0.2,
        hue: 241,
        rings: 2,
        structuralMolts: 1,
        memberCount: 3,
      },
      circle: { status: "founded", chapter: 1, eventCount: 4 },
      circleId: canary,
      name: canary,
      oath: canary,
      memberIds: [canary],
      signatures: [canary],
      memories: canary,
      peerText: canary,
      heirloomBytes: canary,
    };
    const preview = buildRemoteContextPreview(input);
    expect(preview.recipientChain).toBe(REMOTE_RECIPIENT_CHAIN);
    expect(preview.bytes.byteLength).toBeLessThanOrEqual(MAX_REMOTE_CONTEXT_BYTES);
    expect(new TextDecoder().decode(preview.bytes)).toBe(preview.text);
    expect(preview.text).not.toContain(canary);
    const approved = await approveRemoteContext(preview);
    expect(approved.preview.text).toBe(preview.text);
    expect(
      safeLocalLegForProjection(
        `Notice a harmless texture. Because the previous offering chose “${canary},” carry it forward.`,
      ),
    ).toBe("Notice a harmless texture.");
  });

  it("transmits the preview text exactly and exposes no tools or authority", async () => {
    let body = "";
    const { service, calls } = await connectedService((_url, init) => {
      body = String(init?.body);
      return json({
        choices: [
          {
            message: {
              content: `Try one reversible step.${VOICE_RESPONSE_MARKER}Try one small step.`,
            },
          },
        ],
      });
    });
    const preview = buildRemoteContextPreview({ draft: "Plan the next safe local leg." });
    const result = await service.chat(await approveRemoteContext(preview));
    const request = JSON.parse(body) as {
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
      tool_choice?: unknown;
    };
    expect(request.messages[1]?.content).toBe(preview.text);
    expect(new TextEncoder().encode(request.messages[1]?.content).byteLength).toBe(
      preview.bytes.byteLength,
    );
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("tool_choice");
    const chatCall = calls.at(-1);
    expect(chatCall?.init?.cache).toBe("no-store");
    expect(new Headers(chatCall?.init?.headers).has("Cache-Control")).toBe(false);
    expect(nonSimpleRequestHeaders(chatCall?.init)).toEqual([
      "authorization",
      "content-type",
    ]);
    const system = request.messages[0]?.content ?? "";
    expect(system.match(/\|\|\|VOICE\|\|\|/gu)).toHaveLength(1);
    expect(system).toMatch(/exactly one/iu);
    expect(system).toMatch(/full formatted display answer/iu);
    expect(system).toMatch(/2–3 short sentences/iu);
    expect(system).toMatch(/no Markdown, URLs, code, emoji/iu);
    expect(result).toEqual({
      text: "Try one reversible step.",
      voice: "Try one small step.",
    });
    expect(service.chatHistory).toHaveLength(2);
    expect(service.chatHistory[1]?.text).toBe(result.text);
    expect(JSON.stringify(service.chatHistory)).not.toContain(result.voice);
    service.logout();
    expect(service.chatHistory).toEqual([]);
  });
});

describe("RAPP Installer voice response contract", () => {
  it("splits a complete response into bounded display and spoken versions", () => {
    const result = parseIntelligenceResult(
      `# Lantern plan\n\n- Take one reversible step.${VOICE_RESPONSE_MARKER}\nTake one small step and see how it feels.`,
    );
    expect(result).toEqual({
      text: "# Lantern plan\n\n- Take one reversible step.",
      voice: "Take one small step and see how it feels.",
    });
  });

  it("requires exactly one marker and never speaks a multiple-marker tail", () => {
    expect(
      parseIntelligenceResult(
        `Display answer${VOICE_RESPONSE_MARKER}Spoken first ${VOICE_RESPONSE_MARKER} untrusted remainder`,
      ),
    ).toEqual({
      text: "Display answer",
      voice: "",
    });
  });

  it("bounds missing-marker output and leaves speech honestly unavailable", () => {
    const result = parseIntelligenceResult("x".repeat(MAX_AI_TEXT_CHARACTERS + 100));
    expect(result.text).toHaveLength(MAX_AI_TEXT_CHARACTERS);
    expect(result.voice).toBe("");
    expect(parseIntelligenceResult("Display answer |||VOI")).toEqual({
      text: "Display answer",
      voice: "",
    });
    expect(parseIntelligenceResult(`Display answer${VOICE_RESPONSE_MARKER}`)).toEqual({
      text: "Display answer",
      voice: "",
    });
    expect(parseIntelligenceResult(42)).toEqual({ text: "", voice: "" });
    const boundedVoice = parseIntelligenceResult(
      `Display${VOICE_RESPONSE_MARKER}${"v".repeat(MAX_AI_VOICE_CHARACTERS + 100)}`,
    );
    expect(boundedVoice.voice).toHaveLength(MAX_AI_VOICE_CHARACTERS);
  });

  it("holds partial marker suffixes and never exposes the marker or voice tail", () => {
    const displays = [
      "Formatted answer",
      "Formatted answer |",
      "Formatted answer |||VOI",
      `Formatted answer ${VOICE_RESPONSE_MARKER}Voice tail`,
    ].map(displayTextFromVoiceStream);
    expect(displays).toEqual([
      "Formatted answer",
      "Formatted answer",
      "Formatted answer",
      "Formatted answer",
    ]);
    expect(displays.join(" ")).not.toContain("VOICE");
    expect(displays.join(" ")).not.toContain("Voice tail");
  });

  it("never turns malformed SSE/JSON or malformed markers into speech", () => {
    for (const raw of [
      `Display|||VOICE||Spoken canary`,
      `Display${VOICE_RESPONSE_MARKER}Voice${VOICE_RESPONSE_MARKER}Canary`,
      `Display${VOICE_RESPONSE_MARKER}data: {"voice":"raw protocol"}`,
      'data: {"choices":[{"delta":{"content":"raw canary"}}',
      '{"choices": [not valid JSON]}',
    ]) {
      const buffered = parseBufferedChatResponse(raw);
      const result = parseIntelligenceResult(buffered);
      expect(result.voice).toBe("");
      expect(result.text).not.toContain("Spoken canary");
      expect(result.text).not.toContain("raw canary");
    }
  });

  it("speaks only a current voice tail, at most once, and rejects stale or missing tails", () => {
    const gate = new AiVoicePlaybackGate();
    const speak = vi.fn();
    const result = {
      text: "**Formatted display only**",
      voice: "Plain spoken line.",
    };
    expect(gate.speakOnce(4, 4, result, speak)).toBe(true);
    expect(gate.speakOnce(4, 4, result, speak)).toBe(false);
    expect(gate.speakOnce(5, 6, result, speak)).toBe(false);
    expect(gate.speakOnce(6, 6, { text: "Display", voice: "" }, speak)).toBe(false);
    expect(speak).toHaveBeenCalledOnce();
    expect(speak).toHaveBeenCalledWith("Plain spoken line.");
    expect(speak).not.toHaveBeenCalledWith(result.text);
  });
});

describe("Copilot response transport", () => {
  it("parses fragmented UTF-8, CRLF, multiline SSE, and DONE", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(
      'data: {"choices":[{"delta":{"content":"Hi "}}]}\r\n\r\ndata: {"choices":[{"delta":\r\ndata: {"content":"🌙"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    );
    const cuts = [1, 5, 17, 49, 70, bytes.length - 2, bytes.length];
    let start = 0;
    const chunks = cuts.map((end) => {
      const chunk = bytes.slice(start, end);
      start = end;
      return chunk;
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    });
    const deltas: string[] = [];
    expect(await parseSseStream(stream, (text) => deltas.push(text))).toBe("Hi 🌙");
    expect(deltas.at(-1)).toBe("Hi 🌙");
  });

  it("supports JSON and buffered text fallback", () => {
    expect(
      parseBufferedChatResponse(
        JSON.stringify({ choices: [{ message: { content: "Buffered JSON" } }] }),
      ),
    ).toBe("Buffered JSON");
    expect(parseBufferedChatResponse("plain buffered response")).toBe("plain buffered response");
  });

  it("aborts an in-flight SSE reader", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // The abort listener cancels this otherwise-open stream.
      },
    });
    const parsing = parseSseStream(stream, undefined, controller.signal);
    controller.abort();
    await expect(parsing).rejects.toMatchObject({ name: "AbortError" });
  });

  it("falls back to the fixed worker proxy only when direct CORS fetch fails", async () => {
    const { service, calls } = await connectedService((url) => {
      if (url.startsWith("https://api.githubcopilot.com")) throw new TypeError("CORS");
      return json({
        choices: [
          {
            message: {
              content: `Proxy draft${VOICE_RESPONSE_MARKER}Short proxy draft.`,
            },
          },
        ],
      });
    });
    const preview = buildRemoteContextPreview({ draft: "A proxy-safe prompt." });
    expect(await service.chat(await approveRemoteContext(preview))).toEqual({
      text: "Proxy draft",
      voice: "Short proxy draft.",
    });
    const chatCalls = calls.slice(3).map((call) => call.url);
    expect(chatCalls[0]).toBe("https://api.githubcopilot.com/chat/completions");
    expect(chatCalls[1]).toContain(`${VBRAINSTEM_WORKER}/api/copilot/chat?endpoint=`);
  });

  it("refreshes a short-lived Copilot token once after 401", async () => {
    let chats = 0;
    let exchanges = 0;
    const fetch = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith("/api/auth/device")) return json(device);
      if (url.endsWith("/api/auth/device/poll")) return json({ access_token: "github-token" });
      if (url.endsWith("/api/copilot/token")) {
        exchanges += 1;
        return json({ ...copilot, token: `copilot-token-${exchanges}` });
      }
      chats += 1;
      return chats === 1
        ? json({ error: "expired" }, 401)
        : json({
            choices: [
              {
                message: {
                  content: `Refreshed once${VOICE_RESPONSE_MARKER}The draft refreshed once.`,
                },
              },
            ],
          });
    });
    const service = new IntelligenceService({
      fetch: fetch as typeof globalThis.fetch,
      sleep: async () => undefined,
      now: () => 1_000,
    });
    expect(await (await service.startDeviceLogin()).completion).toEqual({
      status: "authenticated",
    });
    const preview = buildRemoteContextPreview({ draft: "Refresh safely." });
    expect(await service.chat(await approveRemoteContext(preview))).toEqual({
      text: "Refreshed once",
      voice: "The draft refreshed once.",
    });
    expect(exchanges).toBe(2);
    expect(chats).toBe(2);
  });

  it("keeps split markers and the voice tail out of streaming display callbacks", async () => {
    const encoder = new TextEncoder();
    const events = [
      'data: {"choices":[{"delta":{"content":"# Display answer"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" |||VOI"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"CE|||Plain spoken answer."}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { service } = await connectedService(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              events.forEach((event) => controller.enqueue(encoder.encode(event)));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const preview = buildRemoteContextPreview({ draft: "Stream safely." });
    const displays: string[] = [];
    const result = await service.chat(
      await approveRemoteContext(preview),
      (display) => displays.push(display),
    );
    expect(result).toEqual({
      text: "# Display answer",
      voice: "Plain spoken answer.",
    });
    expect(displays.at(-1)).toBe("# Display answer");
    expect(displays.join("\n")).not.toContain(VOICE_RESPONSE_MARKER);
    expect(displays.join("\n")).not.toContain("Plain spoken answer");
  });

  it("a new preview request aborts the old stream and only the current result enters history", async () => {
    let chats = 0;
    const cancel = vi.fn();
    const { service } = await connectedService(() => {
      chats += 1;
      if (chats === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {},
            cancel,
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }
      return json({
        choices: [
          {
            message: {
              content: `Current display${VOICE_RESPONSE_MARKER}Current voice.`,
            },
          },
        ],
      });
    });
    const firstPreview = buildRemoteContextPreview({ draft: "First stale preview." });
    const secondPreview = buildRemoteContextPreview({ draft: "Second current preview." });
    const first = service.chat(await approveRemoteContext(firstPreview));
    await vi.waitFor(() => expect(chats).toBe(1));
    const second = service.chat(await approveRemoteContext(secondPreview));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toEqual({
      text: "Current display",
      voice: "Current voice.",
    });
    expect(cancel).toHaveBeenCalled();
    expect(service.chatHistory).toHaveLength(2);
    expect(service.chatHistory[0]?.text).toContain("Second current preview");
    expect(JSON.stringify(service.chatHistory)).not.toContain("First stale preview");
  });
});
