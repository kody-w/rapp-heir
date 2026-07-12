import { canonicalBytes, sha256 } from "./canonical";
import { verifySignedEvent } from "./crypto";
import { deriveOrganismState } from "./organism";
import { deriveSharedReveal, questFromEvent } from "./quest";
import { eventRoot, setSetting, validateGroup, type ReplicaDatabase } from "./storage";
import type {
  CircleRecord,
  HeirloomArtifact,
  HeirloomBody,
  SignedEvent,
} from "./types";

const PRIVATE_FIELD_PATTERN =
  /private|secret|password|credential|api.?key|token|raw.?audio|precise.?location|latitude|longitude|contact|twin.?id/iu;

function hasPrivateField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrivateField);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, child]) => PRIVATE_FIELD_PATTERN.test(key) || hasPrivateField(child));
  }
  return false;
}

export async function heirloomEligibility(
  group: CircleRecord,
  events: readonly SignedEvent[],
): Promise<{ ready: boolean; sharedQuest: boolean; reunionSeal: boolean; reason: string }> {
  const questMembers = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.body.type !== "quest.offering") continue;
    const questId = String(event.body.payload.questId);
    const members = questMembers.get(questId) ?? new Set<string>();
    members.add(event.body.memberId);
    questMembers.set(questId, members);
  }
  const revealQuests = new Set(
    events
      .filter((event) => event.body.type === "quest.reveal")
      .map((event) => String(event.body.payload.questId)),
  );
  const sharedQuest = [...questMembers].some(
    ([questId, memberIds]) => memberIds.size >= 2 && revealQuests.has(questId),
  );
  const reunionSeal = group.genesis
    ? (await deriveOrganismState(group, events)).structuralMolts > 0
    : false;
  const ready = Boolean(group.genesis && sharedQuest && reunionSeal);
  return {
    ready,
    sharedQuest,
    reunionSeal,
    reason: ready
      ? "One shared Braid reveal and one reunion molt are present."
      : `${sharedQuest ? "Shared Braid complete" : "Complete a 2+ member Braid"}; ${
          reunionSeal ? "reunion molt sealed" : "seal a reunion molt"
        }.`,
  };
}

function selectedEvents(events: readonly SignedEvent[], safeRevealIds: ReadonlySet<string>): SignedEvent[] {
  return events
    .filter((event) => {
      if (event.body.type === "quest.offering") return event.body.payload.approvedForHeirloom === true;
      if (event.body.type === "quest.reveal") return safeRevealIds.has(event.id);
      return ["circle.founded", "member.enrolled", "quest.created", "reunion.seal", "heirloom.minted"].includes(
        event.body.type,
      );
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function mintHeirloom(
  group: CircleRecord,
  events: readonly SignedEvent[],
  now = new Date(),
): Promise<HeirloomArtifact> {
  const eligibility = await heirloomEligibility(group, events);
  if (!eligibility.ready || !group.genesis) throw new Error(`Heirloom is not ready: ${eligibility.reason}`);
  const approvedOfferings = events.filter(
    (event) => event.body.type === "quest.offering" && event.body.payload.approvedForHeirloom === true,
  );
  const revealCandidates = events.filter(
    (event) => event.body.type === "quest.reveal" && event.body.payload.approvedForHeirloom === true,
  );
  const approvedReveals: SignedEvent[] = [];
  const approvedOfferingIds = new Set(approvedOfferings.map((event) => event.id));
  for (const reveal of revealCandidates) {
    const questId = String(reveal.body.payload.questId);
    const sourceIds = Array.isArray(reveal.body.payload.sourceOfferingIds)
      ? reveal.body.payload.sourceOfferingIds.map(String)
      : [];
    const sourceEvents = sourceIds
      .map((id) => events.find((event) => event.id === id))
      .filter((event): event is SignedEvent => Boolean(event));
    const questEvent = events.find(
      (event) => event.body.type === "quest.created" && event.body.payload.questId === questId,
    );
    const allQuestOfferingIds = events
      .filter(
        (event) => event.body.type === "quest.offering" && event.body.payload.questId === questId,
      )
      .map((event) => event.id)
      .sort();
    if (
      !questEvent ||
      sourceIds.length !== new Set(sourceIds).size ||
      sourceEvents.length !== sourceIds.length ||
      !sourceIds.every((id) => approvedOfferingIds.has(id)) ||
      sourceIds.sort().join("\n") !== allQuestOfferingIds.join("\n")
    ) {
      throw new Error("Approved reveal depends on an unapproved or missing offering");
    }
    const expected = await deriveSharedReveal(questFromEvent(questEvent), sourceEvents);
    if (
      !expected.approvedForHeirloom ||
      expected.text !== reveal.body.payload.text ||
      expected.influenceRoot !== reveal.body.payload.influenceRoot
    ) {
      throw new Error("Approved reveal is not the deterministic heirloom-safe reveal");
    }
    approvedReveals.push(reveal);
  }
  if (approvedOfferings.length > 128 || approvedReveals.length > 64) {
    throw new Error("Select at most 128 offerings and 64 reveals for one heirloom");
  }
  const { demo: _demo, ...portableGroupBase } = group;
  const portableGroup = { ...portableGroupBase, status: "heirloom-ready" as const };
  const body: HeirloomBody = {
    format: "rapp-heir",
    version: 1,
    mintedAt: now.toISOString(),
    group: portableGroup,
    genesis: group.genesis,
    signedEvents: selectedEvents(events, new Set(approvedReveals.map((event) => event.id))),
    organism: await deriveOrganismState(group, events),
    priorGenerationRoots: [...group.priorGenerationRoots],
    approvedStory: approvedOfferings.map((event) => ({
      memberId: event.body.memberId,
      text: String(event.body.payload.text),
      choice: String(event.body.payload.choice),
    })),
    approvedReveals: approvedReveals.map((event) => String(event.body.payload.text)),
    eventRoot: await eventRoot(events),
  };
  if (hasPrivateField(body)) throw new Error("Heirloom privacy filter rejected a private field");
  return { ...body, packageHash: await sha256(body) };
}

export async function verifyHeirloom(
  artifact: HeirloomArtifact,
): Promise<{ valid: true; packageHash: string; eventCount: number }> {
  if (canonicalBytes(artifact).byteLength > 4_000_000) throw new Error("Heirloom exceeds 4 MB");
  if (artifact.format !== "rapp-heir" || artifact.version !== 1 || !artifact.genesis) {
    throw new Error("Unsupported heirloom");
  }
  const { packageHash, ...body } = artifact;
  if (packageHash !== (await sha256(body))) throw new Error("Heirloom package hash is invalid");
  validateGroup(artifact.group);
  if (
    !Number.isFinite(Date.parse(artifact.mintedAt)) ||
    artifact.signedEvents.length > 5_000 ||
    artifact.approvedStory.length > 128 ||
    artifact.approvedReveals.length > 64 ||
    artifact.organism.aura < 0 ||
    artifact.organism.aura > 1 ||
    artifact.organism.motion < 0 ||
    artifact.organism.motion > 1 ||
    !Number.isSafeInteger(artifact.organism.structuralMolts) ||
    artifact.organism.structuralMolts < 0
  ) {
    throw new Error("Heirloom fields exceed supported bounds");
  }
  if (hasPrivateField(body)) throw new Error("Heirloom contains a forbidden private field");
  if (artifact.genesis.organismId !== artifact.group.genesis?.organismId) {
    throw new Error("Heirloom genesis mismatch");
  }
  for (const event of artifact.signedEvents) {
    const member = artifact.group.members[event.body.memberId];
    if (!member || !(await verifySignedEvent(event, member.publicJwk))) {
      throw new Error(`Heirloom signed event failed verification: ${event.id}`);
    }
  }
  for (const story of artifact.approvedStory) {
    if (story.text.length > 600 || story.choice.length > 48) throw new Error("Approved story exceeds bounds");
    const source = artifact.signedEvents.find(
      (event) =>
        event.body.type === "quest.offering" &&
        event.body.memberId === story.memberId &&
        event.body.payload.text === story.text &&
        event.body.payload.choice === story.choice &&
        event.body.payload.approvedForHeirloom === true,
    );
    if (!source) throw new Error("Approved story lacks its signed selected event");
  }
  for (const reveal of artifact.approvedReveals) {
    if (reveal.length > 8_000) throw new Error("Approved reveal exceeds bounds");
    if (
      !artifact.signedEvents.some(
        (event) =>
          event.body.type === "quest.reveal" &&
          event.body.payload.text === reveal &&
          event.body.payload.approvedForHeirloom === true,
      )
    ) {
      throw new Error("Approved reveal lacks its signed selected event");
    }
  }
  const structuralProof = await deriveOrganismState(artifact.group, artifact.signedEvents);
  if (
    artifact.organism.organismId !== structuralProof.organismId ||
    artifact.organism.memberCount !== structuralProof.memberCount ||
    artifact.organism.structuralMolts !== structuralProof.structuralMolts
  ) {
    throw new Error("Heirloom organism lacks matching signed structural proof");
  }
  return { valid: true, packageHash, eventCount: artifact.signedEvents.length };
}

export async function importVerifiedHeirloom(
  database: ReplicaDatabase,
  artifact: HeirloomArtifact,
): Promise<string> {
  const result = await verifyHeirloom(artifact);
  await setSetting(database, `heirloom:${result.packageHash}`, artifact);
  return result.packageHash;
}
