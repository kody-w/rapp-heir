export type CircleStatus = "forming" | "founded" | "heirloom-ready";
export type MemberKind = "human" | "kited-twin";
export type DeliveryState =
  | "ready-not-sent"
  | "delivery-unknown"
  | "received-hash-checked"
  | "PIN-accepted"
  | "durably-merged";

export interface Companion {
  name: string;
  color: string;
  temperament: "bright" | "gentle" | "curious" | "steady" | "wild" | "wry";
  voiceSeed: string;
}

export interface LocalIdentity {
  key: "local";
  memberId: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  companion: Companion;
  kind: MemberKind;
  specialization?: string;
  createdAt: string;
}

export interface MemberProfile {
  memberId: string;
  publicJwk: JsonWebKey;
  companion: Companion;
  kind: MemberKind;
  specialization?: string;
  joinedAt: string;
  active: boolean;
}

export interface GenesisBody {
  organismId: string;
  founderIds: string[];
  founderSeedHashes: string[];
  radialBias: number;
  pulse: number;
  membrane: number;
  hue: number;
}

export interface CircleRecord {
  id: string;
  name: string;
  oath: string;
  status: CircleStatus;
  coordinatorId: string;
  createdAt: string;
  foundedAt?: string;
  members: Record<string, MemberProfile>;
  genesis?: GenesisBody;
  chapter: number;
  priorGenerationRoots: string[];
  demo?: boolean;
}

export interface EventBody {
  version: 1;
  groupId: string;
  memberId: string;
  seq: number;
  prev: string | null;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface SignedEvent {
  id: string;
  body: EventBody;
  signature: string;
}

export interface OutboxRecord {
  id: string;
  groupId: string;
  eventId: string;
  state: DeliveryState;
  updatedAt: string;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface ReplicaBundle {
  format: "rapp-heir-replica";
  version: 1;
  exportedAt: string;
  group: CircleRecord;
  events: SignedEvent[];
  root: string;
}

export interface HeirpackEnvelope {
  format: "rapp-heir-heirpack";
  version: 1;
  kdf: {
    name: "PBKDF2-SHA-256";
    iterations: number;
    salt: string;
  };
  cipher: {
    name: "AES-256-GCM";
    iv: string;
    ciphertext: string;
  };
  plaintextHash: string;
}

export interface OrganismState {
  organismId: string;
  memberCount: number;
  aura: number;
  motion: number;
  hue: number;
  rings: number;
  structuralMolts: number;
  offeringRoot: string;
  description: string;
}

export interface Quest {
  questId: string;
  title: string;
  premise: string;
  createdAt: string;
  contextClass: string;
  weatherBand: string;
  memberOrder: string[];
  roles: Record<string, QuestRole>;
}

export type QuestRole = "Scout" | "Dreamer" | "Skeptic" | "Keeper" | "Maker" | "Witness";

export interface QuestOffering {
  questId: string;
  memberId: string;
  text: string;
  choice: string;
  selectedTrait?: string;
  contextClass?: string;
  approvedForHeirloom: boolean;
}

export interface QuestLeg {
  questId: string;
  memberId: string;
  role: QuestRole;
  minutes: number;
  prompt: string;
  influencedBy: string[];
  influenceMark: string;
}

export interface ReunionChallenge {
  version: 1;
  groupId: string;
  chapter: number;
  nonce: string;
  eventRoot: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ReunionApproval {
  memberId: string;
  signature: string;
}

export interface ReunionCertificate {
  challenge: ReunionChallenge;
  approvals: ReunionApproval[];
  threshold: number;
}

export interface HeirloomBody {
  format: "rapp-heir";
  version: 1;
  mintedAt: string;
  group: Omit<CircleRecord, "demo">;
  genesis: GenesisBody;
  signedEvents: SignedEvent[];
  organism: OrganismState;
  priorGenerationRoots: string[];
  approvedStory: Array<{ memberId: string; text: string; choice: string }>;
  approvedReveals: string[];
  eventRoot: string;
}

export interface HeirloomArtifact extends HeirloomBody {
  packageHash: string;
}
