import { canonicalStringify, sha256, utf8 } from "./canonical";

export const VBRAINSTEM_WORKER = "https://rapp-auth.kwildfeuer.workers.dev";
export const COPILOT_MODEL = "gpt-4o";
export const MAX_REMOTE_CONTEXT_BYTES = 4 * 1_024;
export const REMOTE_RECIPIENT_CHAIN = "RAPP auth worker → GitHub Copilot";
export const VOICE_RESPONSE_MARKER = "|||VOICE|||";
export const MAX_AI_TEXT_CHARACTERS = 2_000;
export const MAX_AI_TEXT_BYTES = 6_000;
export const MAX_AI_VOICE_CHARACTERS = 600;
export const MAX_AI_VOICE_BYTES = 1_200;
const MALFORMED_PROTOCOL_SENTINEL = "|||RAPP_PROTOCOL_MALFORMED|||";
const MALFORMED_PROTOCOL_DISPLAY =
  "The remote response used malformed protocol data. It was not spoken or staged.";

const DEVICE_START_PATH = "/api/auth/device";
const DEVICE_POLL_PATH = "/api/auth/device/poll";
const COPILOT_TOKEN_PATH = "/api/copilot/token";
const COPILOT_CHAT_PATH = "/api/copilot/chat";

type FetchLike = typeof fetch;

export interface IntelligenceProjectionInput {
  draft: string;
  quest?: {
    title?: string;
    premise?: string;
    contextClass?: string;
    weatherBand?: string;
    localRole?: string;
    minutes?: number;
    safeLocalLeg?: string;
  };
  organism?: {
    aura?: number;
    motion?: number;
    hue?: number;
    rings?: number;
    structuralMolts?: number;
    memberCount?: number;
  };
  circle?: {
    status?: string;
    chapter?: number;
    eventCount?: number;
    questCount?: number;
    offeringCount?: number;
    revealCount?: number;
  };
}

export interface IntelligenceProjection {
  version: 1;
  userDraft: string;
  quest: {
    title: string;
    premise: string;
    contextClass: string;
    weatherBand: string;
    localRole: string;
    minutes: number;
    safeLocalLeg: string;
  } | null;
  organism: {
    auraBand: "quiet" | "awake" | "radiant";
    motionBand: "still" | "drifting" | "lively";
    hueFamily: "red" | "orange" | "yellow" | "green" | "blue" | "violet";
    rings: number;
    molts: number;
    memberCount: number;
  } | null;
  circle: {
    status: "forming" | "founded" | "heirloom-ready" | "unknown";
    chapter: number;
    counts: {
      events: number;
      quests: number;
      offerings: number;
      reveals: number;
    };
  };
}

export interface RemoteContextPreview {
  projection: IntelligenceProjection;
  text: string;
  bytes: Uint8Array<ArrayBuffer>;
  recipientChain: typeof REMOTE_RECIPIENT_CHAIN;
}

export interface ApprovedRemoteContext {
  preview: RemoteContextPreview;
  approvedDigest: string;
  approvedAt: number;
}

export interface IntelligenceResult {
  text: string;
  voice: string;
}

function boundedInteger(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? Math.min(Math.max(value, 0), maximum)
    : 0;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const width = utf8(character).byteLength;
    if (bytes + width > maximumBytes) break;
    output += character;
    bytes += width;
  }
  return output;
}

function boundedText(value: unknown, maximumCharacters: number, maximumBytes: number): string {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, maximumCharacters);
  return truncateUtf8(clean, maximumBytes);
}

function withoutPartialVoiceMarker(value: string): string {
  const maximum = Math.min(value.length, VOICE_RESPONSE_MARKER.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (VOICE_RESPONSE_MARKER.startsWith(value.slice(-length))) {
      return value.slice(0, -length);
    }
  }
  return value;
}

function markerCount(value: string): number {
  return value.split(VOICE_RESPONSE_MARKER).length - 1;
}

function protocolLooking(value: string): boolean {
  const trimmed = value.trimStart();
  return (
    /^(?:data\s*:|event\s*:|id\s*:|retry\s*:)/iu.test(trimmed) ||
    /^[\[{]/u.test(trimmed)
  );
}

function displayPrefix(value: string): string {
  const malformedIndex = value.indexOf(MALFORMED_PROTOCOL_SENTINEL);
  const markerIndex = value.indexOf(VOICE_RESPONSE_MARKER);
  const protocolDelimiter = value.indexOf("|||");
  const indexes = [malformedIndex, markerIndex, protocolDelimiter].filter(
    (index) => index >= 0,
  );
  const end = indexes.length > 0 ? Math.min(...indexes) : value.length;
  return withoutPartialVoiceMarker(value.slice(0, end));
}

export function displayTextFromVoiceStream(value: unknown): string {
  if (typeof value !== "string") return "";
  return boundedText(displayPrefix(value), MAX_AI_TEXT_CHARACTERS, MAX_AI_TEXT_BYTES);
}

export function parseIntelligenceResult(value: unknown): IntelligenceResult {
  if (typeof value !== "string") return { text: "", voice: "" };
  if (value.includes(MALFORMED_PROTOCOL_SENTINEL)) {
    return {
      text:
        boundedText(displayPrefix(value), MAX_AI_TEXT_CHARACTERS, MAX_AI_TEXT_BYTES) ||
        MALFORMED_PROTOCOL_DISPLAY,
      voice: "",
    };
  }
  const count = markerCount(value);
  const markerIndex = value.indexOf(VOICE_RESPONSE_MARKER);
  if (count !== 1 || markerIndex < 0) {
    return {
      text: boundedText(
        displayPrefix(value),
        MAX_AI_TEXT_CHARACTERS,
        MAX_AI_TEXT_BYTES,
      ),
      voice: "",
    };
  }
  const tail = value.slice(markerIndex + VOICE_RESPONSE_MARKER.length);
  if (
    tail.includes("|||") ||
    protocolLooking(value.slice(0, markerIndex)) ||
    protocolLooking(tail)
  ) {
    return {
      text: boundedText(value.slice(0, markerIndex), MAX_AI_TEXT_CHARACTERS, MAX_AI_TEXT_BYTES),
      voice: "",
    };
  }
  return {
    text: boundedText(
      value.slice(0, markerIndex),
      MAX_AI_TEXT_CHARACTERS,
      MAX_AI_TEXT_BYTES,
    ),
    voice: boundedText(
      tail,
      MAX_AI_VOICE_CHARACTERS,
      MAX_AI_VOICE_BYTES,
    ).replace(/\s+/gu, " "),
  };
}

export class AiVoicePlaybackGate {
  #spokenGeneration: number | undefined;

  speakOnce(
    generation: number,
    currentGeneration: number,
    result: IntelligenceResult,
    speak: (voice: string) => void,
  ): boolean {
    if (
      !Number.isSafeInteger(generation) ||
      generation !== currentGeneration ||
      !result.voice ||
      this.#spokenGeneration === generation
    ) {
      return false;
    }
    this.#spokenGeneration = generation;
    speak(result.voice);
    return true;
  }
}

export function safeLocalLegForProjection(value: unknown): string {
  return boundedText(value, 600, 700)
    .replace(/\s+(?:Because the previous offering|You are first in this part of the Braid)[\s\S]*$/u, "")
    .trim();
}

function band(
  value: unknown,
  names: readonly [string, string, string],
): (typeof names)[number] {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
  return names[number < 0.34 ? 0 : number < 0.67 ? 1 : 2];
}

export function hueFamily(
  value: unknown,
): NonNullable<IntelligenceProjection["organism"]>["hueFamily"] {
  const hue = typeof value === "number" && Number.isFinite(value) ? ((value % 360) + 360) % 360 : 0;
  return (["red", "orange", "yellow", "green", "blue", "violet"] as const)[Math.floor(hue / 60)] ?? "red";
}

function circleStatus(value: unknown): IntelligenceProjection["circle"]["status"] {
  return value === "forming" || value === "founded" || value === "heirloom-ready" ? value : "unknown";
}

function projectionText(projection: IntelligenceProjection): RemoteContextPreview {
  const text = canonicalStringify(projection);
  const bytes = utf8(text);
  if (bytes.byteLength > MAX_REMOTE_CONTEXT_BYTES) {
    throw new Error("Approved AI context exceeds 4 KiB");
  }
  return {
    projection,
    text,
    bytes,
    recipientChain: REMOTE_RECIPIENT_CHAIN,
  };
}

export function buildRemoteContextPreview(input: IntelligenceProjectionInput): RemoteContextPreview {
  const quest = input.quest
    ? {
        title: boundedText(input.quest.title, 120, 240),
        premise: boundedText(input.quest.premise, 500, 600),
        contextClass: boundedText(input.quest.contextClass, 24, 48) || "unknown",
        weatherBand: boundedText(input.quest.weatherBand, 24, 48) || "unknown",
        localRole: boundedText(input.quest.localRole, 24, 48) || "unknown",
        minutes: boundedInteger(input.quest.minutes, 60),
        safeLocalLeg: safeLocalLegForProjection(input.quest.safeLocalLeg),
      }
    : null;
  const organism = input.organism
    ? {
        auraBand: band(input.organism.aura, ["quiet", "awake", "radiant"]) as
          | "quiet"
          | "awake"
          | "radiant",
        motionBand: band(input.organism.motion, ["still", "drifting", "lively"]) as
          | "still"
          | "drifting"
          | "lively",
        hueFamily: hueFamily(input.organism.hue),
        rings: boundedInteger(input.organism.rings, 10_000),
        molts: boundedInteger(input.organism.structuralMolts, 10_000),
        memberCount: boundedInteger(input.organism.memberCount, 64),
      }
    : null;
  const projection: IntelligenceProjection = {
    version: 1,
    userDraft: boundedText(input.draft, 600, 2_400),
    quest,
    organism,
    circle: {
      status: circleStatus(input.circle?.status),
      chapter: boundedInteger(input.circle?.chapter, 10_000),
      counts: {
        events: boundedInteger(input.circle?.eventCount, 256),
        quests: boundedInteger(input.circle?.questCount, 256),
        offerings: boundedInteger(input.circle?.offeringCount, 256),
        reveals: boundedInteger(input.circle?.revealCount, 256),
      },
    },
  };
  if (!projection.userDraft) throw new Error("Enter a draft before previewing remote AI context");
  return projectionText(projection);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

const FORBIDDEN_PROJECTION_KEYS = new Set([
  "circleid",
  "groupid",
  "memberid",
  "name",
  "oath",
  "key",
  "keys",
  "signature",
  "signatures",
  "hash",
  "root",
  "timestamp",
  "createdat",
  "roster",
  "order",
  "invite",
  "pin",
  "peerjs",
  "kited",
  "privatekey",
  "audio",
  "location",
  "memories",
  "history",
  "heirloom",
  "replica",
]);

function assertProjectionKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertProjectionKeys);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_PROJECTION_KEYS.has(key.toLocaleLowerCase())) {
      throw new Error("AI context contains a forbidden field");
    }
    assertProjectionKeys(child);
  }
}

function validatePreview(preview: RemoteContextPreview): void {
  if (preview.recipientChain !== REMOTE_RECIPIENT_CHAIN) {
    throw new Error("Remote recipient chain changed");
  }
  const canonical = canonicalStringify(preview.projection);
  const bytes = utf8(canonical);
  if (
    canonical !== preview.text ||
    !equalBytes(bytes, preview.bytes) ||
    bytes.byteLength > MAX_REMOTE_CONTEXT_BYTES
  ) {
    throw new Error("Remote context no longer matches its preview");
  }
  assertProjectionKeys(preview.projection);
}

export async function approveRemoteContext(
  preview: RemoteContextPreview,
  now = Date.now(),
): Promise<ApprovedRemoteContext> {
  validatePreview(preview);
  return {
    preview: structuredClone(preview),
    approvedDigest: await sha256(preview.bytes),
    approvedAt: now,
  };
}

export function isAllowedGitHubVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      (url.pathname === "/login/device" || url.pathname === "/login/device/")
    );
  } catch {
    return false;
  }
}

const COPILOT_HOSTS = new Set([
  "api.githubcopilot.com",
  "api.individual.githubcopilot.com",
  "api.business.githubcopilot.com",
  "api.enterprise.githubcopilot.com",
  "copilot-proxy.githubusercontent.com",
]);

export function isAllowedCopilotEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && COPILOT_HOSTS.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function chatCompletionsEndpoint(endpoint: string): string {
  if (!isAllowedCopilotEndpoint(endpoint)) throw new Error("Copilot returned an untrusted endpoint");
  const url = new URL(endpoint);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/u, "");
  if (!url.pathname.endsWith("/chat/completions")) {
    url.pathname = `${url.pathname}/chat/completions`.replace(/\/{2,}/gu, "/");
  }
  return url.toString();
}

function abortError(): DOMException {
  return new DOMException("Operation cancelled", "AbortError");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function noStoreInit(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  };
}

interface DeviceStartResponse {
  device_code?: unknown;
  user_code?: unknown;
  verification_uri?: unknown;
  verification_uri_complete?: unknown;
  expires_in?: unknown;
  interval?: unknown;
}

export interface DeviceCodeView {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalSeconds: number;
}

export type DeviceLoginResult =
  | { status: "authenticated" }
  | { status: "cancelled" }
  | { status: "denied" }
  | { status: "expired" };

export interface DeviceLoginSession {
  device: DeviceCodeView;
  completion: Promise<DeviceLoginResult>;
  cancel(): void;
}

export interface DeviceLoginCallbacks {
  onStatus?: (status: string) => void;
}

export interface IntelligenceOptions {
  fetch?: FetchLike;
  workerUrl?: string;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface CopilotCredentials {
  token: string;
  endpoint: string;
  expiresAt: number;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function safeUserCode(value: unknown): string {
  if (typeof value !== "string") throw new Error("GitHub did not return a device code");
  const code = value.trim().toLocaleUpperCase();
  if (!/^[A-Z0-9-]{4,20}$/u.test(code)) throw new Error("GitHub returned an invalid user code");
  return code;
}

function safeDeviceCode(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 512) {
    throw new Error("GitHub did not return a valid device authorization");
  }
  return value;
}

function verificationUrl(response: DeviceStartResponse, userCode: string): string {
  const complete =
    typeof response.verification_uri_complete === "string"
      ? response.verification_uri_complete
      : "";
  if (complete && isAllowedGitHubVerificationUrl(complete)) return complete;
  const basic = typeof response.verification_uri === "string" ? response.verification_uri : "";
  if (!isAllowedGitHubVerificationUrl(basic)) {
    throw new Error("GitHub returned an untrusted verification URL");
  }
  const url = new URL(basic);
  url.searchParams.set("user_code", userCode);
  return url.toString();
}

function parsePositiveSeconds(value: unknown, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.ceil(value), 1), maximum)
    : fallback;
}

function extractSseContent(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const delta = choice?.delta as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const candidate = delta?.content ?? message?.content ?? choice?.text ?? record.content ?? record.output_text;
  if (typeof candidate === "string") return candidate;
  if (Array.isArray(candidate)) {
    return candidate
      .map((part) =>
        part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
          ? String((part as Record<string, unknown>).text)
          : "",
      )
      .join("");
  }
  return "";
}

function eventBoundary(buffer: string): { index: number; length: number } | undefined {
  const matches = [
    { index: buffer.indexOf("\r\n\r\n"), length: 4 },
    { index: buffer.indexOf("\n\n"), length: 2 },
    { index: buffer.indexOf("\r\r"), length: 2 },
  ].filter((match) => match.index >= 0);
  return matches.sort((left, right) => left.index - right.index)[0];
}

export async function parseSseStream(
  stream: ReadableStream<Uint8Array>,
  onDelta?: (fullText: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let doneMarker = false;
  const cancelReader = (): void => {
    void reader.cancel();
  };
  signal?.addEventListener("abort", cancelReader, { once: true });

  const processEvent = (raw: string): void => {
    const data = raw
      .replace(/\r\n?/gu, "\n")
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") {
      doneMarker = true;
      return;
    }
    let addition = "";
    try {
      addition = extractSseContent(JSON.parse(data));
    } catch {
      if (!full.includes(MALFORMED_PROTOCOL_SENTINEL)) {
        full += MALFORMED_PROTOCOL_SENTINEL;
        onDelta?.(displayTextFromVoiceStream(full));
      }
      return;
    }
    if (addition) {
      full += addition;
      onDelta?.(full);
    }
  };

  try {
    while (!doneMarker) {
      if (signal?.aborted) throw abortError();
      const chunk = await reader.read();
      if (signal?.aborted) throw abortError();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = eventBoundary(buffer);
      while (boundary) {
        processEvent(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary.length);
        if (doneMarker) break;
        boundary = eventBoundary(buffer);
      }
    }
    buffer += decoder.decode();
    if (!doneMarker && buffer.trim()) processEvent(buffer);
    return full.trim();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

export function parseBufferedChatResponse(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    const content = extractSseContent(JSON.parse(trimmed)).trim();
    return content || MALFORMED_PROTOCOL_SENTINEL;
  } catch {
    return protocolLooking(trimmed) ? MALFORMED_PROTOCOL_SENTINEL : trimmed;
  }
}

async function consumeChatResponse(
  response: Response,
  onDelta: ((fullText: string) => void) | undefined,
  signal: AbortSignal,
): Promise<IntelligenceResult> {
  if (signal.aborted) throw abortError();
  const contentType = response.headers.get("content-type") ?? "";
  let output = "";
  const emitDisplay = (raw: string): void => {
    onDelta?.(displayTextFromVoiceStream(raw));
  };
  if (/text\/event-stream/iu.test(contentType) && response.body) {
    output = await parseSseStream(response.body, emitDisplay, signal);
  } else {
    output = parseBufferedChatResponse(await response.text());
    if (output) emitDisplay(output);
  }
  return parseIntelligenceResult(output);
}

function safeRemoteError(error: unknown): Error {
  if (isAbort(error)) return abortError();
  if (error instanceof Error && /untrusted endpoint|recipient chain|context/iu.test(error.message)) {
    return new Error(error.message);
  }
  return new Error("Remote intelligence request failed without changing the Circle");
}

export class IntelligenceService {
  readonly #fetch: FetchLike;
  readonly #workerUrl: string;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  #githubToken: string | undefined;
  #copilotToken: string | undefined;
  #copilotEndpoint: string | undefined;
  #copilotExpiresAt = 0;
  #loginGeneration = 0;
  #loginAbort: AbortController | undefined;
  #chatGeneration = 0;
  #chatAbort: AbortController | undefined;
  #chatHistory: Array<{ role: "user" | "assistant"; text: string }> = [];

  constructor(options: IntelligenceOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#workerUrl = options.workerUrl ?? VBRAINSTEM_WORKER;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    const worker = new URL(this.#workerUrl);
    if (worker.toString().replace(/\/$/u, "") !== VBRAINSTEM_WORKER) {
      throw new Error("Authentication worker is not allowlisted");
    }
  }

  get authenticated(): boolean {
    return Boolean(
      this.#githubToken &&
        this.#copilotToken &&
        this.#copilotEndpoint,
    );
  }

  get chatHistory(): ReadonlyArray<{ role: "user" | "assistant"; text: string }> {
    return this.#chatHistory.map((item) => ({ ...item }));
  }

  #clearAuthentication(): void {
    this.#githubToken = undefined;
    this.#copilotToken = undefined;
    this.#copilotEndpoint = undefined;
    this.#copilotExpiresAt = 0;
  }

  cancelDeviceLogin(): void {
    const pending = Boolean(this.#loginAbort);
    this.#loginGeneration += 1;
    this.#loginAbort?.abort();
    this.#loginAbort = undefined;
    if (pending) this.#clearAuthentication();
  }

  async startDeviceLogin(callbacks: DeviceLoginCallbacks = {}): Promise<DeviceLoginSession> {
    this.cancelDeviceLogin();
    this.#clearAuthentication();
    const generation = ++this.#loginGeneration;
    const controller = new AbortController();
    this.#loginAbort = controller;
    const active = (): boolean =>
      generation === this.#loginGeneration && !controller.signal.aborted;
    callbacks.onStatus?.("Requesting a one-time GitHub device code…");
    try {
      const response = await this.#fetch(
        `${this.#workerUrl}${DEVICE_START_PATH}`,
        noStoreInit({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: controller.signal,
        }),
      );
      if (!active()) throw abortError();
      if (!response.ok) throw new Error("Device authorization is unavailable");
      const data = (await response.json()) as DeviceStartResponse;
      if (!active()) throw abortError();
      const userCode = safeUserCode(data.user_code);
      const deviceCode = safeDeviceCode(data.device_code);
      const expiresIn = parsePositiveSeconds(data.expires_in, 900, 900);
      const intervalSeconds = parsePositiveSeconds(data.interval, 5, 60);
      const device: DeviceCodeView = {
        userCode,
        verificationUrl: verificationUrl(data, userCode),
        expiresAt: this.#now() + expiresIn * 1_000,
        intervalSeconds,
      };
      callbacks.onStatus?.("Open GitHub, enter the code, then return here.");
      const completion = this.#pollDevice(
        deviceCode,
        device,
        intervalSeconds,
        generation,
        controller,
        callbacks,
      );
      return {
        device,
        completion,
        cancel: () => {
          if (generation === this.#loginGeneration) this.cancelDeviceLogin();
        },
      };
    } catch (error) {
      if (!active()) throw abortError();
      this.#clearAuthentication();
      this.#loginAbort = undefined;
      throw safeRemoteError(error);
    }
  }

  async #pollDevice(
    deviceCode: string,
    device: DeviceCodeView,
    initialInterval: number,
    generation: number,
    controller: AbortController,
    callbacks: DeviceLoginCallbacks,
  ): Promise<DeviceLoginResult> {
    let interval = initialInterval;
    const active = (): boolean =>
      generation === this.#loginGeneration && !controller.signal.aborted;
    try {
      while (this.#now() < device.expiresAt) {
        await this.#sleep(interval * 1_000, controller.signal);
        if (!active()) return { status: "cancelled" };
        if (this.#now() >= device.expiresAt) {
          this.#clearAuthentication();
          this.#loginAbort = undefined;
          callbacks.onStatus?.("The GitHub device code expired. Nothing was stored.");
          return { status: "expired" };
        }
        const response = await this.#fetch(
          `${this.#workerUrl}${DEVICE_POLL_PATH}`,
          noStoreInit({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_code: deviceCode }),
            signal: controller.signal,
          }),
        );
        if (!response.ok) throw new Error("GitHub authorization polling failed");
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!active()) return { status: "cancelled" };
        if (typeof data.access_token === "string" && data.access_token.length >= 8) {
          const accessToken = data.access_token;
          callbacks.onStatus?.("GitHub authorized. Connecting Copilot…");
          const credentials = await this.#exchangeCopilotToken(
            accessToken,
            controller.signal,
            generation,
          );
          if (!active()) {
            this.#clearAuthentication();
            return { status: "cancelled" };
          }
          this.#githubToken = accessToken;
          this.#copilotToken = credentials.token;
          this.#copilotEndpoint = credentials.endpoint;
          this.#copilotExpiresAt = credentials.expiresAt;
          this.#loginAbort = undefined;
          callbacks.onStatus?.("Copilot connected. Tokens remain only in memory.");
          return { status: "authenticated" };
        }
        const error = typeof data.error === "string" ? data.error : "authorization_pending";
        if (error === "slow_down") {
          interval = Math.min(interval + 5, 60);
          callbacks.onStatus?.("GitHub asked polling to slow down; still waiting.");
        } else if (error === "access_denied") {
          this.#clearAuthentication();
          this.#loginAbort = undefined;
          callbacks.onStatus?.("GitHub authorization was denied. Nothing was stored.");
          return { status: "denied" };
        } else if (error === "expired_token") {
          this.#clearAuthentication();
          this.#loginAbort = undefined;
          callbacks.onStatus?.("The GitHub device code expired. Nothing was stored.");
          return { status: "expired" };
        } else {
          callbacks.onStatus?.("Waiting for GitHub authorization…");
        }
      }
      this.#clearAuthentication();
      this.#loginAbort = undefined;
      callbacks.onStatus?.("The GitHub device code expired. Nothing was stored.");
      return { status: "expired" };
    } catch (error) {
      this.#clearAuthentication();
      if (generation === this.#loginGeneration) this.#loginAbort = undefined;
      if (isAbort(error) || !active()) return { status: "cancelled" };
      throw safeRemoteError(error);
    }
  }

  async #exchangeCopilotToken(
    githubToken: string,
    signal: AbortSignal,
    loginGeneration?: number,
  ): Promise<CopilotCredentials> {
    if (!githubToken) throw new Error("Sign in to GitHub first");
    const response = await this.#fetch(
      `${this.#workerUrl}${COPILOT_TOKEN_PATH}`,
      noStoreInit({
        headers: { Authorization: `Bearer ${githubToken}` },
        signal,
      }),
    );
    if (
      loginGeneration !== undefined &&
      (loginGeneration !== this.#loginGeneration || signal.aborted)
    ) {
      throw abortError();
    }
    if (!response.ok) throw new Error("Copilot access is unavailable");
    const data = (await response.json()) as Record<string, unknown>;
    if (
      typeof data.token !== "string" ||
      data.token.length < 8 ||
      data.token.length > 8_192
    ) {
      throw new Error("Copilot returned an invalid temporary token");
    }
    const endpoints =
      data.endpoints && typeof data.endpoints === "object"
        ? (data.endpoints as Record<string, unknown>)
        : {};
    const endpoint = typeof endpoints.api === "string" ? endpoints.api : "";
    if (!isAllowedCopilotEndpoint(endpoint)) {
      throw new Error("Copilot returned an untrusted endpoint");
    }
    const expiresAtSeconds =
      typeof data.expires_at === "number" && Number.isFinite(data.expires_at)
        ? data.expires_at
        : Math.floor(this.#now() / 1_000) + 1_500;
    return {
      token: data.token,
      endpoint,
      expiresAt: expiresAtSeconds * 1_000,
    };
  }

  async #ensureCopilotToken(signal: AbortSignal, force = false): Promise<void> {
    if (
      force ||
      !this.#copilotToken ||
      !this.#copilotEndpoint ||
      this.#now() >= this.#copilotExpiresAt - 60_000
    ) {
      const githubToken = this.#githubToken;
      if (!githubToken) throw new Error("Sign in to GitHub first");
      const credentials = await this.#exchangeCopilotToken(githubToken, signal);
      if (signal.aborted) throw abortError();
      this.#copilotToken = credentials.token;
      this.#copilotEndpoint = credentials.endpoint;
      this.#copilotExpiresAt = credentials.expiresAt;
    }
  }

  abortChat(): void {
    this.#chatGeneration += 1;
    this.#chatAbort?.abort();
    this.#chatAbort = undefined;
  }

  clearChat(): void {
    this.abortChat();
    this.#chatHistory = [];
  }

  logout(): void {
    this.cancelDeviceLogin();
    this.clearChat();
    this.#clearAuthentication();
  }

  async chat(
    approved: ApprovedRemoteContext,
    onDelta?: (fullText: string) => void,
    onRequestSent?: () => void,
  ): Promise<IntelligenceResult> {
    this.abortChat();
    const generation = ++this.#chatGeneration;
    const controller = new AbortController();
    this.#chatAbort = controller;
    try {
      validatePreview(approved.preview);
      if ((await sha256(approved.preview.bytes)) !== approved.approvedDigest) {
        throw new Error("Approved AI context changed");
      }
      await this.#ensureCopilotToken(controller.signal);
      const requestBody = JSON.stringify({
        model: COPILOT_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are the Pocket Quest Master narrator/planner. Return concise, all-ages prose only. You have no tools or authority to sign, store, sync, seal, or mutate. Any suggestion is an untrusted draft requiring local review. End every response with exactly one |||VOICE||| separator. Put the full formatted display answer before it. After it, provide a plain, conversational, voice-first version in no more than 2–3 short sentences, with no Markdown, URLs, code, emoji, or raw symbols where practical.",
          },
          { role: "user", content: approved.preview.text },
        ],
        temperature: 0.6,
        max_tokens: 300,
        stream: true,
      });
      let response: Response;
      let usedProxy = false;
      try {
        onRequestSent?.();
        response = await this.#directChat(requestBody, controller.signal);
      } catch (error) {
        if (isAbort(error)) throw error;
        if (!(error instanceof TypeError)) throw error;
        usedProxy = true;
        onRequestSent?.();
        response = await this.#proxyChat(requestBody, controller.signal);
      }
      if (response.status === 401) {
        await this.#ensureCopilotToken(controller.signal, true);
        if (usedProxy) {
          onRequestSent?.();
          response = await this.#proxyChat(requestBody, controller.signal);
        } else {
          try {
            onRequestSent?.();
            response = await this.#directChat(requestBody, controller.signal);
          } catch (error) {
            if (isAbort(error)) throw error;
            if (!(error instanceof TypeError)) throw error;
            usedProxy = true;
            onRequestSent?.();
            response = await this.#proxyChat(requestBody, controller.signal);
          }
        }
      }
      if (!response.ok) throw new Error(`Copilot chat status ${response.status}`);
      if (generation !== this.#chatGeneration || controller.signal.aborted) throw abortError();
      const result = await consumeChatResponse(response, (text) => {
        if (generation === this.#chatGeneration && !controller.signal.aborted) onDelta?.(text);
      }, controller.signal);
      if (generation !== this.#chatGeneration || controller.signal.aborted) throw abortError();
      if (!result.text) throw new Error("Copilot returned an empty draft");
      this.#chatHistory = [
        ...this.#chatHistory,
        { role: "user" as const, text: approved.preview.text },
        { role: "assistant" as const, text: result.text },
      ].slice(-8);
      this.#chatAbort = undefined;
      return result;
    } catch (error) {
      if (generation === this.#chatGeneration) this.#chatAbort = undefined;
      throw safeRemoteError(error);
    }
  }

  async #directChat(body: string, signal: AbortSignal): Promise<Response> {
    const token = this.#copilotToken;
    const endpoint = this.#copilotEndpoint;
    if (!token || !endpoint) throw new Error("Copilot is not connected");
    return this.#fetch(
      chatCompletionsEndpoint(endpoint),
      noStoreInit({
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        signal,
      }),
    );
  }

  async #proxyChat(body: string, signal: AbortSignal): Promise<Response> {
    const token = this.#copilotToken;
    const endpoint = this.#copilotEndpoint;
    if (!token || !endpoint || !isAllowedCopilotEndpoint(endpoint)) {
      throw new Error("Copilot is not connected");
    }
    const url = new URL(`${this.#workerUrl}${COPILOT_CHAT_PATH}`);
    url.searchParams.set("endpoint", endpoint);
    return this.#fetch(
      url.toString(),
      noStoreInit({
        method: "POST",
        headers: {
          Accept: "text/event-stream, application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body,
        signal,
      }),
    );
  }
}
