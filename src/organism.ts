import { fromBase64Url, sha256 } from "./canonical";
import { verifyReunionSealEvent } from "./reunion";
import type {
  CircleRecord,
  GenesisBody,
  MemberProfile,
  OrganismState,
  SignedEvent,
} from "./types";

function founderSeed(member: MemberProfile): Record<string, string | null> {
  return {
    memberId: member.memberId,
    kind: member.kind,
    specialization: member.specialization ?? null,
    color: member.companion.color.toLowerCase(),
    temperament: member.companion.temperament,
    voiceSeed: member.companion.voiceSeed,
  };
}

export async function deriveGenesis(founders: readonly MemberProfile[]): Promise<GenesisBody> {
  if (founders.length < 2) throw new Error("At least two companions must breathe together at genesis");
  const ordered = [...founders].sort((left, right) => left.memberId.localeCompare(right.memberId));
  const hashes = await Promise.all(ordered.map((member) => sha256(founderSeed(member))));
  const mixed = new Uint8Array(32);
  for (const hash of hashes) {
    const bytes = fromBase64Url(hash);
    for (let index = 0; index < mixed.length; index += 1) {
      mixed[index] = (mixed[index] ?? 0) ^ (bytes[index] ?? 0);
    }
  }
  const organismId = `organism_${(await sha256(
    ordered.map((member, index) => ({ memberId: member.memberId, seedHash: hashes[index] })),
  )).slice(0, 28)}`;
  return {
    organismId,
    founderIds: ordered.map((member) => member.memberId),
    founderSeedHashes: hashes,
    radialBias: 0.2 + (mixed[0] ?? 0) / 425,
    pulse: 0.35 + (mixed[1] ?? 0) / 510,
    membrane: 0.35 + (mixed[2] ?? 0) / 510,
    hue: Math.round(((mixed[3] ?? 0) / 255) * 360),
  };
}

export async function deriveOrganismState(
  group: CircleRecord,
  events: readonly SignedEvent[],
): Promise<OrganismState> {
  if (!group.genesis) throw new Error("Circle has no genesis body");
  const offerings = events
    .filter((event) => event.body.type === "quest.offering")
    .sort((left, right) => left.id.localeCompare(right.id));
  const offeringRoot = await sha256(
    offerings.map((event) => ({
      id: event.id,
      choice: event.body.payload.choice,
      trait: event.body.payload.selectedTrait ?? null,
    })),
  );
  const influence = fromBase64Url(offeringRoot);
  let structuralMolts = 0;
  let chapterView = { ...group, chapter: 0 };
  for (const seal of events
    .filter((event) => event.body.type === "reunion.seal")
    .sort((left, right) => Number(left.body.payload.chapter) - Number(right.body.payload.chapter))) {
    if (await verifyReunionSealEvent(chapterView, seal)) {
      structuralMolts += 1;
      chapterView = { ...chapterView, chapter: chapterView.chapter + 1 };
    }
  }
  const aura = Math.min(1, group.genesis.membrane + offerings.length * 0.035 + (influence[0] ?? 0) / 2048);
  const motion = Math.min(1, group.genesis.pulse + offerings.length * 0.025 + (influence[1] ?? 0) / 3072);
  const hue = Math.round((group.genesis.hue + (influence[2] ?? 0) / 3 + offerings.length * 7) % 360);
  const rings = Math.max(1, events.filter((event) => event.body.type === "quest.reveal").length + structuralMolts);
  return {
    organismId: group.genesis.organismId,
    memberCount: Object.values(group.members).filter((member) => member.active).length,
    aura,
    motion,
    hue,
    rings,
    structuralMolts,
    offeringRoot,
    description: `A ${structuralMolts > 0 ? `${structuralMolts}-molted` : "soft-bodied"} Circle organism with ${
      Object.keys(group.members).length
    } companion lobes, ${rings} memory ring${rings === 1 ? "" : "s"}, a ${Math.round(
      aura * 100,
    )}% aura, and motion shaped by ${offerings.length} remote offering${offerings.length === 1 ? "" : "s"}.`,
  };
}

export class OrganismRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #context: CanvasRenderingContext2D;
  #frame = 0;
  #animation = 0;
  #state: OrganismState | undefined;
  #reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    this.#context = context;
    this.resize();
    window.addEventListener("resize", this.resize);
  }

  readonly resize = (): void => {
    const bounds = this.#canvas.getBoundingClientRect();
    const scale = Math.min(devicePixelRatio || 1, 2);
    this.#canvas.width = Math.max(1, Math.round(bounds.width * scale));
    this.#canvas.height = Math.max(1, Math.round(bounds.height * scale));
    this.#context.setTransform(scale, 0, 0, scale, 0, 0);
    this.draw();
  };

  setState(state: OrganismState): void {
    this.#state = state;
    this.#frame = 0;
    cancelAnimationFrame(this.#animation);
    this.draw();
    if (!this.#reduced) this.#animation = requestAnimationFrame(this.tick);
  }

  readonly tick = (): void => {
    this.#frame += 1;
    this.draw();
    if (!this.#reduced && this.#state) this.#animation = requestAnimationFrame(this.tick);
  };

  draw(): void {
    const state = this.#state;
    if (!state) return;
    const width = this.#canvas.clientWidth;
    const height = this.#canvas.clientHeight;
    const context = this.#context;
    context.clearRect(0, 0, width, height);
    const x = width / 2;
    const y = height / 2;
    const base = Math.min(width, height) * 0.2;
    const breath = this.#reduced ? 1 : 1 + Math.sin(this.#frame * 0.018 * state.motion) * 0.035;
    const glow = context.createRadialGradient(x, y, base * 0.2, x, y, base * (2 + state.aura));
    glow.addColorStop(0, `hsla(${state.hue}, 85%, 70%, .62)`);
    glow.addColorStop(0.45, `hsla(${(state.hue + 55) % 360}, 70%, 45%, .2)`);
    glow.addColorStop(1, "transparent");
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
    context.save();
    context.translate(x, y);
    for (let ring = 0; ring < state.rings; ring += 1) {
      context.beginPath();
      context.arc(0, 0, base * (1.35 + ring * 0.18), 0, Math.PI * 2);
      context.strokeStyle = `hsla(${(state.hue + ring * 18) % 360}, 80%, 75%, ${0.3 / (ring + 1)})`;
      context.lineWidth = 1.5;
      context.stroke();
    }
    context.beginPath();
    const points = Math.max(8, state.memberCount * 4 + state.structuralMolts * 3);
    for (let point = 0; point <= points; point += 1) {
      const angle = (point / points) * Math.PI * 2;
      const moltRidge = 1 + Math.sin(angle * (3 + state.structuralMolts)) * state.structuralMolts * 0.035;
      const radius = base * breath * moltRidge * (1 + Math.sin(angle * state.memberCount) * 0.08);
      const px = Math.cos(angle) * radius;
      const py = Math.sin(angle) * radius;
      if (point === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.closePath();
    const body = context.createRadialGradient(-base * 0.25, -base * 0.35, 4, 0, 0, base * 1.2);
    body.addColorStop(0, `hsl(${(state.hue + 45) % 360} 90% 80%)`);
    body.addColorStop(1, `hsl(${state.hue} 62% 34%)`);
    context.fillStyle = body;
    context.shadowColor = `hsl(${state.hue} 80% 65%)`;
    context.shadowBlur = 24 * state.aura;
    context.fill();
    context.shadowBlur = 0;
    for (let lobe = 0; lobe < state.memberCount; lobe += 1) {
      const angle = (lobe / state.memberCount) * Math.PI * 2 - Math.PI / 2;
      const radius = base * 0.62;
      context.beginPath();
      context.arc(Math.cos(angle) * radius, Math.sin(angle) * radius, Math.max(7, base * 0.09), 0, Math.PI * 2);
      context.fillStyle = `hsl(${(state.hue + lobe * 43) % 360} 82% 76%)`;
      context.fill();
    }
    context.restore();
  }

  destroy(): void {
    cancelAnimationFrame(this.#animation);
    window.removeEventListener("resize", this.resize);
  }
}
