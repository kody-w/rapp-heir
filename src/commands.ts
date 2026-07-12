export type PocketCommand =
  | { type: "create-quest" }
  | { type: "turn" }
  | { type: "offer"; text: string }
  | { type: "rest" }
  | { type: "recap" }
  | { type: "sync" }
  | { type: "prepare-reunion" }
  | { type: "seal-chapter" }
  | { type: "repeat" }
  | { type: "stop" }
  | { type: "unknown"; original: string };

export function parseCommand(input: string): PocketCommand {
  const original = input.trim();
  const normalized = original.toLocaleLowerCase().replace(/[.!?]+$/u, "").trim();
  if (/^(create|begin|start)( a| the)? (new )?quest$/u.test(normalized) || normalized === "quest") {
    return { type: "create-quest" };
  }
  if (
    /^(what is|what's|show|tell me)( my)? turn$/u.test(normalized) ||
    normalized === "my turn" ||
    /^(continue|resume)( the| my)? quest$/u.test(normalized)
  ) {
    return { type: "turn" };
  }
  const offering = original.match(/^(?:offer|complete(?: my)?(?: turn)?)(?:\s*[:,-]?\s+)(.+)$/iu);
  if (offering?.[1]) return { type: "offer", text: offering[1].trim() };
  if (/^(offer|complete(?: my)?(?: turn)?)$/u.test(normalized)) return { type: "offer", text: "" };
  if (/^(pass|rest|take a rest)$/u.test(normalized)) return { type: "rest" };
  if (/^(recap|recap (the )?story|story so far)$/u.test(normalized)) return { type: "recap" };
  if (/^(sync|reconnect|share changes)$/u.test(normalized)) return { type: "sync" };
  if (/^(prepare|begin|start)( a| the)? reunion$/u.test(normalized)) return { type: "prepare-reunion" };
  if (/^(seal|seal (the )?chapter)$/u.test(normalized)) return { type: "seal-chapter" };
  if (/^(repeat|say that again)$/u.test(normalized)) return { type: "repeat" };
  if (/^(stop|be quiet|stop speaking)$/u.test(normalized)) return { type: "stop" };
  return { type: "unknown", original };
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
  #lastSpoken = "";

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
    this.stopListening();
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    if ("processLocally" in recognition) recognition.processLocally = true;
    recognition.onresult = (event) => {
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript.trim();
        if (result?.isFinal && transcript) this.#onTranscript(transcript);
      }
    };
    recognition.onerror = (event) => {
      this.#onStatus(`Microphone command ended: ${event.error ?? "recognition error"}. No audio was stored.`);
    };
    recognition.onend = () => {
      if (this.#recognition === recognition) this.#recognition = undefined;
      this.#onStatus("Listening stopped. No raw audio was stored or synced.");
    };
    this.#recognition = recognition;
    recognition.start();
    this.#onStatus("Listening only while this control is active…");
  }

  stopListening(): void {
    const recognition = this.#recognition;
    this.#recognition = undefined;
    recognition?.stop();
  }

  speak(text: string): void {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    this.#lastSpoken = text.slice(0, 2_000);
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(this.#lastSpoken));
  }

  repeat(): void {
    if (this.#lastSpoken) this.speak(this.#lastSpoken);
  }

  stopSpeaking(): void {
    window.speechSynthesis?.cancel();
  }
}

export function parseTypedCommand(input: string): PocketCommand {
  return parseCommand(input);
}

export function parseVoiceTranscript(input: string): PocketCommand {
  return parseCommand(input);
}
