export type PocketCommand =
  | { type: "create-quest" }
  | { type: "turn" }
  | { type: "offer"; text: string }
  | { type: "rest" }
  | { type: "reveal" }
  | { type: "recap" }
  | { type: "help" }
  | { type: "sync" }
  | { type: "prepare-reunion" }
  | { type: "seal-chapter" }
  | { type: "repeat" }
  | { type: "stop" }
  | { type: "cancel" }
  | { type: "undo" }
  | { type: "confirm" }
  | { type: "unknown"; original: string };

export function parseCommand(input: string): PocketCommand {
  const original = input.trim();
  const normalized = original.toLocaleLowerCase().replace(/[.!?]+$/u, "").trim();
  if (/^(stop|be quiet|stop speaking)$/u.test(normalized)) return { type: "stop" };
  if (/^(cancel|never mind|nevermind)$/u.test(normalized)) return { type: "cancel" };
  if (/^(undo|go back)$/u.test(normalized)) return { type: "undo" };
  if (/^(confirm|confirm pending)$/u.test(normalized)) return { type: "confirm" };
  if (/^(repeat|say that again)$/u.test(normalized)) return { type: "repeat" };
  if (/^(help|show commands|what can i say)$/u.test(normalized)) return { type: "help" };
  if (
    /^(what is|what's|show|tell me)( my)? turn$/u.test(normalized) ||
    normalized === "my turn" ||
    /^(continue|resume)( the| my)? quest$/u.test(normalized)
  ) {
    return { type: "turn" };
  }
  if (/^(recap|recap (the )?story|story so far)$/u.test(normalized)) return { type: "recap" };
  if (/^(create|begin|start)( a| the)? (new )?quest$/u.test(normalized) || normalized === "quest") {
    return { type: "create-quest" };
  }
  const offering = original.match(/^(?:offer|complete(?: my)?(?: turn)?)(?:\s*[:,-]?\s+)(.+)$/iu);
  if (offering?.[1]) return { type: "offer", text: offering[1].trim() };
  if (/^(offer|complete(?: my)?(?: turn)?)$/u.test(normalized)) return { type: "offer", text: "" };
  if (/^(pass|rest|take a rest)$/u.test(normalized)) return { type: "rest" };
  if (/^(reveal|reveal (the )?story|shared reveal)$/u.test(normalized)) return { type: "reveal" };
  if (/^(sync|reconnect|share changes)$/u.test(normalized)) return { type: "sync" };
  if (/^(prepare|begin|start)( a| the)? reunion$/u.test(normalized)) return { type: "prepare-reunion" };
  if (/^(seal|seal (the )?chapter)$/u.test(normalized)) return { type: "seal-chapter" };
  return { type: "unknown", original };
}

export type OrbInputIntent =
  | { kind: "stop" }
  | { kind: "cancel" }
  | { kind: "undo" }
  | { kind: "confirm-pending" }
  | { kind: "read-only"; command: Extract<PocketCommand, { type: "turn" | "recap" | "help" | "repeat" }> }
  | {
      kind: "mutating";
      command: Extract<PocketCommand, { type: "create-quest" | "offer" | "rest" | "reveal" }>;
    }
  | {
      kind: "navigation";
      command: Extract<PocketCommand, { type: "sync" | "prepare-reunion" | "seal-chapter" }>;
    }
  | { kind: "petal"; petalId: string }
  | { kind: "freeform-ai"; text: string }
  | { kind: "assistant-text"; text: string };

export interface ParseOrbInputOptions {
  source?: "user" | "assistant";
  petals?: ReadonlyArray<{ id: string; label: string }>;
}

function normalizedSelection(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s*\/\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function parseOrbInput(input: string, options: ParseOrbInputOptions = {}): OrbInputIntent {
  const original = input.trim().slice(0, 2_000);
  if (options.source === "assistant") return { kind: "assistant-text", text: original };
  const command = parseCommand(original);
  if (command.type === "stop") return { kind: "stop" };
  if (command.type === "cancel") return { kind: "cancel" };
  if (command.type === "undo") return { kind: "undo" };
  if (command.type === "confirm") return { kind: "confirm-pending" };
  if (["turn", "recap", "help", "repeat"].includes(command.type)) {
    return {
      kind: "read-only",
      command: command as Extract<PocketCommand, { type: "turn" | "recap" | "help" | "repeat" }>,
    };
  }
  if (["create-quest", "offer", "rest", "reveal"].includes(command.type)) {
    return {
      kind: "mutating",
      command: command as Extract<
        PocketCommand,
        { type: "create-quest" | "offer" | "rest" | "reveal" }
      >,
    };
  }
  if (["sync", "prepare-reunion", "seal-chapter"].includes(command.type)) {
    return {
      kind: "navigation",
      command: command as Extract<
        PocketCommand,
        { type: "sync" | "prepare-reunion" | "seal-chapter" }
      >,
    };
  }
  const selection = normalizedSelection(original);
  const petal = options.petals?.find(
    (candidate) =>
      normalizedSelection(candidate.id) === selection ||
      normalizedSelection(candidate.label) === selection,
  );
  if (petal) return { kind: "petal", petalId: petal.id };
  return { kind: "freeform-ai", text: original };
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  readonly [index: number]: { transcript: string };
}

interface SpeechRecognitionEventLike extends Event {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  processLocally?: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const speechWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export class VoicePocketGM {
  readonly #onTranscript: (text: string) => void;
  readonly #onStatus: (text: string) => void;
  #recognition: SpeechRecognitionLike | undefined;
  #recognitionStopping = false;
  #lastSpoken = "";
  #generation = 0;

  constructor(onTranscript: (text: string) => void, onStatus: (text: string) => void) {
    this.#onTranscript = onTranscript;
    this.#onStatus = onStatus;
  }

  get available(): boolean {
    return Boolean(recognitionConstructor());
  }

  startPushToTalk(): void {
    const Recognition = recognitionConstructor();
    if (!Recognition) {
      this.#onStatus("Speech recognition is unavailable here. Typed commands have full parity.");
      return;
    }
    this.stopSpeaking();
    this.abortListening();
    const generation = ++this.#generation;
    const recognition = new Recognition();
    this.#recognitionStopping = false;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    if ("processLocally" in recognition) recognition.processLocally = true;
    recognition.onresult = (event) => {
      if (generation !== this.#generation || this.#recognition !== recognition) return;
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript.trim();
        if (result?.isFinal && transcript) this.#onTranscript(transcript);
      }
    };
    recognition.onerror = (event) => {
      if (generation !== this.#generation || this.#recognition !== recognition) return;
      this.#onStatus(`Microphone command ended: ${event.error ?? "recognition error"}. No audio was stored.`);
    };
    recognition.onend = () => {
      if (generation !== this.#generation || this.#recognition !== recognition) return;
      this.#recognition = undefined;
      this.#recognitionStopping = false;
      this.#onStatus("Listening stopped. No raw audio was stored or synced.");
    };
    this.#recognition = recognition;
    recognition.start();
    this.#onStatus("Listening only while this control is active…");
  }

  stopListening(): void {
    const recognition = this.#recognition;
    if (!recognition || this.#recognitionStopping) return;
    this.#recognitionStopping = true;
    recognition.stop();
  }

  abortListening(): void {
    const recognition = this.#recognition;
    this.#recognition = undefined;
    this.#recognitionStopping = false;
    this.#generation += 1;
    recognition?.abort();
  }

  speak(text: string): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    this.#lastSpoken = text.slice(0, 2_000);
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(this.#lastSpoken));
  }

  repeat(): void {
    if (this.#lastSpoken) this.speak(this.#lastSpoken);
  }

  stopSpeaking(): void {
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  }

  stopAll(): void {
    this.abortListening();
    this.stopSpeaking();
    this.#lastSpoken = "";
  }
}

export function parseTypedCommand(input: string): PocketCommand {
  return parseCommand(input);
}

export function parseVoiceTranscript(input: string): PocketCommand {
  return parseCommand(input);
}
