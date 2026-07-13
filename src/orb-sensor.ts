export type OrbSensorDirection = "left" | "right" | "up" | "down" | "center";

export interface FaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FaceDetectionLike {
  boundingBox: FaceBounds;
}

export interface FaceDetectorLike {
  detect(source: HTMLVideoElement): Promise<FaceDetectionLike[]>;
}

type FaceDetectorConstructor = new (options?: {
  fastMode?: boolean;
  maxDetectedFaces?: number;
}) => FaceDetectorLike;

export interface CameraHighlight {
  direction: OrbSensorDirection;
  armed: boolean;
}

export interface CameraAssistDependencies {
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  createFaceDetector?: () => FaceDetectorLike;
  now?: () => number;
  schedule?: (callback: () => void, milliseconds: number) => number;
  cancelSchedule?: (handle: number) => void;
}

export interface CameraAssistResult {
  enabled: boolean;
  reason?: "unsupported" | "unavailable";
}

export const CAMERA_DWELL_MS = 1_200;

export function directionFromFace(
  face: FaceBounds,
  frameWidth: number,
  frameHeight: number,
): OrbSensorDirection {
  if (
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0
  ) {
    return "center";
  }
  const x = (face.x + face.width / 2 - frameWidth / 2) / frameWidth;
  const y = (face.y + face.height / 2 - frameHeight / 2) / frameHeight;
  const threshold = 0.12;
  if (Math.abs(x) < threshold && Math.abs(y) < threshold) return "center";
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? "left" : "right";
  return y < 0 ? "up" : "down";
}

function defaultFaceDetectorFactory(): (() => FaceDetectorLike) | undefined {
  const Detector = (globalThis as typeof globalThis & {
    FaceDetector?: FaceDetectorConstructor;
  }).FaceDetector;
  return Detector
    ? () => new Detector({ fastMode: true, maxDetectedFaces: 1 })
    : undefined;
}

export class CameraAssist {
  readonly #mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined;
  readonly #createFaceDetector: (() => FaceDetectorLike) | undefined;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, milliseconds: number) => number;
  readonly #cancelSchedule: (handle: number) => void;
  #generation = 0;
  #stream: MediaStream | undefined;
  #video: HTMLVideoElement | undefined;
  #timer: number | undefined;
  #direction: OrbSensorDirection | undefined;
  #directionSince = 0;
  #armedEmitted = false;

  constructor(dependencies: CameraAssistDependencies = {}) {
    this.#mediaDevices =
      dependencies.mediaDevices ??
      (typeof navigator === "undefined" ? undefined : navigator.mediaDevices);
    this.#createFaceDetector =
      dependencies.createFaceDetector ??
      defaultFaceDetectorFactory();
    this.#now = dependencies.now ?? Date.now;
    this.#schedule =
      dependencies.schedule ??
      ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
    this.#cancelSchedule =
      dependencies.cancelSchedule ??
      ((handle) => window.clearTimeout(handle));
  }

  get supported(): boolean {
    return Boolean(this.#mediaDevices?.getUserMedia && this.#createFaceDetector);
  }

  get enabled(): boolean {
    return Boolean(this.#stream);
  }

  async enable(
    video: HTMLVideoElement,
    onHighlight: (highlight: CameraHighlight) => void,
  ): Promise<CameraAssistResult> {
    this.disable();
    const generation = ++this.#generation;
    if (!this.supported || !this.#createFaceDetector || !this.#mediaDevices) {
      return { enabled: false, reason: "unsupported" };
    }
    let stream: MediaStream | undefined;
    try {
      stream = await this.#mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user" },
      });
      if (generation !== this.#generation) {
        stream.getTracks().forEach((track) => track.stop());
        return { enabled: false, reason: "unavailable" };
      }
      this.#stream = stream;
      this.#video = video;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      if (generation !== this.#generation) {
        stream.getTracks().forEach((track) => track.stop());
        if (this.#stream === stream) this.#stream = undefined;
        if (this.#video === video) this.#video = undefined;
        if (video.srcObject === stream) video.srcObject = null;
        return { enabled: false, reason: "unavailable" };
      }
      const detector = this.#createFaceDetector();
      const inspect = async (): Promise<boolean> => {
        if (generation !== this.#generation || !this.#stream) return false;
        try {
          const faces = await detector.detect(video);
          if (generation !== this.#generation || !this.#stream) return false;
          const face = faces[0]?.boundingBox;
          const direction = face
            ? directionFromFace(face, video.videoWidth, video.videoHeight)
            : "center";
          const now = this.#now();
          if (direction !== this.#direction) {
            this.#direction = direction;
            this.#directionSince = now;
            this.#armedEmitted = false;
            onHighlight({ direction, armed: false });
          } else if (!this.#armedEmitted && now - this.#directionSince >= CAMERA_DWELL_MS) {
            this.#armedEmitted = true;
            onHighlight({ direction, armed: true });
          }
        } catch {
          if (generation === this.#generation) this.disable();
          return false;
        }
        if (generation === this.#generation && this.#stream) {
          this.#timer = this.#schedule(() => void inspect(), 160);
        }
        return true;
      };
      if (!(await inspect())) return { enabled: false, reason: "unavailable" };
      return { enabled: true };
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation === this.#generation) this.disable();
      return { enabled: false, reason: "unavailable" };
    }
  }

  disable(): void {
    this.#generation += 1;
    if (this.#timer !== undefined) this.#cancelSchedule(this.#timer);
    this.#timer = undefined;
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = undefined;
    if (this.#video) this.#video.srcObject = null;
    this.#video = undefined;
    this.#direction = undefined;
    this.#directionSince = 0;
    this.#armedEmitted = false;
  }
}

export { CameraAssist as OrbCameraAssist };
