import { afterEach, describe, expect, it } from "vitest";
import { canonicalBytes } from "../src/canonical";
import {
  MAX_REPLICA_BYTES,
  MAX_REPLICA_EVENTS,
  appendLocalEvent,
  appendLocalEventWithGroupUpdate,
  canonicalGroupDigest,
  deleteReplicaDatabase,
  eventRoot,
  getCircle,
  getCircleEvents,
  makeReplicaBundle,
  mergeReplicaBundle,
  openReplicaDatabase,
  saveCircle,
  saveIdentity,
  validateReplicaBundle,
  type ReplicaDatabase,
} from "../src/storage";
import type { CircleRecord, ReplicaBundle, SignedEvent } from "../src/types";
import { clone, groupFor, identity, signedEvent, uniqueDatabaseName } from "./helpers";

const databases: ReplicaDatabase[] = [];

async function database(label: string): Promise<ReplicaDatabase> {
  const db = await openReplicaDatabase(uniqueDatabaseName(label));
  databases.push(db);
  return db;
}

async function bundle(group: CircleRecord, events: SignedEvent[]): Promise<ReplicaBundle> {
  return {
    format: "rapp-heir-replica",
    version: 1,
    exportedAt: new Date().toISOString(),
    group,
    events,
    root: await eventRoot(events),
  };
}

afterEach(async () => {
  const open = databases.splice(0);
  for (const db of open) {
    const name = db.name;
    db.close();
    await deleteReplicaDatabase(name);
  }
});

describe("local-first replica merge", () => {
  it("enforces one persistent local companion", async () => {
    const db = await database("identity");
    const fern = await identity("Fern");
    const other = await identity("Other", 1);
    await saveIdentity(db, fern);
    await saveIdentity(db, fern);
    await expect(saveIdentity(db, other)).rejects.toThrow(/one persistent companion/u);
  });

  it("converges two replicas after independent offline edits", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const left = await database("left");
    const right = await database("right");
    await Promise.all([saveCircle(left, group), saveCircle(right, group)]);
    await appendLocalEvent(left, group.id, fern, "story.note", { text: "left was offline" });
    await appendLocalEvent(right, group.id, morrow, "story.note", { text: "right was offline" });
    const [leftBefore, rightBefore] = await Promise.all([
      makeReplicaBundle(left, group.id),
      makeReplicaBundle(right, group.id),
    ]);
    await Promise.all([mergeReplicaBundle(left, rightBefore), mergeReplicaBundle(right, leftBefore)]);
    const [leftEvents, rightEvents] = await Promise.all([
      getCircleEvents(left, group.id),
      getCircleEvents(right, group.id),
    ]);
    expect(leftEvents).toHaveLength(2);
    expect(rightEvents).toHaveLength(2);
    expect(await eventRoot(leftEvents)).toBe(await eventRoot(rightEvents));
  });

  it("is associative, commutative, and idempotent across three replicas", async () => {
    const a = await identity("A");
    const b = await identity("B", 1);
    const c = await identity("C", 2);
    const group = await groupFor([a, b, c]);
    const events = await Promise.all([
      signedEvent(group, a, "story.note", { text: "a" }),
      signedEvent(group, b, "story.note", { text: "b" }),
      signedEvent(group, c, "story.note", { text: "c" }),
    ]);
    const left = await database("aci-left");
    const right = await database("aci-right");
    await saveCircle(left, group);
    await saveCircle(right, group);
    await mergeReplicaBundle(left, await bundle(group, [events[0] as SignedEvent]));
    await mergeReplicaBundle(left, await bundle(group, [events[1] as SignedEvent, events[2] as SignedEvent]));
    await mergeReplicaBundle(right, await bundle(group, [events[2] as SignedEvent, events[0] as SignedEvent]));
    await mergeReplicaBundle(right, await bundle(group, [events[1] as SignedEvent]));
    const duplicate = await mergeReplicaBundle(right, await bundle(group, events as SignedEvent[]));
    expect(duplicate.added).toBe(0);
    expect(duplicate.duplicates).toBe(3);
    expect(await eventRoot(await getCircleEvents(left, group.id))).toBe(
      await eventRoot(await getCircleEvents(right, group.id)),
    );
  });

  it("preserves valid same-sequence forks rather than picking an arrival winner", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const first = await signedEvent(group, fern, "story.note", { text: "path one" }, 1);
    const fork = await signedEvent(group, fern, "story.note", { text: "path two" }, 1);
    expect(first.id).not.toBe(fork.id);
    const db = await database("fork");
    await saveCircle(db, group);
    await mergeReplicaBundle(db, await bundle(group, [first, fork]));
    const events = await getCircleEvents(db, group.id);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.body.seq))).toEqual(new Set([1]));
  });

  it("treats duplicate event IDs as no-ops", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const event = await signedEvent(group, fern, "story.note", { text: "same" });
    const db = await database("duplicate");
    await saveCircle(db, group);
    expect(await mergeReplicaBundle(db, await bundle(group, [event]))).toMatchObject({
      added: 1,
      duplicates: 0,
    });
    expect(await mergeReplicaBundle(db, await bundle(group, [event]))).toMatchObject({
      added: 0,
      duplicates: 1,
    });
  });

  it("rejects a tampered pack atomically", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const valid = await signedEvent(group, fern, "story.note", { text: "valid" });
    const invalid = clone(await signedEvent(group, morrow, "story.note", { text: "before" }));
    invalid.body.payload = { text: "after tamper" };
    const candidate = await bundle(group, [valid, invalid]);
    const db = await database("atomic");
    await saveCircle(db, group);
    await expect(mergeReplicaBundle(db, candidate)).rejects.toThrow(/invalid signed event/iu);
    expect(await getCircleEvents(db, group.id)).toHaveLength(0);
  });

  it("rejects roster injection without a founder manifest or signed enrollment", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const intruder = await identity("Intruder", 2);
    const group = await groupFor([fern, morrow]);
    const injected = clone(group);
    injected.members[intruder.memberId] = {
      memberId: intruder.memberId,
      publicJwk: intruder.publicJwk,
      companion: intruder.companion,
      kind: "human",
      joinedAt: new Date().toISOString(),
      active: true,
    };
    const intruderEvent = await signedEvent(injected, intruder, "story.note", { text: "self enrolled" });
    const db = await database("roster-injection");
    await saveCircle(db, group);
    await expect(
      mergeReplicaBundle(db, await bundle(injected, [intruderEvent])),
    ).rejects.toThrow(/roster is closed|lacks a signed enrollment/u);
    expect((await db.get("groups", group.id))?.members[intruder.memberId]).toBeUndefined();
  });

  it("accepts a clean founded import only with its coordinator-signed founder manifest", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const founded = await signedEvent(group, fern, "circle.founded", {
      name: group.name,
      oath: group.oath,
      genesis: group.genesis,
      founders: Object.values(group.members).map((member) => ({
        memberId: member.memberId,
        publicJwk: member.publicJwk,
        companion: member.companion,
        kind: member.kind,
        ...(member.specialization ? { specialization: member.specialization } : {}),
      })),
      coordinatorIsOwner: false,
    });
    const db = await database("clean-founded");
    await expect(mergeReplicaBundle(db, await bundle(group, [founded]))).resolves.toMatchObject({
      added: 1,
    });
    expect(Object.keys((await db.get("groups", group.id))?.members ?? {})).toHaveLength(2);
  });

  it("requires known predecessors while preserving complete chains", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const first = await signedEvent(group, fern, "story.note", { text: "one" }, 1);
    const second = await signedEvent(group, fern, "story.note", { text: "two" }, 2, first.id);
    await expect(validateReplicaBundle(await bundle(group, [second]), group)).rejects.toThrow(/unknown predecessor/u);
    await expect(validateReplicaBundle(await bundle(group, [first, second]), group)).resolves.toEqual(group);
  });

  it("accepts legacy missing member kind as human and bounds specialization", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const legacy = clone(group);
    delete (legacy.members[fern.memberId] as Partial<CircleRecord["members"][string]>).kind;
    const db = await database("legacy-member-kind");
    await saveCircle(db, legacy);
    expect((await getCircle(db, group.id))?.members[fern.memberId]?.kind).toBe("human");

    const invalid = clone(group);
    invalid.members[fern.memberId]!.specialization = "x".repeat(121);
    await expect(saveCircle(db, invalid)).rejects.toThrow(/specialization/u);

    const changedKind = clone(group);
    changedKind.members[fern.memberId]!.kind = "kited-twin";
    await expect(
      validateReplicaBundle(await bundle(changedKind, []), group),
    ).rejects.toThrow(/member identity conflicts/iu);
  });

  it("rejects a stale structural update after a concurrent roster/status/chapter change", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const db = await database("stale-structural-group");
    await saveCircle(db, group);
    const expected = {
      eventRoot: await eventRoot([]),
      groupDigest: canonicalGroupDigest(group),
    };
    const newerGroup = clone(group);
    newerGroup.members[morrow.memberId]!.active = false;
    newerGroup.status = "heirloom-ready";
    newerGroup.chapter = 3;

    const groupMutation = saveCircle(db, newerGroup);
    const staleUpdate = appendLocalEventWithGroupUpdate(
      db,
      group.id,
      fern,
      "reunion.seal",
      { chapter: 1 },
      { ...group, chapter: 1 },
      expected,
    );
    const staleRejection = expect(staleUpdate).rejects.toThrow(
      /state changed before atomic structural update/u,
    );

    await groupMutation;
    await staleRejection;
    expect(await getCircle(db, group.id)).toEqual(newerGroup);
    expect(await getCircleEvents(db, group.id)).toEqual([]);
    expect(await db.getAllFromIndex("outbox", "by-group", group.id)).toEqual([]);
  });

  it("rejects a stale event root without forking and permits a freshly bound update", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const db = await database("stale-structural-events");
    await saveCircle(db, group);
    const staleBinding = {
      eventRoot: await eventRoot([]),
      groupDigest: canonicalGroupDigest(group),
    };

    const eventMutation = appendLocalEvent(
      db,
      group.id,
      fern,
      "story.note",
      { text: "newer event" },
    );
    const staleUpdate = appendLocalEventWithGroupUpdate(
      db,
      group.id,
      fern,
      "reunion.seal",
      { chapter: 1 },
      { ...group, chapter: 1 },
      staleBinding,
    );
    const staleRejection = expect(staleUpdate).rejects.toThrow(
      /state changed before atomic structural update/u,
    );

    const newerEvent = await eventMutation;
    await staleRejection;
    expect(await getCircle(db, group.id)).toEqual(group);
    expect(await getCircleEvents(db, group.id)).toEqual([newerEvent]);
    expect(await db.getAllFromIndex("outbox", "by-group", group.id)).toHaveLength(1);

    const currentGroup = await getCircle(db, group.id);
    const currentEvents = await getCircleEvents(db, group.id);
    if (!currentGroup) throw new Error("Circle missing");
    const validEvent = await appendLocalEventWithGroupUpdate(
      db,
      group.id,
      fern,
      "reunion.seal",
      { chapter: 1 },
      { ...currentGroup, chapter: 1 },
      {
        eventRoot: await eventRoot(currentEvents),
        groupDigest: canonicalGroupDigest(currentGroup),
      },
    );

    expect(validEvent.body).toMatchObject({ seq: 2, prev: newerEvent.id });
    expect(await getCircle(db, group.id)).toEqual({ ...group, chapter: 1 });
    const finalEvents = await getCircleEvents(db, group.id);
    expect(finalEvents.map((event) => event.body.seq).sort()).toEqual([1, 2]);
    expect(new Set(finalEvents.map((event) => event.id)).size).toBe(2);
    expect(await db.getAllFromIndex("outbox", "by-group", group.id)).toHaveLength(2);
  });

  it("enforces the 256-event boundary before an atomic local append", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const db = await database("event-boundary");
    await saveCircle(db, group);
    for (let index = 0; index < MAX_REPLICA_EVENTS; index += 1) {
      await appendLocalEvent(db, group.id, fern, "story.note", { text: `note ${index}` });
    }
    expect(await getCircleEvents(db, group.id)).toHaveLength(MAX_REPLICA_EVENTS);
    await expect(
      appendLocalEvent(db, group.id, fern, "story.note", { text: "one too many" }),
    ).rejects.toThrow(/256 events/u);
    await expect(
      appendLocalEventWithGroupUpdate(
        db,
        group.id,
        fern,
        "story.note",
        { text: "still too many" },
        { ...group, name: "Must Not Commit" },
        {
          eventRoot: await eventRoot(await getCircleEvents(db, group.id)),
          groupDigest: canonicalGroupDigest(group),
        },
      ),
    ).rejects.toThrow(/256 events/u);
    expect(await getCircleEvents(db, group.id)).toHaveLength(MAX_REPLICA_EVENTS);
    expect((await getCircle(db, group.id))?.name).toBe(group.name);
    await expect(makeReplicaBundle(db, group.id)).resolves.toMatchObject({
      events: { length: MAX_REPLICA_EVENTS },
    });
  });

  it("accepts the last sub-512 KiB replica and rejects the next import atomically", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    let below: ReplicaBundle | undefined;
    let above: ReplicaBundle | undefined;
    const events: SignedEvent[] = [];
    for (let index = 0; index < 64; index += 1) {
      events.push(
        await signedEvent(group, fern, "story.note", {
          text: `${index}:${"x".repeat(15_000)}`,
        }),
      );
      const candidate = await bundle(group, [...events]);
      if (canonicalBytes(candidate).byteLength <= MAX_REPLICA_BYTES) below = candidate;
      else {
        above = candidate;
        break;
      }
    }
    expect(below).toBeDefined();
    expect(above).toBeDefined();
    expect(canonicalBytes(below).byteLength).toBeLessThanOrEqual(MAX_REPLICA_BYTES);
    expect(canonicalBytes(above).byteLength).toBeGreaterThan(MAX_REPLICA_BYTES);

    const db = await database("byte-boundary");
    await saveCircle(db, group);
    await mergeReplicaBundle(db, below!);
    const acceptedCount = below!.events.length;
    await expect(mergeReplicaBundle(db, above!)).rejects.toThrow(/512 KiB/u);
    expect(await getCircleEvents(db, group.id)).toHaveLength(acceptedCount);
  });
});
