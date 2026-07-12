# Rapp Heir

Rapp Heir is a standalone, local-first mobile PWA in which nearby people found a Circle, then continue an asynchronous
Braid of short quests. Each device keeps one persistent companion and a full signed Circle replica. The Circle’s
organism becomes a voice-first Pocket Quest Master; remote offerings change its aura and another member’s next leg,
while only a quorum reunion certificate can change structural form.

## Play the MVP

1. Create the device’s companion. Its extractable P-256 private JWK is stored only in IndexedDB `rapp-heir` v1.
2. One person enters a Circle name/oath and makes a five-minute, single-use first-breath QR.
3. A nearby joiner scans or pastes it. The joiner reads the derived six-digit PIN aloud; the host enters it.
4. The host releases encrypted state only after that local PIN match. Enrollment becomes final after the joiner’s
   durable merge ACK. Repeat for other founders, review the manifest, then found the Circle.
5. Start a 5–10 minute quest by voice, type, or tap. Sign an offering and reconnect or exchange an encrypted
   `.heirpack`. One offering changes the previous lobe’s next prompt and the shared reveal.
6. At reunion, gather `max(2, ceil(active members / 2))` distinct enrolled-key approvals over fresh QR/PeerJS/PIN
   sessions. A valid seal visibly molts the organism.
7. One 2+ member shared quest/reveal plus one reunion seal unlocks a selected-only `.rapp-heir.json` artifact.

The welcome screen can verify and open a `.rapp-heir.json` on a clean device without creating a companion.

**Offline practice** creates a visibly labeled simulated second lobe so the whole progression is playable on one
device without opening PeerJS. Its on-device keys can complete the practice reunion and heirloom path, demonstrate
protocol behavior, and never claim another person was present.

Release one creates human companions only. The signed member schema is future-safe for optional Kited Twins, but
there is deliberately no Kited join UI. See [ROADMAP.md](ROADMAP.md).

## Development

Requirements: Node.js 20.19+ and a modern browser with Web Crypto, IndexedDB, Canvas, and WebRTC.

```bash
npm install
npm test
npm run typecheck
npm run build
npm run dev
```

Vite’s production base is `/rapp-heir/`. No runtime asset uses a CDN. The custom service worker caches the local shell,
hashed build assets after first fetch, icons, manifest, and bundled agent source. GitHub Pages deployment is defined in
`.github/workflows/pages.yml`.

An accepted MVP replica is bounded to **256 signed events and 512 KiB of canonical replica bytes**. Local append,
import, export, encrypted `.heirpack`, and secure-wire paths refuse atomically before crossing that bound. Rapp Heir
does not implement chunking in v1.

## Architecture

- `src/crypto.ts`: canonical ECDSA events, ECDH/HKDF/AES-GCM links, PIN derivation, encrypted packs.
- `src/storage.ts`: IndexedDB schema, atomic import, event-set union, duplicate/fork preservation.
- `src/protocol.ts`, `src/peer.ts`: expiring offers, transcript handshake, injectable transport, encrypted
  `HELLO/SUMMARY/WANT/PACK/ACK`.
- `src/quest.ts`, `src/commands.ts`: original offline quests, causal Braid legs, command grammar, optional local
  browser `LanguageModel`.
- `src/reunion.ts`, `src/heirloom.ts`: quorum certificates and portable selected-only artifacts.
- `src/organism.ts`: original Canvas body, lobe/ring rendering, reduced-motion behavior, text equivalent.
- `public/agents/`: four actual single-file, `BasicAgent`-compatible Python source files, indexed by
  `public/agents/manifest.json`. They are reference/bundled agents, not skills. Peer-supplied code is never executed.

Read [PROTOCOL.md](PROTOCOL.md), [SECURITY.md](SECURITY.md), and [PRIVACY.md](PRIVACY.md) before deployment.

## Honest limits

The explicitly configured public PeerJS cloud broker is signaling only, has no SLA, and PeerJS IDs are transport addresses rather than
identity. WebRTC may expose IP/network metadata; NAT or absent TURN paths can prevent connection. `.heirpack` transfer
is the supported fallback. The app ships no permanent TURN credentials or relay guarantee. QR/PIN ceremonies can be relayed. Signatures and certificates prove possession of enrolled
keys—not legal identity, truth of a contribution, or physical location.

Speech recognition and browser `LanguageModel` availability vary. Typed play and bundled quest templates remain the
authoritative offline path. This MVP has no relay server, account recovery, key rotation, multi-device identity, or
background sync when the PWA is closed.

## License

MIT. See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md), and the shipped
[production dependency licenses](public/THIRD_PARTY_LICENSES.txt).
