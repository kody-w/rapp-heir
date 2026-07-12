import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CircleLinkController,
  sendRequired,
  type PeerTransportFactory,
  type TransportConnection,
  type TransportEndpoint,
} from "../src/peer";
import {
  appendLocalEvent,
  createCircleDraft,
  deleteReplicaDatabase,
  eventRoot,
  getCircle,
  getCircleEvents,
  openReplicaDatabase,
  saveCircle,
  saveIdentity,
  type ReplicaDatabase,
} from "../src/storage";
import { createReunionChallenge } from "../src/reunion";
import { groupFor, identity, uniqueDatabaseName } from "./helpers";

class MemoryConnection implements TransportConnection {
  readonly peerId: string;
  readonly network: MemoryNetwork;
  open = true;
  partner: MemoryConnection | undefined;
  readonly dataHandlers: Array<(value: unknown) => void> = [];
  readonly closeHandlers: Array<() => void> = [];
  readonly errorHandlers: Array<(error: Error) => void> = [];

  constructor(peerId: string, network: MemoryNetwork) {
    this.peerId = peerId;
    this.network = network;
  }

  send(value: unknown): void {
    if (!this.open || !this.partner?.open) throw new Error("Memory connection closed");
    const copy = structuredClone(value);
    this.network.record(copy);
    if (this.network.shouldDrop(copy)) return;
    queueMicrotask(() => {
      for (const handler of this.partner?.dataHandlers ?? []) handler(copy);
    });
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    for (const handler of this.closeHandlers) handler();
  }

  onData(handler: (value: unknown) => void): void {
    this.dataHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }
}

class MemoryEndpoint implements TransportEndpoint {
  readonly id: string;
  readonly network: MemoryNetwork;
  connectionHandler: ((connection: TransportConnection) => void) | undefined;

  constructor(id: string, network: MemoryNetwork) {
    this.id = id;
    this.network = network;
  }

  async connect(peerId: string): Promise<TransportConnection> {
    const remote = this.network.endpoints.get(peerId);
    if (!remote?.connectionHandler) throw new Error("Memory peer unavailable");
    const localConnection = new MemoryConnection(peerId, this.network);
    const remoteConnection = new MemoryConnection(this.id, this.network);
    localConnection.partner = remoteConnection;
    remoteConnection.partner = localConnection;
    remote.connectionHandler(remoteConnection);
    return localConnection;
  }

  onConnection(handler: (connection: TransportConnection) => void): void {
    this.connectionHandler = handler;
  }

  destroy(): void {
    this.network.endpoints.delete(this.id);
  }
}

class MemoryNetwork implements PeerTransportFactory {
  readonly endpoints = new Map<string, MemoryEndpoint>();
  count = 0;
  readonly sentSecureKinds: string[] = [];
  dropPredicate: ((value: unknown) => boolean) | undefined;

  dropNext(predicate: (value: unknown) => boolean): void {
    this.dropPredicate = predicate;
  }

  shouldDrop(value: unknown): boolean {
    if (!this.dropPredicate?.(value)) return false;
    this.dropPredicate = undefined;
    return true;
  }

  record(value: unknown): void {
    const message = value as { type?: string; envelope?: { kind?: string } };
    if (message.type === "SECURE" && message.envelope?.kind) {
      this.sentSecureKinds.push(message.envelope.kind);
    }
  }

  async open(): Promise<TransportEndpoint> {
    this.count += 1;
    const endpoint = new MemoryEndpoint(`memory-peer-${this.count}`, this);
    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }
}

const databases: ReplicaDatabase[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) {
    const name = db.name;
    db.close();
    await deleteReplicaDatabase(name);
  }
});

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("injectable peer transport", () => {
  it("throws instead of reporting a secure send on a closed link", () => {
    const send = vi.fn();
    const closed = {
      peerId: "closed",
      open: false,
      send,
      close: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
    } satisfies TransportConnection;
    expect(() => sendRequired(closed, { secure: true }, "Secure PACK")).toThrow(/remains pending.*closed/u);
    expect(send).not.toHaveBeenCalled();
  });

  it("completes QR-secret/PIN enrollment and durable replica convergence over a fake transport", async () => {
    const network = new MemoryNetwork();
    const hostIdentity = await identity("Host");
    const joinerIdentity = await identity("Joiner", 1);
    const hostDb = await openReplicaDatabase(uniqueDatabaseName("transport-host"));
    const joinerDb = await openReplicaDatabase(uniqueDatabaseName("transport-joiner"));
    databases.push(hostDb, joinerDb);
    await Promise.all([saveIdentity(hostDb, hostIdentity), saveIdentity(joinerDb, joinerIdentity)]);
    const group = await createCircleDraft(
      hostDb,
      hostIdentity,
      "Memory Transport",
      "We accept only after the spoken code.",
    );

    let hostComplete = false;
    let joinerComplete = false;
    const errors: string[] = [];
    let resolveComplete: (() => void) | undefined;
    const complete = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });
    const checkComplete = (): void => {
      if (hostComplete && joinerComplete) resolveComplete?.();
    };

    let hostController: CircleLinkController;
    hostController = new CircleLinkController(
      hostDb,
      hostIdentity,
      {
        onComplete: () => {
          hostComplete = true;
          checkComplete();
        },
        onError: (message) => errors.push(message),
      },
      network,
    );
    const joinerController = new CircleLinkController(
      joinerDb,
      joinerIdentity,
      {
        onJoinerPin: (pin) => {
          void hostController.submitHostPin(pin);
        },
        onComplete: () => {
          joinerComplete = true;
          checkComplete();
        },
        onError: (message) => errors.push(message),
      },
      network,
    );

    const invite = await hostController.host(group, "first-breath");
    await joinerController.join(invite);
    await Promise.race([
      complete,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Fake transport timed out: ${errors.join("; ")}`)), 5_000),
      ),
    ]);

    const [hostGroup, joinerGroup, hostEvents, joinerEvents] = await Promise.all([
      getCircle(hostDb, group.id),
      getCircle(joinerDb, group.id),
      getCircleEvents(hostDb, group.id),
      getCircleEvents(joinerDb, group.id),
    ]);
    expect(errors).toEqual([]);
    expect(hostController.offer?.state).toBe("consumed");
    expect(hostGroup?.members[joinerIdentity.memberId]?.companion.name).toBe("Joiner");
    expect(joinerGroup?.members[joinerIdentity.memberId]?.companion.name).toBe("Joiner");
    expect(hostEvents.some((event) => event.body.type === "member.enrolled")).toBe(true);
    expect(await eventRoot(hostEvents)).toBe(await eventRoot(joinerEvents));

    hostController.dispose();
    joinerController.dispose();
  });

  it("resumes first breath after a dropped durable ACK, before and after host commit", async () => {
    const network = new MemoryNetwork();
    const hostIdentity = await identity("Host");
    const joinerIdentity = await identity("Joiner", 1);
    const hostDb = await openReplicaDatabase(uniqueDatabaseName("retry-host"));
    const joinerDb = await openReplicaDatabase(uniqueDatabaseName("retry-joiner"));
    databases.push(hostDb, joinerDb);
    await Promise.all([saveIdentity(hostDb, hostIdentity), saveIdentity(joinerDb, joinerIdentity)]);
    const draft = await createCircleDraft(hostDb, hostIdentity, "Retry Circle", "Durable means safely retryable.");

    network.dropNext(
      (value) =>
        (value as { type?: string; envelope?: { kind?: string } }).type === "SECURE" &&
        (value as { envelope?: { kind?: string } }).envelope?.kind === "DURABLE_ACK",
    );
    let firstJoinComplete = false;
    let firstHostComplete = false;
    let hostOne: CircleLinkController;
    hostOne = new CircleLinkController(
      hostDb,
      hostIdentity,
      {
        onJoinerPin: undefined,
        onComplete: () => {
          firstHostComplete = true;
        },
      },
      network,
    );
    const joinOne = new CircleLinkController(
      joinerDb,
      joinerIdentity,
      {
        onJoinerPin: (pin) => void hostOne.submitHostPin(pin),
        onComplete: () => {
          firstJoinComplete = true;
        },
      },
      network,
    );
    await joinOne.join(await hostOne.host(draft, "first-breath"));
    await waitUntil(() => firstJoinComplete, "joiner did not durably merge before ACK drop");
    expect(firstHostComplete).toBe(false);
    expect((await getCircle(hostDb, draft.id))?.members[joinerIdentity.memberId]).toBeUndefined();
    expect((await getCircle(joinerDb, draft.id))?.members[joinerIdentity.memberId]).toBeDefined();
    hostOne.dispose();
    joinOne.dispose();

    const runResume = async (): Promise<void> => {
      const current = await getCircle(hostDb, draft.id);
      if (!current) throw new Error("Host draft missing");
      let hostDone = false;
      let joinDone = false;
      let host: CircleLinkController;
      host = new CircleLinkController(
        hostDb,
        hostIdentity,
        { onComplete: () => { hostDone = true; } },
        network,
      );
      const joiner = new CircleLinkController(
        joinerDb,
        joinerIdentity,
        {
          onJoinerPin: (pin) => void host.submitHostPin(pin),
          onComplete: () => { joinDone = true; },
        },
        network,
      );
      await joiner.join(await host.host(current, "first-breath"));
      await waitUntil(() => hostDone && joinDone, "resumed first breath did not complete");
      await waitUntil(
        async () =>
          (await eventRoot(await getCircleEvents(hostDb, draft.id))) ===
          (await eventRoot(await getCircleEvents(joinerDb, draft.id))),
        "resumed replicas did not converge",
      );
      host.dispose();
      joiner.dispose();
    };

    await runResume();
    expect((await getCircle(hostDb, draft.id))?.members[joinerIdentity.memberId]).toBeDefined();
    const enrollmentCount = (await getCircleEvents(hostDb, draft.id)).filter(
      (event) => event.body.type === "member.enrolled",
    ).length;
    await runResume();
    expect(
      (await getCircleEvents(hostDb, draft.id)).filter((event) => event.body.type === "member.enrolled"),
    ).toHaveLength(enrollmentCount);
  });

  it("refuses a stale reunion challenge before opening signaling", async () => {
    const network = new MemoryNetwork();
    const hostIdentity = await identity("Host");
    const other = await identity("Other", 1);
    const hostDb = await openReplicaDatabase(uniqueDatabaseName("stale-reunion"));
    databases.push(hostDb);
    await saveIdentity(hostDb, hostIdentity);
    const group = await groupFor([hostIdentity, other]);
    await saveCircle(hostDb, group);
    const challenge = await createReunionChallenge(group, [], Date.now());
    await appendLocalEvent(hostDb, group.id, hostIdentity, "story.note", { text: "changed root" });
    const controller = new CircleLinkController(hostDb, hostIdentity, {}, network);
    await expect(controller.host(group, "reunion", challenge)).rejects.toThrow(/root changed/u);
    expect(network.count).toBe(0);
    controller.dispose();
  });

  it("pauses all anti-entropy messages during a reunion approval handshake", async () => {
    const network = new MemoryNetwork();
    const hostIdentity = await identity("Host");
    const signerIdentity = await identity("Signer", 1);
    const group = await groupFor([hostIdentity, signerIdentity]);
    const hostDb = await openReplicaDatabase(uniqueDatabaseName("reunion-host"));
    const signerDb = await openReplicaDatabase(uniqueDatabaseName("reunion-signer"));
    databases.push(hostDb, signerDb);
    await Promise.all([
      saveIdentity(hostDb, hostIdentity),
      saveIdentity(signerDb, signerIdentity),
      saveCircle(hostDb, group),
      saveCircle(signerDb, group),
    ]);
    const challenge = await createReunionChallenge(group, [], Date.now());
    let hostComplete = false;
    let signerComplete = false;
    let requestReady = false;
    let approvalReady = false;
    let host: CircleLinkController;
    host = new CircleLinkController(
      hostDb,
      hostIdentity,
      {
        onComplete: () => { hostComplete = true; },
        onReunionApproval: () => { approvalReady = true; },
      },
      network,
    );
    const signer = new CircleLinkController(
      signerDb,
      signerIdentity,
      {
        onJoinerPin: (pin) => void host.submitHostPin(pin),
        onComplete: () => { signerComplete = true; },
        onReunionRequest: () => { requestReady = true; },
      },
      network,
    );
    await signer.join(await host.host(group, "reunion", challenge));
    await waitUntil(
      () => hostComplete && signerComplete && requestReady,
      "reunion state acceptance did not complete",
    );
    await signer.approvePendingReunion();
    await waitUntil(() => approvalReady, "reunion approval did not arrive");
    expect(network.sentSecureKinds).toEqual(["STATE", "DURABLE_ACK", "REUNION_APPROVAL"]);
    host.dispose();
    signer.dispose();
  });

  it("expires host offers and tears down their endpoints", async () => {
    const network = new MemoryNetwork();
    const hostIdentity = await identity("Host");
    const hostDb = await openReplicaDatabase(uniqueDatabaseName("offer-expiry"));
    databases.push(hostDb);
    await saveIdentity(hostDb, hostIdentity);
    const group = await createCircleDraft(hostDb, hostIdentity, "Expiry Circle", "Offers close after five minutes.");
    const controller = new CircleLinkController(hostDb, hostIdentity, {}, network);
    await controller.host(group, "first-breath");
    const expiresAt = controller.offer?.invite.expiresAt;
    if (!expiresAt) throw new Error("Offer missing");
    await controller.expireHostOffer(expiresAt + 1);
    expect(controller.offer?.state).toBe("expired");
    expect(network.endpoints.size).toBe(0);
    controller.dispose();
  });
});
