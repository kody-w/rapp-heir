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

## Adaptive Orb proposal boundary

`#/play/:circleId` uses pure Orbit/Compass/Tunnel controller state. Input precedence is:
`stop > cancel > undo > confirm pending > read-only > mutating proposal > petal selection > freeform AI`.
Assistant output never re-enters this parser. Touch and camera can only highlight; explicit Confirm, voice `confirm`,
or Enter activates reversible navigation or stages a mutation.

A mutation proposal is memory-only and contains Circle ID, current event root, state digest, originating user turn,
author member, canonical event type/payload, preview, creation time, and five-minute expiry. Staging never appends.
A later confirmation reloads the Circle/events, requires a later turn and unchanged root/digest, rechecks enrolled
authorization, reconstructs a sanitized payload byte-for-byte equal to the frozen canonical payload, and serializes
one signing call. Authorization/sanitation await points and the instant before commit recheck expiry and cancellation.
Once commit starts, UI reports non-cancelable signing rather than promising zero events. Every Circle mutation is
serialized by one per-Circle Web Lock where available plus an in-process queue fallback. Proposal append passes the
expected root into the IndexedDB transaction; the transaction rechecks that root before adding the event. Cancel/undo
before commit, same-turn confirmation, expiry, state change, failed authorization, changed sanitation, and
duplicate/concurrent confirmation append nothing. A successful commit consumes the proposal even if later UI work
fails. Existing signed history remains append-only.

## Verified built-in Python cell

`agent-cell.html` is loaded on demand only as an opaque-origin iframe with `sandbox="allow-scripts"`. It accepts one
initial transferred private `MessagePort`, ignores ordinary window messages afterward, and owns a blob Web Worker so
Python cannot block the host UI thread. The cell exposes one request shape:

```text
run-agent(requestId, allowlisted built-in agent name, bounded JSON args)
```

There is no arbitrary source, URL, eval, host callback, storage, DOM, signing, PeerJS, or network-capability API. The
worker pins Pyodide 0.26.4 and fetches only:

```text
https://raw.githubusercontent.com/kody-w/rapp-heir/
dd583a19c86414f98ae6c2c6d482f409c55679a4/public/agents/manifest.json
```

The exact manifest SHA-256 is
`ac249a9ddfddc9661d3f9093dc3b5149cb947bbba1556312d94f0fcd283bdc98`. Manifest redirects, URL drift, non-200 status,
wrong MIME/schema/hash, paths other than the fixed simple `*_agent.py` children, and responses over 16 KiB fail.
Selected source is limited to 64 KiB and must match its full manifest SHA-256 before compile/exec in a fresh namespace.
Only `AGENT.perform(**args)` is called. Args are at most 16 KiB and the typed
`{agent, manifestHash, sourceHash, output, metadata}` result is at most 32 KiB.

The host uses lifecycle generations, private request IDs, boot/run deadlines, AbortSignal, and stale-response
rejection. Timeout/abort/route cleanup tears down the host iframe; timeout/cancel/failure terminates and replaces the
cell worker. QuestMaster output is strictly parsed and may optionally be checked by QuestSafety, then becomes only a
normal memory PendingProposal. Peer/Kited-Twin code is never accepted. First run needs pinned raw GitHub and Pyodide
network access; browser cache is best-effort and the deterministic JavaScript quest fallback remains authoritative.

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

## Optional vBrainstem/Copilot transport

The fixed worker is `https://rapp-auth.kwildfeuer.workers.dev`:

- `POST /api/auth/device` with `{}` starts GitHub device authorization.
- `POST /api/auth/device/poll` with only `device_code` honors interval, `slow_down`, expiry, and denial.
- `GET /api/copilot/token` exchanges a memory-only GitHub bearer token.
- `POST /api/copilot/chat?endpoint=…` is the buffered/SSE fallback when direct GitHub Copilot CORS fails.

Generations plus AbortController reject stale login/chat callbacks. A GitHub token remains staged locally until its
Copilot exchange succeeds while the same login generation is active; cancel/denial/expiry/error clears staged and
auth values. Tokens/endpoints/chat are never persisted.
Temporary Copilot credentials refresh once on expiry/401. Verification URLs must be HTTPS `github.com/login/device`;
chat endpoints must be HTTPS on an exact GitHub Copilot allowlist. Requests are `no-store`, and the PWA service worker
does not intercept or cache them. `Cache-Control` is not added as a request header.
The client retains `cache: "no-store"`, omitted credentials, and no-referrer; response-cache policy at the remote
authentication worker is outside this repository and must be configured by that operator.

Each remote turn requires explicit approval of canonical JSON ≤4 KiB. Its only fields are the current ≤600-character
draft; bounded quest title/premise/broad context/weather/local role/minutes/safe local leg; coarse three-band aura and
motion, six-family hue, rings/molts/member count; and generic status/chapter/event counts. Identifiers, names/oath,
keys/signatures/hashes/roots/times, roster/order, invitation/PIN/PeerJS/Kited data, private keys, audio/location,
memories/history, unselected offerings/peer text, and heirloom/replica bytes have no projection field. The exact
preview string is the exact user-message string sent to the recipient chain
`RAPP auth worker → GitHub Copilot`.

Release chat uses `gpt-4o`, no tools, and at most a concise narrator/planner draft. SSE parsing supports fragmented
UTF-8, CRLF, multiline `data`, and `[DONE]`; JSON/plain buffered responses are accepted from the fallback. Exactly one
voice marker is required for speech. Malformed/multiple markers and protocol-looking malformed SSE/JSON are bounded
for display without raw protocol-to-speech fallback. Copilot
cannot append, sign, store, sync, seal, or approve an heirloom. A user may separately stage a bounded draft as an
unchecked offering proposal and later review/sign it through the normal gate.
