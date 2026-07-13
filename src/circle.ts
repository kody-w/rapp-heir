import { generateIdentity } from "./crypto";
import { deriveGenesis } from "./organism";
import {
  appendLocalEvent,
  appendLocalEventExpectedRoot,
  appendLocalEventWithGroupUpdate,
  canonicalGroupDigest,
  createCircleDraft,
  eventRoot,
  getCircle,
  getCircleEvents,
  getSetting,
  saveCircle,
  setSetting,
  type ReplicaDatabase,
} from "./storage";
import type { CircleRecord, LocalIdentity, SignedEvent } from "./types";

export async function finalizeCircle(
  database: ReplicaDatabase,
  groupId: string,
  identity: LocalIdentity,
  now = new Date(),
): Promise<CircleRecord> {
  const [group, events] = await Promise.all([
    getCircle(database, groupId),
    getCircleEvents(database, groupId),
  ]);
  if (!group) throw new Error("Circle not found");
  if (group.status !== "forming") throw new Error("Circle is already founded");
  if (group.coordinatorId !== identity.memberId) {
    throw new Error("The first-breath coordinator must commit the reviewed manifest");
  }
  const founders = Object.values(group.members).filter((member) => member.active);
  if (founders.length < 2) throw new Error("At least two people must complete QR + PIN before first breath");
  const expected = {
    eventRoot: await eventRoot(events),
    groupDigest: canonicalGroupDigest(group),
  };
  const genesis = await deriveGenesis(founders);
  const founded: CircleRecord = {
    ...group,
    status: "founded",
    foundedAt: now.toISOString(),
    genesis,
  };
  await appendLocalEventWithGroupUpdate(
    database,
    group.id,
    identity,
    "circle.founded",
    {
      name: group.name,
      oath: group.oath,
      genesis,
      founders: founders
        .map((member) => ({
          memberId: member.memberId,
          companion: member.companion,
          publicJwk: member.publicJwk,
          kind: member.kind,
          ...(member.specialization ? { specialization: member.specialization } : {}),
        }))
        .sort((left, right) => left.memberId.localeCompare(right.memberId)),
      coordinatorIsOwner: false,
    },
    founded,
    expected,
    now,
  );
  return founded;
}

export async function createOfflineDemo(
  database: ReplicaDatabase,
  identity: LocalIdentity,
): Promise<CircleRecord> {
  const demo = await generateIdentity({
    name: "Morrow (demo)",
    color: "#F4A261",
    temperament: "wry",
    voiceSeed: "paper-lantern",
  });
  const group = await createCircleDraft(
    database,
    identity,
    "Lantern Practice Circle",
    "We leave each path kinder than we found it.",
    true,
  );
  group.members[demo.memberId] = {
    memberId: demo.memberId,
    publicJwk: demo.publicJwk,
    companion: demo.companion,
    kind: "human",
    joinedAt: new Date().toISOString(),
    active: true,
  };
  await saveCircle(database, group);
  await setSetting(database, `demo-identity:${group.id}`, demo);
  return finalizeCircle(database, group.id, identity);
}

export function getDemoIdentity(
  database: ReplicaDatabase,
  groupId: string,
): Promise<LocalIdentity | undefined> {
  return getSetting<LocalIdentity>(database, `demo-identity:${groupId}`);
}

export async function appendDemoEvent(
  database: ReplicaDatabase,
  groupId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<SignedEvent> {
  const demo = await getDemoIdentity(database, groupId);
  if (!demo) throw new Error("This is not an offline practice Circle");
  return appendLocalEvent(database, groupId, demo, type, payload);
}

export async function appendDemoEventExpectedRoot(
  database: ReplicaDatabase,
  groupId: string,
  type: string,
  payload: Record<string, unknown>,
  expectedRoot: string,
): Promise<SignedEvent> {
  const demo = await getDemoIdentity(database, groupId);
  if (!demo) throw new Error("This is not an offline practice Circle");
  return appendLocalEventExpectedRoot(
    database,
    groupId,
    demo,
    type,
    payload,
    expectedRoot,
  );
}
