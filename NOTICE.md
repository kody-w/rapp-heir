# Notices

Rapp Heir includes original interface copy, Canvas artwork, and quest material created for this repository.

Adaptive Orb interaction/state/lifecycle principles were adapted from:

- repository: `kody-w/rapp-moonshots`
- source path: `moonshots/003-impossible-interface-tournament`
- commit: `d00cca8f04e11530bfb2294b9ad7a4bc2596a8f1`
- license: MIT

Rapp Heir adapts the Orbit/Compass/Tunnel, center/cancel, explicit-confirmation, and multimodal-highlight principles.
It does not copy the finalist HTML/CSS or tournament task logic wholesale.

The AI display/text-to-speech response split was adapted from the RAPP Installer brainstem contract:

- repository: `kody-w/rapp-installer`
- commit: `5fbde1776a72715935c3d597a9ddfce28a04032b`
- path: `rapp_brainstem/brainstem.py` (voice prompt and split-once handling around lines 2292–2295 and 2352–2355)
- marker: `|||VOICE|||`

The opaque-origin verified Python cell follows the capability-isolation and verify-before-execute pattern used by
`kody-w/rapp-static-mcp` under `RAR/vbrainstem-cell`: a private transferred `MessagePort`, no ambient host
capabilities, commit-pinned raw source, and full SHA-256 verification before compilation. This implementation is
original for Rapp Heir and pins the built-in agent manifest and sources to:

- repository: `kody-w/rapp-heir`
- commit: `dd583a19c86414f98ae6c2c6d482f409c55679a4`
- manifest SHA-256: `ac249a9ddfddc9661d3f9093dc3b5149cb947bbba1556312d94f0fcd283bdc98`
- runtime: Pyodide `0.26.4` (Mozilla Public License 2.0; bundled/downloaded components retain their upstream terms)

Runtime dependencies are distributed under their respective licenses:

- PeerJS (`peerjs`) — MIT
- IndexedDB Promised (`idb`) — ISC
- QRCode (`qrcode`) — MIT
- ZXing browser layer (`@zxing/browser`) — MIT / Apache-2.0 components as documented upstream
- Vite, TypeScript, Vitest, and fake-indexeddb are development dependencies under their upstream licenses.

The app explicitly configures the public PeerJS cloud broker for signaling. That service is not operated by this
application and has no promised availability.

Apple, iOS, and related marks belong to Apple Inc. “Apple-like” in product requirements describes a final
human-verified acceptance pattern; this project is not affiliated with or endorsed by Apple.

Exact production versions, license texts, and available notices are generated from the lockfile and shipped at
`public/THIRD_PARTY_LICENSES.txt` (and as `dist/THIRD_PARTY_LICENSES.txt` in a production build).
