# Rapp Heir

Rapp Heir is a standalone, local-first mobile PWA in which nearby people found a Circle, then continue an asynchronous
Braid of short quests. Each device keeps one persistent companion and a full signed Circle replica. On
`#/play/:circleId`, the Circle organism becomes an **Adaptive Orb** Pocket Quest Master: Orbit presents contextual
petals, Compass bounds choices/review, and Tunnel carries multi-step drafts. Remote offerings change its aura and
another member’s next leg, while only a quorum reunion certificate can change structural form.

## Play the MVP

1. Create the device’s companion. Its extractable P-256 private JWK is stored only in IndexedDB `rapp-heir` v1.
2. One person enters a Circle name/oath and makes a five-minute, single-use first-breath QR.
3. A nearby joiner scans or pastes it. The joiner reads the derived six-digit PIN aloud; the host enters it.
4. The host releases encrypted state only after that local PIN match. Enrollment becomes final after the joiner’s
   durable merge ACK. Repeat for other founders, review the manifest, then found the Circle.
5. Start a 5–10 minute quest by voice, type, touch, or keyboard. Every quest, offering, rest, reveal, or AI-derived
   action is first frozen as a proposal. A later, separate **Review & sign** control/turn rechecks the Circle root and
   authorization before signing once. Highlight, cancel, and undo never sign.
6. At reunion, gather `max(2, ceil(active members / 2))` distinct enrolled-key approvals over fresh QR/PeerJS/PIN
   sessions. A valid seal visibly molts the organism.
7. One 2+ member shared quest/reveal plus one reunion seal unlocks a selected-only `.rapp-heir.json` artifact.

The welcome screen can verify and open a `.rapp-heir.json` on a clean device without creating a companion.

**Offline practice** creates a visibly labeled simulated second lobe so the whole progression is playable on one
device without opening PeerJS. Its on-device keys can complete the practice reunion and heirloom path, demonstrate
protocol behavior, and never claim another person was present.

## Optional Copilot mind

Offline deterministic quest templates remain the complete default. A user may explicitly connect GitHub Copilot
through the existing vBrainstem-compatible RAPP auth worker. Device-code sign-in sends no Circle content. GitHub and
short-lived Copilot tokens stay only in JavaScript memory and explicit logout clears tokens, chat, proposals, and
speech without changing the local Circle identity.

Every remote turn first displays the exact ≤4 KiB projection and recipient chain
**RAPP auth worker → GitHub Copilot**. Only the current draft, bounded quest/local-leg fields, coarse organism bands,
and generic Circle counts are included. Approval sends those exact bytes. Copilot is an untrusted narrator/planner:
it has no signing, storage, PeerJS, reunion, key, event, or heirloom tool, and its output cannot commit itself.

AI replies use the RAPP Installer brainstem contract: one `|||VOICE|||` separates the full bounded display answer from
a short plain spoken version. Marker fragments and the voice tail are withheld while display text streams. The Orb
shows only the display answer; speech synthesis receives only the spoken version, which is also available in an
optional details caption. A missing or malformed separator leaves speech unavailable rather than reading the
formatted answer aloud. The voice tail is transient and never enters commands, chat history, proposals, signed
events, replica/PeerJS exchange, or heirlooms.

## Verified local RAPP agents

The Mind tunnel can run the built-in `QuestMaster` and optional `QuestSafety` as real Python in CPython through
Pyodide 0.26.4. The host creates `agent-cell.html` only on demand with an opaque-origin
`sandbox="allow-scripts"` iframe. That headless cell owns a Web Worker and communicates over one transferred private
`MessagePort`; it receives bounded JSON context but no DOM, storage, signing, PeerJS, Copilot, key, or other host
capability.

The cell fetches only the exact manifest at Rapp Heir commit
`dd583a19c86414f98ae6c2c6d482f409c55679a4`, verifies its full SHA-256
`ac249a9ddfddc9661d3f9093dc3b5149cb947bbba1556312d94f0fcd283bdc98`, resolves only allowlisted simple
`*_agent.py` children, and verifies each full source hash before `compile`/`exec` in a fresh namespace. It calls only
`AGENT.perform(**args)`. Output is inert bounded data: the app shows the exact output, parses typed quest fields, and
stages the normal pending proposal. A local user must still Review & sign.

First use requires the pinned jsDelivr Pyodide files and pinned `raw.githubusercontent.com` sources. The service
worker intentionally bypasses both origins. Normal browser HTTP caches may help later, but persistence, offline
reuse, and availability are not guaranteed. If either origin or Pyodide is unavailable, the UI says so and uses the
existing deterministic JavaScript quest generator instead. No peer/Kited-Twin source is ever executed.

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

Vite’s production base is `/rapp-heir/`. App code, styles, icons, and normal dependencies are local; only the
explicit on-demand verified Python path uses pinned Pyodide from jsDelivr and commit-pinned raw GitHub source. The
custom service worker caches `agent-cell.html`, the local shell, and every build-manifest JS/CSS asset, but bypasses
Pyodide, raw GitHub, auth, and Copilot requests. GitHub Pages deployment is defined in `.github/workflows/pages.yml`.

An accepted MVP replica is bounded to **256 signed events and 512 KiB of canonical replica bytes**. Local append,
import, export, encrypted `.heirpack`, and secure-wire paths refuse atomically before crossing that bound. Rapp Heir
does not implement chunking in v1.

## Architecture

- `src/crypto.ts`: canonical ECDSA events, ECDH/HKDF/AES-GCM links, PIN derivation, encrypted packs.
- `src/storage.ts`: IndexedDB schema, atomic import, event-set union, duplicate/fork preservation.
- `src/protocol.ts`, `src/peer.ts`: expiring offers, transcript handshake, injectable transport, encrypted
  `HELLO/SUMMARY/WANT/PACK/ACK`.
- `src/quest.ts`, `src/commands.ts`: original offline quests, causal Braid legs, and precedence-safe command grammar.
- `src/adaptive-orb.ts`, `src/pending-proposal.ts`: pure Orb state and frozen two-turn mutation authority.
- `src/agent-cell.ts`, `src/agent-proposals.ts`, `public/agent-cell.html`: private-port iframe/worker lifecycle,
  pinned Python verification, and bounded QuestMaster/QuestSafety output parsing.
- `src/intelligence.ts`: memory-only vBrainstem device login, bounded context preview, allowlisted Copilot
  SSE/proxy transport, marker-safe display/voice parsing, and abort/logout lifecycle.
- `src/orb-sensor.ts`: optional FaceDetector-only highlight assist; never an action executor.
- `src/reunion.ts`, `src/heirloom.ts`: quorum certificates and portable selected-only artifacts.
- `src/organism.ts`: original Canvas body, lobe/ring rendering, reduced-motion behavior, text equivalent.
- `public/agents/`: four actual single-file, `BasicAgent`-compatible Python source files matching the pinned commit.
  They are agents, not skills. Execution fetches and verifies the exact pinned raw bytes; peer-supplied code is never
  executed.

Read [PROTOCOL.md](PROTOCOL.md), [SECURITY.md](SECURITY.md), and [PRIVACY.md](PRIVACY.md) before deployment.

## Honest limits

The explicitly configured public PeerJS cloud broker is signaling only, has no SLA, and PeerJS IDs are transport addresses rather than
identity. WebRTC may expose IP/network metadata; NAT or absent TURN paths can prevent connection. `.heirpack` transfer
is the supported fallback. The app ships no permanent TURN credentials or relay guarantee. QR/PIN ceremonies can be relayed. Signatures and certificates prove possession of enrolled
keys—not legal identity, truth of a contribution, or physical location.

Browser/platform speech recognition and speech synthesis may use platform, browser, or vendor services, including
network services, even though Rapp Heir requests local recognition where supported. The optional local camera
assist requests video only and stores no pixels/vectors; without FaceDetector it stays disabled. Copilot
availability, entitlement, direct CORS, and the Cloudflare worker are not guaranteed. Typed play and bundled quest
templates remain authoritative offline. This MVP has no account recovery, key rotation, multi-device identity, or
background sync when the PWA is closed.

## License

MIT. See [LICENSE](LICENSE), [NOTICE.md](NOTICE.md), and the shipped
[production dependency licenses](public/THIRD_PARTY_LICENSES.txt).
