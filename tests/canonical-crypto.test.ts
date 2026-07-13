import { describe, expect, it } from "vitest";
import {
  canonicalBytes,
  canonicalStringify,
  fromBase64Url,
  sha256,
  sha256Sync,
  toBase64Url,
} from "../src/canonical";
import {
  createSignedEvent,
  decryptEnvelope,
  decryptHeirpack,
  encryptEnvelope,
  encryptHeirpack,
  signValue,
  verifySignedEvent,
  verifyValue,
} from "../src/crypto";
import { MAX_REPLICA_BYTES } from "../src/limits";
import { parseWireMessage } from "../src/protocol";
import { groupFor, identity } from "./helpers";

describe("canonical signing and encryption", () => {
  it("canonicalizes keys recursively and preserves array order", () => {
    expect(canonicalStringify({ z: 1, a: { y: 2, x: [3, 1] } })).toBe(
      '{"a":{"x":[3,1],"y":2},"z":1}',
    );
  });

  it("rejects non-canonical values", () => {
    expect(() => canonicalBytes({ value: Number.NaN })).toThrow(/non-finite/u);
    expect(() => canonicalBytes({ value: undefined })).toThrow(/unsupported/u);
  });

  it("produces stable canonical hashes", async () => {
    await expect(sha256({ b: 2, a: 1 })).resolves.toBe(await sha256({ a: 1, b: 2 }));
    await expect(sha256({ b: 3, a: 1 })).resolves.not.toBe(await sha256({ a: 1, b: 2 }));
    expect(sha256Sync({ b: 2, a: 1 })).toBe(await sha256({ a: 1, b: 2 }));
    expect(sha256Sync(new Uint8Array())).toBe(await sha256(new Uint8Array()));
  });

  it("signs and verifies canonical values", async () => {
    const member = await identity("Fern");
    const signature = await signValue({ z: 2, a: "thread" }, member.privateJwk);
    await expect(verifyValue({ a: "thread", z: 2 }, signature, member.publicJwk)).resolves.toBe(true);
    await expect(verifyValue({ a: "changed", z: 2 }, signature, member.publicJwk)).resolves.toBe(false);
  });

  it("detects event body, ID, and signature tampering", async () => {
    const member = await identity("Fern");
    const other = await identity("Morrow", 1);
    const group = await groupFor([member, other]);
    const body = {
      version: 1 as const,
      groupId: group.id,
      memberId: member.memberId,
      seq: 1,
      prev: null,
      type: "story.note",
      createdAt: new Date().toISOString(),
      payload: { text: "a bounded note" },
    };
    const event = await createSignedEvent(body, member.privateJwk);
    await expect(verifySignedEvent(event, member.publicJwk)).resolves.toBe(true);
    await expect(
      verifySignedEvent(
        { ...event, body: { ...event.body, payload: { text: "tampered" } } },
        member.publicJwk,
      ),
    ).resolves.toBe(false);
    await expect(verifySignedEvent({ ...event, id: `${event.id}x` }, member.publicJwk)).resolves.toBe(false);
    await expect(verifySignedEvent(event, other.publicJwk)).resolves.toBe(false);
  });

  it("rejects private, credential, raw-audio, and precise-location event fields", async () => {
    const member = await identity("Fern");
    const other = await identity("Morrow", 1);
    const group = await groupFor([member, other]);
    for (const payload of [
      { privateKey: "no" },
      { nested: { apiKey: "no" } },
      { rawAudio: "no" },
      { latitude: 40.7, longitude: -74 },
    ]) {
      await expect(
        createSignedEvent(
          {
            version: 1,
            groupId: group.id,
            memberId: member.memberId,
            seq: 1,
            prev: null,
            type: "story.note",
            createdAt: new Date().toISOString(),
            payload,
          },
          member.privateJwk,
        ),
      ).rejects.toThrow(/forbidden on the wire/u);
    }
  });

  it("authenticates AES-GCM envelope kind, sequence, and ciphertext", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    const envelope = await encryptEnvelope(key, "client-to-host", 7, "PACK", { answer: 42 });
    await expect(
      decryptEnvelope<{ answer: number }>(key, "client-to-host", envelope),
    ).resolves.toEqual({ answer: 42 });
    await expect(
      decryptEnvelope(key, "client-to-host", { ...envelope, kind: "STATE" }),
    ).rejects.toThrow(/authentication/u);
    await expect(
      decryptEnvelope(key, "host-to-client", envelope),
    ).rejects.toThrow(/unsupported/u);
    const bytes = fromBase64Url(envelope.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await expect(
      decryptEnvelope(key, "client-to-host", { ...envelope, ciphertext: toBase64Url(bytes) }),
    ).rejects.toThrow(/authentication/u);
  });

  it("round-trips a canonical encrypted heirpack", async () => {
    const value = { format: "fixture", nested: { z: 2, a: 1 } };
    const envelope = await encryptHeirpack(value, "lantern phrase");
    await expect(decryptHeirpack(envelope, "lantern phrase")).resolves.toEqual(value);
  });

  it("refuses an oversized heirpack before encryption", async () => {
    await expect(
      encryptHeirpack({ padding: "x".repeat(MAX_REPLICA_BYTES) }, "lantern phrase"),
    ).rejects.toThrow(/512 KiB.*no file/u);
  });

  it("fits a maximum-sized replica plaintext inside the encrypted wire bound", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    const envelope = await encryptEnvelope(
      key,
      "client-to-host",
      0,
      "PACK",
      { padding: "x".repeat(MAX_REPLICA_BYTES - 64) },
    );
    expect(() => parseWireMessage({ type: "SECURE", envelope })).not.toThrow();
  });

  it("rejects a wrong heirpack phrase and changed ciphertext", async () => {
    const envelope = await encryptHeirpack({ safe: true }, "correct phrase");
    await expect(decryptHeirpack(envelope, "wrong phrase")).rejects.toThrow(/wrong/u);
    const changed = structuredClone(envelope);
    const bytes = fromBase64Url(changed.cipher.ciphertext);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
    changed.cipher.ciphertext = toBase64Url(bytes);
    await expect(decryptHeirpack(changed, "correct phrase")).rejects.toThrow(/wrong/u);
  });
});
