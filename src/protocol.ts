import {
  boundedJsonParse,
  canonicalBytes,
  constantTimeEqual,
  fromBase64Url,
  fromUtf8,
  randomBytes,
  randomId,
  sha256,
  toBase64Url,
} from "./canonical";
import {
  decryptEnvelope,
  deriveLinkSecrets,
  encryptEnvelope,
  fingerprintPublicKey,
  generateEphemeralKeys,
  memberIdFromPublicKey,
  normalizeMemberKind,
  normalizeSpecialization,
  qrProof,
  validateCompanion,
  verifyQrProof,
  type EncryptedEnvelope,
  type EphemeralKeys,
  type LinkSecrets,
} from "./crypto";
import { MAX_REPLICA_EVENTS, MAX_WIRE_MESSAGE_BYTES } from "./limits";
import { eventRoot } from "./storage";
import type {
  CircleRecord,
  Companion,
  LocalIdentity,
  MemberKind,
  ReplicaBundle,
  SignedEvent,
} from "./types";

export const PROTOCOL_NAME = "rapp-heir-link-v1";
export const OFFER_LIFETIME_MS = 5 * 60 * 1000;
export const MAX_PIN_ATTEMPTS = 3;
export { MAX_WIRE_MESSAGE_BYTES };

export type OfferMode = "first-breath" | "reconnect" | "reunion";
export type OfferState = "fresh" | "in-use" | "PIN-accepted" | "consumed" | "locked" | "expired";

export interface BootstrapInvite {
  v: 1;
  protocol: typeof PROTOCOL_NAME;
  groupId: string;
  offerId: string;
  mode: OfferMode;
  issuedAt: number;
  expiresAt: number;
  hostPeerId: string;
  hostFingerprint: string;
  secret: string;
  chapterNonce: string | null;
}

export interface OfferRecord {
  invite: BootstrapInvite;
  state: OfferState;
  attempts: number;
  clientNonce: string | null;
  transcriptHash: string | null;
}

export interface ClientHelloCore {
  protocol: typeof PROTOCOL_NAME;
  groupId: string;
  offerId: string;
  memberId: string;
  signingPublicJwk: JsonWebKey;
  companion: Companion;
  kind: MemberKind;
  specialization?: string;
  ephemeralPublicJwk: JsonWebKey;
  clientNonce: string;
}

export interface ClientHello extends ClientHelloCore {
  authProof: string;
}

export interface ServerHelloCore {
  protocol: typeof PROTOCOL_NAME;
  groupId: string;
  offerId: string;
  hostMemberId: string;
  hostSigningPublicJwk: JsonWebKey;
  ephemeralPublicJwk: JsonWebKey;
  hostNonce: string;
  clientNonce: string;
}

export interface ServerHello extends ServerHelloCore {
  authProof: string;
}

export interface Transcript {
  protocol: typeof PROTOCOL_NAME;
  invite: Omit<BootstrapInvite, "secret"> & { secretHash: string };
  client: ClientHelloCore;
  host: ServerHelloCore;
}

export interface SummaryMessage {
  type: "SUMMARY";
  groupId: string;
  root: string;
  eventIds: string[];
}

export interface WantMessage {
  type: "WANT";
  groupId: string;
  eventIds: string[];
}

export interface PackMessage {
  type: "PACK";
  transferId: string;
  eventIds: string[];
  bundle: ReplicaBundle;
}

export interface AckMessage {
  type: "ACK";
  groupId: string;
  transferId: string;
  root: string;
  receivedEventIds: string[];
}

function inviteWithoutSecret(invite: BootstrapInvite): Omit<BootstrapInvite, "secret"> {
  const { secret: _secret, ...rest } = invite;
  return rest;
}

export async function createBootstrapOffer(
  group: CircleRecord,
  hostPeerId: string,
  hostPublicJwk: JsonWebKey,
  mode: OfferMode,
  chapterNonce: string | null = null,
  now = Date.now(),
): Promise<OfferRecord> {
  if (!/^[A-Za-z0-9_-]{1,120}$/u.test(hostPeerId)) throw new Error("Invalid PeerJS transport address");
  const invite: BootstrapInvite = {
    v: 1,
    protocol: PROTOCOL_NAME,
    groupId: group.id,
    offerId: randomId("offer"),
    mode,
    issuedAt: now,
    expiresAt: now + OFFER_LIFETIME_MS,
    hostPeerId,
    hostFingerprint: await fingerprintPublicKey(hostPublicJwk),
    secret: toBase64Url(randomBytes(32)),
    chapterNonce,
  };
  return { invite, state: "fresh", attempts: 0, clientNonce: null, transcriptHash: null };
}

export function validateBootstrapInvite(
  invite: BootstrapInvite,
  now = Date.now(),
  expectedGroupId?: string,
): void {
  if (
    invite.v !== 1 ||
    invite.protocol !== PROTOCOL_NAME ||
    !/^circle_[A-Za-z0-9_-]{12,}$/u.test(invite.groupId) ||
    !/^offer_[A-Za-z0-9_-]{12,}$/u.test(invite.offerId) ||
    !["first-breath", "reconnect", "reunion"].includes(invite.mode) ||
    !/^[A-Za-z0-9_-]{1,120}$/u.test(invite.hostPeerId) ||
    !/^[A-Z0-9_-]{16,24}$/u.test(invite.hostFingerprint) ||
    fromBase64Url(invite.secret).byteLength !== 32 ||
    invite.expiresAt - invite.issuedAt !== OFFER_LIFETIME_MS ||
    invite.issuedAt > now + 60_000 ||
    invite.expiresAt < now
  ) {
    throw new Error("Invite is invalid or expired");
  }
  if (expectedGroupId && invite.groupId !== expectedGroupId) throw new Error("Invite belongs to another Circle");
  if (invite.mode === "reunion" && !invite.chapterNonce) throw new Error("Reunion invite is missing its chapter nonce");
}

export function encodeInviteCode(invite: BootstrapInvite): string {
  validateBootstrapInvite(invite, invite.issuedAt);
  return toBase64Url(canonicalBytes(invite));
}

export function inviteLink(invite: BootstrapInvite, appUrl = "https://kody-w.github.io/rapp-heir/"): string {
  return `${appUrl.replace(/#.*$/u, "").replace(/\/?$/u, "/")}#/join?invite=${encodeURIComponent(
    encodeInviteCode(invite),
  )}`;
}

export function decodeInvite(input: string, now = Date.now()): BootstrapInvite {
  const trimmed = input.trim();
  let code = trimmed;
  if (trimmed.includes("invite=")) {
    const fragment = trimmed.includes("#") ? trimmed.slice(trimmed.indexOf("#") + 1) : trimmed;
    const query = fragment.includes("?") ? fragment.slice(fragment.indexOf("?") + 1) : fragment;
    code = new URLSearchParams(query).get("invite") ?? "";
  }
  const invite = boundedJsonParse<BootstrapInvite>(fromUtf8(fromBase64Url(decodeURIComponent(code))), 4_096);
  validateBootstrapInvite(invite, now);
  return invite;
}

function clientCore(hello: ClientHello): ClientHelloCore {
  const { authProof: _authProof, ...core } = hello;
  return core;
}

function serverCore(hello: ServerHello): ServerHelloCore {
  const { authProof: _authProof, ...core } = hello;
  return core;
}

async function makeTranscript(
  invite: BootstrapInvite,
  client: ClientHelloCore,
  host: ServerHelloCore,
): Promise<Transcript> {
  return {
    protocol: PROTOCOL_NAME,
    invite: { ...inviteWithoutSecret(invite), secretHash: await sha256(fromBase64Url(invite.secret)) },
    client,
    host,
  };
}

function validateHelloShape(hello: ClientHello, invite: BootstrapInvite): void {
  if (
    canonicalBytes(hello).byteLength > 12_000 ||
    hello.protocol !== PROTOCOL_NAME ||
    hello.groupId !== invite.groupId ||
    hello.offerId !== invite.offerId ||
    !/^member_[A-Za-z0-9_-]{20,}$/u.test(hello.memberId) ||
    fromBase64Url(hello.clientNonce).byteLength !== 24
  ) {
    throw new Error("Client hello does not match this offer");
  }
  validateCompanion(hello.companion);
  normalizeMemberKind(hello.kind);
  normalizeSpecialization(hello.specialization);
}

export class ClientHandshake {
  readonly invite: BootstrapInvite;
  readonly hello: ClientHello;
  readonly #ephemeral: EphemeralKeys;
  #secrets: LinkSecrets | undefined;
  #transcript: Transcript | undefined;
  #inboundSequence = -1;
  #outboundSequence = 0;

  private constructor(invite: BootstrapInvite, hello: ClientHello, ephemeral: EphemeralKeys) {
    this.invite = invite;
    this.hello = hello;
    this.#ephemeral = ephemeral;
  }

  static async start(
    invite: BootstrapInvite,
    identity: LocalIdentity,
    now = Date.now(),
  ): Promise<ClientHandshake> {
    validateBootstrapInvite(invite, now);
    const ephemeral = await generateEphemeralKeys();
    const specialization = normalizeSpecialization(identity.specialization);
    const core: ClientHelloCore = {
      protocol: PROTOCOL_NAME,
      groupId: invite.groupId,
      offerId: invite.offerId,
      memberId: identity.memberId,
      signingPublicJwk: identity.publicJwk,
      companion: identity.companion,
      kind: normalizeMemberKind(identity.kind),
      ...(specialization ? { specialization } : {}),
      ephemeralPublicJwk: ephemeral.publicJwk,
      clientNonce: toBase64Url(randomBytes(24)),
    };
    const hello: ClientHello = { ...core, authProof: await qrProof(invite.secret, core) };
    return new ClientHandshake(invite, hello, ephemeral);
  }

  async receiveServerHello(hello: ServerHello, now = Date.now()): Promise<string> {
    validateBootstrapInvite(this.invite, now);
    if (
      hello.protocol !== PROTOCOL_NAME ||
      hello.groupId !== this.invite.groupId ||
      hello.offerId !== this.invite.offerId ||
      hello.clientNonce !== this.hello.clientNonce ||
      (await memberIdFromPublicKey(hello.hostSigningPublicJwk)) !== hello.hostMemberId ||
      (await fingerprintPublicKey(hello.hostSigningPublicJwk)) !== this.invite.hostFingerprint
    ) {
      throw new Error("Host hello identity or transcript mismatch");
    }
    const transcript = await makeTranscript(this.invite, clientCore(this.hello), serverCore(hello));
    if (!(await verifyQrProof(this.invite.secret, transcript, hello.authProof))) {
      throw new Error("Host did not authenticate the QR secret");
    }
    this.#transcript = transcript;
    this.#secrets = await deriveLinkSecrets(
      this.#ephemeral.privateKey,
      hello.ephemeralPublicJwk,
      transcript,
      this.invite.secret,
      this.hello.clientNonce,
      hello.hostNonce,
    );
    return this.#secrets.pin;
  }

  get transcriptHash(): string {
    if (!this.#secrets) throw new Error("Handshake is incomplete");
    return this.#secrets.transcriptHash;
  }

  async encrypt(kind: string, value: unknown): Promise<EncryptedEnvelope> {
    if (!this.#secrets) throw new Error("Handshake is incomplete");
    return encryptEnvelope(
      this.#secrets.clientToHostKey,
      "client-to-host",
      this.#outboundSequence++,
      kind,
      value,
    );
  }

  async decrypt<T>(envelope: EncryptedEnvelope): Promise<T> {
    if (!this.#secrets) throw new Error("Handshake is incomplete");
    if (envelope.sequence <= this.#inboundSequence) throw new Error("Encrypted replay or reordering rejected");
    const value = await decryptEnvelope<T>(
      this.#secrets.hostToClientKey,
      "host-to-client",
      envelope,
    );
    this.#inboundSequence = envelope.sequence;
    return value;
  }

  transcript(): Transcript {
    if (!this.#transcript) throw new Error("Handshake is incomplete");
    return structuredClone(this.#transcript);
  }
}

export class HostHandshake {
  readonly record: OfferRecord;
  readonly clientHello: ClientHello;
  readonly serverHello: ServerHello;
  readonly joiningMember: {
    memberId: string;
    publicJwk: JsonWebKey;
    companion: Companion;
    kind: MemberKind;
    specialization?: string;
  };
  readonly #secrets: LinkSecrets;
  #inboundSequence = -1;
  #outboundSequence = 0;

  private constructor(
    record: OfferRecord,
    clientHello: ClientHello,
    serverHello: ServerHello,
    secrets: LinkSecrets,
  ) {
    this.record = record;
    this.clientHello = clientHello;
    this.serverHello = serverHello;
    this.#secrets = secrets;
    const specialization = normalizeSpecialization(clientHello.specialization);
    this.joiningMember = {
      memberId: clientHello.memberId,
      publicJwk: clientHello.signingPublicJwk,
      companion: clientHello.companion,
      kind: normalizeMemberKind(clientHello.kind),
      ...(specialization ? { specialization } : {}),
    };
  }

  static async acceptHello(
    record: OfferRecord,
    hello: ClientHello,
    hostIdentity: LocalIdentity,
    now = Date.now(),
  ): Promise<HostHandshake> {
    validateBootstrapInvite(record.invite, now);
    if (record.state !== "fresh") throw new Error("Offer is already in use or consumed");
    validateHelloShape(hello, record.invite);
    if (
      !(await verifyQrProof(record.invite.secret, clientCore(hello), hello.authProof)) ||
      (await memberIdFromPublicKey(hello.signingPublicJwk)) !== hello.memberId
    ) {
      throw new Error("Client failed QR-secret or signing-key authentication");
    }
    if (record.clientNonce === hello.clientNonce) throw new Error("Replayed client hello");
    const ephemeral = await generateEphemeralKeys();
    const core: ServerHelloCore = {
      protocol: PROTOCOL_NAME,
      groupId: record.invite.groupId,
      offerId: record.invite.offerId,
      hostMemberId: hostIdentity.memberId,
      hostSigningPublicJwk: hostIdentity.publicJwk,
      ephemeralPublicJwk: ephemeral.publicJwk,
      hostNonce: toBase64Url(randomBytes(24)),
      clientNonce: hello.clientNonce,
    };
    if ((await fingerprintPublicKey(hostIdentity.publicJwk)) !== record.invite.hostFingerprint) {
      throw new Error("Host key does not match the offer fingerprint");
    }
    const transcript = await makeTranscript(record.invite, clientCore(hello), core);
    const serverHello: ServerHello = {
      ...core,
      authProof: await qrProof(record.invite.secret, transcript),
    };
    const secrets = await deriveLinkSecrets(
      ephemeral.privateKey,
      hello.ephemeralPublicJwk,
      transcript,
      record.invite.secret,
      hello.clientNonce,
      core.hostNonce,
    );
    record.state = "in-use";
    record.clientNonce = hello.clientNonce;
    record.transcriptHash = secrets.transcriptHash;
    return new HostHandshake(record, hello, serverHello, secrets);
  }

  submitPin(pin: string, now = Date.now()): boolean {
    if (this.record.invite.expiresAt < now || this.record.state === "consumed" || this.record.state === "locked") {
      throw new Error("Offer expired or consumed");
    }
    if (this.record.state === "PIN-accepted") return true;
    if (this.record.state !== "in-use") throw new Error("Offer is not waiting for a PIN");
    this.record.attempts += 1;
    if (!/^\d{6}$/u.test(pin) || !constantTimeEqual(pin, this.#secrets.pin)) {
      if (this.record.attempts >= MAX_PIN_ATTEMPTS) this.record.state = "locked";
      return false;
    }
    this.record.state = "PIN-accepted";
    return true;
  }

  async encrypt(kind: string, value: unknown): Promise<EncryptedEnvelope> {
    if (this.record.state !== "PIN-accepted" && this.record.state !== "consumed") {
      throw new Error("No group data is released before final PIN acceptance");
    }
    return encryptEnvelope(
      this.#secrets.hostToClientKey,
      "host-to-client",
      this.#outboundSequence++,
      kind,
      value,
    );
  }

  async decrypt<T>(envelope: EncryptedEnvelope): Promise<T> {
    if (this.record.state !== "PIN-accepted" && this.record.state !== "consumed") {
      throw new Error("Encrypted state is unavailable before PIN acceptance");
    }
    if (envelope.sequence <= this.#inboundSequence) throw new Error("Encrypted replay or reordering rejected");
    const value = await decryptEnvelope<T>(
      this.#secrets.clientToHostKey,
      "client-to-host",
      envelope,
    );
    this.#inboundSequence = envelope.sequence;
    return value;
  }

  consumeAfterDurableAck(ack: { transcriptHash: string; root: string }, expectedRoot: string): void {
    if (
      this.record.state !== "PIN-accepted" ||
      !constantTimeEqual(ack.transcriptHash, this.#secrets.transcriptHash) ||
      !constantTimeEqual(ack.root, expectedRoot)
    ) {
      throw new Error("Durable acknowledgement does not match accepted state");
    }
    this.record.state = "consumed";
  }
}

export async function makeSummary(groupId: string, events: readonly SignedEvent[]): Promise<SummaryMessage> {
  if (events.length > MAX_REPLICA_EVENTS) throw new Error("Summary event limit exceeded");
  return {
    type: "SUMMARY",
    groupId,
    root: await eventRoot(events),
    eventIds: events.map((event) => event.id).sort(),
  };
}

export function makeWant(
  localEvents: readonly SignedEvent[],
  remoteSummary: SummaryMessage,
): WantMessage {
  const local = new Set(localEvents.map((event) => event.id));
  return {
    type: "WANT",
    groupId: remoteSummary.groupId,
    eventIds: remoteSummary.eventIds.filter((id) => !local.has(id)).slice(0, MAX_REPLICA_EVENTS),
  };
}

export function eventsForWant(events: readonly SignedEvent[], want: WantMessage): SignedEvent[] {
  if (want.eventIds.length > MAX_REPLICA_EVENTS) throw new Error("WANT limit exceeded");
  const requested = new Set(want.eventIds);
  return events.filter((event) => requested.has(event.id));
}

function sortedExactIds(ids: readonly string[]): string[] {
  if (ids.length > MAX_REPLICA_EVENTS || new Set(ids).size !== ids.length) {
    throw new Error("Transfer event-ID set is invalid");
  }
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]{20,}$/u.test(id)) throw new Error("Transfer event-ID set is invalid");
  }
  return [...ids].sort();
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  const a = sortedExactIds(left);
  const b = sortedExactIds(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function createPackMessage(
  bundle: ReplicaBundle,
  transferId = randomId("transfer"),
): PackMessage {
  if (!/^transfer_[A-Za-z0-9_-]{12,}$/u.test(transferId)) throw new Error("Invalid transfer ID");
  const eventIds = sortedExactIds(bundle.events.map((event) => event.id));
  return { type: "PACK", transferId, eventIds, bundle };
}

export function validatePackMessage(pack: PackMessage, expectedGroupId: string): void {
  if (
    pack.type !== "PACK" ||
    !/^transfer_[A-Za-z0-9_-]{12,}$/u.test(pack.transferId) ||
    pack.bundle.group.id !== expectedGroupId ||
    !sameIdSet(pack.eventIds, pack.bundle.events.map((event) => event.id))
  ) {
    throw new Error("PACK transfer binding mismatch");
  }
}

export class OutstandingTransferLedger {
  readonly #outstanding = new Map<string, { groupId: string; eventIds: string[] }>();

  register(pack: PackMessage): void {
    validatePackMessage(pack, pack.bundle.group.id);
    if (this.#outstanding.has(pack.transferId)) throw new Error("Transfer ID is already outstanding");
    this.#outstanding.set(pack.transferId, {
      groupId: pack.bundle.group.id,
      eventIds: sortedExactIds(pack.eventIds),
    });
  }

  acknowledge(ack: AckMessage): string[] {
    const expected = this.#outstanding.get(ack.transferId);
    if (
      ack.type !== "ACK" ||
      !expected ||
      ack.groupId !== expected.groupId ||
      !/^[A-Za-z0-9_-]{20,}$/u.test(ack.root) ||
      !sameIdSet(ack.receivedEventIds, expected.eventIds)
    ) {
      throw new Error("ACK does not match an outstanding transfer and exact event-ID set");
    }
    this.#outstanding.delete(ack.transferId);
    return [...expected.eventIds];
  }

  clear(): void {
    this.#outstanding.clear();
  }

  get size(): number {
    return this.#outstanding.size;
  }
}

export function parseWireMessage<T>(value: unknown): T {
  if (canonicalBytes(value).byteLength > MAX_WIRE_MESSAGE_BYTES) throw new Error("Wire message exceeds limit");
  if (!value || typeof value !== "object") throw new Error("Malformed wire message");
  return value as T;
}
