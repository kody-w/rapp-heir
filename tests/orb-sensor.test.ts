import { describe, expect, it, vi } from "vitest";
import { CameraAssist, CAMERA_DWELL_MS, directionFromFace } from "../src/orb-sensor";

function fakeVideo() {
  return {
    muted: false,
    playsInline: false,
    srcObject: null,
    videoWidth: 100,
    videoHeight: 100,
    play: vi.fn(async () => undefined),
  } as unknown as HTMLVideoElement;
}

function fakeStream() {
  const stop = vi.fn();
  return {
    stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
    stop,
  };
}

describe("optional FaceDetector camera assist", () => {
  it("maps only four coarse directions and center", () => {
    expect(directionFromFace({ x: 40, y: 40, width: 20, height: 20 }, 100, 100)).toBe("center");
    expect(directionFromFace({ x: 0, y: 40, width: 20, height: 20 }, 100, 100)).toBe("left");
    expect(directionFromFace({ x: 80, y: 40, width: 20, height: 20 }, 100, 100)).toBe("right");
    expect(directionFromFace({ x: 40, y: 0, width: 20, height: 20 }, 100, 100)).toBe("up");
    expect(directionFromFace({ x: 40, y: 80, width: 20, height: 20 }, 100, 100)).toBe("down");
  });

  it("does not request a camera when FaceDetector is unavailable", async () => {
    const getUserMedia = vi.fn();
    const assist = new CameraAssist({ mediaDevices: { getUserMedia } });
    expect(assist.supported).toBe(false);
    await expect(assist.enable(fakeVideo(), vi.fn())).resolves.toEqual({
      enabled: false,
      reason: "unsupported",
    });
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("requests video without audio and dwell emits highlight-only state", async () => {
    const { stream, stop } = fakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const highlights = vi.fn();
    let now = 0;
    let scheduled: (() => void) | undefined;
    const assist = new CameraAssist({
      mediaDevices: { getUserMedia },
      createFaceDetector: () => ({
        detect: vi.fn(async () => [
          { boundingBox: { x: 80, y: 40, width: 20, height: 20 } },
        ]),
      }),
      now: () => now,
      schedule: (callback) => {
        scheduled = callback;
        return 1;
      },
      cancelSchedule: vi.fn(),
    });
    const result = await assist.enable(fakeVideo(), highlights);
    expect(result).toEqual({ enabled: true });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { facingMode: "user" },
    });
    await vi.waitFor(() =>
      expect(highlights).toHaveBeenCalledWith({ direction: "right", armed: false }),
    );
    now = CAMERA_DWELL_MS;
    scheduled?.();
    await vi.waitFor(() =>
      expect(highlights).toHaveBeenCalledWith({ direction: "right", armed: true }),
    );
    expect(highlights.mock.calls.flat().some((value) => value === "commit")).toBe(false);
    assist.disable();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops late media tracks after disable invalidates startup", async () => {
    let resolve!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((done) => {
      resolve = done;
    });
    const { stream, stop } = fakeStream();
    const assist = new CameraAssist({
      mediaDevices: { getUserMedia: vi.fn(() => pending) },
      createFaceDetector: () => ({ detect: vi.fn(async () => []) }),
      schedule: vi.fn(() => 1),
      cancelSchedule: vi.fn(),
    });
    const enabling = assist.enable(fakeVideo(), vi.fn());
    assist.disable();
    resolve(stream);
    await expect(enabling).resolves.toMatchObject({ enabled: false });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("a stale first enable cannot stop or hide a newer captured stream", async () => {
    const first = fakeStream();
    const second = fakeStream();
    let mediaCall = 0;
    let finishFirstPlay!: () => void;
    const firstVideo = fakeVideo();
    firstVideo.play = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirstPlay = resolve;
        }),
    );
    const secondVideo = fakeVideo();
    const assist = new CameraAssist({
      mediaDevices: {
        getUserMedia: vi.fn(async () => (mediaCall++ === 0 ? first.stream : second.stream)),
      },
      createFaceDetector: () => ({ detect: vi.fn(async () => []) }),
      schedule: vi.fn(() => 1),
      cancelSchedule: vi.fn(),
    });
    const firstEnable = assist.enable(firstVideo, vi.fn());
    await vi.waitFor(() => expect(firstVideo.srcObject).toBe(first.stream));
    const secondEnable = assist.enable(secondVideo, vi.fn());
    await expect(secondEnable).resolves.toEqual({ enabled: true });
    finishFirstPlay();
    await expect(firstEnable).resolves.toMatchObject({ enabled: false });
    expect(assist.enabled).toBe(true);
    expect(secondVideo.srcObject).toBe(second.stream);
    expect(second.stop).not.toHaveBeenCalled();
    assist.disable();
    expect(second.stop).toHaveBeenCalledOnce();
  });
});
