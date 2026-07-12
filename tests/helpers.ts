import { randomId } from "../src/canonical";
import { createSignedEvent, generateIdentity } from "../src/crypto";
import { deriveGenesis } from "../src/organism";
import type {
  CircleRecord,
  Companion,
  EventBody,
  LocalIdentity,
  SignedEvent,
} from "../src/types";

const COLORS = ["#8B7CFF", "#75EBC4", "#F4A261", "#E76F91"];

export async function identity(name: string, index = 0): Promise<LocalIdentity> {
  const companion: Companion = {
    name,
    color: COLORS[index % COLORS.length] ?? "#8B7CFF",
    temperament: (["curious", "steady", "wry", "bright"] as const)[index % 4] ?? "curious",
    voiceSeed: `${name.toLowerCase().replace(/\s+/gu, "-")}-seed`,
  };
  return generateIdentity(companion);
}

export async function groupFor(
  members: readonly LocalIdentity[],
  options: { status?: CircleRecord["status"]; demo?: boolean } = {},
): Promise<CircleRecord> {
  if (!members[0]) throw new Error("Need a coordinator");
  const createdAt = new Date(1_700_000_000_000).toISOString();
  const group: CircleRecord = {
    id: randomId("circle"),
    name: "Test Lanterns",
    oath: "We change one another gently.",
    status: options.status ?? "founded",
    coordinatorId: members[0].memberId,
    createdAt,
    members: Object.fromEntries(
      members.map((member) => [
        member.memberId,
        {
          memberId: member.memberId,
          publicJwk: member.publicJwk,
          companion: member.companion,
          kind: member.kind,
          ...(member.specialization ? { specialization: member.specialization } : {}),
          joinedAt: createdAt,
          active: true,
        },
      ]),
    ),
    chapter: 0,
    priorGenerationRoots: [],
  };
  if (group.status !== "forming") {
    group.foundedAt = createdAt;
    group.genesis = await deriveGenesis(Object.values(group.members));
  }
  if (options.demo !== undefined) group.demo = options.demo;
  return group;
}

export async function signedEvent(
  group: CircleRecord,
  signer: LocalIdentity,
  type: string,
  payload: Record<string, unknown>,
  seq = 1,
  prev: string | null = null,
  date = new Date(1_700_000_000_000 + seq * 1000),
): Promise<SignedEvent> {
  const body: EventBody = {
    version: 1,
    groupId: group.id,
    memberId: signer.memberId,
    seq,
    prev,
    type,
    createdAt: date.toISOString(),
    payload,
  };
  return createSignedEvent(body, signer.privateJwk);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function uniqueDatabaseName(label: string): string {
  return `rapp-heir-test-${label}-${crypto.randomUUID()}`;
}
