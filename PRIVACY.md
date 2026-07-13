# Privacy

Rapp Heir has no application account or analytics service. The complete working replica, signing identity, settings,
and queued actions live in this browser’s IndexedDB. Clearing site data can remove them permanently. Optional GitHub
device authorization connects Copilot but does not create a Rapp Heir account.

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
Browser/platform SpeechRecognition and SpeechSynthesis may use platform, browser, or vendor services (including
network services) under their own policies, so typed/tap controls always provide parity.
Offline deterministic quest templates require no language model or network.

The optional camera highlight assist is explicit, requests **video only**, and uses `FaceDetector` locally. It stores,
logs, networks, AI-sends, and exports no pixels, face vectors, direction history, or raw camera output. It stops all
tracks on disable, route exit, scanner start, blur, hidden state, or page hide. If FaceDetector is unavailable, no
whole-frame motion fallback runs.

## Verified local Python exception

On explicit use, the opaque sandboxed agent cell downloads Pyodide 0.26.4 from pinned jsDelivr paths and the exact
agent manifest/source bytes from commit `dd583a19c86414f98ae6c2c6d482f409c55679a4` on
`raw.githubusercontent.com`. The service worker does not intercept or cache either origin. Ordinary network metadata
is subject to those providers’ policies, and browser HTTP cache retention is neither controlled nor promised by
Rapp Heir.

The host passes only bounded coarse quest inputs (context/weather, active count, companion temperament labels, and an
empty history summary) over a private MessagePort. It passes no IDs, names, peer contribution text, raw location,
audio, storage, credentials, keys, signing function, PeerJS object, Copilot token, DOM, or arbitrary source/URL.
Only full-hash-verified built-in source runs. Exact bounded output is shown as inert data and cannot mutate IndexedDB
until a user separately stages, reviews, and signs a typed proposal. If the network/runtime is unavailable, the
existing deterministic JavaScript fallback stays local.

## Optional remote intelligence exception

Copilot is the one explicit content-processing exception to local-first play. Sign-in calls
`https://rapp-auth.kwildfeuer.workers.dev` for a GitHub device code, polling, and Copilot token exchange; sign-in sends
zero Circle content. GitHub access tokens, short-lived Copilot tokens/endpoints, chat, generated voice text, and
proposals are memory-only: they are never written to localStorage, sessionStorage, IndexedDB, URLs, Cache Storage,
DOM attributes, or logs.

Before each remote turn, the app shows the exact ≤4 KiB payload and recipient chain
**RAPP auth worker → GitHub Copilot**. It can contain only the current ≤600-character user draft; quest
title/premise/broad context/weather/local role/minutes/safe local leg; coarse aura/motion/hue, rings/molts/member
count; and generic Circle status/chapter/counts. It excludes Circle/member IDs, names/oath, keys, signatures, hashes,
roots, timestamps, roster/order, invite/PIN/PeerJS/Kited fields, private keys, audio, location, memories, full history,
unselected offerings, peer text, and heirloom/replica bytes.

Copilot is instructed to return exactly one `|||VOICE|||` separator between a bounded display answer and a short plain spoken
version. Partial separators and the voice tail are withheld from the streaming display. Only the display answer may
be kept in memory chat history or explicitly staged for review; only the spoken version is passed to speech
synthesis and shown in an optional details caption. Missing, malformed, multiple, or raw SSE/JSON separation produces an honest unavailable
caption and no speech. The voice tail is not stored, signed, synchronized over PeerJS, or exported in replica packs
or heirlooms. Stop, route exit, and logout abort pending remote work and cancel speech.

## Network metadata

Opening a peer ceremony contacts the explicitly configured public PeerJS signaling service. PeerJS and WebRTC infrastructure may process IP
addresses, timing, browser/network metadata, and offer/answer data. A direct peer may learn network addresses. Rapp
Heir provides no PeerJS SLA or guaranteed TURN relay. GitHub Pages serves static application files and may retain
ordinary web server logs under GitHub’s policies.

When a user approves a remote turn, the Cloudflare worker and GitHub Copilot may process request content and ordinary
network metadata under their policies. The app tries an allowlisted HTTPS GitHub Copilot endpoint directly and uses
the RAPP worker proxy only when browser CORS prevents that path. Auth/chat requests use `no-store`, and the service
worker bypasses all auth/Copilot endpoints.

Speech synthesis is invoked through the browser only after a complete valid spoken version arrives. Installed
browser/platform voices may have their own processing behavior and policy; Rapp Heir does not send the spoken
version to any additional application server.

## Exports and deletion

`.heirpack` files contain the full public replica and are encrypted under the transfer phrase; they never contain the
local private signing key. `.rapp-heir.json` contains selected story contributions only, plus public proof/organism
data and hashes. Anyone holding an exported file can retain it independently.

Delete site data in browser settings to erase the local database. Delete exported files separately. There is no server
operator who can recover either data or keys. Offline practice does not contact PeerJS.
