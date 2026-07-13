import { describe, expect, it } from "vitest";
import { deriveGenesis, deriveOrganismState } from "../src/organism";
import {
  QUEST_ROLES,
  assertMemberCanOffer,
  createQuest,
  deriveQuestLeg,
  deriveSharedReveal,
  offeringPayload,
  questPayload,
  sanitizeOffering,
} from "../src/quest";
import type { LocalIdentity, SignedEvent } from "../src/types";
import { clone, groupFor, identity, signedEvent } from "./helpers";

function memberIdentity(members: readonly LocalIdentity[], memberId: string): LocalIdentity {
  const member = members.find((candidate) => candidate.memberId === memberId);
  if (!member) throw new Error("Missing test member");
  return member;
}

describe("Circle organism and Braid gameplay", () => {
  it("derives order-independent genesis with one equal seed contribution per founder", async () => {
    const a = await identity("A");
    const b = await identity("B", 1);
    const c = await identity("C", 2);
    const group = await groupFor([a, b, c]);
    const forward = await deriveGenesis(Object.values(group.members));
    const reversed = await deriveGenesis(Object.values(group.members).reverse());
    expect(reversed).toEqual(forward);
    expect(forward.founderSeedHashes).toHaveLength(3);
    expect(new Set(forward.founderIds)).toEqual(new Set([a.memberId, b.memberId, c.memberId]));
  });

  it("changes genesis when any one founder companion seed changes", async () => {
    const a = await identity("A");
    const b = await identity("B", 1);
    const group = await groupFor([a, b]);
    const original = await deriveGenesis(Object.values(group.members));
    const changedMembers = clone(Object.values(group.members));
    const changed = changedMembers.find((member) => member.memberId === b.memberId);
    if (!changed) throw new Error("Missing founder");
    changed.companion.voiceSeed = "different-seed";
    const mutated = await deriveGenesis(changedMembers);
    expect(mutated.organismId).not.toBe(original.organismId);
    expect(mutated.founderSeedHashes).not.toEqual(original.founderSeedHashes);
  });

  it("assigns one lobe per active member and rotating quest roles", async () => {
    const members = await Promise.all([identity("A"), identity("B", 1), identity("C", 2)]);
    const group = await groupFor(members);
    const first = await createQuest(group, [], "park", "wind");
    const creation = await signedEvent(group, members[0] as LocalIdentity, "quest.created", questPayload(first));
    const second = await createQuest(group, [creation], "park", "wind");
    expect(Object.keys(first.roles)).toHaveLength(3);
    for (const memberId of first.memberOrder) {
      expect(QUEST_ROLES).toContain(first.roles[memberId]);
      expect(second.roles[memberId]).not.toBe(first.roles[memberId]);
    }
    expect((await deriveOrganismState(group, [])).memberCount).toBe(3);
  });

  it("never commits an exact coordinate as quest context", async () => {
    const members = await Promise.all([identity("A"), identity("B", 1)]);
    const group = await groupFor(members);
    const quest = await createQuest(group, [], "40.7128,-74.0060", "storm-level-9");
    expect(quest.contextClass).toBe("unknown");
    expect(quest.weatherBand).toBe("unknown");
    const offering = sanitizeOffering(
      {
        questId: quest.questId,
        memberId: members[0]?.memberId ?? "",
        text: "A safe nearby texture.",
        choice: "follow the quiet line",
        contextClass: "40.7128,-74.0060",
        approvedForHeirloom: false,
      },
      group,
    );
    expect(offering.contextClass).toBeUndefined();
  });

  it("makes one offering materially change another member's next leg", async () => {
    const members = await Promise.all([identity("A"), identity("B", 1), identity("C", 2)]);
    const group = await groupFor(members);
    const quest = await createQuest(group, [], "indoors", "rain");
    const target = quest.memberOrder[1] as string;
    const source = quest.memberOrder[0] as string;
    const sourceIdentity = memberIdentity(members, source);
    const offering = await signedEvent(
      group,
      sourceIdentity,
      "quest.offering",
      offeringPayload({
        questId: quest.questId,
        memberId: source,
        text: "I placed the echo beneath a cup.",
        choice: "turn the cup toward rain",
        approvedForHeirloom: true,
      }),
    );
    const without = await deriveQuestLeg(quest, target, []);
    const withOffering = await deriveQuestLeg(quest, target, [offering]);
    expect(withOffering.influencedBy).toEqual([offering.id]);
    expect(withOffering.influenceMark).not.toBe(without.influenceMark);
    expect(withOffering.prompt).not.toBe(without.prompt);
    expect(withOffering.prompt).toContain("turn the cup toward rain");
  });

  it("changes the shared reveal and organism when an offering is removed", async () => {
    const members = await Promise.all([identity("A"), identity("B", 1), identity("C", 2)]);
    const group = await groupFor(members);
    const quest = await createQuest(group, [], "doorstep", "clear");
    const offerings: SignedEvent[] = [];
    for (const [index, memberId] of quest.memberOrder.entries()) {
      offerings.push(
        await signedEvent(
          group,
          memberIdentity(members, memberId),
          "quest.offering",
          offeringPayload({
            questId: quest.questId,
            memberId,
            text: `offering ${index}`,
            choice: `choice ${index}`,
            approvedForHeirloom: true,
          }),
        ),
      );
    }
    const fullReveal = await deriveSharedReveal(quest, offerings);
    const reducedReveal = await deriveSharedReveal(quest, offerings.slice(0, 2));
    expect(reducedReveal.influenceRoot).not.toBe(fullReveal.influenceRoot);
    expect(reducedReveal.text).not.toBe(fullReveal.text);
    const fullBody = await deriveOrganismState(group, offerings);
    const reducedBody = await deriveOrganismState(group, offerings.slice(0, 2));
    expect(reducedBody.offeringRoot).not.toBe(fullBody.offeringRoot);
    expect([reducedBody.aura, reducedBody.motion, reducedBody.hue]).not.toEqual([
      fullBody.aura,
      fullBody.motion,
      fullBody.hue,
    ]);
  });

  it("enforces one offering per member and quest for manual or AI staging", async () => {
    const fern = await identity("Fern");
    const morrow = await identity("Morrow", 1);
    const group = await groupFor([fern, morrow]);
    const existing = await signedEvent(group, fern, "quest.offering", {
      questId: "quest_one_offer",
      text: "A first answer",
      choice: "leave one path",
      approvedForHeirloom: false,
    });
    expect(() =>
      assertMemberCanOffer([existing], "quest_one_offer", fern.memberId),
    ).toThrow("already offered");
    expect(() =>
      assertMemberCanOffer([existing], "quest_one_offer", morrow.memberId),
    ).not.toThrow();
    expect(() =>
      assertMemberCanOffer([existing], "quest_other", fern.memberId),
    ).not.toThrow();
  });

  it("does not let an ordinary signed remote event fake a structural molt", async () => {
    const local = await identity("Local");
    const remote = await identity("Remote", 1);
    const group = await groupFor([local, remote]);
    const ordinary = await signedEvent(group, remote, "quest.offering", {
      questId: "quest_remote",
      text: "remote aura",
      choice: "glow",
      approvedForHeirloom: false,
    });
    const forgedSeal = await signedEvent(group, remote, "reunion.seal", {
      chapter: 1,
      mutation: "membrane-molt",
      certificate: { challenge: { groupId: group.id }, approvals: [], threshold: 2 },
    });
    const auraOnly = await deriveOrganismState(group, [ordinary]);
    const attempted = await deriveOrganismState(group, [ordinary, forgedSeal]);
    expect(attempted.structuralMolts).toBe(0);
    expect(attempted.aura).toBe(auraOnly.aura);
  });
});
