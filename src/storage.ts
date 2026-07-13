import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import { canonicalBytes, randomId, sha256, sha256Sync } from "./canonical";
import {
  createSignedEvent,
  memberIdFromPublicKey,
  normalizeMemberKind,
  normalizeSpecialization,
  validateCompanion,
  verifySignedEvent,
  verifyValue,
} from "./crypto";
import { MAX_REPLICA_BYTES, MAX_REPLICA_EVENTS } from "./limits";
import type {
  CircleRecord,
  EventBody,
  LocalIdentity,
  OutboxRecord,
  ReplicaBundle,
  ReunionCertificate,
  SettingRecord,
  SignedEvent,
} from "./types";

export const DATABASE_NAME = "rapp-heir";
export const DATABASE_VERSION = 1;
export const MAX_EVENTS_PER_PACK = MAX_REPLICA_EVENTS;
export const MAX_MEMBERS = 64;
export { MAX_REPLICA_BYTES, MAX_REPLICA_EVENTS };

interface HeirDatabase extends DBSchema {
  identity: {
    key: string;
    value: LocalIdentity;
  };
  groups: {
    key: string;
    value: CircleRecord;
  };
  events: {
    key: string;
    value: SignedEvent;
    indexes: {
      "by-group": string;
      "by-member": [string, string];
      "by-sequence": [string, string, number];
    };
  };
  outbox: {
    key: string;
    value: OutboxRecord;
    indexes: {
      "by-group": string;
      "by-state": string;
    };
  };
  settings: {
    key: string;
    value: SettingRecord;
  };
}

export type ReplicaDatabase = IDBPDatabase<HeirDatabase>;

const mutationTails = new Map<string, Promise<void>>();

async function withInProcessCircleQueue<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = mutationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => hold);
  mutationTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (mutationTails.get(key) === tail) {
      void tail.finally(() => {
        if (mutationTails.get(key) === tail) mutationTails.delete(key);
      });
    }
  }
}

export async function withCircleMutationLock<T>(
  db: ReplicaDatabase,
  groupId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${db.name}:${groupId}`;
  const run = (): Promise<T> => withInProcessCircleQueue(key, operation);
  const locks =
    typeof navigator === "undefined"
      ? undefined
      : navigator.locks;
  if (!locks) return run();
  return locks.request(`rapp-heir:circle:${key}`, { mode: "exclusive" }, run);
}

export function openReplicaDatabase(name = DATABASE_NAME): Promise<ReplicaDatabase> {
  return openDB<HeirDatabase>(name, DATABASE_VERSION, {
    upgrade(database) {
      database.createObjectStore("identity", { keyPath: "key" });
      database.createObjectStore("groups", { keyPath: "id" });
      const events = database.createObjectStore("events", { keyPath: "id" });
      events.createIndex("by-group", "body.groupId");
      events.createIndex("by-member", ["body.groupId", "body.memberId"]);
      events.createIndex("by-sequence", ["body.groupId", "body.memberId", "body.seq"]);
      const outbox = database.createObjectStore("outbox", { keyPath: "id" });
      outbox.createIndex("by-group", "groupId");
      outbox.createIndex("by-state", "state");
      database.createObjectStore("settings", { keyPath: "key" });
    },
    blocked() {
      console.warn("Rapp Heir storage upgrade is blocked by another tab.");
    },
  });
}

export async function saveIdentity(db: ReplicaDatabase, identity: LocalIdentity): Promise<void> {
  const existing = await db.get("identity", "local");
  if (existing && existing.memberId !== identity.memberId) {
    throw new Error("This device already has its one persistent companion");
  }
  if (identity.memberId !== (await memberIdFromPublicKey(identity.publicJwk))) {
    throw new Error("Identity public key does not match member ID");
  }
  const specialization = normalizeSpecialization(identity.specialization);
  await db.put("identity", {
    ...structuredClone(identity),
    kind: normalizeMemberKind(identity.kind),
    ...(specialization ? { specialization } : {}),
  });
}

export async function loadIdentity(db: ReplicaDatabase): Promise<LocalIdentity | undefined> {
  const identity = await db.get("identity", "local");
  if (!identity) return undefined;
  const specialization = normalizeSpecialization(identity.specialization);
  return {
    ...identity,
    kind: normalizeMemberKind(identity.kind),
    ...(specialization ? { specialization } : {}),
  };
}

export async function createCircleDraft(
  db: ReplicaDatabase,
  identity: LocalIdentity,
  name: string,
  oath: string,
  demo = false,
): Promise<CircleRecord> {
  const cleanName = name.trim();
  const cleanOath = oath.trim();
  if (cleanName.length < 2 || cleanName.length > 60) throw new Error("Circle name must be 2–60 characters");
  if (cleanOath.length < 4 || cleanOath.length > 180) throw new Error("Oath must be 4–180 characters");
  const createdAt = new Date().toISOString();
  const group: CircleRecord = {
    id: randomId("circle"),
    name: cleanName,
    oath: cleanOath,
    status: "forming",
    coordinatorId: identity.memberId,
    createdAt,
    members: {
      [identity.memberId]: {
        memberId: identity.memberId,
        publicJwk: identity.publicJwk,
        companion: identity.companion,
        kind: normalizeMemberKind(identity.kind),
        ...(identity.specialization ? { specialization: identity.specialization } : {}),
        joinedAt: createdAt,
        active: true,
      },
    },
    chapter: 0,
    priorGenerationRoots: [],
    demo,
  };
  validateGroup(group);
  await withCircleMutationLock(db, group.id, () =>
    db.put("groups", group).then(() => undefined),
  );
  return group;
}

export async function getCircle(db: ReplicaDatabase, groupId: string): Promise<CircleRecord | undefined> {
  const group = await db.get("groups", groupId);
  if (group) validateGroup(group);
  return group;
}

export async function listCircles(db: ReplicaDatabase): Promise<CircleRecord[]> {
  const groups = await db.getAll("groups");
  groups.forEach(validateGroup);
  return groups;
}

export async function saveCircle(db: ReplicaDatabase, group: CircleRecord): Promise<string> {
  validateGroup(group);
  return withCircleMutationLock(db, group.id, async () => {
    const transaction = db.transaction(["groups", "events"], "readwrite");
    const events = await transaction.objectStore("events").index("by-group").getAll(group.id);
    assertReplicaStateBounds(group, events);
    const key = await transaction.objectStore("groups").put(structuredClone(group));
    await transaction.done;
    return key;
  });
}

export function getCircleEvents(db: ReplicaDatabase, groupId: string): Promise<SignedEvent[]> {
  return db.getAllFromIndex("events", "by-group", groupId);
}

export async function eventRoot(events: readonly SignedEvent[]): Promise<string> {
  return sha256([...new Set(events.map((event) => event.id))].sort());
}

export function eventRootSync(events: readonly SignedEvent[]): string {
  return sha256Sync([...new Set(events.map((event) => event.id))].sort());
}

export function canonicalGroupDigest(group: CircleRecord): string {
  const normalized = structuredClone(group);
  validateGroup(normalized);
  return sha256Sync(normalized);
}

export interface GroupUpdateBinding {
  eventRoot: string;
  groupDigest: string;
}

export function assertReplicaBounds(bundle: ReplicaBundle): void {
  if (bundle.events.length > MAX_REPLICA_EVENTS) {
    throw new Error(`Replica limit is ${MAX_REPLICA_EVENTS} events; nothing was changed`);
  }
  if (new Set(bundle.events.map((event) => event.id)).size !== bundle.events.length) {
    throw new Error("Replica contains duplicate event IDs");
  }
  if (canonicalBytes(bundle).byteLength > MAX_REPLICA_BYTES) {
    throw new Error("Replica exceeds the 512 KiB canonical limit; nothing was changed");
  }
}

function assertReplicaStateBounds(
  group: CircleRecord,
  events: readonly SignedEvent[],
  exportedAt = new Date().toISOString(),
): void {
  assertReplicaBounds({
    format: "rapp-heir-replica",
    version: 1,
    exportedAt,
    group,
    events: [...events].sort((left, right) => left.id.localeCompare(right.id)),
    root: "x".repeat(43),
  });
}

export async function buildReplicaBundle(
  group: CircleRecord,
  events: readonly SignedEvent[],
  exportedAt = new Date().toISOString(),
): Promise<ReplicaBundle> {
  const sorted = [...events].sort((left, right) => left.id.localeCompare(right.id));
  const bundle: ReplicaBundle = {
    format: "rapp-heir-replica",
    version: 1,
    exportedAt,
    group: structuredClone(group),
    events: sorted,
    root: await eventRoot(sorted),
  };
  assertReplicaBounds(bundle);
  return bundle;
}

async function prepareLocalEventFromState(
  currentGroup: CircleRecord,
  allEvents: readonly SignedEvent[],
  groupId: string,
  identity: LocalIdentity,
  type: string,
  payload: Record<string, unknown>,
  now = new Date(),
  updatedGroup?: CircleRecord,
): Promise<{ event: SignedEvent; outbox: OutboxRecord; group: CircleRecord }> {
  const group = structuredClone(currentGroup);
  if (!group.members[identity.memberId]) throw new Error("Local companion is not enrolled in this Circle");
  validateGroup(group);
  const replicaGroup = updatedGroup ? structuredClone(updatedGroup) : group;
  if (replicaGroup.id !== group.id || !replicaGroup.members[identity.memberId]) {
    throw new Error("Atomic group update does not match the local Circle");
  }
  validateGroup(replicaGroup);
  const existing = allEvents.filter((event) => event.body.memberId === identity.memberId);
  let sequence = 1;
  let previous: string | null = null;
  if (existing.length > 0) {
    const maximum = Math.max(...existing.map((event) => event.body.seq));
    sequence = maximum + 1;
    previous =
      existing
        .filter((event) => event.body.seq === maximum)
        .map((event) => event.id)
        .sort()
        .at(0) ?? null;
  }
  const body: EventBody = {
    version: 1,
    groupId,
    memberId: identity.memberId,
    seq: sequence,
    prev: previous,
    type,
    createdAt: now.toISOString(),
    payload,
  };
  const event = await createSignedEvent(body, identity.privateJwk);
  await buildReplicaBundle(replicaGroup, [...allEvents, event], now.toISOString());
  const outbox: OutboxRecord = {
    id: `${groupId}:${event.id}`,
    groupId,
    eventId: event.id,
    state: "ready-not-sent",
    updatedAt: now.toISOString(),
  };
  return { event, outbox, group: replicaGroup };
}

async function prepareLocalEvent(
  db: ReplicaDatabase,
  groupId: string,
  identity: LocalIdentity,
  type: string,
  payload: Record<string, unknown>,
  now = new Date(),
  updatedGroup?: CircleRecord,
): Promise<{ event: SignedEvent; outbox: OutboxRecord; group: CircleRecord }> {
  const [group, allEvents] = await Promise.all([
    db.get("groups", groupId),
    getCircleEvents(db, groupId),
  ]);
  if (!group) throw new Error("Local companion is not enrolled in this Circle");
  return prepareLocalEventFromState(
    group,
    allEvents,
    groupId,
    identity,
    type,
    payload,
    now,
    updatedGroup,
  );
}

async function appendLocalEventUnlocked(
  db: ReplicaDatabase,
  groupId: string,
  identity: LocalIdentity,
  type: string,
  payload: Record<string, unknown>,
  now = new Date(),
  expectedRoot?: string,
): Promise<SignedEvent> {
  const { event, outbox } = await prepareLocalEvent(db, groupId, identity, type, payload, now);
  const transaction = db.transaction(["groups", "events", "outbox"], "readwrite");
  const [currentGroup, currentEvents] = await Promise.all([
    transaction.objectStore("groups").get(groupId),
    transaction.objectStore("events").index("by-group").getAll(groupId),
  ]);
  if (!currentGroup) throw new Error("Circle disappeared before local append");
  if (expectedRoot !== undefined && eventRootSync(currentEvents) !== expectedRoot) {
    transaction.abort();
    await transaction.done.catch(() => undefined);
    throw new Error("Circle state changed before atomic append");
  }
  assertReplicaStateBounds(currentGroup, [...currentEvents, event], now.toISOString());
  await Promise.all([transaction.objectStore("events").add(event), transaction.objectStore("outbox").put(outbox)]);
  await transaction.done;
  return event;
}

export function appendLocalEvent(
  db: ReplicaDatabase,
  groupId: string,
  identity: LocalIdentity,
  type: string,
  payload: Record<string, unknown>,
  now = new Date(),
): Promise<SignedEvent> {
  return withCircleMutationLock(db, groupId, () =>
    appendLocalEventUnlocked(db, groupId, identity, type, payload, now),
  );
}

export function appendLocalEventExpectedRoot(
  db: ReplicaDatabase,
  groupId: string,
  identity: LocalIdentity,
  type: string,
  payload: Record<string, unknown>,
  expectedRoot: string,
  now = new Date(),
): Promise<SignedEvent> {
  if (!/^[A-Za-z0-9_-]{20,}$/u.test(expectedRoot)) {
    return Promise.reject(new Error("Expected Circle event root is invalid"));
  }
  return withCircleMutationLock(db, groupId, () =>
    appendLocalEventUnlocked(
      db,
      groupId,
      identity,
      type,
      payload,
      now,
      expectedRoot,
    ),
  );
}

export async function appendLocalEventWithGroupUpdate(
  db: ReplicaDatabase,
  groupId: string,
  identity: LocalIdentity,
  type: string,
  payload: Record<string, unknown>,
  updatedGroup: CircleRecord,
  expected: GroupUpdateBinding,
  now = new Date(),
): Promise<SignedEvent> {
  if (
    !/^[A-Za-z0-9_-]{43}$/u.test(expected.eventRoot) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(expected.groupDigest)
  ) {
    throw new Error("Expected structural update binding is invalid");
  }
  const groupUpdate = structuredClone(updatedGroup);
  const binding = structuredClone(expected);
  return withCircleMutationLock(db, groupId, async () => {
    const snapshotTransaction = db.transaction(["groups", "events"], "readwrite");
    const [snapshotGroup, snapshotEvents] = await Promise.all([
      snapshotTransaction.objectStore("groups").get(groupId),
      snapshotTransaction.objectStore("events").index("by-group").getAll(groupId),
    ]);
    if (
      !snapshotGroup ||
      eventRootSync(snapshotEvents) !== binding.eventRoot ||
      canonicalGroupDigest(snapshotGroup) !== binding.groupDigest
    ) {
      snapshotTransaction.abort();
      await snapshotTransaction.done.catch(() => undefined);
      throw new Error("Circle state changed before atomic structural update");
    }
    await snapshotTransaction.done;

    const { event, outbox, group } = await prepareLocalEventFromState(
      snapshotGroup,
      snapshotEvents,
      groupId,
      identity,
      type,
      payload,
      now,
      groupUpdate,
    );
    const transaction = db.transaction(["groups", "events", "outbox"], "readwrite");
    const [currentGroup, currentEvents] = await Promise.all([
      transaction.objectStore("groups").get(groupId),
      transaction.objectStore("events").index("by-group").getAll(groupId),
    ]);
    if (
      !currentGroup ||
      eventRootSync(currentEvents) !== binding.eventRoot ||
      canonicalGroupDigest(currentGroup) !== binding.groupDigest
    ) {
      transaction.abort();
      await transaction.done.catch(() => undefined);
      throw new Error("Circle state changed before atomic structural update");
    }
    assertReplicaStateBounds(group, [...currentEvents, event], now.toISOString());
    await Promise.all([
      transaction.objectStore("groups").put(group),
      transaction.objectStore("events").add(event),
      transaction.objectStore("outbox").put(outbox),
    ]);
    await transaction.done;
    return event;
  });
}

export async function makeReplicaBundle(
  db: ReplicaDatabase,
  groupId: string,
): Promise<ReplicaBundle> {
  const [group, events] = await Promise.all([db.get("groups", groupId), getCircleEvents(db, groupId)]);
  if (!group) throw new Error("Circle not found");
  validateGroup(group);
  return buildReplicaBundle(group, events);
}

function samePublicKey(left: JsonWebKey, right: JsonWebKey): boolean {
  return left.kty === right.kty && left.crv === right.crv && left.x === right.x && left.y === right.y;
}

function sameCompanion(
  left: CircleRecord["members"][string]["companion"],
  right: CircleRecord["members"][string]["companion"],
): boolean {
  return (
    left.name === right.name &&
    left.color.toLowerCase() === right.color.toLowerCase() &&
    left.temperament === right.temperament &&
    left.voiceSeed === right.voiceSeed
  );
}

function sameMemberFields(
  left: { kind?: unknown; specialization?: unknown },
  right: { kind?: unknown; specialization?: unknown },
): boolean {
  return (
    normalizeMemberKind(left.kind) === normalizeMemberKind(right.kind) &&
    normalizeSpecialization(left.specialization) === normalizeSpecialization(right.specialization)
  );
}

function mergeGroups(existing: CircleRecord | undefined, incoming: CircleRecord): CircleRecord {
  if (!existing) return structuredClone(incoming);
  if (
    existing.id !== incoming.id ||
    existing.name !== incoming.name ||
    existing.oath !== incoming.oath ||
    existing.coordinatorId !== incoming.coordinatorId ||
    existing.createdAt !== incoming.createdAt
  ) {
    throw new Error("Circle manifest conflicts with the local replica");
  }
  const members = structuredClone(existing.members);
  for (const [memberId, member] of Object.entries(incoming.members)) {
    const local = members[memberId];
    if (
      local &&
      (
        !samePublicKey(local.publicJwk, member.publicJwk) ||
        !sameCompanion(local.companion, member.companion) ||
        !sameMemberFields(local, member)
      )
    ) {
      throw new Error("Member identity conflicts with the local replica");
    }
    members[memberId] = local ?? structuredClone(member);
  }
  if (existing.genesis && incoming.genesis && existing.genesis.organismId !== incoming.genesis.organismId) {
    throw new Error("Genesis body conflicts with the local replica");
  }
  const statusRank = { forming: 0, founded: 1, "heirloom-ready": 2 } as const;
  const status = statusRank[incoming.status] > statusRank[existing.status] ? incoming.status : existing.status;
  const merged: CircleRecord = {
    ...existing,
    status,
    members,
    chapter: Math.max(existing.chapter, incoming.chapter),
    priorGenerationRoots: [...new Set([...existing.priorGenerationRoots, ...incoming.priorGenerationRoots])].sort(),
  };
  const genesis = existing.genesis ?? incoming.genesis;
  const foundedAt = existing.foundedAt ?? incoming.foundedAt;
  if (genesis) merged.genesis = genesis;
  if (foundedAt) merged.foundedAt = foundedAt;
  if (existing.demo !== undefined || incoming.demo !== undefined) {
    merged.demo = Boolean(existing.demo || incoming.demo);
  }
  return merged;
}

export async function validateReplicaBundle(
  bundle: ReplicaBundle,
  existing?: CircleRecord,
  existingEvents: readonly SignedEvent[] = [],
): Promise<CircleRecord> {
  if (bundle.format !== "rapp-heir-replica" || bundle.version !== 1) throw new Error("Unsupported replica pack");
  if (!Number.isFinite(Date.parse(bundle.exportedAt))) throw new Error("Replica export timestamp is invalid");
  assertReplicaBounds(bundle);
  if (existing) validateGroup(existing);
  validateGroup(bundle.group);
  for (const [memberId, member] of Object.entries(bundle.group.members)) {
    try {
      if ((await memberIdFromPublicKey(member.publicJwk)) !== memberId) {
        throw new Error("mismatch");
      }
    } catch {
      throw new Error(`Roster key does not derive member ID ${memberId}`);
    }
  }
  if (bundle.root !== (await eventRoot(bundle.events))) throw new Error("Replica event root is invalid");
  const merged = mergeGroups(existing, bundle.group);
  const eventIds = new Set([...existingEvents.map((event) => event.id), ...bundle.events.map((event) => event.id)]);
  const eventMap = new Map(
    [...existingEvents, ...bundle.events].map((event) => [event.id, event] as const),
  );
  await buildReplicaBundle(merged, [...eventMap.values()], bundle.exportedAt);
  const importedIds = new Set<string>();
  for (const event of bundle.events) {
    if (importedIds.has(event.id)) continue;
    importedIds.add(event.id);
    if (event.body.groupId !== bundle.group.id) throw new Error("Cross-Circle event rejected");
    const member = merged.members[event.body.memberId];
    if (!member || !(await verifySignedEvent(event, member.publicJwk))) throw new Error(`Invalid signed event ${event.id}`);
    if (event.body.prev === null) {
      if (event.body.seq !== 1) throw new Error(`Event ${event.id} breaks its member chain`);
    } else {
      if (!eventIds.has(event.body.prev)) throw new Error(`Event ${event.id} has an unknown predecessor`);
      const predecessor = eventMap.get(event.body.prev);
      if (
        !predecessor ||
        predecessor.body.groupId !== event.body.groupId ||
        predecessor.body.memberId !== event.body.memberId ||
        predecessor.body.seq + 1 !== event.body.seq
      ) {
        throw new Error(`Event ${event.id} breaks its member chain`);
      }
    }
  }

  const authorizedMembers = new Set(existing ? Object.keys(existing.members) : [bundle.group.coordinatorId]);
  const newlyPresentedMembers = Object.keys(bundle.group.members).filter(
    (memberId) => !existing?.members[memberId],
  );
  if (existing && existing.status !== "forming" && newlyPresentedMembers.length > 0) {
    throw new Error("Founded Circle roster is closed; unknown member keys are rejected");
  }
  const founded = [...eventMap.values()].find(
    (event) =>
      event.body.type === "circle.founded" &&
      event.body.memberId === bundle.group.coordinatorId &&
      event.body.payload.genesis &&
      typeof event.body.payload.genesis === "object" &&
      (event.body.payload.genesis as { organismId?: unknown }).organismId === bundle.group.genesis?.organismId,
  );
  if (founded && Array.isArray(founded.body.payload.founders)) {
    for (const candidate of founded.body.payload.founders) {
      if (!candidate || typeof candidate !== "object") continue;
      const founder = candidate as {
        memberId?: unknown;
        publicJwk?: JsonWebKey;
        companion?: CircleRecord["members"][string]["companion"];
        kind?: unknown;
        specialization?: unknown;
      };
      if (typeof founder.memberId !== "string") continue;
      const rosterMember = merged.members[founder.memberId];
      if (
        rosterMember &&
        founder.publicJwk &&
        founder.companion &&
        samePublicKey(rosterMember.publicJwk, founder.publicJwk) &&
        sameCompanion(rosterMember.companion, founder.companion) &&
        sameMemberFields(rosterMember, founder)
      ) {
        authorizedMembers.add(founder.memberId);
      }
    }
  }
  if (
    (!existing || existing.status === "forming") &&
    bundle.group.status !== "forming" &&
    (!founded || !bundle.group.genesis)
  ) {
    throw new Error("Founded Circle state lacks its coordinator-signed manifest");
  }
  const enrollments = bundle.events.filter((event) => event.body.type === "member.enrolled");
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of enrollments) {
      if (!authorizedMembers.has(event.body.memberId)) continue;
      const enrolledMemberId = event.body.payload.enrolledMemberId;
      if (typeof enrolledMemberId !== "string" || authorizedMembers.has(enrolledMemberId)) continue;
      const rosterMember = merged.members[enrolledMemberId];
      const publicJwk = event.body.payload.publicJwk as JsonWebKey | undefined;
      const companion = event.body.payload.companion as
        | CircleRecord["members"][string]["companion"]
        | undefined;
      const enrolledFields = {
        kind: event.body.payload.kind,
        specialization: event.body.payload.specialization,
      };
      if (
        rosterMember &&
        publicJwk &&
        companion &&
        samePublicKey(rosterMember.publicJwk, publicJwk) &&
        sameCompanion(rosterMember.companion, companion) &&
        sameMemberFields(rosterMember, enrolledFields)
      ) {
        authorizedMembers.add(enrolledMemberId);
        changed = true;
      }
    }
  }
  for (const memberId of Object.keys(bundle.group.members)) {
    if (!authorizedMembers.has(memberId)) {
      throw new Error(`Roster member ${memberId} lacks a signed enrollment or founder manifest`);
    }
  }

  const statusRank = { forming: 0, founded: 1, "heirloom-ready": 2 } as const;
  let projectedStatus = existing?.status ?? "forming";
  if (founded) projectedStatus = "founded";
  if (
    [...eventMap.values()].some(
      (event) =>
        event.body.type === "heirloom.minted" &&
        typeof event.body.payload.packageHash === "string" &&
        /^[A-Za-z0-9_-]{20,}$/u.test(event.body.payload.packageHash),
    )
  ) {
    projectedStatus = "heirloom-ready";
  }
  if (statusRank[bundle.group.status] > statusRank[projectedStatus]) {
    throw new Error("Circle progression is not supported by signed events");
  }
  merged.status = projectedStatus;

  let projectedChapter = existing?.chapter ?? 0;
  const projectedRoots = new Set(existing?.priorGenerationRoots ?? []);
  const seals = [...eventMap.values()]
    .filter((event) => event.body.type === "reunion.seal")
    .sort(
      (left, right) =>
        Number(left.body.payload.chapter) - Number(right.body.payload.chapter) ||
        left.id.localeCompare(right.id),
    );
  for (const seal of seals) {
    const certificate = seal.body.payload.certificate as ReunionCertificate | undefined;
    if (
      certificate?.challenge?.chapter === projectedChapter + 1 &&
      (await certificateApprovesChapter(merged, certificate, Date.parse(seal.body.createdAt)))
    ) {
      projectedChapter += 1;
      projectedRoots.add(certificate.challenge.eventRoot);
    }
  }
  if (bundle.group.chapter > projectedChapter) {
    throw new Error("Circle chapter is not supported by reunion quorum");
  }
  for (const root of bundle.group.priorGenerationRoots) {
    if (!projectedRoots.has(root)) throw new Error("Prior generation root lacks a valid reunion seal");
  }
  merged.chapter = projectedChapter;
  merged.priorGenerationRoots = [...projectedRoots].sort();
  await buildReplicaBundle(merged, [...eventMap.values()], bundle.exportedAt);
  return merged;
}

async function certificateApprovesChapter(
  group: CircleRecord,
  certificate: ReunionCertificate,
  atTime: number,
): Promise<boolean> {
  if (
    !certificate ||
    !certificate.challenge ||
    !Array.isArray(certificate.approvals)
  ) {
    return false;
  }
  const challenge = certificate.challenge;
  const active = Object.values(group.members).filter((member) => member.active).length;
  const threshold = Math.max(2, Math.ceil(active / 2));
  if (
    challenge.version !== 1 ||
    challenge.groupId !== group.id ||
    !Number.isSafeInteger(challenge.chapter) ||
    !Number.isFinite(challenge.issuedAt) ||
    !Number.isFinite(challenge.expiresAt) ||
    typeof challenge.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{20,}$/u.test(challenge.eventRoot) ||
    challenge.issuedAt > atTime ||
    challenge.expiresAt < atTime ||
    challenge.expiresAt - challenge.issuedAt > 5 * 60 * 1000 ||
    certificate.threshold !== threshold
  ) {
    return false;
  }
  const seen = new Set<string>();
  let approvals = 0;
  for (const approval of certificate.approvals) {
    if (
      !approval ||
      typeof approval.memberId !== "string" ||
      typeof approval.signature !== "string"
    ) {
      continue;
    }
    if (seen.has(approval.memberId)) continue;
    seen.add(approval.memberId);
    const member = group.members[approval.memberId];
    if (member?.active && (await verifyValue(challenge, approval.signature, member.publicJwk))) {
      approvals += 1;
    }
  }
  return approvals >= threshold;
}

async function mergeReplicaBundleUnlocked(
  db: ReplicaDatabase,
  bundle: ReplicaBundle,
): Promise<{ added: number; duplicates: number; root: string }> {
  const [existing, existingEvents] = await Promise.all([
    db.get("groups", bundle.group.id),
    getCircleEvents(db, bundle.group.id),
  ]);
  const mergedGroup = await validateReplicaBundle(bundle, existing, existingEvents);
  let added = 0;
  let duplicates = 0;
  const transaction = db.transaction(["groups", "events", "outbox"], "readwrite");
  const latestEvents = await transaction
    .objectStore("events")
    .index("by-group")
    .getAll(bundle.group.id);
  const localIds = new Set(latestEvents.map((event) => event.id));
  const boundedEvents = new Map(
    [...latestEvents, ...bundle.events].map((event) => [event.id, event] as const),
  );
  assertReplicaStateBounds(mergedGroup, [...boundedEvents.values()], bundle.exportedAt);
  await transaction.objectStore("groups").put(mergedGroup);
  for (const event of bundle.events) {
    if (localIds.has(event.id)) {
      duplicates += 1;
      continue;
    }
    await transaction.objectStore("events").add(event);
    added += 1;
    await transaction.objectStore("outbox").put({
      id: `${bundle.group.id}:${event.id}`,
      groupId: bundle.group.id,
      eventId: event.id,
      state: "received-hash-checked",
      updatedAt: new Date().toISOString(),
    });
    localIds.add(event.id);
  }
  await transaction.done;
  const mergedEvents = new Map(
    [...latestEvents, ...bundle.events].map((event) => [event.id, event] as const),
  );
  return { added, duplicates, root: await eventRoot([...mergedEvents.values()]) };
}

export function mergeReplicaBundle(
  db: ReplicaDatabase,
  bundle: ReplicaBundle,
): Promise<{ added: number; duplicates: number; root: string }> {
  return withCircleMutationLock(db, bundle.group.id, () =>
    mergeReplicaBundleUnlocked(db, bundle),
  );
}

export async function markOutbox(
  db: ReplicaDatabase,
  groupId: string,
  eventIds: readonly string[],
  state: OutboxRecord["state"],
): Promise<void> {
  await withCircleMutationLock(db, groupId, async () => {
    const transaction = db.transaction("outbox", "readwrite");
    for (const eventId of eventIds) {
      await transaction.store.put({
        id: `${groupId}:${eventId}`,
        groupId,
        eventId,
        state,
        updatedAt: new Date().toISOString(),
      });
    }
    await transaction.done;
  });
}

export async function getSetting<T>(db: ReplicaDatabase, key: string): Promise<T | undefined> {
  return (await db.get("settings", key))?.value as T | undefined;
}

export async function setSetting(db: ReplicaDatabase, key: string, value: unknown): Promise<void> {
  await db.put("settings", { key, value: structuredClone(value) });
}

export async function storagePersistenceState(): Promise<{
  supported: boolean;
  persisted: boolean;
  requested: boolean;
}> {
  if (!navigator.storage?.persisted || !navigator.storage.persist) {
    return { supported: false, persisted: false, requested: false };
  }
  const before = await navigator.storage.persisted();
  if (before) return { supported: true, persisted: true, requested: false };
  const persisted = await navigator.storage.persist();
  return { supported: true, persisted, requested: true };
}

export function validateGroup(group: CircleRecord): void {
  if (!/^circle_[A-Za-z0-9_-]{12,}$/u.test(group.id)) throw new Error("Invalid Circle ID");
  if (group.name.trim().length < 2 || group.name.length > 60) throw new Error("Invalid Circle name");
  if (group.oath.trim().length < 4 || group.oath.length > 180) throw new Error("Invalid Circle oath");
  const members = Object.entries(group.members);
  if (members.length < 1 || members.length > MAX_MEMBERS) throw new Error("Circle member count is invalid");
  if (!group.members[group.coordinatorId]) throw new Error("Coordinator must be an enrolled member");
  for (const [memberId, member] of members) {
    if (member.memberId !== memberId) throw new Error("Member map is inconsistent");
    if (!member.companion || !member.publicJwk) throw new Error("Every member must have exactly one companion and key");
    member.kind = normalizeMemberKind(member.kind);
    const specialization = normalizeSpecialization(member.specialization);
    if (specialization) member.specialization = specialization;
    else delete member.specialization;
    validateCompanion(member.companion);
    if (
      member.publicJwk.kty !== "EC" ||
      member.publicJwk.crv !== "P-256" ||
      typeof member.publicJwk.x !== "string" ||
      typeof member.publicJwk.y !== "string" ||
      member.publicJwk.d !== undefined ||
      typeof member.active !== "boolean" ||
      !Number.isFinite(Date.parse(member.joinedAt))
    ) {
      throw new Error("Member profile contains an invalid public key or enrollment record");
    }
  }
}

export async function deleteReplicaDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
    request.onblocked = () => reject(new Error("Database deletion blocked"));
  });
}
