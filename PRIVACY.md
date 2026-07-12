# Privacy

Rapp Heir has no application account or analytics service. The complete working replica, signing identity, settings,
and queued actions live in this browser’s IndexedDB. Clearing site data can remove them permanently.

## Stored locally

- one human-default companion profile (including signed member kind and optional bounded specialization) and one
  ECDSA P-256 private signing JWK;
- joined Circle manifests, public member keys/companion profiles, signed events, and outbox states;
- temporary expiring offer records and imported heirloom artifacts;
- in explicitly labeled offline practice only, a simulated second private key.

## Shared only by an explicit ceremony or file action

- persistent public signing key, companion profile, Circle manifest, and signed bounded events;
- ephemeral public keys/nonces and QR-secret proofs;
- user-selected broad place class, weather band, companion trait, offering text/choice, and heirloom approval;
- encrypted replica files or selected-only public heirloom files.

Rapp Heir does not request contacts or exact GPS. It does not capture, store, or synchronize raw audio. Speech
recognition begins only on the visible push-to-talk control; where supported, the app requests local recognition.
Browser/platform speech services may have their own behavior and policy, so typed/tap controls always provide parity.
The optional browser-built-in `LanguageModel` path is clearly labeled experimental/local and is never required.

## Network metadata

Opening a peer ceremony contacts the explicitly configured public PeerJS signaling service. PeerJS and WebRTC infrastructure may process IP
addresses, timing, browser/network metadata, and offer/answer data. A direct peer may learn network addresses. Rapp
Heir provides no PeerJS SLA or guaranteed TURN relay. GitHub Pages serves static application files and may retain
ordinary web server logs under GitHub’s policies.

## Exports and deletion

`.heirpack` files contain the full public replica and are encrypted under the transfer phrase; they never contain the
local private signing key. `.rapp-heir.json` contains selected story contributions only, plus public proof/organism
data and hashes. Anyone holding an exported file can retain it independently.

Delete site data in browser settings to erase the local database. Delete exported files separately. There is no server
operator who can recover either data or keys. Offline practice does not contact PeerJS.
