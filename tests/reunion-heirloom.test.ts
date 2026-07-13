import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify, sha256 } from "../src/canonical";
import { importVerifiedHeirloom, mintHeirloom, verifyHeirloom } from "../src/heirloom";
import {
  parseIntelligenceResult,
  VOICE_RESPONSE_MARKER,
} from "../src/intelligence";
import { deriveOrganismState } from "../src/organism";
import { deriveSharedReveal, questFromEvent } from "../src/quest";
import {
  approveReunion,
  createReunionChallenge,
  prepareOfflinePracticeReunion,
  reunionChallengeIsCurrent,
  reunionDraftPayload,
  reunionSealPayload,
  reunionThreshold,
  verifyReunionCertificate,
} from "../src/reunion";
import {
  deleteReplicaDatabase,
  getSetting,
  openReplicaDatabase,
  type ReplicaDatabase,
} from "../src/storage";
import type {
  HeirloomArtifact,
  ReunionCertificate,
  SignedEvent,
} from "../src/types";
import { clone, groupFor, identity, signedEvent, uniqueDatabaseName } from "./helpers";

const NOW = 1_750_000_000_000;
const AI_VOICE_CANARY = "HEIRLOOM-VOICE-TAIL-CANARY-833a";
const databases: ReplicaDatabase[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) {
    const name = db.name;
    db.close();
    await deleteReplicaDatabase(name);
  }
});

async function validSealFixture() {
  const a = await identity("A");
  const b = await identity("B", 1);
  const group = await groupFor([a, b]);
  const challenge = await createReunionChallenge(group, [], NOW);
  const certificate: ReunionCertificate = {
    challenge,
    approvals: [await approveReunion(challenge, a, NOW), await approveReunion(challenge, b, NOW)],
    threshold: reunionThreshold(group),
  };
  const payload = await reunionSealPayload(group, certificate, [], NOW + 100);
  const seal = await signedEvent(
    group,
    a,
    "reunion.seal",
    payload,
    1,
    null,
    new Date(NOW + 100),
  );
  return { a, b, group, challenge, certificate, seal };
}

describe("reunion quorum and heirloom", () => {
  it("requires max(2, ceil(active/2)) distinct enrolled signatures", async () => {
    const members = await Promise.all([
      identity("A"),
      identity("B", 1),
      identity("C", 2),
      identity("D", 3),
      identity("E", 0),
    ]);
    const group = await groupFor(members);
    expect(reunionThreshold(group)).toBe(3);
    const challenge = await createReunionChallenge(group, [], NOW);
    const first = await approveReunion(challenge, members[0]!, NOW);
    const second = await approveReunion(challenge, members[1]!, NOW);
    const failed: ReunionCertificate = {
      challenge,
      approvals: [first, first, second],
      threshold: 3,
    };
    await expect(verifyReunionCertificate(group, failed, NOW + 10)).resolves.toBe(false);
    failed.approvals.push(await approveReunion(challenge, members[2]!, NOW));
    await expect(verifyReunionCertificate(group, failed, NOW + 10)).resolves.toBe(true);
  });

  it("freezes one root for multiple signers and invalidates approvals on root change or expiry", async () => {
    const a = await identity("A");
    const b = await identity("B", 1);
    const group = await groupFor([a, b]);
    const challenge = await createReunionChallenge(group, [], NOW);
    const approvals = [
      await approveReunion(challenge, a, NOW + 10),
      await approveReunion(challenge, b, NOW + 20),
    ];
    const certificate: ReunionCertificate = {
      challenge,
      approvals,
      threshold: reunionThreshold(group),
    };
    await expect(reunionChallengeIsCurrent(group, [], challenge, NOW + 20)).resolves.toBe(true);
    await expect(reunionSealPayload(group, certificate, [], NOW + 20)).resolves.toMatchObject({
      chapter: 1,
    });

    const changed = await signedEvent(group, a, "story.note", { text: "root changed" });
    await expect(reunionChallengeIsCurrent(group, [changed], challenge, NOW + 30)).resolves.toBe(false);
    await expect(
      reunionSealPayload(group, certificate, [changed], NOW + 30),
    ).rejects.toThrow(/quorum|expired|root/u);

    const replacement = await createReunionChallenge(group, [changed], NOW + 40);
    await expect(
      verifyReunionCertificate(
        group,
        { challenge: replacement, approvals, threshold: 2 },
        NOW + 50,
      ),
    ).resolves.toBe(false);
    await expect(
      approveReunion(challenge, a, challenge.expiresAt + 1),
    ).rejects.toThrow(/expired/u);
    await expect(
      reunionSealPayload(group, certificate, [], challenge.expiresAt + 1),
    ).rejects.toThrow(/quorum|expired/u);
  });

  it("lets failed quorum save a draft but not structurally mutate", async () => {
    const a = await identity("A");
    const b = await identity("B", 1);
    const group = await groupFor([a, b]);
    const challenge = await createReunionChallenge(group, [], NOW);
    const approval = await approveReunion(challenge, a, NOW);
    const failed: ReunionCertificate = {
      challenge,
      approvals: [approval],
      threshold: 2,
    };
    await expect(reunionSealPayload(group, failed, [], NOW + 10)).rejects.toThrow(/quorum/u);
    const draft = await signedEvent(
      group,
      a,
      "reunion.draft",
      reunionDraftPayload(challenge, [approval]),
      1,
      null,
      new Date(NOW + 10),
    );
    expect((await deriveOrganismState(group, [draft])).structuralMolts).toBe(0);
  });

  it("allows a valid reunion certificate to mutate structural form", async () => {
    const { group, seal } = await validSealFixture();
    const before = await deriveOrganismState(group, []);
    const after = await deriveOrganismState(group, [seal]);
    expect(before.structuralMolts).toBe(0);
    expect(after.structuralMolts).toBe(1);
    expect(after.description).toContain("1-molted");
  });

  it("completes the simulated practice reunion entirely with on-device keys", async () => {
    const local = await identity("Local");
    const demo = await identity("Morrow demo", 1);
    const group = await groupFor([local, demo], { demo: true });
    const practice = await prepareOfflinePracticeReunion(group, [], local, demo, NOW);
    const certificate: ReunionCertificate = {
      challenge: practice.challenge,
      approvals: practice.approvals,
      threshold: reunionThreshold(group),
    };
    const payload = await reunionSealPayload(group, certificate, [], NOW + 10);
    const seal = await signedEvent(
      group,
      local,
      "reunion.seal",
      payload,
      1,
      null,
      new Date(NOW + 10),
    );
    expect(practice.approvals.map((approval) => approval.memberId).sort()).toEqual(
      [local.memberId, demo.memberId].sort(),
    );
    expect((await deriveOrganismState(group, [seal])).structuralMolts).toBe(1);
  });

  async function heirloomFixture(): Promise<{
    artifact: HeirloomArtifact;
    events: SignedEvent[];
  }> {
    const { a, b, group, seal } = await validSealFixture();
    const questId = "quest_heirloom_fixture";
    const created = await signedEvent(group, a, "quest.created", {
      questId,
      title: "The Lantern Between Us",
      premise: "A fixture quest.",
      createdAt: new Date(NOW - 1000).toISOString(),
      contextClass: "indoors",
      weatherBand: "clear",
      memberOrder: [a.memberId, b.memberId],
      roles: { [a.memberId]: "Scout", [b.memberId]: "Dreamer" },
    });
    const aiOffering = parseIntelligenceResult(
      `Keep this selected lantern.${VOICE_RESPONSE_MARKER}${AI_VOICE_CANARY}`,
    );
    const approved = await signedEvent(group, a, "quest.offering", {
      questId,
      text: aiOffering.text,
      choice: "turn left",
      selectedTrait: null,
      contextClass: null,
      approvedForHeirloom: true,
    });
    const unapproved = await signedEvent(group, b, "quest.offering", {
      questId,
      text: "Private unselected wording.",
      choice: "turn right",
      selectedTrait: null,
      contextClass: null,
      approvedForHeirloom: false,
    });
    const derivedReveal = await deriveSharedReveal(questFromEvent(created), [approved, unapproved]);
    const reveal = await signedEvent(group, a, "quest.reveal", {
      questId,
      text: derivedReveal.text,
      influenceRoot: derivedReveal.influenceRoot,
      memberIds: derivedReveal.memberIds,
      sourceOfferingIds: derivedReveal.sourceOfferingIds,
      approvedForHeirloom: derivedReveal.approvedForHeirloom,
    });
    const events = [created, approved, unapproved, reveal, seal];
    return { artifact: await mintHeirloom(group, events, new Date(NOW + 500)), events };
  }

  it("mints and verifies a selected-only portable artifact", async () => {
    const { artifact } = await heirloomFixture();
    await expect(verifyHeirloom(artifact)).resolves.toMatchObject({
      valid: true,
      packageHash: artifact.packageHash,
    });
    expect(artifact.approvedStory).toHaveLength(1);
    expect(Object.values(artifact.group.members).every((member) => member.kind === "human")).toBe(true);
    expect(artifact.approvedReveals).toEqual([]);
    expect(canonicalStringify(artifact)).toContain("Keep this selected lantern.");
    expect(canonicalStringify(artifact)).not.toContain("Private unselected wording.");
    expect(canonicalStringify(artifact)).not.toContain("turn right");
    expect(canonicalStringify(artifact)).not.toContain(AI_VOICE_CANARY);
    expect(canonicalStringify(artifact)).not.toMatch(/privateJwk|rawAudio|latitude|longitude/u);
  });

  it("rejects heirloom hash, event, and privacy tampering", async () => {
    const { artifact } = await heirloomFixture();
    const changed = clone(artifact);
    changed.organism.hue += 1;
    await expect(verifyHeirloom(changed)).rejects.toThrow(/package hash/u);

    const changedEvent = clone(artifact);
    const first = changedEvent.signedEvents[0];
    if (!first) throw new Error("Expected selected event");
    first.body.payload = { changed: true };
    const { packageHash: _oldHash, ...changedBody } = changedEvent;
    changedEvent.packageHash = await sha256(changedBody);
    await expect(verifyHeirloom(changedEvent)).rejects.toThrow(/signed event/u);

    const privateArtifact = clone(artifact) as HeirloomArtifact & { privateKey: string };
    privateArtifact.privateKey = "must-not-ship";
    const { packageHash: _hash, ...privateBody } = privateArtifact;
    privateArtifact.packageHash = await sha256(privateBody);
    await expect(verifyHeirloom(privateArtifact)).rejects.toThrow(/private field/u);
  });

  it("imports and verifies an heirloom on an otherwise clean database", async () => {
    const { artifact } = await heirloomFixture();
    const db = await openReplicaDatabase(uniqueDatabaseName("clean-heirloom"));
    databases.push(db);
    const hash = await importVerifiedHeirloom(db, artifact);
    expect(hash).toBe(artifact.packageHash);
    expect(await getSetting(db, `heirloom:${hash}`)).toEqual(artifact);
  });
});
