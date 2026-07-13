import { canonicalStringify, sha256, utf8 } from "./canonical";

export const PROPOSAL_LIFETIME_MS = 5 * 60 * 1_000;
export const MAX_PROPOSAL_PAYLOAD_BYTES = 16 * 1_024;

export type ProposalOrigin =
  | "typed"
  | "voice"
  | "touch"
  | "keyboard"
  | "copilot-draft"
  | "verified-agent"
  | "practice";

export interface ProposalBinding {
  circleId: string;
  eventRoot: string;
  stateDigest: string;
}

export interface PendingProposal {
  id: string;
  circleId: string;
  authorMemberId: string;
  eventType: string;
  binding: ProposalBinding;
  origin: ProposalOrigin;
  originTurn: number;
  canonicalPayload: string;
  payloadDigest: string;
  preview: string;
  createdAt: number;
  expiresAt: number;
}

export interface StageProposalInput {
  binding: ProposalBinding;
  authorMemberId: string;
  eventType: string;
  origin: ProposalOrigin;
  originTurn: number;
  payload: Record<string, unknown>;
  preview: string;
  now?: number;
  lifetimeMs?: number;
}

function cleanPreview(value: string): string {
  const preview = value.trim().replace(/\s+/gu, " ");
  if (!preview) throw new Error("Proposal preview is required");
  return preview.slice(0, 2_000);
}

export async function stagePendingProposal(input: StageProposalInput): Promise<PendingProposal> {
  if (!input.binding.circleId || input.binding.circleId !== input.binding.circleId.trim()) {
    throw new Error("Proposal Circle binding is invalid");
  }
  if (!input.binding.eventRoot || !input.binding.stateDigest) {
    throw new Error("Proposal state binding is incomplete");
  }
  if (!Number.isSafeInteger(input.originTurn) || input.originTurn < 1) {
    throw new Error("Proposal must originate in a user turn");
  }
  const canonicalPayload = canonicalStringify(input.payload);
  if (utf8(canonicalPayload).byteLength > MAX_PROPOSAL_PAYLOAD_BYTES) {
    throw new Error("Proposal payload exceeds the signed-event limit");
  }
  const now = input.now ?? Date.now();
  const lifetime = Math.min(
    Math.max(input.lifetimeMs ?? PROPOSAL_LIFETIME_MS, 1_000),
    PROPOSAL_LIFETIME_MS,
  );
  const payloadDigest = await sha256(utf8(canonicalPayload));
  const id = `proposal_${(
    await sha256({
      authorMemberId: input.authorMemberId,
      binding: input.binding,
      canonicalPayload,
      eventType: input.eventType,
      now,
      originTurn: input.originTurn,
    })
  ).slice(0, 28)}`;
  return {
    id,
    circleId: input.binding.circleId,
    authorMemberId: input.authorMemberId,
    eventType: input.eventType,
    binding: { ...input.binding },
    origin: input.origin,
    originTurn: input.originTurn,
    canonicalPayload,
    payloadDigest,
    preview: cleanPreview(input.preview),
    createdAt: now,
    expiresAt: now + lifetime,
  };
}

export async function stateDigestForProposal(
  circleState: unknown,
  eventRoot: string,
): Promise<string> {
  return sha256({ circleState, eventRoot });
}

export interface ConfirmProposalInput {
  binding: ProposalBinding;
  confirmingMemberId: string;
  confirmationTurn: number;
  now?: number | (() => number);
  authorize: (proposal: PendingProposal, confirmingMemberId: string) => boolean | Promise<boolean>;
  sanitize: (
    eventType: string,
    payload: Record<string, unknown>,
    proposal: PendingProposal,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  sign: (
    eventType: string,
    payload: Record<string, unknown>,
    proposal: PendingProposal,
  ) => void | Promise<void>;
  onCommitStart?: (proposal: PendingProposal) => void;
}

export interface ProposalCancellation {
  cancelled: boolean;
  commitStarted: boolean;
}

export class PendingProposalGate {
  #pending: PendingProposal | undefined;
  #phase: "idle" | "validating" | "committing" = "idle";
  #stageGeneration = 0;
  #confirmationGeneration = 0;
  readonly #consumed = new Set<string>();

  get pending(): PendingProposal | undefined {
    return this.#pending ? structuredClone(this.#pending) : undefined;
  }

  get signing(): boolean {
    return this.#phase !== "idle";
  }

  get committing(): boolean {
    return this.#phase === "committing";
  }

  reserveStage(): number {
    if (this.signing) throw new Error("A proposal is already being signed");
    if (this.#pending) {
      throw new Error("Cancel or confirm the current proposal before staging another");
    }
    this.#stageGeneration += 1;
    return this.#stageGeneration;
  }

  stageReservationIsCurrent(reservation: number): boolean {
    return (
      Number.isSafeInteger(reservation) &&
      reservation === this.#stageGeneration &&
      !this.signing &&
      !this.#pending
    );
  }

  stage(proposal: PendingProposal, reservation?: number): void {
    if (this.signing) throw new Error("A proposal is already being signed");
    if (reservation !== undefined && reservation !== this.#stageGeneration) {
      throw new Error("Proposal staging was cancelled before completion");
    }
    if (this.#pending) {
      throw new Error("A newer pending proposal is already awaiting review");
    }
    if (reservation === undefined) this.#stageGeneration += 1;
    this.#pending = structuredClone(proposal);
  }

  cancel(): ProposalCancellation {
    if (this.#phase === "committing") {
      return { cancelled: false, commitStarted: true };
    }
    this.#stageGeneration += 1;
    this.#confirmationGeneration += 1;
    this.#pending = undefined;
    return { cancelled: true, commitStarted: false };
  }

  async confirm(input: ConfirmProposalInput): Promise<PendingProposal> {
    const proposal = this.#pending;
    if (!proposal) throw new Error("There is no pending proposal to confirm");
    if (this.signing || this.#consumed.has(proposal.id)) {
      throw new Error("This proposal was already confirmed");
    }
    if (input.confirmationTurn <= proposal.originTurn) {
      throw new Error("Review the proposal, then confirm it in a separate turn");
    }
    const now = (): number =>
      typeof input.now === "function" ? input.now() : input.now ?? Date.now();
    if (now() >= proposal.expiresAt) {
      this.#pending = undefined;
      this.#stageGeneration += 1;
      throw new Error("The proposal expired without creating an event");
    }
    if (
      input.binding.circleId !== proposal.circleId ||
      input.binding.circleId !== proposal.binding.circleId ||
      input.binding.eventRoot !== proposal.binding.eventRoot ||
      input.binding.stateDigest !== proposal.binding.stateDigest
    ) {
      this.#pending = undefined;
      this.#stageGeneration += 1;
      throw new Error("Circle state changed; review a fresh proposal");
    }
    this.#phase = "validating";
    const confirmationGeneration = ++this.#confirmationGeneration;
    const assertStillValid = (): void => {
      if (
        confirmationGeneration !== this.#confirmationGeneration ||
        this.#pending?.id !== proposal.id
      ) {
        throw new Error("Proposal confirmation was cancelled before commit");
      }
      if (now() >= proposal.expiresAt) {
        this.#pending = undefined;
        this.#stageGeneration += 1;
        this.#confirmationGeneration += 1;
        throw new Error("The proposal expired without creating an event");
      }
    };
    try {
      const authorized = await input.authorize(proposal, input.confirmingMemberId);
      assertStillValid();
      if (!authorized) {
        throw new Error("This companion is not authorized to sign the proposal");
      }
      const parsed: unknown = JSON.parse(proposal.canonicalPayload);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("Proposal payload is invalid");
      }
      const sanitized = await input.sanitize(
        proposal.eventType,
        parsed as Record<string, unknown>,
        proposal,
      );
      assertStillValid();
      if (canonicalStringify(sanitized) !== proposal.canonicalPayload) {
        throw new Error("Proposal payload changed during validation");
      }
      assertStillValid();
      this.#phase = "committing";
      try {
        input.onCommitStart?.(structuredClone(proposal));
      } catch {
        // UI status must never prevent the already-started atomic commit.
      }
      await input.sign(proposal.eventType, sanitized, proposal);
      this.#consumed.add(proposal.id);
      this.#pending = undefined;
      this.#stageGeneration += 1;
      return structuredClone(proposal);
    } finally {
      this.#phase = "idle";
    }
  }
}
