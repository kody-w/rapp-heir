# Security and trust

## What cryptography establishes

- ECDSA P-256 event signatures establish possession of an enrolled private key at signing time.
- Ephemeral ECDH P-256 + HKDF-SHA-256 derives direction-separated AES-256-GCM keys for one accepted link transcript.
- The joiner-visible, host-entered six-digit SAS binds the QR offer, both persistent public keys, both ephemeral keys,
  both nonces, and the ECDH secret. It is not transmitted on that link.
- A reunion certificate establishes that the threshold of distinct enrolled keys signed one exact challenge.
- Canonical hashes detect changed signed events, encrypted packs, and heirloom packages.

These facts do **not** establish legal identity, age, authorship truth, exact location, human co-presence, or that a
QR/PIN was not relayed. The ceremony is a social check with a six-digit security margin.

## Threat handling

- Offers expire in five minutes, are single-use, bind one Circle/mode, and lock after three wrong PIN attempts.
- No roster or Circle state is sent before host PIN acceptance. First-breath enrollment is provisional until durable
  joiner ACK; a fresh offer for the same key/profile safely resumes a lost ACK while forming.
- Reconnects never trust remembered PeerJS IDs; every DataConnection repeats the full acceptance ceremony.
- AES-GCM AAD and envelope bind direction, sequence, and message kind. Reflection, changed ciphertext/AAD, and replayed
  sequence fail closed.
- Event signatures, member/key derivation, predecessor availability, event root, group, bounds, and canonical form are
  checked before atomic import.
- Accepted replicas stop at 256 events and 512 KiB canonical bytes. PACK ACKs bind one transfer ID and its exact event
  set; partial or forged acknowledgements never advance durable state.
- Reunion links pause anti-entropy. Root change or expiry invalidates collected approvals before another invite or seal.
- Set-union merge does not let arrival time erase forks.
- Peer content is inert data. No peer/Kited-Twin Python or JavaScript is evaluated. The optional built-in Python cell
  accepts only allowlisted names, fetches one commit-pinned raw manifest, verifies its full SHA-256 and the selected
  simple `*_agent.py` child’s full manifest hash, then runs only `AGENT.perform(**bounded_json)` in fresh Pyodide
  CPython state. Its opaque-origin `sandbox="allow-scripts"` iframe owns the worker and has only one private
  transferred MessagePort—no host DOM, storage, key, signing, PeerJS, Copilot, or navigation capability. Output is
  inert and must pass typed TypeScript parsing plus the ordinary proposal review/sign boundary.
- Exact GPS, contacts, raw audio, raw device/twin IDs, credentials, and API keys have no wire fields. Quest context is
  a broad user-selected class and weather band.
- Heirloom export includes only explicitly selected offering/reveal text and applies a forbidden-field scan.
- Adaptive Orb highlights are inert. Quest/offering/rest/reveal and AI-derived actions become memory-only proposals
  bound to Circle ID, event root, state digest, author turn, exact canonical payload, and expiry. Only a later exact
  confirmation reloads and validates that binding, sanitizes unchanged bytes, checks authorization, and signs once.
  Same-turn, stale, expired, unauthorized, changed, cancelled, undone, and duplicate confirmations create no event.
  All per-Circle mutations use a Web Lock where available and an in-process queue fallback. Proposal commit passes
  its expected event root into the IndexedDB transaction, which synchronously rechecks the root before adding the
  event; two tabs confirming one root cannot both succeed.
- Copilot receives a schema-built, user-previewed ≤4 KiB projection only. Endpoint hosts and GitHub verification URLs
  are HTTPS allowlisted. Assistant text/tool-like JSON never enters the command parser, and the intelligence service
  has no signing, storage, sync, PeerJS, reunion, seal, key, event, or heirloom capability.
- Copilot responses are untrusted bounded data. Voice is available only with exactly one `|||VOICE|||`; streaming withholds the
  marker, partial marker suffixes, and all later voice bytes from the display. Only display text can enter memory
  history or a separately reviewed proposal. Only the bounded voice field can reach speech synthesis or its optional
  caption. Missing, malformed, or multiple markers and malformed SSE/JSON disable speech without raw protocol
  fallback. Voice text has no event, replica, PeerJS, or heirloom path.
  A generation gate permits at most one completed current turn to speak; stop aborts the stream, cancels speech, and
  makes late completion stale.

## Platform and operational risks

The explicitly configured public PeerJS cloud broker is a third-party signaling dependency with no SLA. It can observe signaling metadata.
WebRTC peers and network intermediaries may observe IP/network metadata. NAT/firewall conditions and unavailable TURN
paths can prevent direct transfer. No permanent TURN credentials are shipped. Use encrypted `.heirpack` files as the
supported fallback.

Browser compromise, malicious extensions, same-origin XSS, physical access to an unlocked profile, backup extraction,
or IndexedDB deletion can expose or destroy local keys. This MVP has no passcode wrapping, hardware-bound key,
revocation, account recovery, key rotation, or multi-device identity migration. Export replica packs regularly; they
do not recover the private signing identity.

Optional Copilot adds the RAPP Cloudflare auth worker and GitHub Copilot as network trust boundaries. Tokens remain
memory-only, requests are `no-store`, logout aborts and clears auth/chat/proposals/speech, and the service worker
bypasses these origins. This does not prevent a compromised browser/extension from reading process memory. Copilot
output is untrusted prose, not proof or authority. Direct CORS, account entitlement, token exchange, and worker
availability can fail; offline templates remain available.

The verified Python path adds pinned jsDelivr Pyodide and commit-pinned `raw.githubusercontent.com` as first-run
network dependencies. CSP restricts the cell to those origins, and the service worker bypasses both. Browser HTTP
caching is outside the app’s authority and is not an offline guarantee. Hash, URL, redirect, MIME, schema, path,
status, size, timeout, and typed-result failures close the cell and preserve the deterministic JavaScript fallback.

Browser/platform speech recognition may send audio to its provider despite the requested local-processing hint.
Push-to-talk is never ambient and raw audio is not retained by the app. Optional camera assist uses video-only
FaceDetector, keeps no image/biometric record, can only highlight, and never confirms an action.
Browser/platform speech synthesis may use installed or provider-backed voices; only the bounded spoken field is
submitted, never the formatted display answer.

The host coordinates a temporary transport and is not the Circle owner. A malicious enrolled member can fork its own
sequence, submit untruthful inert text, withhold events, or refuse quorum. It cannot forge another enrolled signature
under the assumed security of Web Crypto.

## Reporting

Do not include real Circle packs, invite secrets, private keys, or personal story text in a public report. Open a
minimal GitHub security advisory for repository `kody-w/rapp-heir` after it exists.
