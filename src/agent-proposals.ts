import { boundedJsonParse, canonicalStringify, utf8 } from "./canonical";
import { MAX_AGENT_RESULT_BYTES } from "./agent-cell";

const CONTEXT_CLASSES = new Set([
  "indoors",
  "doorstep",
  "park",
  "street",
  "transit",
  "waterside",
  "unknown",
]);
const WEATHER_BANDS = new Set([
  "clear",
  "clouded",
  "rain",
  "snow",
  "wind",
  "warm",
  "cold",
  "unknown",
]);

export interface QuestMasterProposal {
  title: string;
  premise: string;
  contextClass: string;
  weatherBand: string;
  minutesPerLeg: "5-10";
  memberCount: number;
  source: "offline-bundled-agent";
}

export interface QuestSafetyDecision {
  allowed: boolean;
  reasons: string[];
  safeText: string;
  note: string;
}

function recordFromOutput(output: string): Record<string, unknown> {
  const parsed = boundedJsonParse<unknown>(output, MAX_AGENT_RESULT_BYTES);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Verified agent output must be one JSON object");
  }
  return parsed as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error("Verified agent output contains an unexpected field");
  }
}

function boundedString(
  value: unknown,
  label: string,
  maximumCharacters: number,
  maximumBytes: number,
): string {
  if (typeof value !== "string") throw new Error(`Verified ${label} must be text`);
  const text = value.trim();
  if (
    !text ||
    text.length > maximumCharacters ||
    utf8(text).byteLength > maximumBytes ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
  ) {
    throw new Error(`Verified ${label} is outside its bounds`);
  }
  return text;
}

export function parseQuestMasterOutput(output: string): QuestMasterProposal {
  const value = recordFromOutput(output);
  exactKeys(value, [
    "title",
    "premise",
    "context_class",
    "weather_band",
    "minutes_per_leg",
    "member_count",
    "source",
  ]);
  const title = boundedString(value.title, "quest title", 120, 240);
  const premise = boundedString(value.premise, "quest premise", 700, 1_000);
  const contextClass = boundedString(value.context_class, "context class", 24, 48);
  const weatherBand = boundedString(value.weather_band, "weather band", 24, 48);
  if (!CONTEXT_CLASSES.has(contextClass) || !WEATHER_BANDS.has(weatherBand)) {
    throw new Error("Verified quest uses an unsupported coarse context");
  }
  if (
    value.minutes_per_leg !== "5-10" ||
    value.source !== "offline-bundled-agent" ||
    typeof value.member_count !== "number" ||
    !Number.isSafeInteger(value.member_count) ||
    value.member_count < 2 ||
    value.member_count > 64
  ) {
    throw new Error("Verified quest metadata is invalid");
  }
  return {
    title,
    premise,
    contextClass,
    weatherBand,
    minutesPerLeg: "5-10",
    memberCount: value.member_count,
    source: "offline-bundled-agent",
  };
}

export function questSafetyCandidate(proposal: QuestMasterProposal): string {
  return canonicalStringify({
    context_class: proposal.contextClass,
    premise: proposal.premise,
    title: proposal.title,
    weather_band: proposal.weatherBand,
  });
}

export function parseQuestSafetyOutput(output: string): QuestSafetyDecision {
  const value = recordFromOutput(output);
  exactKeys(value, ["allowed", "reasons", "safe_text", "note"]);
  if (typeof value.allowed !== "boolean" || !Array.isArray(value.reasons)) {
    throw new Error("Verified safety decision has an invalid schema");
  }
  if (value.reasons.length > 16) throw new Error("Verified safety decision has too many reasons");
  const reasons = value.reasons.map((reason) =>
    boundedString(reason, "safety reason", 120, 240),
  );
  const safeText =
    value.safe_text === ""
      ? ""
      : boundedString(value.safe_text, "safe text", 1_200, 2_400);
  const note = boundedString(value.note, "safety note", 240, 480);
  if (value.allowed && !safeText) {
    throw new Error("Verified safety decision omitted its safe text");
  }
  if (!value.allowed && safeText) {
    throw new Error("Rejected safety output must not provide executable text");
  }
  return { allowed: value.allowed, reasons, safeText, note };
}
