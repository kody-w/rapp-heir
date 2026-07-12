# Rapp Heir Roadmap

## Kited Twins as first-class Circle citizens

Kited Twins are optional future members, independent of a human account or companion. Release one remains
human-default and does not depend on a Twin; it creates only `kind: "human"` profiles and exposes no simulated Kited
join path.

A future Kited Twin will:

- own its specialized agent/twin signing key and stable member identity;
- follow the same fresh QR/PIN enrollment, one-lobe, event-signing, and quorum rules as every other member;
- carry a bounded, signed capability/specialization descriptor;
- exchange inert signed data only—Rapp Heir will never execute peer-supplied code;
- join at genesis like another founder, or use a reunion-certified post-genesis admission ceremony rather than an
  owner/admin shortcut; and
- remain optional, removable through future certified governance, and unable to impersonate a human.

The v1 schema reserves `kind: "human" | "kited-twin"` and optional bounded `specialization` so signed manifests and
portable artifacts can survive that future without ambiguous identity reinterpretation.
