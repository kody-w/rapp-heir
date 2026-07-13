export type OrbMode = "orbit" | "compass" | "tunnel";

export type OrbActionId =
  | "continue"
  | "new-quest"
  | "offer"
  | "recap"
  | "rest"
  | "sync"
  | "reunion"
  | "mind";

export type OrbActionKind = "read-only" | "mutating" | "navigation" | "intelligence";

export interface OrbPetal {
  id: OrbActionId;
  label: string;
  kind: OrbActionKind;
  enabled: boolean;
}

export interface OrbTrailEntry {
  mode: OrbMode;
  breadcrumb: string[];
  highlighted: OrbActionId | null;
}

export interface OrbActivation {
  action: OrbActionId;
  source: "confirm-control" | "keyboard" | "voice";
  sequence: number;
}

export interface AdaptiveOrbState {
  mode: OrbMode;
  breadcrumb: string[];
  petals: OrbPetal[];
  highlighted: OrbActionId | null;
  trail: OrbTrailEntry[];
  activation: OrbActivation | null;
  sequence: number;
}

export interface OrbContext {
  questActive?: boolean;
  signedIn?: boolean;
}

export const STABLE_ORBIT_PETALS: readonly Omit<OrbPetal, "enabled">[] = [
  { id: "continue", label: "Continue / My Turn", kind: "read-only" },
  { id: "new-quest", label: "New Quest", kind: "mutating" },
  { id: "offer", label: "Offer", kind: "mutating" },
  { id: "recap", label: "Recap", kind: "read-only" },
  { id: "rest", label: "Rest", kind: "mutating" },
  { id: "sync", label: "Sync", kind: "navigation" },
  { id: "reunion", label: "Reunion", kind: "navigation" },
  { id: "mind", label: "Mind / Sign-in", kind: "intelligence" },
] as const;

function petalsFor(context: OrbContext): OrbPetal[] {
  return STABLE_ORBIT_PETALS.map((petal) => ({
    ...petal,
    label: petal.id === "mind" && context.signedIn ? "Mind" : petal.label,
    enabled:
      !["continue", "offer", "rest"].includes(petal.id) ||
      context.questActive === true,
  }));
}

export function createAdaptiveOrbState(context: OrbContext = {}): AdaptiveOrbState {
  return {
    mode: "orbit",
    breadcrumb: ["Orbit"],
    petals: petalsFor(context),
    highlighted: null,
    trail: [],
    activation: null,
    sequence: 0,
  };
}

export function withOrbContext(state: AdaptiveOrbState, context: OrbContext): AdaptiveOrbState {
  const petals = petalsFor(context);
  const highlighted = petals.some((petal) => petal.id === state.highlighted && petal.enabled)
    ? state.highlighted
    : null;
  return { ...state, petals, highlighted, activation: null };
}

export type OrbReducerAction =
  | { type: "rotate"; delta: -1 | 1 }
  | { type: "highlight"; action: OrbActionId | null }
  | { type: "sensor-highlight"; direction: "left" | "right" | "up" | "down" | "center" }
  | { type: "enter"; mode: "compass" | "tunnel"; label: string }
  | { type: "undo" }
  | { type: "cancel" | "center" }
  | { type: "confirm"; source: OrbActivation["source"] }
  | { type: "clear-activation" };

function selectablePetals(state: AdaptiveOrbState): OrbPetal[] {
  return state.petals.filter((petal) => petal.enabled);
}

function rotate(state: AdaptiveOrbState, delta: number): AdaptiveOrbState {
  const petals = selectablePetals(state);
  if (petals.length === 0) return { ...state, highlighted: null, activation: null };
  const current = petals.findIndex((petal) => petal.id === state.highlighted);
  const next = current < 0 ? (delta > 0 ? 0 : petals.length - 1) : (current + delta + petals.length) % petals.length;
  return { ...state, highlighted: petals[next]?.id ?? null, activation: null };
}

function trailEntry(state: AdaptiveOrbState): OrbTrailEntry {
  return {
    mode: state.mode,
    breadcrumb: [...state.breadcrumb],
    highlighted: state.highlighted,
  };
}

export function adaptiveOrbReducer(
  state: AdaptiveOrbState,
  action: OrbReducerAction,
): AdaptiveOrbState {
  if (action.type === "rotate") return rotate(state, action.delta);
  if (action.type === "highlight") {
    const enabled =
      action.action === null ||
      state.petals.some((petal) => petal.id === action.action && petal.enabled);
    return enabled ? { ...state, highlighted: action.action, activation: null } : state;
  }
  if (action.type === "sensor-highlight") {
    if (action.direction === "center") {
      return { ...state, highlighted: null, activation: null };
    }
    const delta = action.direction === "left" || action.direction === "up" ? -1 : 1;
    return rotate(state, delta);
  }
  if (action.type === "enter") {
    return {
      ...state,
      mode: action.mode,
      breadcrumb: [...state.breadcrumb, action.label],
      trail: [...state.trail, trailEntry(state)],
      activation: null,
    };
  }
  if (action.type === "undo") {
    const previous = state.trail.at(-1);
    if (!previous) return { ...state, mode: "orbit", breadcrumb: ["Orbit"], highlighted: null, activation: null };
    return {
      ...state,
      ...previous,
      breadcrumb: [...previous.breadcrumb],
      trail: state.trail.slice(0, -1),
      activation: null,
    };
  }
  if (action.type === "cancel" || action.type === "center") {
    return {
      ...state,
      mode: "orbit",
      breadcrumb: ["Orbit"],
      highlighted: null,
      trail: [],
      activation: null,
    };
  }
  if (action.type === "confirm") {
    if (!state.highlighted) {
      return adaptiveOrbReducer(state, { type: "center" });
    }
    const petal = state.petals.find(
      (candidate) => candidate.id === state.highlighted && candidate.enabled,
    );
    if (!petal) return { ...state, activation: null };
    const sequence = state.sequence + 1;
    return {
      ...state,
      sequence,
      activation: { action: petal.id, source: action.source, sequence },
    };
  }
  return { ...state, activation: null };
}

export function highlightedPetal(state: AdaptiveOrbState): OrbPetal | undefined {
  return state.petals.find((petal) => petal.id === state.highlighted);
}

export type OrbInputSource =
  | "touch-highlight"
  | "camera-highlight"
  | "confirm-control"
  | "keyboard"
  | "voice";

export function sourceCanActivate(source: OrbInputSource): source is OrbActivation["source"] {
  return source === "confirm-control" || source === "keyboard" || source === "voice";
}

export function shouldIgnoreOrbShortcut(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'a, button, input, textarea, select, option, form, summary, h1, h2, h3, h4, h5, h6, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"]',
    ),
  );
}

export function orbShortcutSurfaceOwnsFocus(target: EventTarget | null): boolean {
  if (typeof document === "undefined") return false;
  if (target === document.body || target === document.documentElement) return true;
  return (
    typeof Element !== "undefined" &&
    target instanceof Element &&
    target.matches("[data-orb-shortcut-surface]")
  );
}
