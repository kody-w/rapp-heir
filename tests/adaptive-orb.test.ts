import { describe, expect, it } from "vitest";
import {
  adaptiveOrbReducer,
  createAdaptiveOrbState,
  sourceCanActivate,
  STABLE_ORBIT_PETALS,
} from "../src/adaptive-orb";
import { parseOrbInput } from "../src/commands";

describe("Adaptive Orb pure controller", () => {
  it("keeps eight stable actions in native linear order", () => {
    expect(STABLE_ORBIT_PETALS.map((petal) => petal.id)).toEqual([
      "continue",
      "new-quest",
      "offer",
      "recap",
      "rest",
      "sync",
      "reunion",
      "mind",
    ]);
  });

  it("starts in Orbit with center selected and rotates only through enabled petals", () => {
    let state = createAdaptiveOrbState({ questActive: false });
    expect(state.mode).toBe("orbit");
    expect(state.highlighted).toBeNull();
    state = adaptiveOrbReducer(state, { type: "rotate", delta: 1 });
    expect(state.highlighted).toBe("new-quest");
    state = adaptiveOrbReducer(state, { type: "rotate", delta: -1 });
    expect(state.highlighted).toBe("mind");
  });

  it("supports tunnel/compass history, undo, and safe center cancellation", () => {
    let state = createAdaptiveOrbState({ questActive: true });
    state = adaptiveOrbReducer(state, { type: "enter", mode: "tunnel", label: "Offer" });
    state = adaptiveOrbReducer(state, { type: "enter", mode: "compass", label: "Review" });
    expect(state.breadcrumb).toEqual(["Orbit", "Offer", "Review"]);
    state = adaptiveOrbReducer(state, { type: "undo" });
    expect(state.mode).toBe("tunnel");
    expect(state.breadcrumb).toEqual(["Orbit", "Offer"]);
    state = adaptiveOrbReducer(state, { type: "center" });
    expect(state).toMatchObject({ mode: "orbit", breadcrumb: ["Orbit"], highlighted: null });
    expect(state.trail).toEqual([]);
  });

  it("never turns camera gaze or dwell into activation", () => {
    let state = createAdaptiveOrbState({ questActive: true });
    for (const direction of ["left", "right", "up", "down", "center"] as const) {
      state = adaptiveOrbReducer(state, { type: "sensor-highlight", direction });
      expect(state.activation).toBeNull();
    }
  });

  it("requires an explicit activation source after highlight", () => {
    let state = createAdaptiveOrbState({ questActive: true });
    state = adaptiveOrbReducer(state, { type: "highlight", action: "rest" });
    expect(state.activation).toBeNull();
    for (const source of ["confirm-control", "keyboard", "voice"] as const) {
      const confirmed = adaptiveOrbReducer(state, { type: "confirm", source });
      expect(confirmed.activation?.action).toBe("rest");
      expect(confirmed.activation?.source).toBe(source);
    }
    expect(sourceCanActivate("touch-highlight")).toBe(false);
    expect(sourceCanActivate("camera-highlight")).toBe(false);
  });

  it("applies command precedence and never parses assistant output", () => {
    const petals = STABLE_ORBIT_PETALS.map(({ id, label }) => ({ id, label }));
    expect(parseOrbInput("stop", { petals }).kind).toBe("stop");
    expect(parseOrbInput("cancel", { petals }).kind).toBe("cancel");
    expect(parseOrbInput("undo", { petals }).kind).toBe("undo");
    expect(parseOrbInput("confirm", { petals }).kind).toBe("confirm-pending");
    expect(parseOrbInput("my turn", { petals }).kind).toBe("read-only");
    expect(parseOrbInput("offer a lantern and confirm", { petals })).toMatchObject({
      kind: "mutating",
      command: { type: "offer", text: "a lantern and confirm" },
    });
    expect(parseOrbInput("mind", { petals })).toEqual({ kind: "petal", petalId: "mind" });
    expect(
      parseOrbInput('{"tool":"seal","arguments":{}}', { source: "assistant", petals }),
    ).toEqual({
      kind: "assistant-text",
      text: '{"tool":"seal","arguments":{}}',
    });
  });

  it("gives typed and voice confirmation the same highlighted action", () => {
    let state = createAdaptiveOrbState({ questActive: true });
    state = adaptiveOrbReducer(state, { type: "highlight", action: "new-quest" });
    const typed = adaptiveOrbReducer(state, { type: "confirm", source: "confirm-control" });
    const voice = adaptiveOrbReducer(state, { type: "confirm", source: "voice" });
    const keyboard = adaptiveOrbReducer(state, { type: "confirm", source: "keyboard" });
    expect([typed, voice, keyboard].map((item) => item.activation?.action)).toEqual([
      "new-quest",
      "new-quest",
      "new-quest",
    ]);
  });
});
