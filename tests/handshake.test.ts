import { describe, expect, it } from "vitest";
import { randomBytes, toBase64Url } from "../src/canonical";
import {
  ClientHandshake,
  HostHandshake,
  OutstandingTransferLedger,
  createPackMessage,
  createBootstrapOffer,
  decodeInvite,
  encodeInviteCode,
  validateBootstrapInvite,
} from "../src/protocol";
import { eventRoot } from "../src/storage";
import type { ReplicaBundle } from "../src/types";
import { groupFor, identity, signedEvent } from "./helpers";

const NOW = 1_750_000_000_000;

async function handshakeFixture() {
  const host = await identity("Host");
  const joiner = await identity("Joiner", 1);
  const group = await groupFor([host], { status: "forming" });
  const record = await createBootstrapOffer(group, "peer-host-123", host.publicJwk, "first-breath", null, NOW);
  const client = await ClientHandshake.start(record.invite, joiner, NOW);
  const server = await HostHandshake.acceptHello(record, client.hello, host, NOW);
  const pin = await client.receiveServerHello(server.serverHello, NOW);
  return { host, joiner, group, record, client, server, pin };
}

describe("QR, ECDH, HKDF, and final PIN", () => {
  it("round-trips a bounded fragment invite", async () => {
    const host = await identity("Host");
    const group = await groupFor([host], { status: "forming" });
    const record = await createBootstrapOffer(group, "peer-host-123", host.publicJwk, "first-breath", null, NOW);
    const code = encodeInviteCode(record.invite);
    expect(decodeInvite(code, NOW)).toEqual(record.invite);
    expect(decodeInvite(`https://example.test/rapp-heir/#/join?invite=${code}`, NOW)).toEqual(record.invite);
  });

  it("rejects expired and overlong-lived offers", async () => {
    const host = await identity("Host");
    const group = await groupFor([host], { status: "forming" });
    const record = await createBootstrapOffer(group, "peer-host-123", host.publicJwk, "first-breath", null, NOW);
    expect(() => validateBootstrapInvite(record.invite, record.invite.expiresAt + 1)).toThrow(/expired/u);
    expect(() =>
      validateBootstrapInvite({ ...record.invite, expiresAt: record.invite.expiresAt + 1 }, NOW),
    ).toThrow(/invalid/u);
  });

  it("derives one shared PIN from both ephemeral ECDH sides", async () => {
    const { server, pin } = await handshakeFixture();
    expect(pin).toMatch(/^\d{6}$/u);
    expect(server.submitPin(pin, NOW)).toBe(true);
  });

  it("never includes the derived PIN in either hello", async () => {
    const { client, server, pin } = await handshakeFixture();
    expect(Object.hasOwn(client.hello, "pin")).toBe(false);
    expect(Object.hasOwn(server.serverHello, "pin")).toBe(false);
    expect(JSON.stringify({ client: client.hello, host: server.serverHello })).not.toContain(`"pin":"${pin}"`);
  });

  it("sends signed member kind in the authenticated client hello", async () => {
    const { client, joiner } = await handshakeFixture();
    expect(joiner.kind).toBe("human");
    expect(client.hello.kind).toBe("human");
    expect(client.transcript().client.kind).toBe("human");
  });

  it("authenticates bounded future kited-twin metadata without exposing a v1 UI path", async () => {
    const host = await identity("Host");
    const generated = await identity("Twin key", 1);
    const twin = {
      ...generated,
      kind: "kited-twin" as const,
      specialization: "weather-safe quest prompts",
    };
    const group = await groupFor([host], { status: "forming" });
    const record = await createBootstrapOffer(group, "peer-host-123", host.publicJwk, "first-breath", null, NOW);
    const client = await ClientHandshake.start(record.invite, twin, NOW);
    const server = await HostHandshake.acceptHello(record, client.hello, host, NOW);
    expect(server.joiningMember).toMatchObject({
      kind: "kited-twin",
      specialization: "weather-safe quest prompts",
    });
    await expect(
      ClientHandshake.start(
        record.invite,
        { ...twin, specialization: "x".repeat(121) },
        NOW,
      ),
    ).rejects.toThrow(/specialization/u);
  });

  it("releases no encrypted group state before a correct PIN", async () => {
    const { server, pin } = await handshakeFixture();
    await expect(server.encrypt("STATE", { roster: ["secret"] })).rejects.toThrow(/before final PIN/u);
    const wrong = pin === "000000" ? "111111" : "000000";
    expect(server.submitPin(wrong, NOW)).toBe(false);
    await expect(server.encrypt("STATE", { roster: ["secret"] })).rejects.toThrow(/before final PIN/u);
    expect(server.submitPin(pin, NOW)).toBe(true);
    await expect(server.encrypt("STATE", { roster: ["released"] })).resolves.toMatchObject({ kind: "STATE" });
  });

  it("locks after three wrong host entries", async () => {
    const { server, pin } = await handshakeFixture();
    const wrong = pin === "123456" ? "654321" : "123456";
    expect(server.submitPin(wrong, NOW)).toBe(false);
    expect(server.submitPin(wrong, NOW)).toBe(false);
    expect(server.submitPin(wrong, NOW)).toBe(false);
    expect(server.record.state).toBe("locked");
    expect(() => server.submitPin(pin, NOW)).toThrow(/consumed/u);
    await expect(server.encrypt("STATE", {})).rejects.toThrow(/before final PIN/u);
  });

  it("rejects the wrong QR secret, cross-group hello, and offer replay", async () => {
    const host = await identity("Host");
    const joiner = await identity("Joiner", 1);
    const group = await groupFor([host], { status: "forming" });
    const record = await createBootstrapOffer(group, "peer-host-123", host.publicJwk, "first-breath", null, NOW);
    const wrongInvite = { ...record.invite, secret: toBase64Url(randomBytes(32)) };
    const wrongClient = await ClientHandshake.start(wrongInvite, joiner, NOW);
    await expect(HostHandshake.acceptHello(record, wrongClient.hello, host, NOW)).rejects.toThrow(/authentication/u);

    const client = await ClientHandshake.start(record.invite, joiner, NOW);
    await expect(
      HostHandshake.acceptHello(
        record,
        { ...client.hello, groupId: "circle_cross_group_123456" },
        host,
        NOW,
      ),
    ).rejects.toThrow(/does not match/u);
    await HostHandshake.acceptHello(record, client.hello, host, NOW);
    await expect(HostHandshake.acceptHello(record, client.hello, host, NOW)).rejects.toThrow(/already in use/u);
  });

  it("authenticates encrypted envelopes and consumes only a matching durable ACK", async () => {
    const { client, server, pin } = await handshakeFixture();
    server.submitPin(pin, NOW);
    const envelope = await server.encrypt("STATE", { root: "root_accepted" });
    await expect(client.decrypt(envelope)).resolves.toEqual({ root: "root_accepted" });
    expect(() =>
      server.consumeAfterDurableAck(
        { transcriptHash: client.transcriptHash, root: "wrong" },
        "root_accepted",
      ),
    ).toThrow(/does not match/u);
    server.consumeAfterDurableAck(
      { transcriptHash: client.transcriptHash, root: "root_accepted" },
      "root_accepted",
    );
    expect(server.record.state).toBe("consumed");
  });

  it("rejects encrypted replay and tampering", async () => {
    const { client, server, pin } = await handshakeFixture();
    server.submitPin(pin, NOW);
    const envelope = await server.encrypt("STATE", { safe: true });
    await client.decrypt(envelope);
    await expect(client.decrypt(envelope)).rejects.toThrow(/replay/u);
    const next = await server.encrypt("PACK", { safe: true });
    await expect(client.decrypt({ ...next, kind: "STATE" })).rejects.toThrow(/authentication/u);
  });

  it("separates link directions so reflected ciphertext fails", async () => {
    const { client, server, pin } = await handshakeFixture();
    server.submitPin(pin, NOW);
    const clientMessage = await client.encrypt("HELLO", { side: "client" });
    await expect(client.decrypt(clientMessage)).rejects.toThrow(/unsupported|authentication/u);
    const hostMessage = await server.encrypt("STATE", { side: "host" });
    await expect(server.decrypt(hostMessage)).rejects.toThrow(/unsupported|authentication/u);
    await expect(server.decrypt(clientMessage)).resolves.toEqual({ side: "client" });
    await expect(client.decrypt(hostMessage)).resolves.toEqual({ side: "host" });
  });

  it("accepts ACKs only for the matching transfer and exact event-ID set", async () => {
    const member = await identity("Sender");
    const other = await identity("Receiver", 1);
    const group = await groupFor([member, other]);
    const events = [
      await signedEvent(group, member, "story.note", { text: "one" }),
      await signedEvent(group, other, "story.note", { text: "two" }),
    ];
    const bundle: ReplicaBundle = {
      format: "rapp-heir-replica",
      version: 1,
      exportedAt: new Date(NOW).toISOString(),
      group,
      events,
      root: await eventRoot(events),
    };
    const pack = createPackMessage(bundle, "transfer_exact_fixture_123");
    const ledger = new OutstandingTransferLedger();
    ledger.register(pack);
    const baseAck = {
      type: "ACK" as const,
      groupId: group.id,
      transferId: pack.transferId,
      root: bundle.root,
      receivedEventIds: [...pack.eventIds],
    };
    expect(() =>
      ledger.acknowledge({ ...baseAck, transferId: "transfer_wrong_fixture_123" }),
    ).toThrow(/outstanding transfer/u);
    expect(() =>
      ledger.acknowledge({ ...baseAck, receivedEventIds: pack.eventIds.slice(0, 1) }),
    ).toThrow(/exact event-ID set/u);
    expect(() =>
      ledger.acknowledge({ ...baseAck, receivedEventIds: [...pack.eventIds, "forged_event_identifier_123"] }),
    ).toThrow(/exact event-ID set/u);
    expect(ledger.size).toBe(1);
    expect(ledger.acknowledge(baseAck)).toEqual([...pack.eventIds].sort());
    expect(ledger.size).toBe(0);
  });
});
