import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VoicePocketGM,
  parseCommand,
  parseTypedCommand,
  parseVoiceTranscript,
  type PocketCommand,
} from "../src/commands";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pocket Quest Master command grammar", () => {
  it.each<[string, PocketCommand["type"]]>([
    ["begin quest", "create-quest"],
    ["create a new quest", "create-quest"],
    ["what is my turn?", "turn"],
    ["continue the quest", "turn"],
    ["offer: I found a paper moon", "offer"],
    ["complete my turn with a blue thread", "offer"],
    ["pass", "rest"],
    ["rest", "rest"],
    ["recap story", "recap"],
    ["sync", "sync"],
    ["prepare reunion", "prepare-reunion"],
    ["seal chapter", "seal-chapter"],
    ["repeat", "repeat"],
    ["stop", "stop"],
  ])("parses “%s” as %s", (input, type) => {
    expect(parseCommand(input).type).toBe(type);
  });

  it("preserves bounded offering text for explicit commit UI", () => {
    expect(parseCommand("offer the lantern chose the river")).toEqual({
      type: "offer",
      text: "the lantern chose the river",
    });
  });

  it("uses the exact same parser for typed and voice input", () => {
    const input = "complete my turn: keep the silver leaf";
    expect(parseVoiceTranscript(input)).toEqual(parseTypedCommand(input));
  });

  it("returns safe help behavior for unknown speech", () => {
    expect(parseCommand("open the pod bay doors")).toEqual({
      type: "unknown",
      original: "open the pod bay doors",
    });
  });

  it("stops push-to-talk immediately when the control releases", () => {
      const start = vi.fn();
      const stop = vi.fn();
      class Recognition {
        continuous = false;
        interimResults = false;
        lang = "";
        processLocally = false;
        onresult = null;
        onerror = null;
        onend = null;
        start = start;
        stop = stop;
        abort = vi.fn();
      }
      vi.stubGlobal("window", {
        SpeechRecognition: Recognition,
        speechSynthesis: { cancel: vi.fn(), speak: vi.fn() },
      });
      vi.stubGlobal("navigator", { language: "en-US" });
      const voice = new VoicePocketGM(vi.fn(), vi.fn());
      voice.startPushToTalk();
      expect(start).toHaveBeenCalledOnce();
      voice.stopListening();
      expect(stop).toHaveBeenCalledOnce();
  });

  it("interrupts speech and ignores recognition callbacks after explicit stop cleanup", () => {
    const transcript = vi.fn();
    const cancel = vi.fn();
    const abort = vi.fn();
    let instance:
      | {
          onresult: ((event: unknown) => void) | null;
        }
      | undefined;
    class Recognition {
      continuous = false;
      interimResults = false;
      lang = "";
      processLocally = false;
      onresult: ((event: unknown) => void) | null = null;
      onerror = null;
      onend = null;
      start = vi.fn();
      stop = vi.fn();
      abort = abort;
      constructor() {
        instance = this;
      }
    }
    vi.stubGlobal("window", {
      SpeechRecognition: Recognition,
      speechSynthesis: { cancel, speak: vi.fn() },
    });
    vi.stubGlobal("navigator", { language: "en-US" });
    const voice = new VoicePocketGM(transcript, vi.fn());
    voice.startPushToTalk();
    expect(cancel).toHaveBeenCalled();
    voice.stopAll();
    instance?.onresult?.({
      results: [{ isFinal: true, 0: { transcript: "confirm" } }],
    });
    expect(abort).toHaveBeenCalledOnce();
    expect(transcript).not.toHaveBeenCalled();
  });

  it("clears the repeat buffer on stop so stale AI speech cannot restart", () => {
    const cancel = vi.fn();
    const speak = vi.fn();
    class Utterance {
      constructor(readonly text: string) {}
    }
    vi.stubGlobal("window", {
      speechSynthesis: { cancel, speak },
    });
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    const voice = new VoicePocketGM(vi.fn(), vi.fn());
    voice.speak("Current spoken version.");
    voice.stopAll();
    voice.repeat();
    expect(speak).toHaveBeenCalledOnce();
    expect(speak.mock.calls[0]?.[0]).toMatchObject({ text: "Current spoken version." });
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
