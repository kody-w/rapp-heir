import { describe, expect, it, vi } from "vitest";
import {
  PendingProposalGate,
  stagePendingProposal,
  stateDigestForProposal,
  type ConfirmProposalInput,
  type ProposalBinding,
} from "../src/pending-proposal";
import {
  parseIntelligenceResult,
  VOICE_RESPONSE_MARKER,
} from "../src/intelligence";
import {
  appendLocalEvent,
  eventRoot,
  getCircleEvents,
  makeReplicaBundle,
  openReplicaDatabase,
} from "../src/storage";
import { groupFor, identity, uniqueDatabaseName } from "./helpers";

const binding: ProposalBinding = {
  circleId: "circle_test",
  eventRoot: "root_before",
  stateDigest: "state_before",
};

async function proposal(now = 1_000, originTurn = 1) {
  return stagePendingProposal({
    binding,
    authorMemberId: "member_local",
    eventType: "quest.rest",
    payload: { questId: "quest_one", reason: "rest-without-streak-or-penalty" },
    preview: "Rest without penalty",
    origin: "typed",
    originTurn,
    now,
  });
}

function confirmation(
  sign: ConfirmProposalInput["sign"],
  overrides: Partial<ConfirmProposalInput> = {},
): ConfirmProposalInput {
  return {
    binding,
    confirmingMemberId: "member_local",
    confirmationTurn: 2,
    now: 2_000,
    authorize: () => true,
    sanitize: (_eventType: string, payload: Record<string, unknown>) => payload,
    sign,
    ...overrides,
  };
}

describe("pending proposal authority gate", () => {
  it("creates zero events while staging and exactly one after a later confirmation", async () => {
    const sign = vi.fn<ConfirmProposalInput["sign"]>();
    const gate = new PendingProposalGate();
    gate.stage(await proposal());
    expect(sign).not.toHaveBeenCalled();
    await gate.confirm(confirmation(sign));
    expect(sign).toHaveBeenCalledOnce();
    expect(gate.pending).toBeUndefined();
  });

  it("rejects same-turn confirmation including compound offer-and-confirm behavior", async () => {
    const sign = vi.fn<ConfirmProposalInput["sign"]>();
    const gate = new PendingProposalGate();
    gate.stage(await proposal(1_000, 7));
    await expect(
      gate.confirm(confirmation(sign, { confirmationTurn: 7 })),
    ).rejects.toThrow("separate turn");
    expect(sign).not.toHaveBeenCalled();
  });

  it("expires without signing", async () => {
    const sign = vi.fn<ConfirmProposalInput["sign"]>();
    const gate = new PendingProposalGate();
    const pending = await proposal();
    gate.stage(pending);
    await expect(
      gate.confirm(confirmation(sign, { now: pending.expiresAt })),
    ).rejects.toThrow("expired");
    expect(sign).not.toHaveBeenCalled();
    expect(gate.pending).toBeUndefined();
  });

  it("rejects stale event roots or state digests and clears the proposal", async () => {
    const sign = vi.fn<ConfirmProposalInput["sign"]>();
    const gate = new PendingProposalGate();
    gate.stage(await proposal());
    await expect(
      gate.confirm(
        confirmation(sign, {
          binding: { ...binding, eventRoot: "root_after" },
        }),
      ),
    ).rejects.toThrow("state changed");
    expect(sign).not.toHaveBeenCalled();
    expect(gate.pending).toBeUndefined();
  });

  it("rejects changed sanitized bytes rather than signing a transformed payload", async () => {
    const sign = vi.fn<ConfirmProposalInput["sign"]>();
    const gate = new PendingProposalGate();
    gate.stage(await proposal());
    await expect(
      gate.confirm(
        confirmation(sign, {
          sanitize: () => ({ questId: "quest_other", reason: "changed" }),
        }),
      ),
    ).rejects.toThrow("changed during validation");
    expect(sign).not.toHaveBeenCalled();
  });

  it("rejects unauthorized signers", async () => {
    const sign = vi.fn<ConfirmProposalInput["sign"]>();
    const gate = new PendingProposalGate();
    gate.stage(await proposal());
    await expect(
      gate.confirm(confirmation(sign, { authorize: () => false })),
    ).rejects.toThrow("not authorized");
    expect(sign).not.toHaveBeenCalled();
  });

  it("serializes concurrent confirmations and never double-signs", async () => {
    const sign = vi.fn<ConfirmProposalInput["sign"]>();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = new PendingProposalGate();
    gate.stage(await proposal());
    const first = gate.confirm(
      confirmation(sign, {
        authorize: async () => {
          await wait;
          return true;
        },
      }),
    );
    await expect(gate.confirm(confirmation(sign))).rejects.toThrow("already confirmed");
    release();
    await first;
    expect(sign).toHaveBeenCalledOnce();
    await expect(gate.confirm(confirmation(sign))).rejects.toThrow("no pending");
  });

  it("cancel and undo semantics create no event", async () => {
    const sign = vi.fn<ConfirmProposalInput["sign"]>();
    const gate = new PendingProposalGate();
    gate.stage(await proposal());
    gate.cancel();
    expect(gate.pending).toBeUndefined();
    expect(sign).not.toHaveBeenCalled();
  });

  it("keeps the real signed log empty until the separate gate confirmation", async () => {
    const local = await identity("Proposal Local");
    const remote = await identity("Proposal Remote", 1);
    const group = await groupFor([local, remote]);
    const database = await openReplicaDatabase(uniqueDatabaseName("proposal-gate"));
    await database.put("groups", group);
    const root = await eventRoot([]);
    const realBinding = {
      circleId: group.id,
      eventRoot: root,
      stateDigest: await stateDigestForProposal(group, root),
    };
    const gate = new PendingProposalGate();
    gate.stage(
      await stagePendingProposal({
        binding: realBinding,
        authorMemberId: local.memberId,
        eventType: "quest.rest",
        payload: { questId: "quest_one", reason: "rest-without-streak-or-penalty" },
        preview: "Rest",
        origin: "touch",
        originTurn: 1,
        now: 1_000,
      }),
    );
    expect(await getCircleEvents(database, group.id)).toHaveLength(0);
    await gate.confirm({
      binding: realBinding,
      confirmingMemberId: local.memberId,
      confirmationTurn: 2,
      now: 2_000,
      authorize: () => true,
      sanitize: (_eventType, payload) => payload,
      sign: async (eventType, payload) => {
        await appendLocalEvent(database, group.id, local, eventType, payload);
      },
    });
    expect(await getCircleEvents(database, group.id)).toHaveLength(1);
    await expect(
      gate.confirm(confirmation(vi.fn<ConfirmProposalInput["sign"]>())),
    ).rejects.toThrow("no pending");
    expect(await getCircleEvents(database, group.id)).toHaveLength(1);
    database.close();
  });

  it("keeps the AI voice tail out of proposals, signed events, and replica/PeerJS payloads", async () => {
    const voiceCanary = "VOICE-ONLY-CANARY-72b4";
    const result = parseIntelligenceResult(
      `Display-only offering.${VOICE_RESPONSE_MARKER}${voiceCanary}`,
    );
    const local = await identity("Voice Boundary Local");
    const remote = await identity("Voice Boundary Remote", 1);
    const group = await groupFor([local, remote]);
    const database = await openReplicaDatabase(uniqueDatabaseName("voice-boundary"));
    await database.put("groups", group);
    const root = await eventRoot([]);
    const realBinding = {
      circleId: group.id,
      eventRoot: root,
      stateDigest: await stateDigestForProposal(group, root),
    };
    const gate = new PendingProposalGate();
    gate.stage(
      await stagePendingProposal({
        binding: realBinding,
        authorMemberId: local.memberId,
        eventType: "quest.offering",
        payload: {
          questId: "quest_voice_boundary",
          text: result.text,
          choice: "carry the display answer",
          selectedTrait: null,
          contextClass: null,
          approvedForHeirloom: false,
        },
        preview: result.text,
        origin: "copilot-draft",
        originTurn: 1,
        now: 1_000,
      }),
    );
    expect(JSON.stringify(gate.pending)).toContain(result.text);
    expect(JSON.stringify(gate.pending)).not.toContain(voiceCanary);
    await gate.confirm({
      binding: realBinding,
      confirmingMemberId: local.memberId,
      confirmationTurn: 2,
      now: 2_000,
      authorize: () => true,
      sanitize: (_eventType, payload) => payload,
      sign: async (eventType, payload) => {
        await appendLocalEvent(database, group.id, local, eventType, payload);
      },
    });
    const events = await getCircleEvents(database, group.id);
    const replica = await makeReplicaBundle(database, group.id);
    expect(JSON.stringify(events)).toContain(result.text);
    expect(JSON.stringify(events)).not.toContain(voiceCanary);
    expect(JSON.stringify(replica)).not.toContain(voiceCanary);
    database.close();
  });
});
