import {
  canonicalBytes,
  canonicalStringify,
  constantTimeEqual,
  fromBase64Url,
  fromUtf8,
  randomBytes,
  sha256,
  toBase64Url,
  utf8,
} from "./canonical";
import {
  MAX_REPLICA_BYTES,
  MAX_SECURE_PLAINTEXT_BYTES,
  MAX_SPECIALIZATION_LENGTH,
} from "./limits";
import type {
  Companion,
  EventBody,
  HeirpackEnvelope,
  LocalIdentity,
  MemberKind,
  SignedEvent,
} from "./types";

const EVENT_TYPES = new Set([
  "circle.founded",
  "member.enrolled",
  "quest.created",
  "quest.offering",
  "quest.rest",
  "quest.reveal",
  "reunion.draft",
  "reunion.seal",
  "heirloom.minted",
  "story.note",
]);

const FORBIDDEN_EVENT_FIELD =
  /^(?:private|privateKey|privateJwk|secret|password|credentials?|apiKey|accessToken|rawAudio|preciseLocation|latitude|longitude|contacts?|twinId)$/iu;

function rejectPrivateEventFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectPrivateEventFields);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EVENT_FIELD.test(key)) throw new Error(`Event field ${key} is forbidden on the wire`);
    rejectPrivateEventFields(child);
  }
}

export interface EphemeralKeys {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
}

export interface LinkSecrets {
  clientToHostKey: CryptoKey;
  hostToClientKey: CryptoKey;
  pin: string;
  transcriptHash: string;
}

export type LinkDirection = "client-to-host" | "host-to-client";

export interface EncryptedEnvelope {
  version: 1;
  direction: LinkDirection;
  sequence: number;
  kind: string;
  iv: string;
  ciphertext: string;
}

export async function generateIdentity(companion: Companion): Promise<LocalIdentity> {
  validateCompanion(companion);
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ]);
  return {
    key: "local",
    memberId: await memberIdFromPublicKey(publicJwk),
    publicJwk,
    privateJwk,
    companion: { ...companion },
    kind: "human",
    createdAt: new Date().toISOString(),
  };
}

export function validateCompanion(companion: Companion): void {
  if (!companion.name.trim() || companion.name.length > 40) throw new Error("Companion name must be 1–40 characters");
  if (!/^#[0-9A-Fa-f]{6}$/u.test(companion.color)) throw new Error("Companion color must be a hex color");
  if (!/^[\w -]{1,48}$/u.test(companion.voiceSeed)) throw new Error("Voice seed must be 1–48 simple characters");
}

export function normalizeMemberKind(value: unknown): MemberKind {
  if (value === undefined) return "human";
  if (value === "human" || value === "kited-twin") return value;
  throw new Error("Member kind must be human or kited-twin");
}

export function normalizeSpecialization(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_SPECIALIZATION_LENGTH ||
    value !== value.trim() ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new Error(`Member specialization must be 1–${MAX_SPECIALIZATION_LENGTH} printable characters`);
  }
  return value;
}

export async function memberIdFromPublicKey(publicJwk: JsonWebKey): Promise<string> {
  const publicOnly = { crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y };
  return `member_${(await sha256(publicOnly)).slice(0, 30)}`;
}

export async function fingerprintPublicKey(publicJwk: JsonWebKey): Promise<string> {
  return (await sha256({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x, y: publicJwk.y }))
    .slice(0, 20)
    .toUpperCase();
}

async function importSigningPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function importSigningPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

export async function signValue(value: unknown, privateJwk: JsonWebKey): Promise<string> {
  const key = await importSigningPrivate(privateJwk);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, canonicalBytes(value));
  return toBase64Url(signature);
}

export async function verifyValue(value: unknown, signature: string, publicJwk: JsonWebKey): Promise<boolean> {
  try {
    const key = await importSigningPublic(publicJwk);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64Url(signature),
      canonicalBytes(value),
    );
  } catch {
    return false;
  }
}

export async function createSignedEvent(body: EventBody, privateJwk: JsonWebKey): Promise<SignedEvent> {
  validateEventBody(body);
  const signature = await signValue(body, privateJwk);
  const id = await sha256({ body, signature });
  return { id, body, signature };
}

export async function verifySignedEvent(event: SignedEvent, publicJwk: JsonWebKey): Promise<boolean> {
  try {
    validateEventBody(event.body);
    if (event.id !== (await sha256({ body: event.body, signature: event.signature }))) return false;
    if (event.body.memberId !== (await memberIdFromPublicKey(publicJwk))) return false;
    return verifyValue(event.body, event.signature, publicJwk);
  } catch {
    return false;
  }
}

export function validateEventBody(body: EventBody): void {
  if (body.version !== 1) throw new Error("Unsupported event version");
  if (!/^circle_[A-Za-z0-9_-]{12,}$/u.test(body.groupId)) throw new Error("Invalid Circle ID");
  if (!/^member_[A-Za-z0-9_-]{20,}$/u.test(body.memberId)) throw new Error("Invalid member ID");
  if (!Number.isSafeInteger(body.seq) || body.seq < 1) throw new Error("Invalid member sequence");
  if (body.prev !== null && !/^[A-Za-z0-9_-]{20,}$/u.test(body.prev)) throw new Error("Invalid predecessor");
  if (!EVENT_TYPES.has(body.type)) throw new Error("Unknown event type");
  if (!Number.isFinite(Date.parse(body.createdAt))) throw new Error("Invalid event timestamp");
  const encoded = canonicalBytes(body.payload);
  if (encoded.byteLength > 16_384) throw new Error("Event payload exceeds 16 KiB");
  rejectPrivateEventFields(body.payload);
  if (body.type === "quest.offering") {
    const text = body.payload.text;
    if (typeof text !== "string" || text.length > 600) throw new Error("Offering text exceeds limit");
  }
}

export async function generateEphemeralKeys(): Promise<EphemeralKeys> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
  };
}

export async function qrProof(secret: string, value: unknown): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    fromBase64Url(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(await crypto.subtle.sign("HMAC", key, canonicalBytes(value)));
}

export async function verifyQrProof(secret: string, value: unknown, proof: string): Promise<boolean> {
  const expected = await qrProof(secret, value);
  return constantTimeEqual(expected, proof);
}

export async function deriveLinkSecrets(
  privateKey: CryptoKey,
  peerPublicJwk: JsonWebKey,
  transcript: unknown,
  qrSecret: string,
  clientNonce: string,
  hostNonce: string,
): Promise<LinkSecrets> {
  const peerKey = await crypto.subtle.importKey(
    "jwk",
    peerPublicJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, privateKey, 256);
  const salt = await crypto.subtle.digest(
    "SHA-256",
    canonicalBytes({ clientNonce, hostNonce, qrSecret }),
  );
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const transcriptHash = await sha256(transcript);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: canonicalBytes({ protocol: "rapp-heir-link-v1", transcriptHash }),
      },
      material,
      576,
    ),
  );
  const keys = await Promise.all(
    [bits.slice(0, 32), bits.slice(32, 64)].map((keyBytes) =>
      crypto.subtle.importKey(
        "raw",
        keyBytes,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      ),
    ),
  );
  const clientToHostKey = keys[0];
  const hostToClientKey = keys[1];
  if (!clientToHostKey || !hostToClientKey) throw new Error("Link key derivation failed");
  let pinNumber = 0;
  for (const byte of bits.slice(64)) pinNumber = ((pinNumber * 257) + byte) % 1_000_000;
  return {
    clientToHostKey,
    hostToClientKey,
    pin: pinNumber.toString().padStart(6, "0"),
    transcriptHash,
  };
}

export async function encryptEnvelope(
  key: CryptoKey,
  direction: LinkDirection,
  sequence: number,
  kind: string,
  value: unknown,
): Promise<EncryptedEnvelope> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid envelope sequence");
  if (!kind || kind.length > 64) throw new Error("Invalid envelope kind");
  const plaintext = canonicalBytes(value);
  if (plaintext.byteLength > MAX_SECURE_PLAINTEXT_BYTES) {
    throw new Error("Secure message exceeds the 560 KiB plaintext limit");
  }
  const iv = randomBytes(12);
  const additionalData = canonicalBytes({ version: 1, direction, sequence, kind });
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    plaintext,
  );
  return {
    version: 1,
    direction,
    sequence,
    kind,
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ciphertext),
  };
}

export async function decryptEnvelope<T>(
  key: CryptoKey,
  expectedDirection: LinkDirection,
  envelope: EncryptedEnvelope,
  maximumBytes = MAX_SECURE_PLAINTEXT_BYTES,
): Promise<T> {
  if (
    envelope.version !== 1 ||
    envelope.direction !== expectedDirection ||
    !Number.isSafeInteger(envelope.sequence) ||
    envelope.sequence < 0 ||
    !envelope.kind ||
    envelope.kind.length > 64 ||
    fromBase64Url(envelope.iv).byteLength !== 12 ||
    envelope.ciphertext.length > Math.ceil(((maximumBytes + 16) * 4) / 3) + 4
  ) {
    throw new Error("Rejected oversized or unsupported envelope");
  }
  const additionalData = canonicalBytes({
    version: envelope.version,
    direction: envelope.direction,
    sequence: envelope.sequence,
    kind: envelope.kind,
  });
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(envelope.iv),
        additionalData,
        tagLength: 128,
      },
      key,
      fromBase64Url(envelope.ciphertext),
    );
    if (plaintext.byteLength > maximumBytes) throw new Error("Decrypted message exceeds limit");
    return JSON.parse(fromUtf8(plaintext)) as T;
  } catch {
    throw new Error("Encrypted envelope failed authentication");
  }
}

const PACK_ITERATIONS = 210_000;

async function passphraseKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  usage: KeyUsage[],
): Promise<CryptoKey> {
  if (passphrase.length < 8 || passphrase.length > 256) throw new Error("Transfer phrase must be 8–256 characters");
  const source = await crypto.subtle.importKey("raw", utf8(passphrase.normalize("NFKC")), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PACK_ITERATIONS },
    source,
    { name: "AES-GCM", length: 256 },
    false,
    usage,
  );
}

export async function encryptHeirpack(value: unknown, passphrase: string): Promise<HeirpackEnvelope> {
  const plaintext = canonicalBytes(value);
  if (plaintext.byteLength > MAX_REPLICA_BYTES) {
    throw new Error("Replica exceeds the 512 KiB canonical limit; no file was created");
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await passphraseKey(passphrase, salt, ["encrypt"]);
  const additionalData = canonicalBytes({ format: "rapp-heir-heirpack", version: 1 });
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    plaintext,
  );
  return {
    format: "rapp-heir-heirpack",
    version: 1,
    kdf: {
      name: "PBKDF2-SHA-256",
      iterations: PACK_ITERATIONS,
      salt: toBase64Url(salt),
    },
    cipher: { name: "AES-256-GCM", iv: toBase64Url(iv), ciphertext: toBase64Url(ciphertext) },
    plaintextHash: await sha256(plaintext),
  };
}

export async function decryptHeirpack<T>(envelope: HeirpackEnvelope, passphrase: string): Promise<T> {
  if (
    envelope.format !== "rapp-heir-heirpack" ||
    envelope.version !== 1 ||
    envelope.kdf.name !== "PBKDF2-SHA-256" ||
    envelope.kdf.iterations !== PACK_ITERATIONS ||
    envelope.cipher.name !== "AES-256-GCM" ||
    envelope.cipher.ciphertext.length > Math.ceil(((MAX_REPLICA_BYTES + 16) * 4) / 3) + 4
  ) {
    throw new Error("Invalid heirpack envelope");
  }
  const key = await passphraseKey(passphrase, fromBase64Url(envelope.kdf.salt), ["decrypt"]);
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(envelope.cipher.iv),
        additionalData: canonicalBytes({ format: envelope.format, version: envelope.version }),
        tagLength: 128,
      },
      key,
      fromBase64Url(envelope.cipher.ciphertext),
    );
    if (plaintext.byteLength > MAX_REPLICA_BYTES) throw new Error("Replica exceeds the 512 KiB canonical limit");
    if ((await sha256(new Uint8Array(plaintext))) !== envelope.plaintextHash) throw new Error("Pack hash mismatch");
    return JSON.parse(fromUtf8(plaintext)) as T;
  } catch {
    throw new Error("Heirpack phrase or authentication is wrong");
  }
}

export function canonicalPreview(value: unknown): string {
  return canonicalStringify(value);
}
