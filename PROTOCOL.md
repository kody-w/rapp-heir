# Rapp Heir Protocol v1

All encoded objects use recursively key-sorted canonical JSON and UTF-8. Hashes are SHA-256 base64url. Inputs are
bounded before processing: event payloads 16 KiB, 256 events and 512 KiB canonical bytes per accepted replica,
560 KiB secure plaintext, 768 KiB outer wire messages, 64 members, and 600 characters per offering. V1 has no
chunking; append, import, export, and encryption refuse atomically before a replica crosses its bound.

## Identity and event log

A device creates one extractable ECDSA P-256 signing pair and derives `memberId` from the canonical public point.
The private JWK remains in the local `identity` store. A Circle has a random stable `groupId` and a roster mapping each
member ID to one public key and one companion. Every signed member profile includes `kind: "human" | "kited-twin"`
and may include a printable specialization of at most 120 characters. Missing legacy kind normalizes to `human` only
where the signed/profile comparison remains unambiguous. Release one creates only human profiles.

An event body contains:

```text
version, groupId, memberId, seq, prev, type, createdAt, payload
```

The signature is ECDSA/SHA-256 over canonical body bytes. The event ID hashes `{body, signature}`. Sequence is local to
one member chain. Merge is event-set union: duplicate IDs are no-ops; same-sequence forks have distinct IDs and both
survive; arrival time never selects a winner. Imports validate the complete candidate set and root before one
IndexedDB transaction.

Stores in IndexedDB `rapp-heir` version 1 are `identity`, `groups`, `events`, `outbox`, and `settings`.

## Bootstrap invite

An invite is URL-fragment data and therefore is not sent in an HTTP request:

```text
v, protocol, groupId, offerId, mode, issuedAt, expiresAt,
hostPeerId, hostFingerprint, secret, chapterNonce
```

It expires after exactly five minutes and is single use. It includes only bounded bootstrap data: transport address,
host signing-key fingerprint, random 256-bit QR secret, and optional reunion challenge nonce. A saved invite file and
manual code encode the same secret and need the same care. While a Circle is still forming, a fresh first-breath offer
may safely resume the same enrolled key after a lost durable ACK. Matching key/profile state is idempotent whether the
host committed the provisional enrollment or not; conflicting metadata is rejected.

## Fresh connection handshake

Every join, reconnect, and reunion uses this handshake. A known PeerJS ID is never sufficient.

1. **Client hello:** the joiner generates an ephemeral ECDH P-256 pair and 192-bit nonce, then sends its persistent
   signing public key, companion, ephemeral public key, IDs, and `HMAC(QR secret, client hello core)`.
2. **Host hello:** after validating expiry, use, group, HMAC, and member-key derivation, the host generates another
   ephemeral ECDH pair/nonce. It returns its signing key, ephemeral key, bound client nonce, and
   `HMAC(QR secret, full transcript)`.
3. Both sides derive 256 ECDH bits, then HKDF-SHA-256 with a salt hashing QR secret and both nonces. HKDF info binds a
   SHA-256 hash of the invite (with secret hash), client hello, and host hello.
4. HKDF derives separate client→host and host→client AES-256-GCM keys. Remaining material deterministically forms a
   zero-padded six-digit SAS/PIN, preserving the transcript-derived ceremony.
5. **The PIN is never sent over PeerJS.** Only the joiner displays it and communicates it out-of-band. The host has an
   input, not a displayed expected value. Comparison is bounded/constant-work; three failures lock the offer.
6. Only after the host’s local PIN match may it send an AES-GCM `STATE` envelope. For first breath this contains a
   provisional, host-signed enrollment event. The joiner validates and atomically stores it, then returns an encrypted
   transcript/root durable ACK.
7. The host commits provisional enrollment and consumes the offer only after that ACK. Replays, expired offers,
   cross-Circle data, changed AAD/ciphertext, repeated encrypted sequence numbers, and mismatched roots fail closed.

AES-GCM uses a random 96-bit IV and canonical `{version, direction, sequence, kind}` AAD. The envelope repeats the
direction, each direction has its own key and monotonic sequence, and reflected ciphertext fails authentication.
PeerJS/WebRTC transport encryption is not treated as protocol identity.

## Anti-entropy

After PIN acceptance and durable initial state:

- `HELLO`: protocol, Circle, enrolled member.
- `SUMMARY`: full sorted event-ID set and root.
- `WANT`: IDs absent locally.
- `PACK`: a fresh transfer ID, its exact event-ID set, bounded signed events, and current Circle manifest.
- `ACK`: that same transfer ID, the exact durably received event-ID set, and full local root.

All five message classes are inside the established AES-GCM channel. A received pack is validated atomically. Outbox
labels intentionally distinguish `ready-not-sent`, `delivery-unknown`, `received-hash-checked`, `PIN-accepted`, and
`durably-merged`. A sender tracks outstanding transfers and marks events durable only after a matching transfer ID and
exact ID set; partial, forged, or wrong-transfer ACKs fail closed.

## File reconnection

`.heirpack` is canonical replica JSON, still bounded to 512 KiB plaintext, encrypted with AES-256-GCM. A user transfer phrase derives the key using
PBKDF2-SHA-256, a random 128-bit salt, and 210,000 iterations. Its envelope binds format/version as AAD and carries a
plaintext hash. The entire decrypted bundle is checked before merge. Private identity material is never included.

## Braid, reunion, and heirloom

Quest legs hash the ordered prior offering IDs/choices into an influence mark, duration, and prompt choice. Removing an
offering changes the next leg, reveal root, and organism aura. Ordinary remote events can change aura, motion, palette,
and history rings only.

A reunion challenge binds Circle, next chapter, random nonce, one frozen event root, issue time, and five-minute expiry.
A certificate needs distinct valid enrolled-key signatures at `max(2, ceil(active/2))`. Only a verified
`reunion.seal` increases structural molts. Anti-entropy is paused throughout the reunion handshake. Every signer must
already hold the exact challenge root; expiry or any root change invalidates all collected approvals and requires a
new challenge. Drafts and failed quorum do not.

An heirloom hashes a canonical selected-only body containing public genesis/roster, allowed signed events, organism
state, prior roots, approved offerings/reveals, and the full event root. It excludes all private keys, precise
location, raw audio, contacts, credentials, and unapproved offering text.
