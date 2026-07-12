import { randomId } from "./canonical";
import { signValue, verifyValue } from "./crypto";
import { eventRoot } from "./storage";
import type {
  CircleRecord,
  LocalIdentity,
  ReunionApproval,
  ReunionCertificate,
  ReunionChallenge,
  SignedEvent,
} from "./types";

export const REUNION_WINDOW_MS = 5 * 60 * 1000;

export function reunionThreshold(group: CircleRecord): number {
  const active = Object.values(group.members).filter((member) => member.active).length;
  return Math.max(2, Math.ceil(active / 2));
}

export async function createReunionChallenge(
  group: CircleRecord,
  events: readonly SignedEvent[],
  now = Date.now(),
): Promise<ReunionChallenge> {
  if (group.status === "forming") throw new Error("A Circle must be founded before reunion");
  return {
    version: 1,
    groupId: group.id,
    chapter: group.chapter + 1,
    nonce: randomId("reunion"),
    eventRoot: await eventRoot(events),
    issuedAt: now,
    expiresAt: now + REUNION_WINDOW_MS,
  };
}

export async function approveReunion(
  challenge: ReunionChallenge,
  identity: LocalIdentity,
  now = Date.now(),
): Promise<ReunionApproval> {
  if (
    challenge.issuedAt > now ||
    challenge.expiresAt < now ||
    challenge.expiresAt - challenge.issuedAt !== REUNION_WINDOW_MS
  ) {
    throw new Error("Reunion challenge is expired or malformed; create a new challenge");
  }
  return {
    memberId: identity.memberId,
    signature: await signValue(challenge, identity.privateJwk),
  };
}

export async function reunionChallengeIsCurrent(
  group: CircleRecord,
  events: readonly SignedEvent[],
  challenge: ReunionChallenge,
  now = Date.now(),
): Promise<boolean> {
  return (
    challenge.version === 1 &&
    challenge.groupId === group.id &&
    challenge.chapter === group.chapter + 1 &&
    challenge.issuedAt <= now &&
    challenge.expiresAt >= now &&
    challenge.expiresAt - challenge.issuedAt === REUNION_WINDOW_MS &&
    challenge.eventRoot === (await eventRoot(events))
  );
}

export async function prepareOfflinePracticeReunion(
  group: CircleRecord,
  events: readonly SignedEvent[],
  localIdentity: LocalIdentity,
  demoIdentity: LocalIdentity,
  now = Date.now(),
): Promise<{ challenge: ReunionChallenge; approvals: ReunionApproval[] }> {
  if (
    !group.demo ||
    localIdentity.memberId === demoIdentity.memberId ||
    !group.members[localIdentity.memberId] ||
    !group.members[demoIdentity.memberId]
  ) {
    throw new Error("Offline practice requires two distinct enrolled on-device demo keys");
  }
  const challenge = await createReunionChallenge(group, events, now);
  return {
    challenge,
    approvals: await Promise.all([
      approveReunion(challenge, localIdentity, now),
      approveReunion(challenge, demoIdentity, now),
    ]),
  };
}

export async function verifyReunionCertificate(
  group: CircleRecord,
  certificate: ReunionCertificate,
  atTime = Date.now(),
): Promise<boolean> {
  if (
    !certificate ||
    !certificate.challenge ||
    !Array.isArray(certificate.approvals) ||
    !Number.isFinite(atTime)
  ) {
    return false;
  }
  const { challenge } = certificate;
  if (
    challenge.version !== 1 ||
    challenge.groupId !== group.id ||
    challenge.chapter !== group.chapter + 1 ||
    typeof challenge.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{20,}$/u.test(challenge.eventRoot) ||
    !Number.isFinite(challenge.issuedAt) ||
    !Number.isFinite(challenge.expiresAt) ||
    challenge.issuedAt > atTime ||
    challenge.expiresAt < atTime ||
    challenge.expiresAt - challenge.issuedAt > REUNION_WINDOW_MS ||
    certificate.threshold !== reunionThreshold(group)
  ) {
    return false;
  }
  const unique = new Set<string>();
  let valid = 0;
  for (const approval of certificate.approvals) {
    if (
      !approval ||
      typeof approval.memberId !== "string" ||
      typeof approval.signature !== "string"
    ) {
      continue;
    }
    if (unique.has(approval.memberId)) continue;
    unique.add(approval.memberId);
    const member = group.members[approval.memberId];
    if (member?.active && (await verifyValue(challenge, approval.signature, member.publicJwk))) valid += 1;
  }
  return valid >= certificate.threshold;
}

function certificateFromPayload(payload: Record<string, unknown>): ReunionCertificate | undefined {
  const candidate = payload.certificate;
  if (!candidate || typeof candidate !== "object") return undefined;
  return candidate as ReunionCertificate;
}

export async function verifyReunionSealEvent(
  group: CircleRecord,
  event: SignedEvent,
): Promise<boolean> {
  if (event.body.type !== "reunion.seal" || event.body.groupId !== group.id) return false;
  const certificate = certificateFromPayload(event.body.payload);
  if (!certificate) return false;
  const eventTime = Date.parse(event.body.createdAt);
  return verifyReunionCertificate(group, certificate, eventTime);
}

export async function reunionSealPayload(
  group: CircleRecord,
  certificate: ReunionCertificate,
  events: readonly SignedEvent[],
  now = Date.now(),
): Promise<Record<string, unknown>> {
  if (
    !(await reunionChallengeIsCurrent(group, events, certificate.challenge, now)) ||
    !(await verifyReunionCertificate(group, certificate, now))
  ) {
    throw new Error("Reunion quorum not met, or challenge expired/root changed; create a new challenge");
  }
  return {
    certificate,
    chapter: certificate.challenge.chapter,
    mutation: "membrane-molt",
    statement:
      "Enrolled keys approved one shared challenge. This does not prove identity, location, or unrelayed presence.",
  };
}

export function reunionDraftPayload(
  challenge: ReunionChallenge,
  approvals: readonly ReunionApproval[],
): Record<string, unknown> {
  return {
    challenge,
    approvalMemberIds: [...new Set(approvals.map((approval) => approval.memberId))].sort(),
    status: "remote-echo-no-structural-mutation",
  };
}
