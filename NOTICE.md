# Notices

Rapp Heir includes original interface copy, Canvas artwork, and quest material created for this repository.

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
