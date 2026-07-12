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
- Peer content is inert data. No received Python/JavaScript is evaluated. Bundled Python agents are source artifacts;
  the browser’s typed TypeScript reducer validates all commits.
- Exact GPS, contacts, raw audio, raw device/twin IDs, credentials, and API keys have no wire fields. Quest context is
  a broad user-selected class and weather band.
- Heirloom export includes only explicitly selected offering/reveal text and applies a forbidden-field scan.

## Platform and operational risks

The explicitly configured public PeerJS cloud broker is a third-party signaling dependency with no SLA. It can observe signaling metadata.
WebRTC peers and network intermediaries may observe IP/network metadata. NAT/firewall conditions and unavailable TURN
paths can prevent direct transfer. No permanent TURN credentials are shipped. Use encrypted `.heirpack` files as the
supported fallback.

Browser compromise, malicious extensions, same-origin XSS, physical access to an unlocked profile, backup extraction,
or IndexedDB deletion can expose or destroy local keys. This MVP has no passcode wrapping, hardware-bound key,
revocation, account recovery, key rotation, or multi-device identity migration. Export replica packs regularly; they
do not recover the private signing identity.

The host coordinates a temporary transport and is not the Circle owner. A malicious enrolled member can fork its own
sequence, submit untruthful inert text, withhold events, or refuse quorum. It cannot forge another enrolled signature
under the assumed security of Web Crypto.

## Reporting

Do not include real Circle packs, invite secrets, private keys, or personal story text in a public report. Open a
minimal GitHub security advisory for repository `kody-w/rapp-heir` after it exists.
