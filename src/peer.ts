import Peer, { type DataConnection } from "peerjs";
import { canonicalStringify } from "./canonical";
import { createSignedEvent, verifyValue } from "./crypto";
import {
  ClientHandshake,
  HostHandshake,
  OutstandingTransferLedger,
  createPackMessage,
  createBootstrapOffer,
  eventsForWant,
  makeSummary,
  makeWant,
  parseWireMessage,
  validatePackMessage,
  type AckMessage,
  type BootstrapInvite,
  type ClientHello,
  type OfferMode,
  type OfferRecord,
  type PackMessage,
  type ServerHello,
  type SummaryMessage,
  type WantMessage,
} from "./protocol";
import { approveReunion } from "./reunion";
import {
  buildReplicaBundle,
  eventRoot,
  getCircle,
  getCircleEvents,
  makeReplicaBundle,
  markOutbox,
  mergeReplicaBundle,
  setSetting,
  validateReplicaBundle,
  type ReplicaDatabase,
} from "./storage";
import type {
  CircleRecord,
  LocalIdentity,
  MemberProfile,
  ReplicaBundle,
  ReunionApproval,
  ReunionChallenge,
  SignedEvent,
} from "./types";

export interface TransportConnection {
  readonly peerId: string;
  readonly open: boolean;
  send(value: unknown): void;
  close(): void;
  onData(handler: (value: unknown) => void): void;
  onClose(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}

export interface TransportEndpoint {
  readonly id: string;
  connect(peerId: string): Promise<TransportConnection>;
  onConnection(handler: (connection: TransportConnection) => void): void;
  destroy(): void;
}

export interface PeerTransportFactory {
  open(): Promise<TransportEndpoint>;
}

export function sendRequired(
  connection: TransportConnection,
  value: unknown,
  label = "Secure message",
): void {
  if (!connection.open) throw new Error(`${label} remains pending because the link is closed`);
  connection.send(value);
}

class PeerJsConnection implements TransportConnection {
  readonly #connection: DataConnection;

  constructor(connection: DataConnection) {
    this.#connection = connection;
  }

  get peerId(): string {
    return this.#connection.peer;
  }

  get open(): boolean {
    return this.#connection.open;
  }

  send(value: unknown): void {
    if (!this.#connection.open) throw new Error("PeerJS data connection is closed");
    this.#connection.send(value);
  }

  close(): void {
    this.#connection.close();
  }

  onData(handler: (value: unknown) => void): void {
    this.#connection.on("data", (value) => handler(value));
  }

  onClose(handler: () => void): void {
    this.#connection.on("close", handler);
  }

  onError(handler: (error: Error) => void): void {
    this.#connection.on("error", handler);
  }
}

function waitForDataConnection(connection: DataConnection): Promise<TransportConnection> {
  if (connection.open) return Promise.resolve(new PeerJsConnection(connection));
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      connection.close();
      reject(new Error("PeerJS data connection timed out"));
    }, 15_000);
    connection.once("open", () => {
      if (settled) {
        connection.close();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(new PeerJsConnection(connection));
    });
    connection.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      connection.close();
      reject(error);
    });
  });
}

class PeerJsEndpoint implements TransportEndpoint {
  readonly #peer: Peer;

  constructor(peer: Peer) {
    this.#peer = peer;
  }

  get id(): string {
    return this.#peer.id;
  }

  async connect(peerId: string): Promise<TransportConnection> {
    return waitForDataConnection(
      this.#peer.connect(peerId, {
        reliable: true,
        serialization: "json",
        metadata: { protocol: "rapp-heir-link-v1" },
      }),
    );
  }

  onConnection(handler: (connection: TransportConnection) => void): void {
    this.#peer.on("connection", (connection) => {
      void waitForDataConnection(connection).then(handler).catch(() => connection.close());
    });
  }

  destroy(): void {
    this.#peer.destroy();
  }
}

export const PEERJS_CLOUD_CONFIG = Object.freeze({
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  secure: true,
  key: "peerjs",
  debug: 1,
  config: {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  },
});

export class PeerJsTransportFactory implements PeerTransportFactory {
  async open(): Promise<TransportEndpoint> {
    const peer = new Peer(PEERJS_CLOUD_CONFIG);
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        peer.destroy();
        reject(new Error("PeerJS signaling timed out"));
      }, 15_000);
      peer.once("open", () => {
        clearTimeout(timeout);
        resolve(new PeerJsEndpoint(peer));
      });
      peer.once("error", (error) => {
        clearTimeout(timeout);
        peer.destroy();
        reject(error);
      });
    });
  }
}

interface WireClientHello {
  type: "CLIENT_HELLO";
  hello: ClientHello;
}

interface WireServerHello {
  type: "SERVER_HELLO";
  hello: ServerHello;
}

interface WireSecure {
  type: "SECURE";
  envelope: Awaited<ReturnType<ClientHandshake["encrypt"]>>;
}

interface WireReject {
  type: "REJECT";
  reason: string;
}

type WireMessage = WireClientHello | WireServerHello | WireSecure | WireReject;

interface SecureSide {
  encrypt(kind: string, value: unknown): Promise<WireSecure["envelope"]>;
  decrypt<T>(envelope: WireSecure["envelope"]): Promise<T>;
}

export interface LinkCallbacks {
  onStatus?: (message: string) => void;
  onHostPinNeeded?: (member: { memberId: string; companionName: string; attemptsLeft: number }) => void;
  onJoinerPin?: (pin: string) => void;
  onComplete?: (groupId: string) => void;
  onError?: (message: string) => void;
  onLinkClosed?: () => void;
  onOfferExpired?: () => void;
  onReunionRequest?: (challenge: ReunionChallenge) => void;
  onReunionApproval?: (approval: ReunionApproval) => void;
}

interface HostContext {
  handshake: HostHandshake;
  connection: TransportConnection;
  provisionalBundle?: ReplicaBundle;
  expectedRoot?: string;
}

function sameJoiningProfile(
  existing: MemberProfile,
  joining: HostHandshake["joiningMember"],
): boolean {
  const comparable = (profile: MemberProfile | HostHandshake["joiningMember"]): unknown => ({
    memberId: profile.memberId,
    publicJwk: {
      kty: profile.publicJwk.kty,
      crv: profile.publicJwk.crv,
      x: profile.publicJwk.x,
      y: profile.publicJwk.y,
    },
    companion: profile.companion,
    kind: profile.kind,
    specialization: profile.specialization ?? null,
  });
  return canonicalStringify(comparable(existing)) === canonicalStringify(comparable(joining));
}

export class CircleLinkController {
  readonly #database: ReplicaDatabase;
  readonly #identity: LocalIdentity;
  readonly #transportFactory: PeerTransportFactory;
  readonly #callbacks: LinkCallbacks;
  #endpoint: TransportEndpoint | undefined;
  #connection: TransportConnection | undefined;
  #hostContext: HostContext | undefined;
  #clientHandshake: ClientHandshake | undefined;
  #secureSide: SecureSide | undefined;
  #groupId: string | undefined;
  #offer: OfferRecord | undefined;
  #reunionChallenge: ReunionChallenge | undefined;
  #pendingReunionChallenge: ReunionChallenge | undefined;
  readonly #transfers = new OutstandingTransferLedger();
  #offerExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #handling = Promise.resolve();

  constructor(
    database: ReplicaDatabase,
    identity: LocalIdentity,
    callbacks: LinkCallbacks = {},
    transportFactory: PeerTransportFactory = new PeerJsTransportFactory(),
  ) {
    this.#database = database;
    this.#identity = identity;
    this.#callbacks = callbacks;
    this.#transportFactory = transportFactory;
  }

  get offer(): OfferRecord | undefined {
    return this.#offer ? structuredClone(this.#offer) : undefined;
  }

  async expireHostOffer(now = Date.now()): Promise<boolean> {
    const effectiveExpiry = Math.min(
      this.#offer?.invite.expiresAt ?? Number.POSITIVE_INFINITY,
      this.#reunionChallenge?.expiresAt ?? Number.POSITIVE_INFINITY,
    );
    if (!this.#offer || effectiveExpiry > now) return false;
    await this.#expireHostOffer(this.#generation);
    return true;
  }

  async host(
    group: CircleRecord,
    mode: OfferMode,
    reunionChallenge?: ReunionChallenge,
  ): Promise<BootstrapInvite> {
    if (mode === "first-breath" && group.coordinatorId !== this.#identity.memberId) {
      throw new Error("Only the first-breath coordinator can enroll founders");
    }
    if (
      (mode === "reunion" &&
        (!reunionChallenge ||
          reunionChallenge.groupId !== group.id ||
          reunionChallenge.chapter !== group.chapter + 1)) ||
      (mode !== "reunion" && reunionChallenge)
    ) {
      throw new Error("Host mode and reunion challenge do not match");
    }
    if (reunionChallenge) {
      await this.#assertReunionCurrent(group.id, reunionChallenge);
    }
    this.dispose();
    const generation = this.#generation;
    this.#callbacks.onStatus?.("Connecting to PeerJS signaling…");
    const endpoint = await this.#transportFactory.open();
    if (generation !== this.#generation) {
      endpoint.destroy();
      throw new Error("Host setup was cancelled");
    }
    this.#endpoint = endpoint;
    this.#groupId = group.id;
    this.#reunionChallenge = reunionChallenge;
    this.#offer = await createBootstrapOffer(
      group,
      endpoint.id,
      this.#identity.publicJwk,
      mode,
      reunionChallenge?.nonce ?? null,
    );
    await setSetting(this.#database, `offer:${this.#offer.invite.offerId}`, this.#offer);
    this.#offerExpiryTimer = globalThis.setTimeout(
      () => void this.#expireHostOffer(generation),
      Math.max(
        0,
        Math.min(
          this.#offer.invite.expiresAt,
          reunionChallenge?.expiresAt ?? Number.POSITIVE_INFINITY,
        ) - Date.now(),
      ),
    );
    endpoint.onConnection((connection) => {
      if (this.#offer?.state !== "fresh") {
        if (connection.open) {
          connection.send({ type: "REJECT", reason: "This single-use offer is unavailable." } satisfies WireReject);
        }
        connection.close();
        return;
      }
      this.#connection = connection;
      this.#wire(connection, "host");
      this.#callbacks.onStatus?.("Peer connected; waiting for authenticated hello.");
    });
    this.#callbacks.onStatus?.("Invite ready — not yet sent.");
    return this.#offer.invite;
  }

  async join(invite: BootstrapInvite): Promise<void> {
    this.dispose();
    const generation = this.#generation;
    this.#groupId = invite.groupId;
    this.#callbacks.onStatus?.("Connecting through PeerJS signaling…");
    try {
      const endpoint = await this.#transportFactory.open();
      if (generation !== this.#generation) {
        endpoint.destroy();
        throw new Error("Join setup was cancelled");
      }
      this.#endpoint = endpoint;
      this.#clientHandshake = await ClientHandshake.start(invite, this.#identity);
      this.#offerExpiryTimer = globalThis.setTimeout(
        () => this.#expireJoin(generation),
        Math.max(0, invite.expiresAt - Date.now()),
      );
      const connection = await endpoint.connect(invite.hostPeerId);
      if (generation !== this.#generation) {
        connection.close();
        throw new Error("Join setup was cancelled");
      }
      this.#connection = connection;
      this.#wire(connection, "client");
      if (!connection.open) throw new Error("Peer connection closed before authenticated hello");
      connection.send({ type: "CLIENT_HELLO", hello: this.#clientHandshake.hello } satisfies WireClientHello);
      this.#callbacks.onStatus?.("Authenticated hello sent; delivery unknown.");
    } catch (error) {
      if (generation === this.#generation) this.dispose();
      throw error;
    }
  }

  async submitHostPin(pin: string): Promise<boolean> {
    const context = this.#hostContext;
    if (!context) throw new Error("No joiner is waiting for a PIN");
    if (this.#reunionChallenge && this.#groupId) {
      await this.#assertReunionCurrent(this.#groupId, this.#reunionChallenge);
    }
    const accepted = context.handshake.submitPin(pin);
    await setSetting(
      this.#database,
      `offer:${context.handshake.record.invite.offerId}`,
      context.handshake.record,
    );
    if (!accepted) {
      const attemptsLeft = Math.max(0, 3 - context.handshake.record.attempts);
      this.#callbacks.onStatus?.(
        attemptsLeft > 0 ? `PIN did not match. ${attemptsLeft} attempt${attemptsLeft === 1 ? "" : "s"} left.` : "Offer locked.",
      );
      this.#callbacks.onHostPinNeeded?.({
        memberId: context.handshake.joiningMember.memberId,
        companionName: context.handshake.joiningMember.companion.name,
        attemptsLeft,
      });
      if (attemptsLeft === 0) {
        if (context.connection.open) {
          context.connection.send({ type: "REJECT", reason: "PIN attempts exhausted." } satisfies WireReject);
        }
        context.connection.close();
      }
      return false;
    }
    this.#callbacks.onStatus?.("PIN accepted. Preparing encrypted state…");
    const bundle = await this.#prepareHostBundle(context.handshake);
    context.provisionalBundle = bundle;
    context.expectedRoot = bundle.root;
    const eventIds = bundle.events.map((event) => event.id);
    await markOutbox(this.#database, bundle.group.id, eventIds, "PIN-accepted");
    await this.#sendSecure(context.connection, context.handshake, "STATE", {
      transcriptHash: context.handshake.record.transcriptHash,
      bundle,
      reunionChallenge: this.#reunionChallenge ?? null,
    });
    await markOutbox(this.#database, bundle.group.id, eventIds, "delivery-unknown");
    return true;
  }

  async approvePendingReunion(): Promise<void> {
    if (!this.#pendingReunionChallenge || !this.#secureSide || !this.#connection) {
      throw new Error("No reunion challenge is waiting");
    }
    await this.#assertReunionCurrent(
      this.#pendingReunionChallenge.groupId,
      this.#pendingReunionChallenge,
    );
    const approval = await approveReunion(this.#pendingReunionChallenge, this.#identity);
    await this.#sendSecure(this.#connection, this.#secureSide, "REUNION_APPROVAL", approval);
    this.#pendingReunionChallenge = undefined;
    this.#callbacks.onStatus?.("Reunion approval signed and sent.");
  }

  dispose(): void {
    this.#generation += 1;
    if (this.#offerExpiryTimer !== undefined) globalThis.clearTimeout(this.#offerExpiryTimer);
    this.#offerExpiryTimer = undefined;
    if (
      this.#offer &&
      !["consumed", "locked", "expired"].includes(this.#offer.state)
    ) {
      this.#offer.state = "expired";
      void setSetting(this.#database, `offer:${this.#offer.invite.offerId}`, this.#offer);
    }
    this.#connection?.close();
    this.#endpoint?.destroy();
    this.#connection = undefined;
    this.#endpoint = undefined;
    this.#hostContext = undefined;
    this.#clientHandshake = undefined;
    this.#secureSide = undefined;
    this.#groupId = undefined;
    this.#offer = undefined;
    this.#reunionChallenge = undefined;
    this.#pendingReunionChallenge = undefined;
    this.#transfers.clear();
  }

  async #assertReunionCurrent(groupId: string, challenge: ReunionChallenge): Promise<void> {
    const [group, events] = await Promise.all([
      getCircle(this.#database, groupId),
      getCircleEvents(this.#database, groupId),
    ]);
    const now = Date.now();
    if (
      !group ||
      challenge.groupId !== groupId ||
      challenge.chapter !== group.chapter + 1 ||
      challenge.issuedAt > now ||
      challenge.expiresAt < now ||
      (await eventRoot(events)) !== challenge.eventRoot
    ) {
      throw new Error("Reunion challenge expired or event root changed; start a new challenge");
    }
  }

  async #expireHostOffer(generation: number): Promise<void> {
    if (generation !== this.#generation || !this.#offer) return;
    const consumed = this.#offer.state === "consumed";
    if (!consumed) {
      this.#offer.state = "expired";
      await setSetting(this.#database, `offer:${this.#offer.invite.offerId}`, this.#offer);
    }

    this.#connection?.close();
    this.#endpoint?.destroy();
    this.#connection = undefined;
    this.#endpoint = undefined;
    this.#hostContext = undefined;
    this.#secureSide = undefined;
    if (!consumed) {
      this.#callbacks.onStatus?.("Host offer expired; create a fresh QR/PIN ceremony.");
      this.#callbacks.onOfferExpired?.();
    }
  }

  #expireJoin(generation: number): void {
    if (generation !== this.#generation || !this.#clientHandshake) return;
    this.dispose();
    this.#callbacks.onError?.("Join invite expired; scan a fresh QR/PIN offer");
  }

  #wire(connection: TransportConnection, role: "host" | "client"): void {
    const generation = this.#generation;
    connection.onData((value) => {
      if (generation !== this.#generation) return;
      this.#handling = this.#handling
        .then(() => this.#handleMessage(connection, role, parseWireMessage<WireMessage>(value)))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Connection protocol failed";
          this.#callbacks.onError?.(message);
          this.#callbacks.onStatus?.(`Connection closed safely: ${message}`);
          if (connection.open) {
            try {
              connection.send({ type: "REJECT", reason: "Protocol validation failed." } satisfies WireReject);
            } catch {
              // The peer may already be gone; local failure state is retained.
            }
          }
          connection.close();
        });
    });
    connection.onClose(() => {
      if (generation === this.#generation) {
        this.#callbacks.onStatus?.("Peer connection closed; local replica remains ready.");
        this.dispose();
        this.#callbacks.onLinkClosed?.();
      }
    });
    connection.onError((error) => {
      if (generation === this.#generation) {
        this.dispose();
        this.#callbacks.onError?.(`Peer transport: ${error.message}`);
      }
    });
  }

  async #handleMessage(
    connection: TransportConnection,
    role: "host" | "client",
    message: WireMessage,
  ): Promise<void> {
    if (message.type === "REJECT") throw new Error(message.reason);
    if (role === "host" && message.type === "CLIENT_HELLO") {
      await this.#handleClientHello(connection, message.hello);
      return;
    }
    if (role === "client" && message.type === "SERVER_HELLO") {
      if (!this.#clientHandshake) throw new Error("Unexpected host hello");
      const pin = await this.#clientHandshake.receiveServerHello(message.hello);
      this.#secureSide = this.#clientHandshake;
      this.#callbacks.onJoinerPin?.(pin);
      this.#callbacks.onStatus?.("Read the six-digit PIN to the host. It is never sent over PeerJS.");
      return;
    }
    if (message.type === "SECURE") {
      if (!this.#secureSide) {
        if (role === "host" && this.#hostContext) this.#secureSide = this.#hostContext.handshake;
        else throw new Error("Encrypted data arrived before handshake completion");
      }
      await this.#handleSecure(connection, role, message);
      return;
    }
    throw new Error("Unexpected handshake message");
  }

  async #handleClientHello(connection: TransportConnection, hello: ClientHello): Promise<void> {
    if (!this.#offer || !this.#groupId) throw new Error("No active host offer");
    const group = await getCircle(this.#database, this.#groupId);
    if (!group) throw new Error("Circle is unavailable");
    const existing = group.members[hello.memberId];
    if (this.#offer.invite.mode === "first-breath") {
      if (group.status !== "forming") throw new Error("First-breath enrollment is closed");
      if (
        existing &&
        !sameJoiningProfile(existing, {
          memberId: hello.memberId,
          publicJwk: hello.signingPublicJwk,
          companion: hello.companion,
          kind: hello.kind ?? "human",
          ...(hello.specialization ? { specialization: hello.specialization } : {}),
        })
      ) {
        throw new Error("That enrolled key has conflicting companion metadata");
      }
    } else if (!existing) {
      throw new Error("Reconnect and reunion are only for enrolled member keys");
    }
    const handshake = await HostHandshake.acceptHello(this.#offer, hello, this.#identity);
    this.#hostContext = { handshake, connection };
    this.#secureSide = handshake;
    connection.send({ type: "SERVER_HELLO", hello: handshake.serverHello } satisfies WireServerHello);
    await setSetting(this.#database, `offer:${this.#offer.invite.offerId}`, this.#offer);
    this.#callbacks.onHostPinNeeded?.({
      memberId: handshake.joiningMember.memberId,
      companionName: handshake.joiningMember.companion.name,
      attemptsLeft: 3,
    });
    this.#callbacks.onStatus?.("Joiner authenticated the QR secret. Enter only the PIN they tell you.");
  }

  async #prepareHostBundle(handshake: HostHandshake): Promise<ReplicaBundle> {
    const group = await getCircle(this.#database, handshake.record.invite.groupId);
    if (!group) throw new Error("Circle missing");
    if (group.members[handshake.joiningMember.memberId]) return makeReplicaBundle(this.#database, group.id);
    const joinedAt = new Date().toISOString();
    const member: MemberProfile = {
      memberId: handshake.joiningMember.memberId,
      publicJwk: handshake.joiningMember.publicJwk,
      companion: handshake.joiningMember.companion,
      kind: handshake.joiningMember.kind,
      ...(handshake.joiningMember.specialization
        ? { specialization: handshake.joiningMember.specialization }
        : {}),
      joinedAt,
      active: true,
    };
    const provisionalGroup: CircleRecord = {
      ...structuredClone(group),
      members: { ...structuredClone(group.members), [member.memberId]: member },
    };
    const events = await getCircleEvents(this.#database, group.id);
    const local = events.filter((event) => event.body.memberId === this.#identity.memberId);
    const maximum = local.length > 0 ? Math.max(...local.map((event) => event.body.seq)) : 0;
    const previous =
      local
        .filter((event) => event.body.seq === maximum)
        .map((event) => event.id)
        .sort()
        .at(0) ?? null;
    const enrollment = await createSignedEvent(
      {
        version: 1,
        groupId: group.id,
        memberId: this.#identity.memberId,
        seq: maximum + 1,
        prev: previous,
        type: "member.enrolled",
        createdAt: joinedAt,
        payload: {
          enrolledMemberId: member.memberId,
          publicJwk: member.publicJwk,
          companion: member.companion,
          kind: member.kind,
          ...(member.specialization ? { specialization: member.specialization } : {}),
          offerId: handshake.record.invite.offerId,
        },
      },
      this.#identity.privateJwk,
    );
    const allEvents = [...events, enrollment].sort((left, right) => left.id.localeCompare(right.id));
    return buildReplicaBundle(provisionalGroup, allEvents, joinedAt);
  }

  async #sendSecure(
    connection: TransportConnection,
    side: SecureSide,
    kind: string,
    payload: unknown,
  ): Promise<void> {
    if (!connection.open) throw new Error(`Secure ${kind} remains pending because the link is closed`);
    const envelope = await side.encrypt(kind, payload);
    sendRequired(connection, { type: "SECURE", envelope } satisfies WireSecure, `Secure ${kind}`);
  }

  async #handleSecure(
    connection: TransportConnection,
    role: "host" | "client",
    message: WireSecure,
  ): Promise<void> {
    if (!this.#secureSide || !this.#groupId) throw new Error("Secure channel is not ready");
    const kind = message.envelope.kind;
    const reunionLink =
      this.#clientHandshake?.invite.mode === "reunion" ||
      this.#hostContext?.handshake.record.invite.mode === "reunion";
    if (
      reunionLink &&
      ["HELLO", "SUMMARY", "WANT", "PACK", "ACK"].includes(kind)
    ) {
      throw new Error("Anti-entropy is paused until the reunion certificate closes");
    }
    if (kind === "STATE" && role === "client") {
      const payload = await this.#secureSide.decrypt<{
        transcriptHash: string;
        bundle: ReplicaBundle;
        reunionChallenge: ReunionChallenge | null;
      }>(message.envelope);
      if (
        !this.#clientHandshake ||
        payload.transcriptHash !== this.#clientHandshake.transcriptHash ||
        payload.bundle.group.id !== this.#groupId
      ) {
        throw new Error("Accepted state transcript mismatch");
      }
      if (
        (this.#clientHandshake.invite.mode === "reunion" && !payload.reunionChallenge) ||
        (this.#clientHandshake.invite.mode !== "reunion" && payload.reunionChallenge !== null) ||
        (payload.reunionChallenge &&
          (payload.reunionChallenge.nonce !== this.#clientHandshake.invite.chapterNonce ||
            payload.reunionChallenge.groupId !== this.#groupId ||
            payload.reunionChallenge.chapter !== payload.bundle.group.chapter + 1 ||
            payload.reunionChallenge.eventRoot !== payload.bundle.root ||
            payload.reunionChallenge.expiresAt < Date.now()))
      ) {
        throw new Error("Reunion challenge does not match the scanned invite");
      }
      let result: { added: number; duplicates: number; root: string };
      if (payload.reunionChallenge) {
        const [localGroup, localEvents] = await Promise.all([
          getCircle(this.#database, this.#groupId),
          getCircleEvents(this.#database, this.#groupId),
        ]);
        if (
          !localGroup ||
          (await eventRoot(localEvents)) !== payload.reunionChallenge.eventRoot
        ) {
          throw new Error("Local event root differs; reconnect before starting a new reunion challenge");
        }
        await validateReplicaBundle(payload.bundle, localGroup, localEvents);
        result = {
          added: 0,
          duplicates: payload.bundle.events.length,
          root: payload.reunionChallenge.eventRoot,
        };
      } else {
        result = await mergeReplicaBundle(this.#database, payload.bundle);
      }
      await markOutbox(
        this.#database,
        this.#groupId,
        payload.bundle.events.map((event) => event.id),
        "durably-merged",
      );
      await this.#sendSecure(connection, this.#secureSide, "DURABLE_ACK", {
        transcriptHash: payload.transcriptHash,
        root: payload.bundle.root,
      });
      this.#callbacks.onStatus?.(`PIN accepted; ${result.added} event(s) durably merged.`);
      this.#callbacks.onComplete?.(this.#groupId);
      if (payload.reunionChallenge) {
        this.#pendingReunionChallenge = payload.reunionChallenge;
        this.#callbacks.onReunionRequest?.(payload.reunionChallenge);
        return;
      }
      await this.#sendSecure(connection, this.#secureSide, "HELLO", {
        type: "HELLO",
        protocol: "rapp-heir-link-v1",
        groupId: this.#groupId,
        memberId: this.#identity.memberId,
      });
      return;
    }
    if (kind === "DURABLE_ACK" && role === "host") {
      const ack = await this.#secureSide.decrypt<{ transcriptHash: string; root: string }>(message.envelope);
      const context = this.#hostContext;
      if (!context?.expectedRoot || !context.provisionalBundle) throw new Error("Unexpected durable ACK");
      if (this.#reunionChallenge) {
        await this.#assertReunionCurrent(this.#groupId, this.#reunionChallenge);
      }
      context.handshake.consumeAfterDurableAck(ack, context.expectedRoot);
      await mergeReplicaBundle(this.#database, context.provisionalBundle);
      await markOutbox(
        this.#database,
        this.#groupId,
        context.provisionalBundle.events.map((event) => event.id),
        "durably-merged",
      );
      await setSetting(
        this.#database,
        `offer:${context.handshake.record.invite.offerId}`,
        context.handshake.record,
      );
      this.#callbacks.onStatus?.("Joiner acknowledged durable merge; single-use offer consumed.");
      this.#callbacks.onComplete?.(this.#groupId);
      if (context.handshake.record.invite.mode === "reunion") return;
      await this.#sendSecure(connection, this.#secureSide, "HELLO", {
        type: "HELLO",
        protocol: "rapp-heir-link-v1",
        groupId: this.#groupId,
        memberId: this.#identity.memberId,
      });
      return;
    }
    if (kind === "HELLO") {
      const hello = await this.#secureSide.decrypt<{
        type: "HELLO";
        protocol: string;
        groupId: string;
        memberId: string;
      }>(message.envelope);
      const group = await getCircle(this.#database, this.#groupId);
      if (
        hello.type !== "HELLO" ||
        hello.protocol !== "rapp-heir-link-v1" ||
        hello.groupId !== this.#groupId ||
        !group?.members[hello.memberId]
      ) {
        throw new Error("Encrypted HELLO is not from an enrolled Circle key");
      }
      const events = await getCircleEvents(this.#database, this.#groupId);
      await this.#sendSecure(connection, this.#secureSide, "SUMMARY", await makeSummary(this.#groupId, events));
      return;
    }
    if (kind === "SUMMARY") {
      const summary = await this.#secureSide.decrypt<SummaryMessage>(message.envelope);
      if (summary.type !== "SUMMARY" || summary.groupId !== this.#groupId) throw new Error("SUMMARY mismatch");
      const events = await getCircleEvents(this.#database, this.#groupId);
      await this.#sendSecure(connection, this.#secureSide, "WANT", makeWant(events, summary));
      return;
    }
    if (kind === "WANT") {
      const want = await this.#secureSide.decrypt<WantMessage>(message.envelope);
      if (want.type !== "WANT" || want.groupId !== this.#groupId) throw new Error("WANT mismatch");
      const [group, events] = await Promise.all([
        getCircle(this.#database, this.#groupId),
        getCircleEvents(this.#database, this.#groupId),
      ]);
      if (!group) throw new Error("Circle missing during sync");
      const selected = eventsForWant(events, want);
      const bundle = await buildReplicaBundle(group, selected);
      const pack = createPackMessage(bundle);
      this.#transfers.register(pack);
      await markOutbox(
        this.#database,
        this.#groupId,
        selected.map((event) => event.id),
        "delivery-unknown",
      );
      await this.#sendSecure(connection, this.#secureSide, "PACK", pack);
      return;
    }
    if (kind === "PACK") {
      const pack = await this.#secureSide.decrypt<PackMessage>(message.envelope);
      validatePackMessage(pack, this.#groupId);
      const result = await mergeReplicaBundle(this.#database, pack.bundle);
      const events = await getCircleEvents(this.#database, this.#groupId);
      const ack: AckMessage = {
        type: "ACK",
        groupId: this.#groupId,
        transferId: pack.transferId,
        root: await eventRoot(events),
        receivedEventIds: [...pack.eventIds],
      };
      await this.#sendSecure(connection, this.#secureSide, "ACK", ack);
      this.#callbacks.onStatus?.(`PACK received/hash-checked: ${result.added} new, ${result.duplicates} duplicate.`);
      return;
    }
    if (kind === "ACK") {
      const ack = await this.#secureSide.decrypt<AckMessage>(message.envelope);
      const acknowledgedIds = this.#transfers.acknowledge(ack);
      await markOutbox(this.#database, this.#groupId, acknowledgedIds, "durably-merged");
      this.#callbacks.onStatus?.("Anti-entropy ACK: peer durably merged requested events.");
      return;
    }
    if (kind === "REUNION_APPROVAL" && role === "host") {
      if (!this.#reunionChallenge) throw new Error("No active reunion challenge");
      await this.#assertReunionCurrent(this.#groupId, this.#reunionChallenge);
      const approval = await this.#secureSide.decrypt<ReunionApproval>(message.envelope);
      const group = await getCircle(this.#database, this.#groupId);
      const member = group?.members[approval.memberId];
      if (
        !member?.active ||
        !(await verifyValue(this.#reunionChallenge, approval.signature, member.publicJwk))
      ) {
        throw new Error("Reunion approval is not from a distinct enrolled signing key");
      }
      this.#callbacks.onReunionApproval?.(approval);
      this.#callbacks.onStatus?.("A distinct enrolled key returned a reunion approval.");
      return;
    }
    throw new Error(`Unexpected encrypted message ${kind}`);
  }
}

export async function convergenceRoot(database: ReplicaDatabase, groupId: string): Promise<string> {
  return eventRoot(await getCircleEvents(database, groupId));
}

export function signedEventsById(events: readonly SignedEvent[]): Map<string, SignedEvent> {
  return new Map(events.map((event) => [event.id, event]));
}
