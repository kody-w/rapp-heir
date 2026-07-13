import QRCode from "qrcode";
import {
  adaptiveOrbReducer,
  createAdaptiveOrbState,
  highlightedPetal,
  orbShortcutSurfaceOwnsFocus,
  shouldIgnoreOrbShortcut,
  withOrbContext,
  type AdaptiveOrbState,
  type OrbActionId,
  type OrbActivation,
} from "./adaptive-orb";
import {
  AgentCellClient,
  PINNED_AGENT_MANIFEST_HASH,
  PYODIDE_VERSION,
  type AgentCellResult,
} from "./agent-cell";
import {
  parseQuestMasterOutput,
  parseQuestSafetyOutput,
  questSafetyCandidate,
  type QuestMasterProposal,
  type QuestSafetyDecision,
} from "./agent-proposals";
import { canonicalStringify, boundedJsonParse } from "./canonical";
import {
  createOfflineDemo,
  appendDemoEventExpectedRoot,
  finalizeCircle,
  getDemoIdentity,
} from "./circle";
import { parseOrbInput, VoicePocketGM, type PocketCommand } from "./commands";
import { decryptHeirpack, encryptHeirpack, generateIdentity } from "./crypto";
import { heirloomEligibility, importVerifiedHeirloom, mintHeirloom, verifyHeirloom } from "./heirloom";
import {
  AiVoicePlaybackGate,
  approveRemoteContext,
  buildRemoteContextPreview,
  IntelligenceService,
  REMOTE_RECIPIENT_CHAIN,
  safeLocalLegForProjection,
  type DeviceCodeView,
  type RemoteContextPreview,
} from "./intelligence";
import { OrganismRenderer, deriveOrganismState } from "./organism";
import { CameraAssist } from "./orb-sensor";
import {
  PendingProposalGate,
  stagePendingProposal,
  stateDigestForProposal,
  type PendingProposal,
  type ProposalBinding,
  type ProposalOrigin,
} from "./pending-proposal";
import { CircleLinkController } from "./peer";
import { decodeInvite, encodeInviteCode, inviteLink, type BootstrapInvite, type OfferMode } from "./protocol";
import {
  createQuest,
  assertMemberCanOffer,
  deriveQuestLeg,
  deriveSharedReveal,
  latestQuest,
  offeringPayload,
  QUEST_ROLES,
  questPayload,
  sanitizeOffering,
} from "./quest";
import {
  approveReunion,
  createReunionChallenge,
  prepareOfflinePracticeReunion,
  reunionChallengeIsCurrent,
  reunionDraftPayload,
  reunionSealPayload,
  reunionThreshold,
} from "./reunion";
import { InviteScanner } from "./scanner";
import {
  appendLocalEvent,
  appendLocalEventExpectedRoot,
  appendLocalEventWithGroupUpdate,
  canonicalGroupDigest,
  createCircleDraft,
  eventRoot,
  getCircle,
  getCircleEvents,
  getSetting,
  listCircles,
  loadIdentity,
  makeReplicaBundle,
  mergeReplicaBundle,
  openReplicaDatabase,
  saveIdentity,
  storagePersistenceState,
  type ReplicaDatabase,
} from "./storage";
import type {
  CircleRecord,
  HeirloomArtifact,
  LocalIdentity,
  Quest,
  ReunionApproval,
  ReunionCertificate,
  ReunionChallenge,
} from "./types";

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function routeParts(): { path: string; query: URLSearchParams } {
  const fragment = location.hash.slice(1) || "/";
  const [path = "/", query = ""] = fragment.split("?", 2);
  return { path, query: new URLSearchParams(query) };
}

function downloadFile(name: string, contents: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function shortId(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function fieldValue(form: HTMLFormElement, name: string): string {
  return String(new FormData(form).get(name) ?? "");
}

function currentForm(event: Event): HTMLFormElement {
  if (!(event.currentTarget instanceof HTMLFormElement)) throw new Error("Expected a form event");
  return event.currentTarget;
}

type OrbUserSource = "typed" | "voice" | "touch" | "keyboard";

interface VerifiedAgentPreview {
  proposal: QuestMasterProposal;
  exactOutput: string;
  questMaster?: AgentCellResult;
  questSafety?: AgentCellResult;
  safety?: QuestSafetyDecision;
  safetyOutput?: string;
  fallbackReason?: string;
}

export class RappHeirApp {
  readonly #root: HTMLElement;
  #database: ReplicaDatabase | undefined;
  #identity: LocalIdentity | undefined;
  #status = "Local shell ready.";
  #alert = "";
  #voiceOutput = "";
  #voice: VoicePocketGM;
  #orbState: AdaptiveOrbState = createAdaptiveOrbState();
  #proposalGate = new PendingProposalGate();
  #userTurn = 0;
  #intelligence = new IntelligenceService();
  #deviceCode: DeviceCodeView | undefined;
  #loginUiGeneration = 0;
  #aiPreview: RemoteContextPreview | undefined;
  #aiDraft = "";
  #aiVoice = "";
  #aiStreaming = false;
  #aiRequestSent = false;
  #aiUiGeneration = 0;
  #aiVoicePlayback = new AiVoicePlaybackGate();
  #agentCell: AgentCellClient | undefined;
  #agentPreview: VerifiedAgentPreview | undefined;
  #agentRunning = false;
  #agentUiGeneration = 0;
  #agentAbort: AbortController | undefined;
  #cameraAssist: CameraAssist | undefined;
  #cameraEnableGeneration = 0;
  #cameraEnableQueue: Promise<void> = Promise.resolve();
  #orbShortcutMode = false;
  #scanner = new InviteScanner();
  #link: CircleLinkController | undefined;
  #invite: BootstrapInvite | undefined;
  #joinPin = "";
  #pendingHost:
    | { memberId: string; companionName: string; attemptsLeft: number }
    | undefined;
  #pendingReunion: ReunionChallenge | undefined;
  #reunionChallenge: ReunionChallenge | undefined;
  #reunionApprovals: ReunionApproval[] = [];
  #organismRenderer: OrganismRenderer | undefined;
  #renderNumber = 0;
  #routeGeneration = 0;
  #lastRoutePath = "";
  #focusAfterRender = "";
  #talkCleanup: (() => void) | undefined;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#voice = new VoicePocketGM(
      (transcript) => void this.#handleOrbInput(transcript, "voice"),
      (status) => this.#setStatus(status),
    );
  }

  async start(): Promise<void> {
    this.#database = await openReplicaDatabase();
    this.#identity = await loadIdentity(this.#database);
    window.addEventListener("hashchange", () => {
      const nextPath = routeParts().path;
      if (nextPath !== this.#lastRoutePath) this.#disposeRouteState();
      void this.render();
    });
    document.querySelector<HTMLAnchorElement>(".skip-link")?.addEventListener("click", (event) => {
      event.preventDefault();
      document.querySelector<HTMLElement>("main")?.focus();
    });
    if (!location.hash) location.hash = this.#identity ? "#/circles" : "#/welcome";
    if (
      !this.#identity &&
      routeParts().path !== "/welcome" &&
      !routeParts().path.startsWith("/artifact/")
    ) {
      sessionStorage.setItem("pending-route", location.hash);
      location.hash = "#/welcome";
    }
    await this.render();
  }

  #setStatus(message: string): void {
    this.#status = message;
    const region = document.querySelector<HTMLElement>("#live-status");
    if (region) region.textContent = message;
  }

  #setAlert(message: string): void {
    this.#alert = message;
    const region = document.querySelector<HTMLElement>("#alert-status");
    if (region) region.textContent = message;
    this.#setStatus(message);
  }

  #clearLinkState(): void {
    this.#link?.dispose();
    this.#link = undefined;
    this.#invite = undefined;
    this.#joinPin = "";
    this.#pendingHost = undefined;
    this.#pendingReunion = undefined;
  }

  #clearAiState(): { requestMayHaveBeenSent: boolean } {
    const requestMayHaveBeenSent = this.#aiRequestSent;
    this.#aiUiGeneration += 1;
    this.#intelligence.abortChat();
    this.#voice.stopSpeaking();
    this.#aiPreview = undefined;
    this.#aiDraft = "";
    this.#aiVoice = "";
    this.#aiStreaming = false;
    this.#aiRequestSent = false;
    return { requestMayHaveBeenSent };
  }

  #clearAgentState(teardown = true): void {
    this.#agentUiGeneration += 1;
    this.#agentAbort?.abort();
    this.#agentAbort = undefined;
    this.#agentRunning = false;
    this.#agentPreview = undefined;
    if (teardown) {
      this.#agentCell?.teardown();
      this.#agentCell = undefined;
    }
  }

  #invalidateCamera(): void {
    this.#cameraEnableGeneration += 1;
    this.#cameraAssist?.disable();
    const video = document.querySelector<HTMLVideoElement>("#orb-camera-preview");
    if (video) video.hidden = true;
  }

  #playReservationIsCurrent(groupId: string, routeGeneration: number): boolean {
    return (
      routeGeneration === this.#routeGeneration &&
      routeParts().path === `/play/${groupId}`
    );
  }

  #disposeRouteState(): void {
    this.#routeGeneration += 1;
    this.#scanner.stop();
    this.#voice.stopAll();
    this.#voiceOutput = "";
    this.#talkCleanup?.();
    this.#talkCleanup = undefined;
    this.#invalidateCamera();
    this.#intelligence.cancelDeviceLogin();
    this.#loginUiGeneration += 1;
    this.#deviceCode = undefined;
    this.#clearAiState();
    this.#clearAgentState();
    this.#proposalGate.cancel();
    this.#orbShortcutMode = false;
    this.#orbState = createAdaptiveOrbState({ signedIn: this.#intelligence.authenticated });
    this.#clearLinkState();
    if (this.#lastRoutePath.startsWith("/reunion/")) {
      this.#reunionChallenge = undefined;
      this.#reunionApprovals = [];
    }
  }

  #navigate(path: string): void {
    location.hash = `#${path}`;
  }

  async render(): Promise<void> {
    const renderNumber = ++this.#renderNumber;
    const route = routeParts();
    const routeChanged = route.path !== this.#lastRoutePath;
    const previousFocusId = routeChanged ? "" : (document.activeElement as HTMLElement | null)?.id ?? "";
    this.#talkCleanup?.();
    this.#talkCleanup = undefined;
    this.#invalidateCamera();
    this.#organismRenderer?.destroy();
    this.#organismRenderer = undefined;
    let content = "";
    if (route.path.startsWith("/artifact/")) {
      content = await this.#artifactScreen(route.path.slice("/artifact/".length));
    } else if (!this.#identity || route.path === "/welcome") {
      content = this.#welcomeScreen();
    } else if (route.path === "/circles" || route.path === "/") {
      content = await this.#circlesScreen();
    } else if (route.path === "/join") {
      content = this.#joinScreen(route.query.get("invite") ?? "");
    } else if (route.path.startsWith("/circle/")) {
      const groupId = route.path.slice("/circle/".length);
      content = await this.#circleScreen(groupId);
    } else if (route.path.startsWith("/play/")) {
      content = await this.#playScreen(route.path.slice("/play/".length));
    } else if (route.path.startsWith("/reunion/")) {
      content = await this.#reunionScreen(route.path.slice("/reunion/".length));
    } else if (route.path.startsWith("/heirloom/")) {
      content = await this.#heirloomScreen(route.path.slice("/heirloom/".length));
    } else if (route.path.startsWith("/diagnostics/")) {
      content = await this.#diagnosticsScreen(route.path.slice("/diagnostics/".length));
    } else {
      content = `<section class="card"><h1 tabindex="-1">Path not found</h1><a class="button" href="#/circles">Return to Circles</a></section>`;
    }
    if (renderNumber !== this.#renderNumber) return;
    const alert = this.#alert;
    this.#root.innerHTML = `
      <header class="app-header">
        <a class="brand" href="${this.#identity ? "#/circles" : "#/welcome"}" aria-label="Rapp Heir home">
          <span class="brand-mark" aria-hidden="true">◉</span><span>Rapp Heir</span>
        </a>
        ${
          this.#identity
            ? `<span class="companion-chip"><span aria-hidden="true" style="--companion:${escapeHtml(
                this.#identity.companion.color,
              )}"></span>${escapeHtml(this.#identity.companion.name)}</span>`
            : ""
        }
      </header>
      <main id="main" tabindex="-1">${content}</main>
      <div id="live-status" class="live-status" role="status" aria-live="polite">${escapeHtml(this.#status)}</div>
      <div id="alert-status" class="sr-only" role="alert" aria-live="assertive">${escapeHtml(alert)}</div>
      <footer><p>Local-first • no ambient microphone • PeerJS IDs are transport addresses, not identity</p>
        <p><a href="${import.meta.env.BASE_URL}NOTICE.md">Notices</a> •
        <a href="${import.meta.env.BASE_URL}PRIVACY.md">Privacy</a> •
        <a href="${import.meta.env.BASE_URL}SECURITY.md">Security</a> •
        <a href="${import.meta.env.BASE_URL}PROTOCOL.md">Protocol</a></p></footer>
    `;
    this.#alert = "";
    this.#bind(route);
    this.#lastRoutePath = route.path;
    if (routeChanged) {
      document.querySelector<HTMLElement>("main h1")?.focus();
    } else if (this.#focusAfterRender) {
      document.querySelector<HTMLElement>(this.#focusAfterRender)?.focus();
    } else if (previousFocusId) {
      document.getElementById(previousFocusId)?.focus();
    }
    this.#focusAfterRender = "";
  }

  #welcomeScreen(): string {
    return `
      <section class="hero route" aria-labelledby="welcome-title">
        <p class="eyebrow">A Circle remembers differently</p>
        <h1 id="welcome-title" tabindex="-1">Meet your one local companion.</h1>
        <p class="lede">Your companion is one persistent lobe in every Circle you join. This device creates its
        P-256 signing identity locally. The private key stays in IndexedDB and is never included in a pack.</p>
        <form id="onboarding-form" class="card form-grid">
          <label>Companion name <input name="name" maxlength="40" required autocomplete="off" placeholder="e.g. Fern"></label>
          <label>Color <input name="color" type="color" value="#8B7CFF" required></label>
          <label>Temperament
            <select name="temperament">
              <option>bright</option><option>gentle</option><option>curious</option>
              <option>steady</option><option>wild</option><option>wry</option>
            </select>
          </label>
          <label>Voice seed <input name="voiceSeed" maxlength="48" pattern="[A-Za-z0-9_ \\-]{1,48}" required placeholder="two quiet words"></label>
          <button class="button primary wide" type="submit">Create companion on this device</button>
        </form>
        <details class="trust-note">
          <summary>What leaves this device?</summary>
          <p>The explicitly configured public PeerJS cloud broker sees signaling metadata and has no SLA. Direct peers may learn IP/network
          metadata; NAT may prevent a connection; no permanent TURN credentials or relay guarantee are shipped. QR invites carry a five-minute secret
          in the URL fragment. Encrypted <code>.heirpack</code> files are the fallback. Signatures prove key possession,
          not a legal person or physical presence; QR/PIN can be relayed.</p>
        </details>
        <section class="card" aria-labelledby="clean-verify-title">
          <h2 id="clean-verify-title">Verify an heirloom on a clean device</h2>
          <p>No companion is required. The package hash, selected event signatures, privacy fields, and structural proof are checked locally.</p>
          <form id="import-file-form" class="inline-form">
            <label>Heirloom file <input name="file" type="file" accept=".rapp-heir.json,application/json" required></label>
            <button class="button" type="submit">Verify and open</button>
          </form>
        </section>
      </section>`;
  }

  async #circlesScreen(): Promise<string> {
    const circles = await listCircles(this.#db());
    return `
      <section class="route" aria-labelledby="circles-title">
        <p class="eyebrow">Local replicas</p>
        <h1 id="circles-title" tabindex="-1">Your Circles</h1>
        <div class="action-grid">
          <button id="open-create" class="action-card"><strong>Found a Circle</strong><span>People gather, then QR + PIN.</span></button>
          <a class="action-card" href="#/join"><strong>Join or reconnect</strong><span>Scan, paste, manual code, or file.</span></a>
          <button id="offline-demo" class="action-card"><strong>Offline practice</strong><span>A clearly simulated two-lobe Circle.</span></button>
        </div>
        <div class="circle-list">
          ${
            circles.length
              ? circles
                  .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
                  .map(
                    (circle) => `<a class="circle-row" href="#/circle/${escapeHtml(circle.id)}">
                      <span class="orb" aria-hidden="true"></span>
                      <span><strong>${escapeHtml(circle.name)}</strong>
                      <small>${escapeHtml(circle.status)} • ${Object.keys(circle.members).length} lobes${
                        circle.demo ? " • simulation" : ""
                      }</small></span><span aria-hidden="true">›</span>
                    </a>`,
                  )
                  .join("")
              : `<div class="empty-state"><p>No Circle replica lives here yet.</p></div>`
          }
        </div>
        <section class="card" aria-labelledby="pack-import-title">
          <h2 id="pack-import-title">Import a remote pack or heirloom</h2>
          <p>Whole packs are authenticated and validated before one IndexedDB transaction. A wrong phrase or changed byte fails closed.</p>
          <form id="import-file-form" class="inline-form">
            <label>File <input name="file" type="file" accept=".heirpack,.json,application/json" required></label>
            <label>Transfer phrase (for <code>.heirpack</code>) <input name="phrase" type="password" minlength="8" autocomplete="off"></label>
            <button class="button" type="submit">Verify and import</button>
          </form>
        </section>
      </section>
      <dialog id="create-dialog" aria-labelledby="create-title">
        <form id="create-circle-form" class="form-grid">
          <h2 id="create-title">First breath</h2>
          <p>Enter the shared words now; the manifest stays forming until at least one other companion finishes QR + PIN.</p>
          <label>Circle name <input name="name" minlength="2" maxlength="60" required></label>
          <label>Oath <textarea name="oath" minlength="4" maxlength="180" required></textarea></label>
          <div class="button-row"><button class="button primary" type="submit">Begin ceremony</button>
          <button class="button quiet" value="cancel" formmethod="dialog">Cancel</button></div>
        </form>
      </dialog>`;
  }

  #joinScreen(prefilledCode: string): string {
    const code = prefilledCode || (this.#invite ? encodeInviteCode(this.#invite) : "");
    return `
      <section class="route narrow" aria-labelledby="join-title">
        <p class="eyebrow">Fresh social handshake</p>
        <h1 id="join-title" tabindex="-1">Join, reconnect, or answer reunion</h1>
        <p>Every connection repeats QR-secret authentication, ephemeral P-256 ECDH, and a final out-of-band PIN.
        Known PeerJS IDs are hints only; this app never silently reconnects.</p>
        <div class="card scanner-card">
          <video id="scanner-video" playsinline muted aria-label="QR camera preview"></video>
          <button id="start-scan" class="button">Open camera scanner</button>
          <p class="fine">Uses BarcodeDetector when available, otherwise the bundled ZXing decoder. Camera starts only on this button.</p>
        </div>
        <form id="join-form" class="card form-grid">
          <label>Invite link or manual code
            <textarea name="invite" required autocomplete="off" spellcheck="false">${escapeHtml(code)}</textarea>
          </label>
          <button class="button primary" type="submit">Connect and derive PIN</button>
        </form>
        <form id="invite-file-form" class="inline-form">
          <label>Invite file <input name="file" type="file" accept=".json,.rapp-invite.json" required></label>
          <button class="button" type="submit">Read invite file</button>
        </form>
        ${
          this.#joinPin
            ? `<section class="pin-card" aria-labelledby="pin-title">
                <p id="pin-title">Tell the host this PIN out-of-band</p>
                <output id="join-pin-output" tabindex="-1" aria-label="Six digit acceptance PIN">${escapeHtml(
                  this.#joinPin.replace(/(\d{3})(\d{3})/u, "$1 $2"),
                )}</output>
                <p>Do not type it into the joining device. No Circle data arrives until the host enters it.</p>
              </section>`
            : ""
        }
        ${
          this.#pendingReunion
            ? `<section class="card">
                <h2>Approve reunion challenge?</h2>
                <p>Chapter ${this.#pendingReunion.chapter}; challenge ${escapeHtml(
                  shortId(this.#pendingReunion.nonce),
                )}. This signature proves this enrolled key approved these bytes—not human identity or location.</p>
                <button id="approve-reunion" class="button primary">Sign this challenge</button>
              </section>`
            : ""
        }
        <a class="button quiet" href="#/circles">Cancel and stay local</a>
      </section>`;
  }

  async #circleScreen(groupId: string): Promise<string> {
    const group = await getCircle(this.#db(), groupId);
    if (!group) return this.#missingCircle();
    const events = await getCircleEvents(this.#db(), group.id);
    const memberRows = Object.values(group.members)
      .sort((left, right) => left.memberId.localeCompare(right.memberId))
      .map(
        (member) => `<li><span class="member-dot" style="--member:${escapeHtml(
          member.companion.color,
        )}" aria-hidden="true"></span><span><strong>${escapeHtml(member.companion.name)}</strong>
          <small>${escapeHtml(member.companion.temperament)} • key ${escapeHtml(shortId(member.memberId))}</small></span>
          <span class="status-word">enrolled</span></li>`,
      )
      .join("");
    if (group.status === "forming") {
      const isCoordinator = group.coordinatorId === this.#identityRequired().memberId;
      return `
        <section class="route" aria-labelledby="circle-title">
          <p class="eyebrow">First-breath ceremony • forming</p>
          <h1 id="circle-title" tabindex="-1">${escapeHtml(group.name)}</h1>
          <blockquote>${escapeHtml(group.oath)}</blockquote>
          <div class="two-column">
            <section class="card">
              <h2>Collected companions</h2><ul class="member-list">${memberRows}</ul>
              <p class="fine">The host coordinates transport. Nobody owns the Circle. Each founder seed has equal, order-independent influence.</p>
            </section>
            <section class="card">
              <h2>Single-use invitation</h2>
              <p>Invite one nearby person. It expires in five minutes and is consumed only after their durable ACK.</p>
              <button id="host-first-breath" class="button primary" ${
                isCoordinator ? "" : "disabled"
              }>Make fresh QR invite</button>
              ${this.#invitePanel(group.id)}
            </section>
          </div>
          <section class="card manifest">
            <h2>Final manifest review</h2>
            <dl><div><dt>Name</dt><dd>${escapeHtml(group.name)}</dd></div>
            <div><dt>Oath</dt><dd>${escapeHtml(group.oath)}</dd></div>
            <div><dt>Founders</dt><dd>${Object.keys(group.members).length}; sorted equally at genesis</dd></div></dl>
            <button id="finalize-circle" class="button primary" ${
              Object.keys(group.members).length < 2 || !isCoordinator ? "disabled" : ""
            }>Breathe together and found Circle</button>
            ${
              !isCoordinator
                ? `<p class="fine">The coordinator will commit the reviewed manifest; they do not own the Circle.</p>`
                : Object.keys(group.members).length < 2
                ? `<p class="fine">Waiting for another person to complete QR + PIN.</p>`
                : `<p class="fine">This commits an irreversible genesis body. Later structural molts require reunion quorum.</p>`
            }
          </section>
          <a class="button quiet" href="#/circles">Back to local Circles</a>
        </section>`;
    }
    const organism = group.genesis ? await deriveOrganismState(group, events) : undefined;
    const eligibility = await heirloomEligibility(group, events);
    return `
      <section class="route" aria-labelledby="circle-title">
        <div class="title-row"><div><p class="eyebrow">${escapeHtml(group.status)} • chapter ${group.chapter}</p>
        <h1 id="circle-title" tabindex="-1">${escapeHtml(group.name)}</h1></div>
        <a class="button quiet" href="#/diagnostics/${escapeHtml(group.id)}">Proof & diagnostics</a></div>
        <blockquote>${escapeHtml(group.oath)}</blockquote>
        <section class="organism-card" aria-labelledby="organism-title">
          <h2 id="organism-title" class="sr-only">Circle organism</h2>
          <canvas id="organism-canvas" role="img" aria-describedby="organism-description"></canvas>
          <p id="organism-description">${escapeHtml(organism?.description ?? "Genesis body is unavailable.")}</p>
        </section>
        <div class="progress-track" aria-label="Heirloom progression">
          <span class="done">✓ Founded</span>
          <span class="${eligibility.sharedQuest ? "done" : ""}">${eligibility.sharedQuest ? "✓" : "2"} Remote Braid reveal</span>
          <span class="${eligibility.reunionSeal ? "done" : ""}">${eligibility.reunionSeal ? "✓" : "3"} Reunion molt</span>
          <span class="${eligibility.ready ? "done" : ""}">${eligibility.ready ? "✓" : "4"} Heirloom ready</span>
        </div>
        <div class="action-grid">
          <a class="action-card primary-card" href="#/play/${escapeHtml(group.id)}"><strong>Ask the Pocket GM</strong><span>Voice, type, or tap a 5–10 minute leg.</span></a>
          <button id="host-sync" class="action-card"><strong>Fresh sync QR</strong><span>PIN, then HELLO/SUMMARY/WANT/PACK/ACK.</span></button>
          <a class="action-card" href="#/reunion/${escapeHtml(group.id)}"><strong>Prepare reunion</strong><span>Gather distinct key approvals for a structural molt.</span></a>
          <a class="action-card" href="#/heirloom/${escapeHtml(group.id)}"><strong>Heirloom</strong><span>${escapeHtml(eligibility.reason)}</span></a>
        </div>
        ${this.#invitePanel(group.id)}
        <section class="card">
          <h2>Companion lobes</h2><ul class="member-list">${memberRows}</ul>
        </section>
        <section class="card" aria-labelledby="pack-title">
          <h2 id="pack-title">Encrypted file fallback</h2>
          <p>Use when PeerJS/NAT fails. Includes the full public replica and signed events, never this device’s private key.</p>
          <form id="export-pack-form" class="inline-form">
            <label>Transfer phrase <input name="phrase" type="password" minlength="8" maxlength="256" required autocomplete="new-password"></label>
            <button class="button" type="submit">Export .heirpack</button>
          </form>
        </section>
      </section>`;
  }

  #invitePanel(groupId: string): string {
    if (!this.#invite || this.#invite.groupId !== groupId) return "";
    const link = inviteLink(this.#invite, `${location.origin}${import.meta.env.BASE_URL}`);
    return `
      <div class="invite-panel">
        <canvas id="invite-qr" role="img" aria-label="Expiring QR invite"></canvas>
        <p><strong>${escapeHtml(this.#invite.mode)}</strong> • expires ${new Date(
          this.#invite.expiresAt,
        ).toLocaleTimeString()}</p>
        <label>Link / manual fallback <textarea id="invite-link" readonly>${escapeHtml(link)}</textarea></label>
        <div class="button-row"><button id="copy-invite" class="button">Copy link</button>
        <button id="save-invite" class="button">Save invite file</button></div>
        ${
          this.#pendingHost
            ? `<form id="host-pin-form" class="pin-entry">
                <p><strong>${escapeHtml(this.#pendingHost.companionName)}</strong> authenticated the QR secret.
                Ask them to read their PIN. ${this.#pendingHost.attemptsLeft} attempts remain.</p>
                <label>Six-digit PIN <input name="pin" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" maxlength="6" required></label>
                <button class="button primary" type="submit">Accept this companion</button>
              </form>`
            : ""
        }
      </div>`;
  }

  async #playScreen(groupId: string): Promise<string> {
    const group = await getCircle(this.#db(), groupId);
    if (!group) return this.#missingCircle();
    const events = await getCircleEvents(this.#db(), groupId);
    const quest = latestQuest(events);
    const offerings = quest
      ? events.filter(
          (event) => event.body.type === "quest.offering" && event.body.payload.questId === quest.questId,
        )
      : [];
    const ownOffering = offerings.find((event) => event.body.memberId === this.#identityRequired().memberId);
    const organism = group.genesis ? await deriveOrganismState(group, events) : undefined;
    this.#orbState = withOrbContext(this.#orbState, {
      questActive: Boolean(quest),
      signedIn: this.#intelligence.authenticated,
    });
    const selected = highlightedPetal(this.#orbState);
    const pendingCandidate = this.#proposalGate.pending;
    const pending = pendingCandidate?.circleId === groupId ? pendingCandidate : undefined;
    const tunnel = this.#orbState.breadcrumb.at(-1);
    let leg = "";
    if (quest) {
      const derived = await deriveQuestLeg(quest, this.#identityRequired().memberId, offerings);
      leg = `<article class="quest-leg">
        <p class="eyebrow">Offline deterministic template • ${escapeHtml(derived.role)} • ${derived.minutes} minutes</p>
        <h2>${escapeHtml(quest.title)}</h2><p>${escapeHtml(quest.premise)}</p>
        <p class="prompt">${escapeHtml(derived.prompt)}</p>
        <p class="fine">Local mark ${escapeHtml(derived.influenceMark)}. ${
          derived.influencedBy.length
            ? `Materially changed by ${derived.influencedBy.length} signed prior offering(s).`
            : "No remote model is needed; leave the first choice in this stretch of the Braid."
        }</p>
      </article>`;
    }
    const petals = this.#orbState.petals
      .map(
        (petal, index) => `<li style="--petal-index:${index};--petal-count:${this.#orbState.petals.length}">
          <button type="button" class="orb-petal${petal.id === this.#orbState.highlighted ? " highlighted" : ""}"
            data-orb-petal data-action="${petal.id}" aria-pressed="${
              petal.id === this.#orbState.highlighted
            }" ${petal.enabled ? "" : "disabled"}>
            <span>${escapeHtml(petal.label)}</span><small>${escapeHtml(petal.kind)}</small>
          </button>
        </li>`,
      )
      .join("");
    const pendingCard = pending
      ? `<section class="proposal-card" aria-labelledby="proposal-title">
          <p class="eyebrow">${
            this.#proposalGate.committing
              ? "Atomic signing has begun"
              : "Frozen local proposal • no event yet"
          }</p>
          <h2 id="proposal-title" tabindex="-1">Review &amp; sign</h2>
          <p>${escapeHtml(pending.preview)}</p>
          <dl>
            <div><dt>Event</dt><dd><code>${escapeHtml(pending.eventType)}</code></dd></div>
            <div><dt>Binding</dt><dd>Circle + current event root + state digest</dd></div>
            <div><dt>Expires</dt><dd>${new Date(pending.expiresAt).toLocaleTimeString()}</dd></div>
          </dl>
          <details><summary>Exact canonical payload</summary><pre>${escapeHtml(
            pending.canonicalPayload,
          )}</pre></details>
          <p class="fine">This separate confirmation reloads the Circle, checks authorization and the frozen binding,
          sanitizes the exact payload, then creates at most one signed event. Highlighting never signs.</p>
          <div class="button-row">
            <button id="review-sign-proposal" class="button primary" type="button" ${
              pending.expiresAt <= Date.now() || this.#proposalGate.signing ? "disabled" : ""
            }>${this.#proposalGate.committing ? "Signing atomically…" : "Review &amp; sign this exact proposal"}</button>
            <button id="cancel-proposal" class="button quiet" type="button" ${
              this.#proposalGate.committing ? "disabled" : ""
            }>${
              this.#proposalGate.committing
                ? "Signing cannot be cancelled"
                : "Cancel — create zero events"
            }</button>
          </div>
        </section>`
      : "";
    const newQuestTunnel =
      this.#orbState.mode === "tunnel" && tunnel === "New Quest"
        ? `<form id="quest-draft-form" class="card inline-form">
            <p class="eyebrow">Tunnel • step 1 of 2 • offline</p>
            <h2>Draft a deterministic quest</h2>
            <label>Place class <select name="context">
              <option>indoors</option><option>doorstep</option><option>park</option><option>street</option>
              <option>transit</option><option>waterside</option><option>unknown</option>
            </select></label>
            <label>Weather band <select name="weather">
              <option>clear</option><option>clouded</option><option>rain</option><option>snow</option>
              <option>wind</option><option>warm</option><option>cold</option><option>unknown</option>
            </select></label>
            <button class="button primary" type="submit">Stage offline quest for review</button>
          </form>`
        : "";
    const offeringTunnel =
      this.#orbState.mode === "tunnel" && tunnel === "Offer" && quest && !ownOffering
        ? `<form id="offering-draft-form" class="card form-grid">
            <p class="eyebrow">Tunnel • offering draft</p>
            <h2>Draft your bounded offering</h2>
            <label>Offering <textarea name="text" maxlength="600" required></textarea></label>
            <label>Choice left for the next lobe
              <input name="choice" maxlength="48" required placeholder="follow the warm echo">
            </label>
            <label>Optional companion trait <select name="trait"><option value="">None</option>
              <option>${escapeHtml(this.#identityRequired().companion.temperament)}</option>
              <option>patience</option><option>mischief</option><option>care</option></select></label>
            <label class="check"><input name="context" type="checkbox"> Include broad place class (never coordinates)</label>
            <label class="check"><input name="approved" type="checkbox"> Separately select this text for the portable heirloom</label>
            <button class="button primary" type="submit">Stage offering — do not sign</button>
          </form>`
        : "";
    const devicePanel = this.#deviceCode
      ? `<section class="device-code-panel" aria-labelledby="device-code-title">
          <h3 id="device-code-title" tabindex="-1">Connect GitHub Copilot</h3>
          <p>Sign-in sends no Circle content. Open GitHub and enter:</p>
          <strong class="device-code">${escapeHtml(this.#deviceCode.userCode)}</strong>
          <a class="button primary" href="${escapeHtml(
            this.#deviceCode.verificationUrl,
          )}" target="_blank" rel="noreferrer noopener">Open GitHub verification</a>
          <button id="cancel-device-login" class="button quiet" type="button">Cancel sign-in</button>
        </section>`
      : "";
    const agentPreviewCard = this.#agentPreview
      ? `<section class="agent-preview-card" aria-labelledby="agent-preview-title">
          <p class="eyebrow">${
            this.#agentPreview.fallbackReason
              ? "Deterministic JavaScript offline fallback"
              : `Manifest + source verified • CPython via Pyodide ${PYODIDE_VERSION}`
          }</p>
          <h3 id="agent-preview-title" tabindex="-1">Exact quest-agent output</h3>
          ${
            this.#agentPreview.fallbackReason
              ? `<p class="network-warning">The verified Python path was unavailable or failed validation, so no Python claim is made.
                The existing deterministic JavaScript quest generator was used instead: ${escapeHtml(
                  this.#agentPreview.fallbackReason,
                )}</p>`
              : `<dl><div><dt>Manifest</dt><dd><code>${PINNED_AGENT_MANIFEST_HASH}</code></dd></div>
                <div><dt>QuestMaster source</dt><dd><code>${escapeHtml(
                  this.#agentPreview.questMaster?.sourceHash ?? "",
                )}</code></dd></div>
                ${
                  this.#agentPreview.questSafety
                    ? `<div><dt>QuestSafety source</dt><dd><code>${escapeHtml(
                        this.#agentPreview.questSafety.sourceHash,
                      )}</code></dd></div>`
                    : ""
                }</dl>`
          }
          <pre>${escapeHtml(this.#agentPreview.exactOutput)}</pre>
          ${
            this.#agentPreview.safetyOutput
              ? `<details><summary>Exact QuestSafety output</summary><pre>${escapeHtml(
                  this.#agentPreview.safetyOutput,
                )}</pre></details>`
              : ""
          }
          <p class="fine">The output is inert untrusted data. Staging parses bounded quest fields into the normal
          PendingProposal gate; only your later Review &amp; sign turn can create an event.</p>
          <button id="stage-agent-quest" class="button primary" type="button">Stage this quest for Review &amp; sign</button>
        </section>`
      : "";
    const mindTunnel =
      this.#orbState.mode === "tunnel" && tunnel === "Mind"
        ? `<section class="mind-panel card" aria-labelledby="verified-agents-title">
            <p class="eyebrow">Tunnel • local verified bytecode</p>
            <h2 id="verified-agents-title">Verified local RAPP agents</h2>
            <p>QuestMaster runs as hash-pinned Python in CPython/Pyodide ${PYODIDE_VERSION}, inside an opaque-origin
            <code>sandbox="allow-scripts"</code> iframe and its worker. The cell receives no signing key, storage,
            DOM, PeerJS, Copilot, or host capability. It can propose a quest only.</p>
            <p class="fine">First use needs network access to the exact pinned raw GitHub commit and pinned Pyodide
            files. Browser HTTP caching may help later, but availability and retention are not guaranteed; the
            service worker deliberately does not cache either origin.</p>
            <form id="verified-agent-form" class="form-grid">
              <label>Place class <select name="context">
                <option>indoors</option><option>doorstep</option><option>park</option><option>street</option>
                <option>transit</option><option>waterside</option><option>unknown</option>
              </select></label>
              <label>Weather band <select name="weather">
                <option>clear</option><option>clouded</option><option>rain</option><option>snow</option>
                <option>wind</option><option>warm</option><option>cold</option><option>unknown</option>
              </select></label>
              <label class="check"><input name="safety" type="checkbox" checked>
                Also verify the parsed proposal with hash-pinned QuestSafety</label>
              <button class="button primary" type="submit" ${this.#agentRunning ? "disabled" : ""}>${
                this.#agentRunning ? "Loading verified CPython cell…" : "Run hash-pinned QuestMaster"
              }</button>
            </form>
            ${agentPreviewCard}
          </section>
          <section class="mind-panel card">
            <p class="eyebrow">Tunnel • optional remote mind</p>
            <h2>Copilot narrator/planner</h2>
            <p>Offline quest templates remain authoritative and available. Copilot has no event, signing, storage,
            PeerJS, reunion, key, or heirloom tool.</p>
            ${
              this.#intelligence.authenticated
                ? `<form id="ai-draft-form" class="form-grid">
                    <label>Your current draft (maximum 600 characters)
                      <textarea name="draft" maxlength="600" required></textarea>
                    </label>
                    <button class="button" type="submit">Build exact context preview</button>
                  </form>`
                : `<button id="start-device-login" class="button primary" type="button">Sign in with GitHub device code</button>`
            }
            ${devicePanel}
          </section>`
        : "";
    const aiPreviewCard = this.#aiPreview
      ? `<section class="ai-preview-card" aria-labelledby="ai-preview-title">
          <p class="eyebrow">Exact remote context preview • ${this.#aiPreview.bytes.byteLength} / 4096 bytes</p>
          <h2 id="ai-preview-title" tabindex="-1">Approve this bounded projection?</h2>
          <p><strong>Recipients:</strong> ${REMOTE_RECIPIENT_CHAIN}</p>
          <pre>${escapeHtml(this.#aiPreview.text)}</pre>
          <p class="fine">Excluded: IDs, names/oath, keys/signatures/hashes/roots/timestamps, roster/order, invites/PIN,
          PeerJS and Kited fields, raw audio/location/memories/history, unselected offerings, peer text, and heirloom bytes.</p>
          <div class="button-row">
            <button id="approve-ai-preview" class="button primary" type="button" ${
              this.#intelligence.authenticated && !this.#aiStreaming ? "" : "disabled"
            }>Approve exact bytes &amp; send</button>
            <button id="cancel-ai-preview" class="button quiet" type="button">Cancel preview</button>
          </div>
        </section>`
      : "";
    const aiDraftCard =
      this.#aiPreview || this.#aiDraft || this.#aiStreaming
        ? `<section class="ai-draft-card" aria-labelledby="ai-draft-title">
            <p class="eyebrow">Remote Copilot mode • untrusted draft</p>
            <h2 id="ai-draft-title">Narrator draft</h2>
            <output id="ai-draft-output" tabindex="-1">${escapeHtml(
              this.#aiDraft ||
                (this.#aiStreaming
                  ? "Streaming an untrusted draft…"
                  : "Awaiting explicit context approval."),
            )}</output>
            <p class="fine">This text cannot execute commands or mutate the Circle.</p>
            ${
              this.#aiDraft && !this.#aiStreaming
                ? `<details class="ai-spoken-caption">
                    <summary>Spoken version</summary>
                    <p id="ai-spoken-caption">${escapeHtml(
                      this.#aiVoice ||
                        "Spoken version unavailable because the response did not include a usable voice section.",
                    )}</p>
                  </details>`
                : ""
            }
            <button id="stage-ai-offering" class="button" type="button" ${
              !quest || this.#aiStreaming || !this.#aiDraft || this.#aiDraft.length > 600 ? "hidden" : ""
            }>Stage this exact draft as an offering</button>
          </section>`
        : "";
    return `
      <section class="route adaptive-orb-route" aria-labelledby="gm-title">
        <div class="title-row"><div><p class="eyebrow">Adaptive Orb • Pocket Quest Master</p>
          <h1 id="gm-title" tabindex="-1">Talk with the Circle organism</h1></div>
          <div class="mind-account">
            <span class="account-chip">${this.#intelligence.authenticated ? "Copilot connected • memory only" : "Offline mind"}</span>
            ${
              this.#intelligence.authenticated
                ? '<button id="mind-logout" class="button quiet" type="button">Log out Copilot</button>'
                : ""
            }
          </div>
        </div>
        <p>Orbit is the default conversation. Compass holds bounded choices. Tunnel carries multi-step drafts.
        Center always cancels/rests safely; a highlight is never consent.</p>
        <nav class="orb-breadcrumb" aria-label="Adaptive Orb mode">${this.#orbState.breadcrumb
          .map((item) => `<span>${escapeHtml(item)}</span>`)
          .join("<span aria-hidden=\"true\">›</span>")}</nav>
        <section class="adaptive-orb" tabindex="-1" data-orb-shortcut-surface
          aria-label="Adaptive Orb keyboard background" style="--orb-hue:${organism?.hue ?? 265};--orb-glow:${(
          0.1 +
          (organism?.aura ?? 0.5) * 0.18
        ).toFixed(3)};--orb-breath:${(6.4 - (organism?.motion ?? 0.5) * 2).toFixed(
          2,
        )}s">
          <button id="orb-center" class="orb-center" type="button" aria-label="Center: cancel current draft and rest safely">
            <span class="orb-core" aria-hidden="true"><i></i><i></i><i></i></span>
            <strong>Center</strong><small>safe cancel / rest</small>
          </button>
          <ol class="orb-petals">${petals}</ol>
        </section>
        <section class="orb-conversation" aria-labelledby="caption-title">
          <div class="caption-heading"><h2 id="caption-title">Persistent caption</h2>
            <span class="mode-chip">${escapeHtml(this.#orbState.mode)}</span></div>
          <output id="orb-caption" tabindex="-1" aria-live="polite">${escapeHtml(
            this.#voiceOutput ||
              "Offline and ready. Highlight a petal, then explicitly Confirm; or type a message or command.",
          )}</output>
          <p id="orb-highlight" class="highlight-status">Highlighted: ${
            selected ? escapeHtml(selected.label) : "Center (safe cancel)"
          }. Not activated.</p>
          <div class="button-row orb-explicit-controls">
            <button id="confirm-highlight" class="button primary" type="button">Confirm highlighted action</button>
            <button id="cancel-orb" class="button quiet" type="button">Cancel / center</button>
            <button id="undo-orb" class="button quiet" type="button">Undo draft</button>
          </div>
        </section>
        <section class="input-parity card">
          <h2>Message or command</h2>
          <p class="network-warning"><strong>Browser speech warning:</strong> SpeechRecognition and SpeechSynthesis
          may use platform, browser, or vendor services, including network services. No raw audio is kept by Rapp Heir.</p>
          <div class="voice-command-row">
            <button id="push-to-talk" class="talk-button" aria-describedby="talk-help" aria-pressed="false">
              <span aria-hidden="true">◉</span><strong>Hold or toggle to speak</strong>
            </button>
            <p id="talk-help" class="fine">${
              this.#voice.available
                ? "Speech recognition available. Push-to-talk interrupts speech output."
                : "Speech recognition unavailable; typed/touch/keyboard controls have full parity."
            }</p>
          </div>
          <form id="command-form" class="command-bar">
            <label class="sr-only" for="command-input">Message or command</label>
            <input id="command-input" name="command" maxlength="600" autocomplete="off"
              placeholder="Message or command: my turn, new quest, offer…, recap, stop" required>
            <button class="button primary" type="submit">Submit</button>
          </form>
        </section>
        ${pendingCard}
        ${newQuestTunnel}
        ${offeringTunnel}
        ${mindTunnel}
        ${aiPreviewCard}
        ${aiDraftCard}
        ${leg || '<section class="card"><h2>No active quest</h2><p>Use New Quest for an offline deterministic template.</p></section>'}
        ${
          group.demo && quest
            ? `<section class="card demo-card"><h2>Practice companion</h2>
                <p>Morrow is simulated on this device. Its key cannot prove another person was present. Its answer is
                also staged and separately reviewed before that demo key signs.</p>
                <form id="demo-offering-form" class="form-grid">
                  <label class="check"><input name="approved" type="checkbox"> Separately select Morrow’s simulated
                  text for the portable heirloom</label>
                  <button class="button" type="submit">Stage Morrow’s offline answer</button>
                </form></section>`
            : ""
        }
        ${
          quest
            ? `<section class="card">
                <h2>Shared reveal</h2>
                <p>${new Set(offerings.map((event) => event.body.memberId)).size} distinct member offering(s) received.</p>
                <button id="stage-reveal" class="button" ${
                  new Set(offerings.map((event) => event.body.memberId)).size < 2 ? "disabled" : ""
                }>Stage shared reveal for review</button>
              </section>`
            : ""
        }
        <section class="camera-assist card">
          <h2>Experimental camera highlight assist</h2>
          <p>Explicit opt-in requests video only—never audio. FaceDetector maps one face to four coarse directions or
          center. A 1.2-second dwell can only highlight/arm; it can never Confirm, sign, or send.</p>
          <div class="button-row"><button id="enable-camera-assist" class="button" type="button">Enable camera assist</button>
          <button id="disable-camera-assist" class="button quiet" type="button">Disable camera assist</button></div>
          <video id="orb-camera-preview" class="camera-preview" muted playsinline hidden></video>
          <p class="fine">No pixels, vectors, direction history, or camera output are stored, logged, networked, AI-sent, or exported.</p>
        </section>
        <p class="keyboard-help">When body or the Orb background owns focus: ←/→ rotates highlight, Enter confirms,
        Escape centers, U/Backspace undoes, and R repeats. Space push-to-talk works only after explicit shortcut mode.</p>
        <button id="toggle-orb-shortcuts" class="button quiet" type="button" aria-pressed="${
          this.#orbShortcutMode
        }">${this.#orbShortcutMode ? "Disable" : "Enable"} Orb keyboard shortcut mode</button>
        <a class="button quiet" href="#/circle/${escapeHtml(group.id)}">Back to organism</a>
      </section>`;
  }

  async #reunionScreen(groupId: string): Promise<string> {
    const group = await getCircle(this.#db(), groupId);
    if (!group) return this.#missingCircle();
    const events = await getCircleEvents(this.#db(), groupId);
    if (
      this.#reunionChallenge &&
      !(await reunionChallengeIsCurrent(group, events, this.#reunionChallenge))
    ) {
      this.#reunionChallenge = undefined;
      this.#reunionApprovals = [];
      this.#clearLinkState();
      this.#setStatus("Reunion challenge expired or its event root changed. Start a new challenge.");
    }
    const threshold = reunionThreshold(group);
    const approvals = new Set(this.#reunionApprovals.map((approval) => approval.memberId)).size;
    return `
      <section class="route" aria-labelledby="reunion-title">
        <p class="eyebrow">Irreversible chapter • fresh co-presence ceremony</p>
        <h1 id="reunion-title" tabindex="-1">Prepare reunion molt</h1>
        <p>Policy: <strong>max(2, ceil(active ÷ 2)) = ${threshold} distinct enrolled keys</strong>.
        ${
          group.demo
            ? "Practice uses only the two explicitly simulated on-device keys; PeerJS is never opened."
            : "Every signer scans a fresh QR and completes joiner-PIN-to-host acceptance over the frozen chapter challenge."
        }</p>
        <section class="card">
          <h2>Challenge</h2>
          ${
            this.#reunionChallenge
              ? `<dl><div><dt>Chapter</dt><dd>${this.#reunionChallenge.chapter}</dd></div>
                <div><dt>Event root</dt><dd><code>${escapeHtml(shortId(this.#reunionChallenge.eventRoot))}</code></dd></div>
                <div><dt>Approvals</dt><dd>${approvals} / ${threshold}</dd></div></dl>
                ${
                  group.demo
                    ? ""
                    : '<button id="fresh-reunion-invite" class="button">Invite another signer with fresh QR</button>'
                }`
              : `<p>No active challenge. Starting signs it with this device’s enrolled key${
                  group.demo ? " and stays entirely on-device." : " and opens one five-minute offer."
                }</p>
                <button id="start-reunion" class="button primary">Start reunion challenge</button>`
          }
          ${group.demo ? "" : this.#invitePanel(group.id)}
        </section>
        ${
          group.demo && this.#reunionChallenge && approvals < threshold
            ? `<section class="card demo-card"><h2>Practice approval</h2>
                <p>Add Morrow’s simulated local key. This demonstrates quorum math but does not prove human co-presence.</p>
                <button id="demo-reunion" class="button">Add simulated approval</button></section>`
            : ""
        }
        ${
          this.#reunionChallenge
            ? `<section class="card">
                <h2>Close ceremony</h2>
                <div class="button-row"><button id="seal-reunion" class="button primary" ${
                  approvals < threshold ? "disabled" : ""
                }>Seal chapter and molt</button>
                <button id="save-reunion-draft" class="button quiet">Save draft / remote echo</button></div>
                <p class="fine">A draft never changes structural form. The certificate proves keys approved one challenge,
                not identity, exact location, or absence of relay.</p>
              </section>`
            : ""
        }
        <a class="button quiet" href="#/circle/${escapeHtml(group.id)}">Back without mutating form</a>
        <p class="fine">Current signed event count: ${events.length}</p>
      </section>`;
  }

  async #heirloomScreen(groupId: string): Promise<string> {
    const group = await getCircle(this.#db(), groupId);
    if (!group) return this.#missingCircle();
    const events = await getCircleEvents(this.#db(), groupId);
    const eligibility = await heirloomEligibility(group, events);
    return `
      <section class="route narrow" aria-labelledby="heirloom-title">
        <p class="eyebrow">Portable final artifact</p>
        <h1 id="heirloom-title" tabindex="-1">Circle heirloom</h1>
        <div class="card">
          <p class="readiness ${eligibility.ready ? "ready" : ""}">${escapeHtml(eligibility.reason)}</p>
          <ul class="check-list"><li>${eligibility.sharedQuest ? "✓" : "○"} Shared quest with 2+ members and reveal</li>
          <li>${eligibility.reunionSeal ? "✓" : "○"} Valid reunion seal</li></ul>
          <button id="mint-heirloom" class="button primary" ${eligibility.ready ? "" : "disabled"}>Mint and export .rapp-heir.json</button>
        </div>
        <section class="card">
          <h2>What it carries</h2>
          <p>Genesis, selected signed events, current organism body, prior generation roots, approved offerings/reveals,
          and a package hash. It excludes private keys, precise location, raw voice, and unselected personal text.</p>
          <p>On a clean device, use “Import a remote pack or heirloom” to verify signatures and the package hash.</p>
        </section>
        <a class="button quiet" href="#/circle/${escapeHtml(group.id)}">Back to Circle</a>
      </section>`;
  }

  async #diagnosticsScreen(groupId: string): Promise<string> {
    const group = await getCircle(this.#db(), groupId);
    if (!group) return this.#missingCircle();
    const [events, outbox, persistence] = await Promise.all([
      getCircleEvents(this.#db(), group.id),
      this.#db().getAll("outbox"),
      storagePersistenceState(),
    ]);
    const root = await eventRoot(events);
    const states = outbox
      .filter((item) => item.groupId === group.id)
      .reduce<Record<string, number>>((counts, item) => {
        counts[item.state] = (counts[item.state] ?? 0) + 1;
        return counts;
      }, {});
    return `
      <section class="route" aria-labelledby="diagnostics-title">
        <p class="eyebrow">Visible proof panel</p>
        <h1 id="diagnostics-title" tabindex="-1">Diagnostics & trust</h1>
        <div class="diagnostic-grid">
          <section class="card"><h2>Replica</h2><dl>
            <div><dt>Circle ID</dt><dd><code>${escapeHtml(group.id)}</code></dd></div>
            <div><dt>Event root</dt><dd><code>${escapeHtml(root)}</code></dd></div>
            <div><dt>Events</dt><dd>${events.length}</dd></div>
            <div><dt>Members</dt><dd>${Object.keys(group.members).length}</dd></div>
            <div><dt>Storage persistence</dt><dd>${persistence.supported ? (persistence.persisted ? "granted" : "not granted") : "API unavailable"}</dd></div>
          </dl></section>
          <section class="card"><h2>Delivery labels</h2><ul>
            ${Object.entries(states)
              .map(([state, count]) => `<li>${escapeHtml(state)}: ${count}</li>`)
              .join("") || "<li>No outbox records</li>"}
          </ul><p>“delivery unknown” is never presented as received. A durable ACK is required for “durably merged.”</p></section>
          <section class="card"><h2>Verified</h2><ul>
            <li>Canonical event hashes and enrolled P-256 signatures on import</li>
            <li>QR-secret proof, ephemeral ECDH/HKDF, AES-GCM, transcript PIN</li>
            <li>Event-set union; duplicate no-op; sequence forks preserved</li>
          </ul></section>
          <section class="card"><h2>Not verified</h2><ul>
            <li>Legal identity, human presence, exact location, or unrelayed ceremony</li>
            <li>PeerJS uptime, TURN reachability, or transport-address identity</li>
            <li>Truth of inert peer text; reducers only validate bounds and signed provenance</li>
          </ul></section>
        </div>
        <section class="card"><h2>Enrolled key fingerprints</h2><ul class="mono-list">
          ${Object.values(group.members)
            .map(
              (member) => `<li>${escapeHtml(member.companion.name)} — ${escapeHtml(member.memberId)}</li>`,
            )
            .join("")}</ul></section>
        <a class="button quiet" href="#/circle/${escapeHtml(group.id)}">Back to Circle</a>
      </section>`;
  }

  async #artifactScreen(packageHash: string): Promise<string> {
    const artifact = await getSetting<HeirloomArtifact>(this.#db(), `heirloom:${packageHash}`);
    if (!artifact) {
      return `<section class="card"><h1 tabindex="-1">Heirloom unavailable</h1>
        <p>This device has not imported that package.</p>
        <a class="button" href="${this.#identity ? "#/circles" : "#/welcome"}">Return</a></section>`;
    }
    const verified = await verifyHeirloom(artifact);
    return `
      <section class="route narrow" aria-labelledby="artifact-title">
        <p class="eyebrow">Verified portable heirloom</p>
        <h1 id="artifact-title" tabindex="-1">${escapeHtml(artifact.group.name)}</h1>
        <section class="card">
          <p class="readiness ready">✓ Package hash, ${verified.eventCount} selected event signature(s), privacy bounds,
          and signed structural proof verified on this device.</p>
          <dl><div><dt>Package</dt><dd><code>${escapeHtml(artifact.packageHash)}</code></dd></div>
          <div><dt>Organism</dt><dd>${escapeHtml(artifact.organism.organismId)}</dd></div>
          <div><dt>Minted</dt><dd>${new Date(artifact.mintedAt).toLocaleString()}</dd></div>
          <div><dt>Prior roots</dt><dd>${artifact.priorGenerationRoots.length}</dd></div></dl>
          <p>${escapeHtml(artifact.organism.description)}</p>
        </section>
        <section class="card"><h2>Selected story</h2>
          ${
            artifact.approvedStory.length
              ? `<ul>${artifact.approvedStory
                  .map(
                    (story) =>
                      `<li><strong>${escapeHtml(shortId(story.memberId))}</strong>: ${escapeHtml(
                        story.text,
                      )} <em>Choice: ${escapeHtml(story.choice)}</em></li>`,
                  )
                  .join("")}</ul>`
              : "<p>No personal offering text was selected.</p>"
          }
          ${artifact.approvedReveals.map((reveal) => `<blockquote>${escapeHtml(reveal)}</blockquote>`).join("")}
        </section>
        <p class="fine">Verification proves enrolled key possession and package consistency—not legal identity,
        physical presence, location, or truth of story text.</p>
        <a class="button quiet" href="${this.#identity ? "#/circles" : "#/welcome"}">Close heirloom</a>
      </section>`;
  }

  #missingCircle(): string {
    return `<section class="card"><h1 tabindex="-1">Circle unavailable</h1><p>No local replica matches this ID.</p>
      <a class="button" href="#/circles">Return to Circles</a></section>`;
  }

  #bind(route: ReturnType<typeof routeParts>): void {
    const onboarding = document.querySelector<HTMLFormElement>("#onboarding-form");
    onboarding?.addEventListener("submit", (event) => void this.#onboard(event));
    document.querySelector("#open-create")?.addEventListener("click", () => {
      document.querySelector<HTMLDialogElement>("#create-dialog")?.showModal();
    });
    document.querySelector<HTMLFormElement>("#create-circle-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#createCircle(currentForm(event));
    });
    document.querySelector("#offline-demo")?.addEventListener("click", () => void this.#makeDemo());
    document.querySelector<HTMLFormElement>("#import-file-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#importFile(currentForm(event));
    });
    document.querySelector("#start-scan")?.addEventListener("click", () => void this.#startScanner());
    document.querySelector<HTMLFormElement>("#join-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#joinFromInput(fieldValue(currentForm(event), "invite"));
    });
    document.querySelector<HTMLFormElement>("#invite-file-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#readInviteFile(currentForm(event));
    });
    document.querySelector("#approve-reunion")?.addEventListener("click", () => void this.#approveJoinedReunion());
    document.querySelector("#host-first-breath")?.addEventListener("click", () => void this.#hostOfferFromRoute("first-breath"));
    document.querySelector("#host-sync")?.addEventListener("click", () => void this.#hostOfferFromRoute("reconnect"));
    document.querySelector<HTMLFormElement>("#host-pin-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#submitHostPin(fieldValue(currentForm(event), "pin"));
    });
    document.querySelector("#copy-invite")?.addEventListener("click", () => void this.#copyInvite());
    document.querySelector("#save-invite")?.addEventListener("click", () => this.#saveInvite());
    document.querySelector("#finalize-circle")?.addEventListener("click", () => void this.#finishFirstBreath(route.path));
    document.querySelector<HTMLFormElement>("#export-pack-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#exportPack(route.path.slice("/circle/".length), fieldValue(currentForm(event), "phrase"));
    });
    this.#bindPlay(route);
    this.#bindReunion(route);
    document.querySelector("#mint-heirloom")?.addEventListener("click", () => {
      void this.#mint(route.path.slice("/heirloom/".length));
    });
    this.#drawQr();
    this.#drawOrganism(route);
    if (route.path === "/join" && route.query.get("invite") && !this.#link && this.#identity) {
      void this.#joinFromInput(route.query.get("invite") ?? "");
    }
  }

  #bindPlay(route: ReturnType<typeof routeParts>): void {
    const groupId = route.path.startsWith("/play/") ? route.path.slice("/play/".length) : "";
    if (!groupId) return;
    const talk = document.querySelector<HTMLButtonElement>("#push-to-talk");
    let globalKeyDown: ((event: KeyboardEvent) => void) | undefined;
    if (talk) {
      let pointerId: number | undefined;
      let keyboardCode = "";
      let suppressClick = false;
      const setPressed = (pressed: boolean): void => {
        talk.setAttribute("aria-pressed", String(pressed));
      };
      const startListening = (): void => {
        this.#voice.startPushToTalk();
        setPressed(true);
      };
      const stopListening = (): void => {
        this.#voice.stopListening();
        setPressed(false);
      };
      const pointerDown = (event: PointerEvent): void => {
        if (event.button !== 0) return;
        pointerId = event.pointerId;
        suppressClick = true;
        talk.setPointerCapture?.(event.pointerId);
        startListening();
      };
      const pointerRelease = (event: PointerEvent): void => {
        if (pointerId === undefined || event.pointerId !== pointerId) return;
        if (talk.hasPointerCapture?.(pointerId)) talk.releasePointerCapture(pointerId);
        pointerId = undefined;
        stopListening();
      };
      const keyDown = (event: KeyboardEvent): void => {
        if (!["Enter", "Space"].includes(event.code) || event.repeat) return;
        event.preventDefault();
        keyboardCode = event.code;
        suppressClick = true;
        startListening();
      };
      const keyUp = (event: KeyboardEvent): void => {
        if (!keyboardCode || event.code !== keyboardCode) return;
        keyboardCode = "";
        stopListening();
      };
      const click = (event: MouseEvent): void => {
        if (suppressClick) {
          suppressClick = false;
          event.preventDefault();
          return;
        }
        if (talk.getAttribute("aria-pressed") === "true") stopListening();
        else startListening();
      };
      const stopWhenHidden = (): void => {
        if (document.visibilityState !== "visible") {
          this.#voice.abortListening();
          setPressed(false);
          this.#disableCameraAssist();
        }
      };
      const stopForPage = (): void => {
        this.#voice.abortListening();
        setPressed(false);
        this.#disableCameraAssist();
      };
      globalKeyDown = (event: KeyboardEvent): void => {
        if (
          event.repeat ||
          shouldIgnoreOrbShortcut(event.target) ||
          !orbShortcutSurfaceOwnsFocus(event.target)
        ) return;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          this.#orbState = adaptiveOrbReducer(this.#orbState, { type: "rotate", delta: -1 });
          this.#paintOrbHighlight("", true);
        } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          this.#orbState = adaptiveOrbReducer(this.#orbState, { type: "rotate", delta: 1 });
          this.#paintOrbHighlight("", true);
        } else if (event.key === "Enter") {
          event.preventDefault();
          void this.#activateHighlighted("keyboard");
        } else if (event.key === "Escape") {
          event.preventDefault();
          void this.#cancelOrb();
        } else if (event.key.toLocaleLowerCase() === "u" || event.key === "Backspace") {
          event.preventDefault();
          void this.#undoOrb();
        } else if (event.key.toLocaleLowerCase() === "r") {
          event.preventDefault();
          void this.#handleOrbInput("repeat", "keyboard");
        } else if (event.code === "Space" && this.#orbShortcutMode) {
          event.preventDefault();
          if (talk.getAttribute("aria-pressed") === "true") {
            this.#voice.abortListening();
            setPressed(false);
          } else {
            startListening();
          }
        }
      };
      talk.addEventListener("pointerdown", pointerDown);
      talk.addEventListener("keydown", keyDown);
      talk.addEventListener("click", click);
      talk.addEventListener("lostpointercapture", stopListening);
      window.addEventListener("pointerup", pointerRelease, true);
      window.addEventListener("pointercancel", pointerRelease, true);
      window.addEventListener("keyup", keyUp, true);
      document.addEventListener("visibilitychange", stopWhenHidden);
      document.addEventListener("keydown", globalKeyDown);
      window.addEventListener("pagehide", stopForPage);
      window.addEventListener("blur", stopForPage);
      this.#talkCleanup = () => {
        talk.removeEventListener("pointerdown", pointerDown);
        talk.removeEventListener("keydown", keyDown);
        talk.removeEventListener("click", click);
        talk.removeEventListener("lostpointercapture", stopListening);
        window.removeEventListener("pointerup", pointerRelease, true);
        window.removeEventListener("pointercancel", pointerRelease, true);
        window.removeEventListener("keyup", keyUp, true);
        document.removeEventListener("visibilitychange", stopWhenHidden);
        if (globalKeyDown) document.removeEventListener("keydown", globalKeyDown);
        window.removeEventListener("pagehide", stopForPage);
        window.removeEventListener("blur", stopForPage);
        this.#voice.abortListening();
        this.#disableCameraAssist();
      };
    }
    document.querySelectorAll<HTMLButtonElement>("[data-orb-petal]").forEach((button) => {
      button.addEventListener("click", () => {
        this.#orbState = adaptiveOrbReducer(this.#orbState, {
          type: "highlight",
          action: button.dataset.action as OrbActionId,
        });
        this.#paintOrbHighlight();
      });
      button.addEventListener("keydown", (event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          this.#orbState = adaptiveOrbReducer(this.#orbState, { type: "rotate", delta: -1 });
          this.#paintOrbHighlight("", true);
        } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          this.#orbState = adaptiveOrbReducer(this.#orbState, { type: "rotate", delta: 1 });
          this.#paintOrbHighlight("", true);
        } else if (event.key === "Enter") {
          event.preventDefault();
          this.#orbState = adaptiveOrbReducer(this.#orbState, {
            type: "highlight",
            action: button.dataset.action as OrbActionId,
          });
          void this.#activateHighlighted("keyboard");
        }
      });
    });
    document.querySelector("#orb-center")?.addEventListener("click", () => void this.#cancelOrb());
    document
      .querySelector("#confirm-highlight")
      ?.addEventListener("click", () => void this.#activateHighlighted("confirm-control"));
    document.querySelector("#cancel-orb")?.addEventListener("click", () => void this.#cancelOrb());
    document.querySelector("#undo-orb")?.addEventListener("click", () => void this.#undoOrb());
    document.querySelector<HTMLFormElement>("#command-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = currentForm(event);
      const command = fieldValue(form, "command");
      form.reset();
      void this.#handleOrbInput(command, "typed");
    });
    document.querySelector<HTMLFormElement>("#quest-draft-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#runOrbTask(
        this.#stageQuestProposal(groupId, currentForm(event), "touch", this.#nextUserTurn()),
      );
    });
    document.querySelector<HTMLFormElement>("#offering-draft-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#runOrbTask(
        this.#stageOfferingProposal(
          groupId,
          currentForm(event),
          undefined,
          "touch",
          this.#nextUserTurn(),
        ),
      );
    });
    document
      .querySelector("#review-sign-proposal")
      ?.addEventListener("click", () => void this.#confirmPendingProposal(this.#nextUserTurn()));
    document.querySelector("#cancel-proposal")?.addEventListener("click", () => void this.#cancelOrb());
    document.querySelector<HTMLFormElement>("#demo-offering-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = currentForm(event);
      void this.#stageDemoOffering(
        groupId,
        this.#nextUserTurn(),
        (form.elements.namedItem("approved") as HTMLInputElement).checked,
      );
    });
    document
      .querySelector("#stage-reveal")
      ?.addEventListener("click", () =>
        this.#runOrbTask(this.#stageRevealProposal(groupId, "touch", this.#nextUserTurn())),
      );
    document
      .querySelector("#start-device-login")
      ?.addEventListener("click", () => void this.#startDeviceLogin());
    document.querySelector("#cancel-device-login")?.addEventListener("click", () => {
      this.#loginUiGeneration += 1;
      this.#intelligence.cancelDeviceLogin();
      this.#deviceCode = undefined;
      this.#setStatus("GitHub device sign-in cancelled. Nothing was stored.");
      void this.render();
    });
    document.querySelector("#mind-logout")?.addEventListener("click", () => void this.#logoutMind());
    document
      .querySelector<HTMLFormElement>("#verified-agent-form")
      ?.addEventListener("submit", (event) => {
        event.preventDefault();
        const form = currentForm(event);
        void this.#runVerifiedQuestAgent(
          groupId,
          fieldValue(form, "context"),
          fieldValue(form, "weather"),
          (form.elements.namedItem("safety") as HTMLInputElement).checked,
        );
      });
    document.querySelector("#stage-agent-quest")?.addEventListener("click", () => {
      this.#runOrbTask(
        this.#stageVerifiedAgentQuest(groupId, this.#nextUserTurn()),
      );
    });
    document.querySelector<HTMLFormElement>("#ai-draft-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#runOrbTask(
        this.#prepareAiPreview(groupId, fieldValue(currentForm(event), "draft")),
      );
    });
    document
      .querySelector("#approve-ai-preview")
      ?.addEventListener("click", () => void this.#sendApprovedAiPreview());
    document.querySelector("#cancel-ai-preview")?.addEventListener("click", () => {
      const ai = this.#clearAiState();
      this.#loginUiGeneration += 1;
      this.#intelligence.cancelDeviceLogin();
      this.#deviceCode = undefined;
      this.#setStatus(
        ai.requestMayHaveBeenSent
          ? "Remote request cancelled. Context bytes had already been sent; no Circle event was created."
          : "Remote context preview cancelled before its bytes were sent.",
      );
      void this.render();
    });
    document
      .querySelector("#stage-ai-offering")
      ?.addEventListener("click", () => void this.#stageAiOffering(groupId, this.#nextUserTurn()));
    document
      .querySelector("#enable-camera-assist")
      ?.addEventListener("click", () => void this.#enableCameraAssist());
    document
      .querySelector("#disable-camera-assist")
      ?.addEventListener("click", () => this.#disableCameraAssist(true));
    document.querySelector("#toggle-orb-shortcuts")?.addEventListener("click", () => {
      this.#orbShortcutMode = !this.#orbShortcutMode;
      const surface = document.querySelector<HTMLElement>("[data-orb-shortcut-surface]");
      surface?.focus();
      this.#setStatus(
        this.#orbShortcutMode
          ? "Orb shortcut mode enabled. Space may now toggle push-to-talk while the Orb background owns focus."
          : "Orb shortcut mode disabled. Native keyboard behavior is preserved.",
      );
      this.#focusAfterRender = "[data-orb-shortcut-surface]";
      void this.render();
    });
  }

  #bindReunion(route: ReturnType<typeof routeParts>): void {
    const groupId = route.path.startsWith("/reunion/") ? route.path.slice("/reunion/".length) : "";
    if (!groupId) return;
    document.querySelector("#start-reunion")?.addEventListener("click", () => void this.#startReunion(groupId));
    document.querySelector("#fresh-reunion-invite")?.addEventListener("click", () => void this.#hostReunion(groupId));
    document.querySelector("#demo-reunion")?.addEventListener("click", () => void this.#demoReunion(groupId));
    document.querySelector("#save-reunion-draft")?.addEventListener("click", () => void this.#saveReunionDraft(groupId));
    document.querySelector("#seal-reunion")?.addEventListener("click", () => void this.#sealReunion(groupId));
  }

  async #onboard(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    try {
      this.#setStatus("Generating a persistent P-256 signing identity locally…");
      const identity = await generateIdentity({
        name: fieldValue(form, "name"),
        color: fieldValue(form, "color"),
        temperament: fieldValue(form, "temperament") as LocalIdentity["companion"]["temperament"],
        voiceSeed: fieldValue(form, "voiceSeed"),
      });
      await saveIdentity(this.#db(), identity);
      this.#identity = identity;
      await storagePersistenceState();
      const pending = sessionStorage.getItem("pending-route");
      sessionStorage.removeItem("pending-route");
      this.#setStatus("Companion and private signing key stored only on this device.");
      location.hash = pending || "#/circles";
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #createCircle(form: HTMLFormElement): Promise<void> {
    try {
      const group = await createCircleDraft(
        this.#db(),
        this.#identityRequired(),
        fieldValue(form, "name"),
        fieldValue(form, "oath"),
      );
      this.#setStatus("Circle draft is local. Gather another person for first breath.");
      this.#navigate(`/circle/${group.id}`);
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #makeDemo(): Promise<void> {
    try {
      const group = await createOfflineDemo(this.#db(), this.#identityRequired());
      this.#setStatus("Created an explicitly simulated offline Circle; no co-presence claim is made.");
      this.#navigate(`/circle/${group.id}`);
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #hostOfferFromRoute(mode: OfferMode): Promise<void> {
    const path = routeParts().path;
    const groupId = path.slice("/circle/".length);
    const group = await getCircle(this.#db(), groupId);
    if (!group) return;
    try {
      await this.#startHost(group, mode);
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #startHost(
    group: CircleRecord,
    mode: OfferMode,
    challenge?: ReunionChallenge,
  ): Promise<void> {
    this.#clearLinkState();
    this.#pendingHost = undefined;
    this.#link = this.#newLink();
    try {
      this.#invite = await this.#link.host(group, mode, challenge);
      await this.render();
    } catch (error) {
      this.#clearLinkState();
      throw error;
    }
  }

  #newLink(): CircleLinkController {
    return new CircleLinkController(this.#db(), this.#identityRequired(), {
      onStatus: (message) => this.#setStatus(message),
      onError: (message) => {
        this.#setStatus(`Safe failure: ${message}`);
        this.#clearLinkState();
        void this.render();
      },
      onOfferExpired: () => {
        this.#invite = undefined;
        this.#pendingHost = undefined;
        void this.render();
      },
      onLinkClosed: () => {
        this.#clearLinkState();
        void this.render();
      },
      onHostPinNeeded: (member) => {
        this.#pendingHost = member;
        this.#focusAfterRender = '#host-pin-form input[name="pin"]';
        void this.render();
      },
      onJoinerPin: (pin) => {
        this.#joinPin = pin;
        this.#focusAfterRender = "#join-pin-output";
        void this.render();
      },
      onComplete: () => {
        this.#pendingHost = undefined;
        void this.render();
      },
      onReunionRequest: (challenge) => {
        this.#pendingReunion = challenge;
        void this.render();
      },
      onReunionApproval: (approval) => {
        if (!this.#reunionApprovals.some((item) => item.memberId === approval.memberId)) {
          this.#reunionApprovals.push(approval);
        }
        void this.render();
      },
    });
  }

  async #submitHostPin(pin: string): Promise<void> {
    try {
      const accepted = await this.#link?.submitHostPin(pin);
      if (accepted) this.#pendingHost = undefined;
      await this.render();
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #joinFromInput(input: string): Promise<void> {
    try {
      this.#scanner.stop();
      const invite = decodeInvite(input);
      const existing = await getCircle(this.#db(), invite.groupId);
      if (existing && invite.mode === "first-breath" && existing.status !== "forming") {
        throw new Error("First breath is closed; ask for a reconnect QR");
      }
      this.#invite = invite;
      this.#joinPin = "";
      this.#link?.dispose();
      this.#link = this.#newLink();
      await this.#link.join(invite);
    } catch (error) {
      this.#clearLinkState();
      this.#setStatus(this.#error(error));
    }
  }

  async #startScanner(): Promise<void> {
    const video = document.querySelector<HTMLVideoElement>("#scanner-video");
    if (!video) return;
    try {
      this.#disableCameraAssist();
      await this.#scanner.start(video, (text) => void this.#joinFromInput(text), (text) => this.#setStatus(text));
    } catch (error) {
      this.#setStatus(`Camera unavailable: ${this.#error(error)}. Paste, type, or load a file instead.`);
    }
  }

  async #readInviteFile(form: HTMLFormElement): Promise<void> {
    try {
      const file = (form.elements.namedItem("file") as HTMLInputElement).files?.[0];
      if (!file || file.size > 8_192) throw new Error("Invite file missing or over 8 KiB");
      const parsed = boundedJsonParse<{ invite?: BootstrapInvite }>(await file.text(), 8_192);
      const invite = parsed.invite ?? (parsed as unknown as BootstrapInvite);
      await this.#joinFromInput(encodeInviteCode(invite));
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #approveJoinedReunion(): Promise<void> {
    try {
      await this.#link?.approvePendingReunion();
      this.#pendingReunion = undefined;
      await this.render();
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #copyInvite(): Promise<void> {
    const link = document.querySelector<HTMLTextAreaElement>("#invite-link")?.value;
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      this.#setStatus("Invite link copied. It contains a five-minute secret; share only with the intended person.");
    } catch {
      document.querySelector<HTMLTextAreaElement>("#invite-link")?.select();
      this.#setStatus("Clipboard blocked; link selected for manual copy.");
    }
  }

  #saveInvite(): void {
    if (!this.#invite) return;
    downloadFile(
      `${this.#invite.mode}-${this.#invite.offerId}.rapp-invite.json`,
      canonicalStringify({ format: "rapp-heir-invite", invite: this.#invite }),
      "application/json",
    );
    this.#setStatus("Invite file saved. Treat it like the QR: it contains an expiring secret.");
  }

  async #finishFirstBreath(path: string): Promise<void> {
    try {
      const groupId = path.slice("/circle/".length);
      await finalizeCircle(this.#db(), groupId, this.#identityRequired());
      this.#invite = undefined;
      this.#link?.dispose();
      this.#setStatus("Circle founded. Genesis is now stable and equal across sorted founder seeds.");
      await this.render();
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #exportPack(groupId: string, phrase: string): Promise<void> {
    try {
      this.#setStatus("Canonicalizing and encrypting full replica locally…");
      const bundle = await makeReplicaBundle(this.#db(), groupId);
      const envelope = await encryptHeirpack(bundle, phrase);
      const group = bundle.group.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
      downloadFile(`${group || "circle"}.heirpack`, canonicalStringify(envelope), "application/json");
      this.#setStatus("Encrypted heirpack exported; delivery remains unknown until the recipient verifies it.");
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #importFile(form: HTMLFormElement): Promise<void> {
    try {
      const input = form.elements.namedItem("file") as HTMLInputElement;
      const file = input.files?.[0];
      if (!file || file.size > 4_000_000) throw new Error("Choose a file under 4 MB");
      const text = await file.text();
      const parsed = boundedJsonParse<Record<string, unknown>>(text, 4_000_000);
      if (parsed.format === "rapp-heir-heirpack") {
        const phrase = fieldValue(form, "phrase");
        const bundle = await decryptHeirpack<Awaited<ReturnType<typeof makeReplicaBundle>>>(
          parsed as never,
          phrase,
        );
        const result = await mergeReplicaBundle(this.#db(), bundle);
        this.#setStatus(`Heirpack authenticated and atomically merged: ${result.added} new event(s).`);
        this.#navigate(`/circle/${bundle.group.id}`);
      } else if (parsed.format === "rapp-heir") {
        const artifact = parsed as unknown as HeirloomArtifact;
        const verified = await verifyHeirloom(artifact);
        await importVerifiedHeirloom(this.#db(), artifact);
        this.#setStatus(`Heirloom verified on this device: package ${shortId(verified.packageHash)}.`);
        this.#navigate(`/artifact/${verified.packageHash}`);
      } else {
        throw new Error("File is neither a .heirpack nor a Rapp Heir artifact");
      }
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  #nextUserTurn(): number {
    this.#userTurn += 1;
    return this.#userTurn;
  }

  #runOrbTask(task: Promise<void>): void {
    void task.catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.#setAlert(this.#error(error));
    });
  }

  #proposalOrigin(source: OrbUserSource): ProposalOrigin {
    return source === "typed" ? "typed" : source === "voice" ? "voice" : source;
  }

  #paintOrbHighlight(extra = "", moveFocus = false): void {
    const selected = highlightedPetal(this.#orbState);
    let selectedButton: HTMLButtonElement | undefined;
    document.querySelectorAll<HTMLButtonElement>("[data-orb-petal]").forEach((button) => {
      const highlighted = button.dataset.action === this.#orbState.highlighted;
      button.classList.toggle("highlighted", highlighted);
      button.setAttribute("aria-pressed", String(highlighted));
      if (highlighted) selectedButton = button;
    });
    if (moveFocus) selectedButton?.focus();
    const status = document.querySelector<HTMLElement>("#orb-highlight");
    if (status) {
      status.textContent = `Highlighted: ${
        selected?.label ?? "Center (safe cancel)"
      }. Not activated.${extra ? ` ${extra}` : ""}`;
    }
  }

  async #activateHighlighted(source: OrbActivation["source"], turn?: number): Promise<void> {
    this.#orbState = adaptiveOrbReducer(this.#orbState, { type: "confirm", source });
    const activation = this.#orbState.activation;
    this.#orbState = adaptiveOrbReducer(this.#orbState, { type: "clear-activation" });
    if (!activation) {
      await this.#cancelOrb();
      return;
    }
    await this.#activateOrbAction(
      activation.action,
      source === "voice" ? "voice" : source === "keyboard" ? "keyboard" : "touch",
      turn ?? this.#nextUserTurn(),
    );
  }

  async #activateOrbAction(
    action: OrbActionId,
    source: OrbUserSource,
    turn: number,
  ): Promise<void> {
    const path = routeParts().path;
    const groupId = path.startsWith("/play/") ? path.slice("/play/".length) : "";
    if (!groupId) return;
    try {
      if (action === "continue") {
        await this.#runReadOnly(groupId, { type: "turn" });
      } else if (action === "new-quest") {
        this.#orbState = adaptiveOrbReducer(this.#orbState, {
          type: "enter",
          mode: "tunnel",
          label: "New Quest",
        });
        this.#voiceOutput = "Quest tunnel opened. Choose broad context, then stage a proposal.";
        await this.render();
      } else if (action === "offer") {
        this.#orbState = adaptiveOrbReducer(this.#orbState, {
          type: "enter",
          mode: "tunnel",
          label: "Offer",
        });
        this.#voiceOutput = "Offering tunnel opened. Drafting creates no signed event.";
        await this.render();
      } else if (action === "recap") {
        await this.#runReadOnly(groupId, { type: "recap" });
      } else if (action === "rest") {
        await this.#stageRestProposal(groupId, this.#proposalOrigin(source), turn);
      } else if (action === "sync") {
        this.#setStatus("Choose Fresh sync QR; no known peer is silently trusted.");
        this.#navigate(`/circle/${groupId}`);
      } else if (action === "reunion") {
        this.#navigate(`/reunion/${groupId}`);
      } else {
        this.#orbState = adaptiveOrbReducer(this.#orbState, {
          type: "enter",
          mode: "tunnel",
          label: "Mind",
        });
        this.#voiceOutput = this.#intelligence.authenticated
          ? "Remote mind tunnel opened. A message first becomes an exact context preview."
          : "Sign-in tunnel opened. Device sign-in sends zero Circle content.";
        await this.render();
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.#setAlert(this.#error(error));
    }
  }

  async #cancelOrb(): Promise<void> {
    const proposalCancellation = this.#proposalGate.cancel();
    if (proposalCancellation.commitStarted) {
      this.#voiceOutput =
        "Atomic signing already began. Cancellation cannot promise zero events; wait for the result.";
      this.#setStatus(this.#voiceOutput);
      await this.render();
      return;
    }
    const ai = this.#clearAiState();
    this.#clearAgentState();
    this.#loginUiGeneration += 1;
    this.#intelligence.cancelDeviceLogin();
    this.#deviceCode = undefined;
    this.#orbState = adaptiveOrbReducer(this.#orbState, { type: "cancel" });
    this.#voiceOutput = ai.requestMayHaveBeenSent
      ? "Centered safely. The remote request was aborted but bytes had already been sent; drafts were cleared and zero Circle events were created."
      : "Centered safely. Drafts were cancelled and zero Circle events were created.";
    this.#focusAfterRender = "#orb-center";
    this.#setStatus(this.#voiceOutput);
    await this.render();
  }

  async #undoOrb(): Promise<void> {
    const proposalCancellation = this.#proposalGate.cancel();
    if (proposalCancellation.commitStarted) {
      this.#setStatus("Atomic signing already began; undo cannot cancel that commit.");
      return;
    }
    this.#clearAiState();
    this.#clearAgentState();
    this.#loginUiGeneration += 1;
    this.#intelligence.cancelDeviceLogin();
    this.#deviceCode = undefined;
    this.#orbState = adaptiveOrbReducer(this.#orbState, { type: "undo" });
    this.#voiceOutput = "Undid the current draft step. No event was created.";
    this.#focusAfterRender = "#orb-caption";
    this.#setStatus(this.#voiceOutput);
    await this.render();
  }

  async #handleOrbInput(input: string, source: OrbUserSource): Promise<void> {
    const path = routeParts().path;
    const groupId = path.startsWith("/play/") ? path.slice("/play/".length) : "";
    if (!groupId) {
      this.#setStatus("Open a Circle’s Pocket Quest Master to use game commands.");
      return;
    }
    const turn = this.#nextUserTurn();
    const intent = parseOrbInput(input, {
      source: "user",
      petals: this.#orbState.petals,
    });
    try {
      if (intent.kind === "stop") {
        this.#voice.stopAll();
        const ai = this.#clearAiState();
        this.#clearAgentState();
        this.#loginUiGeneration += 1;
        this.#intelligence.cancelDeviceLogin();
        this.#deviceCode = undefined;
        document.querySelector(".device-code-panel")?.remove();
        document.querySelector("#push-to-talk")?.setAttribute("aria-pressed", "false");
        this.#setAlert(
          ai.requestMayHaveBeenSent
            ? "Stopped microphone, speech, and remote stream. Request bytes had already been sent; stale callbacks are ignored."
            : "Stopped microphone, speech, and remote request before context bytes were sent. Stale callbacks are ignored.",
        );
        await this.render();
      } else if (intent.kind === "cancel") {
        await this.#cancelOrb();
      } else if (intent.kind === "undo") {
        await this.#undoOrb();
      } else if (intent.kind === "confirm-pending") {
        if (this.#proposalGate.pending) {
          await this.#confirmPendingProposal(turn);
        } else {
          await this.#activateHighlighted(
            source === "voice" ? "voice" : source === "keyboard" ? "keyboard" : "confirm-control",
            turn,
          );
        }
      } else if (intent.kind === "read-only") {
        await this.#runReadOnly(groupId, intent.command);
      } else if (intent.kind === "mutating") {
        if (intent.command.type === "create-quest") {
          await this.#stageQuestProposal(
            groupId,
            undefined,
            this.#proposalOrigin(source),
            turn,
          );
        } else if (intent.command.type === "offer") {
          if (!intent.command.text) {
            this.#orbState = adaptiveOrbReducer(this.#orbState, {
              type: "enter",
              mode: "tunnel",
              label: "Offer",
            });
            this.#voiceOutput = "Draft the offering, then stage it. Voice never auto-commits.";
            await this.render();
          } else {
            await this.#stageOfferingProposal(
              groupId,
              undefined,
              intent.command.text,
              this.#proposalOrigin(source),
              turn,
            );
          }
        } else if (intent.command.type === "rest") {
          await this.#stageRestProposal(groupId, this.#proposalOrigin(source), turn);
        } else {
          await this.#stageRevealProposal(groupId, this.#proposalOrigin(source), turn);
        }
      } else if (intent.kind === "navigation") {
        if (intent.command.type === "sync") {
          this.#setStatus("Choose Fresh sync QR; no known peer is silently trusted.");
          this.#navigate(`/circle/${groupId}`);
        } else {
          this.#navigate(`/reunion/${groupId}`);
        }
      } else if (intent.kind === "petal") {
        this.#orbState = adaptiveOrbReducer(this.#orbState, {
          type: "highlight",
          action: intent.petalId as OrbActionId,
        });
        this.#paintOrbHighlight("Say “confirm,” press Enter, or use the Confirm control to activate.");
      } else if (intent.kind === "freeform-ai") {
        await this.#prepareAiPreview(groupId, intent.text);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.#setAlert(this.#error(error));
    }
  }

  async #runReadOnly(
    groupId: string,
    command: Extract<PocketCommand, { type: "turn" | "recap" | "help" | "repeat" }>,
  ): Promise<void> {
    const routeGeneration = this.#routeGeneration;
    const assertCurrent = (): void => {
      if (!this.#playReservationIsCurrent(groupId, routeGeneration)) {
        throw new DOMException("Caption request was cancelled", "AbortError");
      }
    };
    if (command.type === "repeat") {
      this.#voice.repeat();
      return;
    }
    if (command.type === "help") {
      this.#voiceOutput =
        "Try: my turn, new quest, offer…, rest, reveal, recap, sync, reunion, mind, confirm, cancel, undo, repeat, or stop.";
    } else if (command.type === "turn") {
      const events = await getCircleEvents(this.#db(), groupId);
      assertCurrent();
      const quest = latestQuest(events);
      if (!quest) throw new Error("No quest yet. Highlight New Quest, then confirm.");
      const leg = await deriveQuestLeg(quest, this.#identityRequired().memberId, events);
      assertCurrent();
      this.#voiceOutput = `${leg.role}, ${leg.minutes} minutes. ${leg.prompt}`;
    } else {
      const events = await getCircleEvents(this.#db(), groupId);
      assertCurrent();
      const reveal = events
        .filter((event) => event.body.type === "quest.reveal")
        .sort(
          (left, right) =>
            left.body.createdAt.localeCompare(right.body.createdAt) ||
            left.id.localeCompare(right.id),
        )
        .at(-1);
      this.#voiceOutput = reveal
        ? String(reveal.body.payload.text)
        : "No signed shared reveal has arrived yet.";
    }
    assertCurrent();
    this.#voice.speak(this.#voiceOutput);
    await this.render();
  }

  async #proposalState(groupId: string): Promise<{
    group: CircleRecord;
    events: Awaited<ReturnType<typeof getCircleEvents>>;
    binding: ProposalBinding;
  }>;
  async #proposalState(
    groupId: string,
    assertCurrent: () => void,
  ): Promise<{
    group: CircleRecord;
    events: Awaited<ReturnType<typeof getCircleEvents>>;
    binding: ProposalBinding;
  }>;
  async #proposalState(
    groupId: string,
    assertCurrent: () => void = () => undefined,
  ): Promise<{
    group: CircleRecord;
    events: Awaited<ReturnType<typeof getCircleEvents>>;
    binding: ProposalBinding;
  }> {
    const [group, events] = await Promise.all([
      getCircle(this.#db(), groupId),
      getCircleEvents(this.#db(), groupId),
    ]);
    assertCurrent();
    if (!group) throw new Error("Circle missing");
    const root = await eventRoot(events);
    assertCurrent();
    const stateDigest = await stateDigestForProposal(group, root);
    assertCurrent();
    return {
      group,
      events,
      binding: {
        circleId: group.id,
        eventRoot: root,
        stateDigest,
      },
    };
  }

  #assertStageCurrent(
    groupId: string,
    reservation: number,
    routeGeneration: number,
  ): void {
    if (
      !this.#proposalGate.stageReservationIsCurrent(reservation) ||
      !this.#playReservationIsCurrent(groupId, routeGeneration)
    ) {
      throw new DOMException("Proposal staging was cancelled", "AbortError");
    }
  }

  async #stageEventProposal(
    binding: ProposalBinding,
    authorMemberId: string,
    eventType: string,
    payload: Record<string, unknown>,
    preview: string,
    origin: ProposalOrigin,
    originTurn: number,
    reservation: number,
    routeGeneration: number,
  ): Promise<void> {
    this.#assertStageCurrent(binding.circleId, reservation, routeGeneration);
    const proposal = await stagePendingProposal({
      binding,
      authorMemberId,
      eventType,
      payload,
      preview,
      origin,
      originTurn,
    });
    this.#assertStageCurrent(binding.circleId, reservation, routeGeneration);
    this.#proposalGate.stage(proposal, reservation);
    this.#orbState = adaptiveOrbReducer(this.#orbState, {
      type: "enter",
      mode: "compass",
      label: "Review & sign",
    });
    this.#voiceOutput = `${preview} No event exists yet. Review, then confirm in a separate turn.`;
    this.#focusAfterRender = "#proposal-title";
    this.#setStatus("Proposal staged in memory. Circle history is unchanged.");
    await this.render();
  }

  async #stageQuestProposal(
    groupId: string,
    form: HTMLFormElement | undefined,
    origin: ProposalOrigin,
    turn: number,
  ): Promise<void> {
    const reservation = this.#proposalGate.reserveStage();
    const routeGeneration = this.#routeGeneration;
    const context = form ? fieldValue(form, "context") : "unknown";
    const weather = form ? fieldValue(form, "weather") : "unknown";
    const assertCurrent = (): void =>
      this.#assertStageCurrent(groupId, reservation, routeGeneration);
    const { group, events, binding } = await this.#proposalState(groupId, assertCurrent);
    const quest = await createQuest(
      group,
      events,
      context,
      weather,
    );
    assertCurrent();
    await this.#stageEventProposal(
      binding,
      this.#identityRequired().memberId,
      "quest.created",
      { ...questPayload(quest), promptSource: "offline-template" },
      `Create offline quest “${quest.title}” with ${quest.contextClass}/${quest.weatherBand} context.`,
      origin,
      turn,
      reservation,
      routeGeneration,
    );
  }

  async #stageOfferingProposal(
    groupId: string,
    form: HTMLFormElement | undefined,
    commandText: string | undefined,
    origin: ProposalOrigin,
    turn: number,
  ): Promise<void> {
    const reservation = this.#proposalGate.reserveStage();
    const routeGeneration = this.#routeGeneration;
    const formValues = form
      ? {
          text: fieldValue(form, "text"),
          choice: fieldValue(form, "choice"),
          trait: fieldValue(form, "trait") || undefined,
          includeContext: (form.elements.namedItem("context") as HTMLInputElement).checked,
          approved: (form.elements.namedItem("approved") as HTMLInputElement).checked,
        }
      : undefined;
    const assertCurrent = (): void =>
      this.#assertStageCurrent(groupId, reservation, routeGeneration);
    const { group, events, binding } = await this.#proposalState(groupId, assertCurrent);
    const quest = latestQuest(events);
    if (!quest) throw new Error("Begin a quest first");
    const memberId = this.#identityRequired().memberId;
    assertMemberCanOffer(events, quest.questId, memberId);
    const offering = sanitizeOffering(
      {
        questId: quest.questId,
        memberId,
        text: commandText ?? formValues?.text ?? "",
        choice: commandText
          ? "carry the spoken thread"
          : formValues?.choice ?? "",
        selectedTrait: formValues?.trait,
        contextClass: formValues?.includeContext ? quest.contextClass : undefined,
        approvedForHeirloom: Boolean(formValues?.approved),
      },
      group,
    );
    await this.#stageEventProposal(
      binding,
      memberId,
      "quest.offering",
      offeringPayload(offering),
      `Offer “${offering.text}” and leave choice “${offering.choice}”.`,
      origin,
      turn,
      reservation,
      routeGeneration,
    );
  }

  async #stageRestProposal(
    groupId: string,
    origin: ProposalOrigin,
    turn: number,
  ): Promise<void> {
    const reservation = this.#proposalGate.reserveStage();
    const routeGeneration = this.#routeGeneration;
    const assertCurrent = (): void =>
      this.#assertStageCurrent(groupId, reservation, routeGeneration);
    const { events, binding } = await this.#proposalState(groupId, assertCurrent);
    const quest = latestQuest(events);
    if (!quest) throw new Error("No quest is active");
    await this.#stageEventProposal(
      binding,
      this.#identityRequired().memberId,
      "quest.rest",
      { questId: quest.questId, reason: "rest-without-streak-or-penalty" },
      "Rest this lobe without guilt, score, or streak.",
      origin,
      turn,
      reservation,
      routeGeneration,
    );
  }

  async #stageDemoOffering(
    groupId: string,
    turn: number,
    approvedForHeirloom: boolean,
  ): Promise<void> {
    try {
      const reservation = this.#proposalGate.reserveStage();
      const routeGeneration = this.#routeGeneration;
      const assertCurrent = (): void =>
        this.#assertStageCurrent(groupId, reservation, routeGeneration);
      const [{ group, events, binding }, demo] = await Promise.all([
        this.#proposalState(groupId, assertCurrent),
        getDemoIdentity(this.#db(), groupId),
      ]);
      assertCurrent();
      if (!group.demo || !demo) throw new Error("No practice companion");
      const quest = latestQuest(events);
      if (!quest) throw new Error("Begin a quest first");
      assertMemberCanOffer(events, quest.questId, demo.memberId);
      const leg = await deriveQuestLeg(quest, demo.memberId, events);
      assertCurrent();
      const offering = sanitizeOffering(
        {
          questId: quest.questId,
          memberId: demo.memberId,
          text: `Morrow noticed the ${leg.influenceMark} thread and folded it into a paper doorway.`,
          choice: `turn toward mark ${leg.influenceMark.slice(0, 4)}`,
          selectedTrait: demo.companion.temperament,
          approvedForHeirloom,
        },
        group,
      );
      await this.#stageEventProposal(
        binding,
        demo.memberId,
        "quest.offering",
        offeringPayload(offering),
        `Let simulated Morrow offer “${offering.text}” with its on-device demo key.`,
        "practice",
        turn,
        reservation,
        routeGeneration,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.#setAlert(this.#error(error));
    }
  }

  async #stageRevealProposal(
    groupId: string,
    origin: ProposalOrigin,
    turn: number,
  ): Promise<void> {
    const reservation = this.#proposalGate.reserveStage();
    const routeGeneration = this.#routeGeneration;
    const assertCurrent = (): void =>
      this.#assertStageCurrent(groupId, reservation, routeGeneration);
    const { events, binding } = await this.#proposalState(groupId, assertCurrent);
    const quest = latestQuest(events);
    if (!quest) throw new Error("No quest is active");
    const reveal = await deriveSharedReveal(quest, events);
    assertCurrent();
    await this.#stageEventProposal(
      binding,
      this.#identityRequired().memberId,
      "quest.reveal",
      {
        questId: quest.questId,
        text: reveal.text,
        influenceRoot: reveal.influenceRoot,
        memberIds: reveal.memberIds,
        sourceOfferingIds: reveal.sourceOfferingIds,
        approvedForHeirloom: reveal.approvedForHeirloom,
      },
      `Reveal the signed Braid from ${reveal.memberIds.length} distinct member offerings.`,
      origin,
      turn,
      reservation,
      routeGeneration,
    );
  }

  async #sanitizePendingPayload(
    group: CircleRecord,
    events: Awaited<ReturnType<typeof getCircleEvents>>,
    eventType: string,
    payload: Record<string, unknown>,
    proposal: PendingProposal,
  ): Promise<Record<string, unknown>> {
    const text = (key: string, maximum: number): string => {
      const value = payload[key];
      if (typeof value !== "string" || !value.trim() || value.length > maximum) {
        throw new Error(`Proposal ${key} is invalid`);
      }
      return value;
    };
    if (eventType === "quest.created") {
      if (group.status === "forming") throw new Error("Finish first breath before beginning a quest");
      const memberOrder = Array.isArray(payload.memberOrder) ? payload.memberOrder.map(String) : [];
      const active = Object.keys(group.members)
        .filter((memberId) => group.members[memberId]?.active)
        .sort();
      if (canonicalStringify(memberOrder) !== canonicalStringify(active)) {
        throw new Error("Quest member order no longer matches the Circle");
      }
      const rawRoles =
        payload.roles && typeof payload.roles === "object" && !Array.isArray(payload.roles)
          ? (payload.roles as Record<string, unknown>)
          : {};
      const roles = Object.fromEntries(
        active.map((memberId) => {
          const role = rawRoles[memberId];
          if (typeof role !== "string" || !QUEST_ROLES.includes(role as Quest["roles"][string])) {
            throw new Error("Quest role is invalid");
          }
          return [memberId, role];
        }),
      ) as Quest["roles"];
      const contextClass = text("contextClass", 24);
      const weatherBand = text("weatherBand", 24);
      if (
        !["indoors", "doorstep", "park", "street", "transit", "waterside", "unknown"].includes(
          contextClass,
        ) ||
        !["clear", "clouded", "rain", "snow", "wind", "warm", "cold", "unknown"].includes(
          weatherBand,
        )
      ) {
        throw new Error("Quest context is outside the broad local vocabulary");
      }
      const createdAt = text("createdAt", 40);
      if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Quest time is invalid");
      const quest: Quest = {
        questId: text("questId", 80),
        title: text("title", 120),
        premise: text("premise", 700),
        createdAt,
        contextClass,
        weatherBand,
        memberOrder,
        roles,
      };
      if (payload.promptSource === "offline-template") {
        return { ...questPayload(quest), promptSource: "offline-template" };
      }
      const verification =
        payload.agentVerification &&
        typeof payload.agentVerification === "object" &&
        !Array.isArray(payload.agentVerification)
          ? (payload.agentVerification as Record<string, unknown>)
          : {};
      if (
        payload.promptSource !== "verified-rapp-agent" ||
        verification.agent !== "QuestMaster" ||
        verification.manifestHash !== PINNED_AGENT_MANIFEST_HASH ||
        verification.sourceHash !==
          "5a155774b590d2127fda09b563fb04611b525082829b1da6c1ad7a0e28fd1e5d"
      ) {
        throw new Error("Quest source is not a hash-pinned reviewed agent");
      }
      return {
        ...questPayload(quest),
        promptSource: "verified-rapp-agent",
        agentVerification: {
          agent: "QuestMaster",
          manifestHash: PINNED_AGENT_MANIFEST_HASH,
          sourceHash:
            "5a155774b590d2127fda09b563fb04611b525082829b1da6c1ad7a0e28fd1e5d",
        },
      };
    }
    if (eventType === "quest.offering") {
      const offering = sanitizeOffering(
        {
          questId: text("questId", 80),
          memberId: proposal.authorMemberId,
          text: text("text", 600),
          choice: text("choice", 48),
          selectedTrait:
            typeof payload.selectedTrait === "string" ? payload.selectedTrait : undefined,
          contextClass:
            typeof payload.contextClass === "string" ? payload.contextClass : undefined,
          approvedForHeirloom: payload.approvedForHeirloom === true,
        },
        group,
      );
      const quest = latestQuest(events);
      if (!quest || quest.questId !== offering.questId) {
        throw new Error("Offering no longer targets the current quest");
      }
      assertMemberCanOffer(events, quest.questId, proposal.authorMemberId);
      return offeringPayload(offering);
    }
    if (eventType === "quest.rest") {
      const quest = latestQuest(events);
      if (!quest || payload.questId !== quest.questId) {
        throw new Error("Rest no longer targets the current quest");
      }
      return {
        questId: quest.questId,
        reason: "rest-without-streak-or-penalty",
      };
    }
    if (eventType === "quest.reveal") {
      const quest = latestQuest(events);
      if (!quest) throw new Error("No quest is active");
      const reveal = await deriveSharedReveal(quest, events);
      return {
        questId: quest.questId,
        text: reveal.text,
        influenceRoot: reveal.influenceRoot,
        memberIds: reveal.memberIds,
        sourceOfferingIds: reveal.sourceOfferingIds,
        approvedForHeirloom: reveal.approvedForHeirloom,
      };
    }
    throw new Error("Unrecognized proposal event type");
  }

  async #confirmPendingProposal(turn: number): Promise<void> {
    const pending = this.#proposalGate.pending;
    if (!pending) {
      this.#setAlert("There is no pending proposal to confirm.");
      return;
    }
    const routeGeneration = this.#routeGeneration;
    const assertCurrentRoute = (): void => {
      if (
        !this.#playReservationIsCurrent(pending.circleId, routeGeneration) ||
        this.#proposalGate.pending?.id !== pending.id
      ) {
        throw new DOMException("Proposal confirmation was cancelled", "AbortError");
      }
    };
    try {
      const { group, events, binding } = await this.#proposalState(
        pending.circleId,
        assertCurrentRoute,
      );
      const local = this.#identityRequired();
      const demo = group.demo ? await getDemoIdentity(this.#db(), group.id) : undefined;
      assertCurrentRoute();
      const confirmed = await this.#proposalGate.confirm({
        binding,
        confirmingMemberId: local.memberId,
        confirmationTurn: turn,
        authorize: (proposal, confirmingMemberId) =>
          Boolean(
            group.members[confirmingMemberId]?.active &&
              (proposal.authorMemberId === confirmingMemberId ||
                (group.demo && demo?.memberId === proposal.authorMemberId)),
          ),
        sanitize: (eventType, payload, proposal) =>
          this.#sanitizePendingPayload(group, events, eventType, payload, proposal),
        sign: async (eventType, payload, proposal) => {
          if (proposal.authorMemberId === local.memberId) {
            await appendLocalEventExpectedRoot(
              this.#db(),
              group.id,
              local,
              eventType,
              payload,
              proposal.binding.eventRoot,
            );
          } else if (group.demo && demo?.memberId === proposal.authorMemberId) {
            await appendDemoEventExpectedRoot(
              this.#db(),
              group.id,
              eventType,
              payload,
              proposal.binding.eventRoot,
            );
          } else {
            throw new Error("Proposal signer is unavailable");
          }
        },
        onCommitStart: () => {
          const sign = document.querySelector<HTMLButtonElement>("#review-sign-proposal");
          const cancel = document.querySelector<HTMLButtonElement>("#cancel-proposal");
          if (sign) {
            sign.disabled = true;
            sign.textContent = "Signing atomically…";
          }
          if (cancel) {
            cancel.disabled = true;
            cancel.textContent = "Signing cannot be cancelled";
          }
          this.#setStatus(
            "Atomic signing has begun. Cancel can no longer promise zero events.",
          );
        },
      });
      if (!this.#playReservationIsCurrent(pending.circleId, routeGeneration)) return;
      this.#orbState = adaptiveOrbReducer(this.#orbState, { type: "cancel" });
      this.#voiceOutput = `Signed exactly one ${confirmed.eventType} event. It is ready-not-sent.`;
      this.#focusAfterRender = "#orb-caption";
      this.#voice.speak(this.#voiceOutput);
      this.#setStatus(this.#voiceOutput);
      await this.render();
    } catch (error) {
      if (/state changed/iu.test(this.#error(error))) this.#proposalGate.cancel();
      if (!this.#playReservationIsCurrent(pending.circleId, routeGeneration)) return;
      this.#setAlert(this.#error(error));
      await this.render();
    }
  }

  async #startDeviceLogin(): Promise<void> {
    this.#nextUserTurn();
    const generation = ++this.#loginUiGeneration;
    try {
      const session = await this.#intelligence.startDeviceLogin({
        onStatus: (status) => {
          if (generation === this.#loginUiGeneration) this.#setStatus(status);
        },
      });
      if (generation !== this.#loginUiGeneration) return;
      this.#deviceCode = session.device;
      this.#focusAfterRender = "#device-code-title";
      await this.render();
      void session.completion
        .then(async (result) => {
          if (generation !== this.#loginUiGeneration) return;
          this.#deviceCode = undefined;
          if (result.status === "authenticated") {
            this.#voiceOutput =
              "Copilot connected with memory-only tokens. No Circle content was sent during sign-in.";
            this.#focusAfterRender = "#command-input";
          }
          if (routeParts().path.startsWith("/play/")) await this.render();
        })
        .catch((error: unknown) => {
          if (generation !== this.#loginUiGeneration) return;
          this.#deviceCode = undefined;
          this.#setAlert(this.#error(error));
          if (routeParts().path.startsWith("/play/")) void this.render();
        });
    } catch (error) {
      if (generation !== this.#loginUiGeneration) return;
      this.#deviceCode = undefined;
      this.#setAlert(this.#error(error));
    }
  }

  async #runVerifiedQuestAgent(
    groupId: string,
    contextClass: string,
    weatherBand: string,
    runSafety: boolean,
  ): Promise<void> {
    this.#clearAgentState();
    const generation = this.#agentUiGeneration;
    const routeGeneration = this.#routeGeneration;
    const controller = new AbortController();
    this.#agentAbort = controller;
    this.#agentRunning = true;
    this.#setStatus(
      `Loading pinned Pyodide ${PYODIDE_VERSION} and verifying the pinned RAPP manifest and source…`,
    );
    const assertCurrent = (): void => {
      if (
        generation !== this.#agentUiGeneration ||
        controller.signal.aborted ||
        !this.#playReservationIsCurrent(groupId, routeGeneration)
      ) {
        throw new DOMException("Verified agent run was cancelled", "AbortError");
      }
    };
    let state:
      | {
          group: CircleRecord;
          events: Awaited<ReturnType<typeof getCircleEvents>>;
          binding: ProposalBinding;
        }
      | undefined;
    try {
      state = await this.#proposalState(groupId, assertCurrent);
      const activeMembers = Object.values(state.group.members)
        .filter((member) => member.active)
        .sort((left, right) => left.memberId.localeCompare(right.memberId));
      const client = new AgentCellClient();
      this.#agentCell = client;
      const questMaster = await client.runAgent(
        "QuestMaster",
        {
          context_class: contextClass,
          weather_band: weatherBand,
          companion_traits: activeMembers.map((member) => member.companion.temperament),
          history_summary: "",
          member_count: activeMembers.length,
        },
        controller.signal,
      );
      assertCurrent();
      const proposal = parseQuestMasterOutput(questMaster.output);
      if (proposal.memberCount !== activeMembers.length) {
        throw new Error("Verified QuestMaster changed the active member count");
      }
      let safety: QuestSafetyDecision | undefined;
      let safetyOutput: string | undefined;
      let questSafety: AgentCellResult | undefined;
      if (runSafety) {
        const candidate = questSafetyCandidate(proposal);
        questSafety = await client.runAgent(
          "QuestSafety",
          {
            candidate_text: candidate,
            context_class: proposal.contextClass,
          },
          controller.signal,
        );
        assertCurrent();
        safety = parseQuestSafetyOutput(questSafety.output);
        safetyOutput = questSafety.output;
        if (!safety.allowed || safety.safeText !== candidate) {
          throw new Error(
            `QuestSafety refused this proposal${
              safety.reasons.length ? `: ${safety.reasons.join(", ")}` : ""
            }`,
          );
        }
      }
      client.teardown();
      if (this.#agentCell === client) this.#agentCell = undefined;
      assertCurrent();
      this.#agentPreview = {
        proposal,
        exactOutput: questMaster.output,
        questMaster,
        ...(questSafety ? { questSafety } : {}),
        ...(safety ? { safety } : {}),
        ...(safetyOutput ? { safetyOutput } : {}),
      };
      this.#agentRunning = false;
      this.#agentAbort = undefined;
      this.#focusAfterRender = "#agent-preview-title";
      this.#setStatus(
        "QuestMaster manifest and source hashes verified; CPython output is inert and ready for local review.",
      );
      await this.render();
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === "AbortError"
      ) return;
      if (
        generation !== this.#agentUiGeneration ||
        !this.#playReservationIsCurrent(groupId, routeGeneration)
      ) return;
      this.#agentCell?.teardown();
      this.#agentCell = undefined;
      this.#agentRunning = false;
      this.#agentAbort = undefined;
      if (/^QuestSafety refused/u.test(this.#error(error))) {
        this.#agentPreview = undefined;
        this.#setAlert(`${this.#error(error)}. No proposal was staged.`);
        await this.render();
        return;
      }
      try {
        state ??= await this.#proposalState(groupId, assertCurrent);
        assertCurrent();
        const quest = await createQuest(
          state.group,
          state.events,
          contextClass,
          weatherBand,
        );
        assertCurrent();
        const activeCount = Object.values(state.group.members).filter(
          (member) => member.active,
        ).length;
        const fallbackOutput = canonicalStringify({
          title: quest.title,
          premise: quest.premise,
          context_class: quest.contextClass,
          weather_band: quest.weatherBand,
          minutes_per_leg: "5-10",
          member_count: activeCount,
          source: "deterministic-js-offline-fallback",
        });
        this.#agentPreview = {
          proposal: {
            title: quest.title,
            premise: quest.premise,
            contextClass: quest.contextClass,
            weatherBand: quest.weatherBand,
            minutesPerLeg: "5-10",
            memberCount: activeCount,
            source: "offline-bundled-agent",
          },
          exactOutput: fallbackOutput,
          fallbackReason: this.#error(error).slice(0, 240),
        };
        this.#focusAfterRender = "#agent-preview-title";
        this.#setStatus(
          "The pinned Python path was unavailable or failed validation. The deterministic JavaScript fallback produced a local-only preview.",
        );
        await this.render();
      } catch (fallbackError) {
        if (
          generation !== this.#agentUiGeneration ||
          !this.#playReservationIsCurrent(groupId, routeGeneration)
        ) return;
        this.#setAlert(this.#error(fallbackError));
      }
    }
  }

  async #stageVerifiedAgentQuest(groupId: string, turn: number): Promise<void> {
    const preview = this.#agentPreview;
    if (!preview) throw new Error("Run QuestMaster and review its exact output first");
    const reservation = this.#proposalGate.reserveStage();
    const routeGeneration = this.#routeGeneration;
    const assertCurrent = (): void =>
      this.#assertStageCurrent(groupId, reservation, routeGeneration);
    const { group, events, binding } = await this.#proposalState(groupId, assertCurrent);
    const activeCount = Object.values(group.members).filter((member) => member.active).length;
    if (preview.proposal.memberCount !== activeCount) {
      throw new Error("Circle membership changed; run QuestMaster again");
    }
    const generated = await createQuest(
      group,
      events,
      preview.proposal.contextClass,
      preview.proposal.weatherBand,
    );
    assertCurrent();
    const quest: Quest = {
      ...generated,
      title: preview.proposal.title,
      premise: preview.proposal.premise,
    };
    const payload = preview.fallbackReason
      ? { ...questPayload(quest), promptSource: "offline-template" }
      : {
          ...questPayload(quest),
          promptSource: "verified-rapp-agent",
          agentVerification: {
            agent: "QuestMaster",
            manifestHash: preview.questMaster?.manifestHash,
            sourceHash: preview.questMaster?.sourceHash,
          },
        };
    await this.#stageEventProposal(
      binding,
      this.#identityRequired().memberId,
      "quest.created",
      payload,
      preview.fallbackReason
        ? `Create deterministic fallback quest “${quest.title}”.`
        : `Create hash-verified QuestMaster proposal “${quest.title}”.`,
      preview.fallbackReason ? "touch" : "verified-agent",
      turn,
      reservation,
      routeGeneration,
    );
  }

  async #prepareAiPreview(groupId: string, draft: string): Promise<void> {
    this.#clearAiState();
    const generation = this.#aiUiGeneration;
    const routeGeneration = this.#routeGeneration;
    const assertCurrent = (): void => {
      if (
        generation !== this.#aiUiGeneration ||
        !this.#playReservationIsCurrent(groupId, routeGeneration)
      ) {
        throw new DOMException("AI preview was cancelled", "AbortError");
      }
    };
    this.#setStatus("Building a fresh bounded AI context preview locally…");
    await this.render();
    assertCurrent();
    const { group, events } = await this.#proposalState(groupId, assertCurrent);
    const quest = latestQuest(events);
    const leg = quest
      ? await deriveQuestLeg(quest, this.#identityRequired().memberId, events)
      : undefined;
    assertCurrent();
    const organism = group.genesis ? await deriveOrganismState(group, events) : undefined;
    assertCurrent();
    this.#aiPreview = buildRemoteContextPreview({
      draft,
      quest: quest
        ? {
            title: quest.title,
            premise: quest.premise,
            contextClass: quest.contextClass,
            weatherBand: quest.weatherBand,
            localRole: leg?.role,
            minutes: leg?.minutes,
            safeLocalLeg: safeLocalLegForProjection(leg?.prompt),
          }
        : undefined,
      organism: organism
        ? {
            aura: organism.aura,
            motion: organism.motion,
            hue: organism.hue,
            rings: organism.rings,
            structuralMolts: organism.structuralMolts,
            memberCount: organism.memberCount,
          }
        : undefined,
      circle: {
        status: group.status,
        chapter: group.chapter,
        eventCount: events.length,
        questCount: events.filter((event) => event.body.type === "quest.created").length,
        offeringCount: events.filter((event) => event.body.type === "quest.offering").length,
        revealCount: events.filter((event) => event.body.type === "quest.reveal").length,
      },
    });
    this.#aiDraft = "";
    this.#aiVoice = "";
    if (this.#orbState.breadcrumb.at(-1) !== "Mind") {
      this.#orbState = adaptiveOrbReducer(this.#orbState, {
        type: "enter",
        mode: "tunnel",
        label: "Mind",
      });
    }
    this.#focusAfterRender = "#ai-preview-title";
    this.#setStatus("Exact bounded AI context is ready for explicit approval; nothing was sent.");
    await this.render();
  }

  async #sendApprovedAiPreview(): Promise<void> {
    const preview = this.#aiPreview;
    if (this.#aiStreaming) return;
    if (!preview || !this.#intelligence.authenticated) {
      this.#setAlert("Connect Copilot and build a context preview first.");
      return;
    }
    const path = routeParts().path;
    const groupId = path.startsWith("/play/") ? path.slice("/play/".length) : "";
    const routeGeneration = this.#routeGeneration;
    if (!groupId) return;
    this.#nextUserTurn();
    const generation = ++this.#aiUiGeneration;
    this.#aiStreaming = true;
    this.#aiRequestSent = false;
    document
      .querySelector<HTMLButtonElement>("#approve-ai-preview")
      ?.setAttribute("disabled", "");
    this.#aiDraft = "";
    this.#aiVoice = "";
    const output = document.querySelector<HTMLElement>("#ai-draft-output");
    if (output) output.textContent = "Streaming an untrusted draft…";
    try {
      const approved = await approveRemoteContext(preview);
      if (
        generation !== this.#aiUiGeneration ||
        !this.#playReservationIsCurrent(groupId, routeGeneration)
      ) return;
      const result = await this.#intelligence.chat(
        approved,
        (fullText) => {
          if (
            generation !== this.#aiUiGeneration ||
            !this.#playReservationIsCurrent(groupId, routeGeneration)
          ) return;
          const region = document.querySelector<HTMLElement>("#ai-draft-output");
          if (region) region.textContent = fullText.slice(0, 2_000);
        },
        () => {
          if (generation === this.#aiUiGeneration) this.#aiRequestSent = true;
        },
      );
      if (
        generation !== this.#aiUiGeneration ||
        !this.#playReservationIsCurrent(groupId, routeGeneration)
      ) return;
      this.#aiDraft = result.text;
      this.#aiVoice = result.voice;
      this.#aiStreaming = false;
      this.#aiRequestSent = false;
      this.#aiPreview = undefined;
      this.#voiceOutput = "Untrusted Copilot draft ready for review below.";
      this.#status =
        result.voice
          ? "Untrusted Copilot display and spoken versions received. Neither entered the command parser or Circle log."
          : "Untrusted Copilot display received. Spoken version unavailable; nothing was sent to speech.";
      this.#focusAfterRender = "#ai-draft-output";
      await this.render();
      if (
        generation !== this.#aiUiGeneration ||
        !this.#playReservationIsCurrent(groupId, routeGeneration)
      ) return;
      this.#aiVoicePlayback.speakOnce(
        generation,
        this.#aiUiGeneration,
        result,
        (voice) => this.#voice.speak(voice),
      );
    } catch (error) {
      if (generation !== this.#aiUiGeneration) return;
      this.#aiStreaming = false;
      this.#aiRequestSent = false;
      document
        .querySelector<HTMLButtonElement>("#approve-ai-preview")
        ?.removeAttribute("disabled");
      this.#setAlert(this.#error(error));
    }
  }

  async #stageAiOffering(groupId: string, turn: number): Promise<void> {
    try {
      const draft = this.#aiDraft;
      if (!draft || draft.length > 600) {
        throw new Error("Copilot draft must be 1–600 characters to stage as an offering");
      }
      const reservation = this.#proposalGate.reserveStage();
      const routeGeneration = this.#routeGeneration;
      const assertCurrent = (): void =>
        this.#assertStageCurrent(groupId, reservation, routeGeneration);
      const { group, events, binding } = await this.#proposalState(groupId, assertCurrent);
      const quest = latestQuest(events);
      if (!quest) throw new Error("Begin a quest before staging a Copilot offering");
      const memberId = this.#identityRequired().memberId;
      assertMemberCanOffer(events, quest.questId, memberId);
      const offering = sanitizeOffering(
        {
          questId: quest.questId,
          memberId,
          text: draft,
          choice: "carry the Copilot draft",
          approvedForHeirloom: false,
        },
        group,
      );
      await this.#stageEventProposal(
        binding,
        memberId,
        "quest.offering",
        offeringPayload(offering),
        `Stage the exact untrusted Copilot draft as an unselected offering: “${offering.text}”.`,
        "copilot-draft",
        turn,
        reservation,
        routeGeneration,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.#setAlert(this.#error(error));
    }
  }

  async #logoutMind(): Promise<void> {
    this.#loginUiGeneration += 1;
    this.#intelligence.logout();
    const proposalCancellation = this.#proposalGate.cancel();
    this.#voice.stopAll();
    this.#deviceCode = undefined;
    this.#clearAiState();
    this.#clearAgentState();
    if (!proposalCancellation.commitStarted) {
      this.#orbState = adaptiveOrbReducer(this.#orbState, { type: "cancel" });
    }
    this.#voiceOutput = proposalCancellation.commitStarted
      ? "Copilot logged out and remote state was cleared. Atomic Circle signing had already begun and continues."
      : "Copilot logged out. Tokens, remote chat, proposals, and speech were cleared; local Circle identity remains.";
    this.#focusAfterRender = "#orb-center";
    this.#setStatus(this.#voiceOutput);
    await this.render();
  }

  async #enableCameraAssist(): Promise<void> {
    const video = document.querySelector<HTMLVideoElement>("#orb-camera-preview");
    if (!video) return;
    const path = routeParts().path;
    const generation = ++this.#cameraEnableGeneration;
    const routeGeneration = this.#routeGeneration;
    const run = this.#cameraEnableQueue.catch(() => undefined).then(async () => {
      if (
        generation !== this.#cameraEnableGeneration ||
        routeGeneration !== this.#routeGeneration ||
        routeParts().path !== path ||
        !path.startsWith("/play/") ||
        !video.isConnected
      ) return;
      this.#cameraAssist ??= new CameraAssist();
      try {
        const result = await this.#cameraAssist.enable(video, ({ direction, armed }) => {
          if (
            generation !== this.#cameraEnableGeneration ||
            routeGeneration !== this.#routeGeneration ||
            routeParts().path !== path ||
            !video.isConnected
          ) return;
          this.#orbState = adaptiveOrbReducer(this.#orbState, {
            type: "sensor-highlight",
            direction,
          });
          this.#paintOrbHighlight(
            armed
              ? "Camera dwell armed only the highlight; explicit confirmation is still required."
              : "Camera changed highlight only.",
          );
        });
        if (
          generation !== this.#cameraEnableGeneration ||
          routeGeneration !== this.#routeGeneration ||
          routeParts().path !== path ||
          !video.isConnected
        ) {
          this.#cameraAssist.disable();
          return;
        }
        video.hidden = !result.enabled;
        this.#setStatus(
          result.enabled
            ? "Camera assist enabled locally. It can highlight only."
            : result.reason === "unsupported"
              ? "FaceDetector is unavailable; camera assist is disabled. All other controls still work."
              : "Camera unavailable; all AI, voice, touch, and keyboard controls still work.",
        );
      } catch {
        if (generation !== this.#cameraEnableGeneration) return;
        video.hidden = true;
        this.#setStatus("Camera assist could not start. All other controls still work.");
      }
    });
    this.#cameraEnableQueue = run;
    await run;
  }

  #disableCameraAssist(announce = false): void {
    this.#invalidateCamera();
    if (announce) this.#setStatus("Camera assist disabled and video tracks stopped.");
  }

  async #startReunion(groupId: string): Promise<void> {
    try {
      const [group, events] = await Promise.all([
        getCircle(this.#db(), groupId),
        getCircleEvents(this.#db(), groupId),
      ]);
      if (!group) throw new Error("Circle missing");
      if (group.demo) {
        const demo = await getDemoIdentity(this.#db(), groupId);
        if (!demo) throw new Error("Practice companion is unavailable");
        const practice = await prepareOfflinePracticeReunion(
          group,
          events,
          this.#identityRequired(),
          demo,
        );
        this.#reunionChallenge = practice.challenge;
        this.#reunionApprovals = practice.approvals;
        this.#setStatus("Simulation: both on-device demo keys approved the frozen root; PeerJS was not opened.");
        await this.render();
      } else {
        this.#reunionChallenge = await createReunionChallenge(group, events);
        this.#reunionApprovals = [await approveReunion(this.#reunionChallenge, this.#identityRequired())];
        await this.#startHost(group, "reunion", this.#reunionChallenge);
        this.#setStatus("Reunion challenge started and locally signed; fresh invite ready.");
      }
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #currentReunion(
    groupId: string,
  ): Promise<{ group: CircleRecord; events: Awaited<ReturnType<typeof getCircleEvents>>; challenge: ReunionChallenge }> {
    const [group, events] = await Promise.all([
      getCircle(this.#db(), groupId),
      getCircleEvents(this.#db(), groupId),
    ]);
    const challenge = this.#reunionChallenge;
    if (!group || !challenge || !(await reunionChallengeIsCurrent(group, events, challenge))) {
      this.#reunionChallenge = undefined;
      this.#reunionApprovals = [];
      this.#clearLinkState();
      throw new Error("Reunion challenge expired or its event root changed; start a new challenge");
    }
    return { group, events, challenge };
  }

  async #hostReunion(groupId: string): Promise<void> {
    try {
      const { group, challenge } = await this.#currentReunion(groupId);
      if (group.demo) throw new Error("Offline practice never opens PeerJS");
      await this.#startHost(group, "reunion", challenge);
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #demoReunion(groupId: string): Promise<void> {
    try {
      const { challenge } = await this.#currentReunion(groupId);
      const demo = await getDemoIdentity(this.#db(), groupId);
      if (!demo) throw new Error("No practice companion");
      const approval = await approveReunion(challenge, demo);
      if (!this.#reunionApprovals.some((item) => item.memberId === approval.memberId)) {
        this.#reunionApprovals.push(approval);
      }
      this.#setStatus("Added a clearly simulated key approval; no human presence claim.");
      await this.render();
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #saveReunionDraft(groupId: string): Promise<void> {
    try {
      const { challenge } = await this.#currentReunion(groupId);
      await appendLocalEvent(
        this.#db(),
        groupId,
        this.#identityRequired(),
        "reunion.draft",
        reunionDraftPayload(challenge, this.#reunionApprovals),
      );
      this.#reunionChallenge = undefined;
      this.#reunionApprovals = [];
      this.#clearLinkState();
      this.#setStatus("Draft saved. Structural form did not change.");
      await this.render();
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #sealReunion(groupId: string): Promise<void> {
    try {
      const { group, events, challenge } = await this.#currentReunion(groupId);
      const certificate: ReunionCertificate = {
        challenge,
        approvals: this.#reunionApprovals,
        threshold: reunionThreshold(group),
      };
      const payload = await reunionSealPayload(group, certificate, events);
      const updatedGroup: CircleRecord = {
        ...group,
        chapter: group.chapter + 1,
        priorGenerationRoots: [
          ...new Set([...group.priorGenerationRoots, challenge.eventRoot]),
        ].sort(),
      };
      await appendLocalEventWithGroupUpdate(
        this.#db(),
        groupId,
        this.#identityRequired(),
        "reunion.seal",
        payload,
        updatedGroup,
        {
          eventRoot: challenge.eventRoot,
          groupDigest: canonicalGroupDigest(group),
        },
      );
      this.#reunionChallenge = undefined;
      this.#reunionApprovals = [];
      this.#invite = undefined;
      this.#link?.dispose();
      this.#setStatus("Reunion quorum verified. The organism’s structural membrane molted.");
      this.#navigate(`/circle/${groupId}`);
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  async #mint(groupId: string): Promise<void> {
    try {
      const [group, events] = await Promise.all([
        getCircle(this.#db(), groupId),
        getCircleEvents(this.#db(), groupId),
      ]);
      if (!group) throw new Error("Circle missing");
      const expected = {
        eventRoot: await eventRoot(events),
        groupDigest: canonicalGroupDigest(group),
      };
      const artifact = await mintHeirloom(group, events);
      await verifyHeirloom(artifact);
      await appendLocalEventWithGroupUpdate(
        this.#db(),
        groupId,
        this.#identityRequired(),
        "heirloom.minted",
        {
          packageHash: artifact.packageHash,
          selectedContributionCount: artifact.approvedStory.length,
        },
        { ...group, status: "heirloom-ready" },
        expected,
      );
      downloadFile(
        `${group.name.toLowerCase().replace(/[^a-z0-9]+/gu, "-") || "circle"}.rapp-heir.json`,
        canonicalStringify(artifact),
        "application/json",
      );
      this.#setStatus("Heirloom package verified and exported. Keep copies like a family object.");
      await this.render();
    } catch (error) {
      this.#setStatus(this.#error(error));
    }
  }

  #drawQr(): void {
    const canvas = document.querySelector<HTMLCanvasElement>("#invite-qr");
    if (!canvas || !this.#invite) return;
    const link = inviteLink(this.#invite, `${location.origin}${import.meta.env.BASE_URL}`);
    void QRCode.toCanvas(canvas, link, {
      width: 232,
      margin: 2,
      color: { dark: "#17152b", light: "#fffdf8" },
      errorCorrectionLevel: "M",
    });
  }

  #drawOrganism(route: ReturnType<typeof routeParts>): void {
    const canvas = document.querySelector<HTMLCanvasElement>("#organism-canvas");
    if (!canvas || !route.path.startsWith("/circle/")) return;
    const groupId = route.path.slice("/circle/".length);
    const renderNumber = this.#renderNumber;
    void Promise.all([getCircle(this.#db(), groupId), getCircleEvents(this.#db(), groupId)]).then(
      async ([group, events]) => {
        if (!group?.genesis || renderNumber !== this.#renderNumber || !canvas.isConnected) return;
        this.#organismRenderer = new OrganismRenderer(canvas);
        this.#organismRenderer.setState(await deriveOrganismState(group, events));
      },
    );
  }

  #db(): ReplicaDatabase {
    if (!this.#database) throw new Error("Storage is not ready");
    return this.#database;
  }

  #identityRequired(): LocalIdentity {
    if (!this.#identity) throw new Error("Create a local companion first");
    return this.#identity;
  }

  #error(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
  }
}
