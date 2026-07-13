import { fromBase64Url, sha256 } from "./canonical";
import type {
  CircleRecord,
  Quest,
  QuestLeg,
  QuestOffering,
  QuestRole,
  SignedEvent,
} from "./types";

export const QUEST_ROLES: readonly QuestRole[] = [
  "Scout",
  "Dreamer",
  "Skeptic",
  "Keeper",
  "Maker",
  "Witness",
];

const QUEST_TEMPLATES = [
  {
    title: "The Borrowed Echo",
    premise: "A familiar sound has returned carrying one detail nobody remembers giving it.",
    turns: [
      "Find a harmless threshold and notice what seems to be waiting on the other side.",
      "Invent a promise the echo might keep, then choose its smallest visible sign.",
      "Test one assumption by seeking an ordinary counterexample nearby.",
      "Name the detail that the Circle must preserve without trapping it.",
    ],
  },
  {
    title: "Weather for a Hidden Door",
    premise: "The day’s weather is touching an entrance that only companions can notice.",
    turns: [
      "Choose a nearby texture that could be the door’s quiet handle.",
      "Imagine what changes when the weather crosses the threshold.",
      "Ask what the door refuses and offer a gentler alternative.",
      "Make a tiny token from words, shadow, or arrangement—leave no trace behind.",
    ],
  },
  {
    title: "The Lantern Between Us",
    premise: "An unseen lantern brightens whenever one member’s choice changes another member’s path.",
    turns: [
      "Notice a safe source of reflected light and give it a secret purpose.",
      "Describe the creature that tends this lantern when everyone is away.",
      "Choose which old story the lantern should question rather than repeat.",
      "Keep one phrase and transform another into a new direction.",
    ],
  },
] as const;

const CONTEXT_CLASSES = new Set(["indoors", "doorstep", "park", "street", "transit", "waterside", "unknown"]);
const WEATHER_BANDS = new Set(["clear", "clouded", "rain", "snow", "wind", "warm", "cold", "unknown"]);

function companionSeed(group: CircleRecord, memberId: string): string {
  const companion = group.members[memberId]?.companion;
  if (!companion) throw new Error("Quest member is not enrolled");
  return `${companion.color}|${companion.temperament}|${companion.voiceSeed}`;
}

export async function createQuest(
  group: CircleRecord,
  events: readonly SignedEvent[],
  contextClass: string,
  weatherBand: string,
  now = new Date(),
): Promise<Quest> {
  if (group.status === "forming") throw new Error("Finish the first-breath manifest before beginning a quest");
  const safeContext = CONTEXT_CLASSES.has(contextClass) ? contextClass : "unknown";
  const safeWeather = WEATHER_BANDS.has(weatherBand) ? weatherBand : "unknown";
  const questIndex = events.filter((event) => event.body.type === "quest.created").length;
  const members = Object.keys(group.members)
    .filter((memberId) => group.members[memberId]?.active)
    .sort();
  if (members.length < 2) throw new Error("A Braid quest needs at least two active members");
  const seed = await sha256({
    groupId: group.id,
    organismId: group.genesis?.organismId,
    questIndex,
    contextClass: safeContext,
    weatherBand: safeWeather,
    companionSeeds: members.map((memberId) => companionSeed(group, memberId)),
    recentHistory: events
      .filter((event) =>
        ["quest.offering", "quest.reveal", "quest.rest", "reunion.seal"].includes(event.body.type),
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(-32)
      .map((event) => ({
        id: event.id,
        type: event.body.type,
        choice: event.body.type === "quest.offering" ? event.body.payload.choice : null,
      })),
  });
  const byte = fromBase64Url(seed)[0] ?? 0;
  const template = QUEST_TEMPLATES[byte % QUEST_TEMPLATES.length] ?? QUEST_TEMPLATES[0];
  const roles: Record<string, QuestRole> = {};
  members.forEach((memberId, index) => {
    roles[memberId] = QUEST_ROLES[(index + questIndex) % QUEST_ROLES.length] ?? "Scout";
  });
  return {
    questId: `quest_${seed.slice(0, 24)}`,
    title: template.title,
    premise: template.premise,
    createdAt: now.toISOString(),
    contextClass: safeContext,
    weatherBand: safeWeather,
    memberOrder: members,
    roles,
  };
}

export function questPayload(quest: Quest): Record<string, unknown> {
  return {
    questId: quest.questId,
    title: quest.title,
    premise: quest.premise,
    createdAt: quest.createdAt,
    contextClass: quest.contextClass,
    weatherBand: quest.weatherBand,
    memberOrder: quest.memberOrder,
    roles: quest.roles,
  };
}

export function questFromEvent(event: SignedEvent): Quest {
  if (event.body.type !== "quest.created") throw new Error("Not a quest creation event");
  const payload = event.body.payload;
  return {
    questId: String(payload.questId),
    title: String(payload.title),
    premise: String(payload.premise),
    createdAt: String(payload.createdAt),
    contextClass: String(payload.contextClass),
    weatherBand: String(payload.weatherBand),
    memberOrder: Array.isArray(payload.memberOrder) ? payload.memberOrder.map(String) : [],
    roles: payload.roles as Record<string, QuestRole>,
  };
}

export function offeringFromEvent(event: SignedEvent): QuestOffering {
  if (event.body.type !== "quest.offering") throw new Error("Not an offering event");
  return {
    questId: String(event.body.payload.questId),
    memberId: event.body.memberId,
    text: String(event.body.payload.text),
    choice: String(event.body.payload.choice),
    selectedTrait:
      typeof event.body.payload.selectedTrait === "string" ? event.body.payload.selectedTrait : undefined,
    contextClass:
      typeof event.body.payload.contextClass === "string" ? event.body.payload.contextClass : undefined,
    approvedForHeirloom: event.body.payload.approvedForHeirloom === true,
  };
}

export function sanitizeOffering(input: QuestOffering, group: CircleRecord): QuestOffering {
  if (!group.members[input.memberId]) throw new Error("Only enrolled members can offer");
  const text = input.text.trim().replace(/\s+/gu, " ");
  const choice = input.choice.trim().replace(/\s+/gu, " ");
  if (!text || text.length > 600) throw new Error("Offering must be 1–600 characters");
  if (!choice || choice.length > 48) throw new Error("Choice must be 1–48 characters");
  const selectedTrait =
    input.selectedTrait && input.selectedTrait.length <= 40 ? input.selectedTrait : undefined;
  const contextClass =
    input.contextClass && CONTEXT_CLASSES.has(input.contextClass) ? input.contextClass : undefined;
  return {
    questId: input.questId,
    memberId: input.memberId,
    text,
    choice,
    ...(selectedTrait ? { selectedTrait } : {}),
    ...(contextClass ? { contextClass } : {}),
    approvedForHeirloom: input.approvedForHeirloom,
  };
}

export function offeringPayload(offering: QuestOffering): Record<string, unknown> {
  return {
    questId: offering.questId,
    text: offering.text,
    choice: offering.choice,
    selectedTrait: offering.selectedTrait ?? null,
    contextClass: offering.contextClass ?? null,
    approvedForHeirloom: offering.approvedForHeirloom,
  };
}

export function assertMemberCanOffer(
  events: readonly SignedEvent[],
  questId: string,
  memberId: string,
): void {
  if (
    events.some(
      (event) =>
        event.body.type === "quest.offering" &&
        event.body.payload.questId === questId &&
        event.body.memberId === memberId,
    )
  ) {
    throw new Error("This companion has already offered to this quest");
  }
}

export async function deriveQuestLeg(
  quest: Quest,
  memberId: string,
  offerings: readonly SignedEvent[],
): Promise<QuestLeg> {
  const memberIndex = quest.memberOrder.indexOf(memberId);
  if (memberIndex < 0) throw new Error("Member has no leg in this quest");
  const predecessor = quest.memberOrder[(memberIndex - 1 + quest.memberOrder.length) % quest.memberOrder.length];
  const relevant = offerings
    .filter(
      (event) =>
        event.body.type === "quest.offering" &&
        event.body.payload.questId === quest.questId &&
        event.body.memberId === predecessor,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const influence = relevant.map((event) => ({
    id: event.id,
    choice: event.body.payload.choice,
    textHash: event.id.slice(0, 16),
    trait: event.body.payload.selectedTrait ?? null,
  }));
  const influenceMark = await sha256({ questId: quest.questId, memberId, influence });
  const byte = fromBase64Url(influenceMark)[0] ?? 0;
  const template = QUEST_TEMPLATES.find((candidate) => candidate.title === quest.title) ?? QUEST_TEMPLATES[0];
  const baseTurn = template.turns[(memberIndex + byte) % template.turns.length] ?? template.turns[0];
  const sourceChoice =
    relevant.length > 0 ? String(relevant.at(-1)?.body.payload.choice ?? "an earlier choice") : "an unopened path";
  const bridge =
    relevant.length > 0
      ? `Because the previous offering chose “${sourceChoice},” carry its ${influenceMark.slice(0, 6)} mark into your answer.`
      : "You are first in this part of the Braid; leave a clear choice for the next companion.";
  return {
    questId: quest.questId,
    memberId,
    role: quest.roles[memberId] ?? "Scout",
    minutes: 5 + (byte % 6),
    prompt: `${baseTurn} ${bridge}`,
    influencedBy: relevant.map((event) => event.id),
    influenceMark: influenceMark.slice(0, 12),
  };
}

export async function deriveSharedReveal(
  quest: Quest,
  offeringEvents: readonly SignedEvent[],
): Promise<{
  text: string;
  influenceRoot: string;
  memberIds: string[];
  sourceOfferingIds: string[];
  approvedForHeirloom: boolean;
}> {
  const relevant = offeringEvents
    .filter(
      (event) => event.body.type === "quest.offering" && event.body.payload.questId === quest.questId,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const memberIds = [...new Set(relevant.map((event) => event.body.memberId))];
  if (memberIds.length < 2) throw new Error("The shared reveal waits for offerings from at least two members");
  const influenceRoot = await sha256(
    relevant.map((event) => ({
      id: event.id,
      memberId: event.body.memberId,
      choice: event.body.payload.choice,
    })),
  );
  const lines = relevant.map((event) => {
    const sourceIndex = quest.memberOrder.indexOf(event.body.memberId);
    const target =
      quest.memberOrder[(sourceIndex + 1) % quest.memberOrder.length] ?? quest.memberOrder[0] ?? "the Circle";
    const sourceName = event.body.memberId.slice(-6);
    const targetName = target.slice(-6);
    return `${sourceName} choosing “${String(event.body.payload.choice)}” bent ${targetName}’s path`;
  });
  return {
    text: `${quest.title} revealed its Braid: ${lines.join("; ")}. The organism kept mark ${influenceRoot.slice(0, 10)}.`,
    influenceRoot,
    memberIds: memberIds.sort(),
    sourceOfferingIds: relevant.map((event) => event.id),
    approvedForHeirloom: relevant.every((event) => event.body.payload.approvedForHeirloom === true),
  };
}

export function latestQuest(events: readonly SignedEvent[]): Quest | undefined {
  const creation = events
    .filter((event) => event.body.type === "quest.created")
    .sort(
      (left, right) =>
        left.body.createdAt.localeCompare(right.body.createdAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  return creation ? questFromEvent(creation) : undefined;
}

interface BrowserLanguageModel {
  create(options?: Record<string, unknown>): Promise<{
    prompt(text: string): Promise<string>;
    destroy?(): void;
  }>;
}

export async function optionallyEnhancePrompt(
  original: string,
  enabled: boolean,
): Promise<{ text: string; source: "offline-original" | "browser-local-experimental" }> {
  if (!enabled) return { text: original, source: "offline-original" };
  const languageModel = (globalThis as typeof globalThis & { LanguageModel?: BrowserLanguageModel }).LanguageModel;
  if (!languageModel) return { text: original, source: "offline-original" };
  try {
    const session = await languageModel.create({ temperature: 0.4, topK: 4 });
    const response = await session.prompt(
      `Rewrite this safe, all-ages 5–10 minute quest prompt in at most 90 words. Do not add locations or personal data:\n${original}`,
    );
    session.destroy?.();
    const clean = response.trim().slice(0, 700);
    return clean
      ? { text: clean, source: "browser-local-experimental" }
      : { text: original, source: "offline-original" };
  } catch {
    return { text: original, source: "offline-original" };
  }
}
