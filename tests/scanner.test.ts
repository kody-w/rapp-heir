import { afterEach, describe, expect, it, vi } from "vitest";
import { InviteScanner } from "../src/scanner";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("invite scanner cancellation", () => {
  it("stops a camera stream that arrives after route cancellation", async () => {
    let resolveStream: ((stream: MediaStream) => void) | undefined;
    let markRequested: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
          markRequested?.();
        }),
    );
    class Detector {
      static async getSupportedFormats(): Promise<string[]> {
        return ["qr_code"];
      }

      async detect(): Promise<[]> {
        return [];
      }
    }
    vi.stubGlobal("BarcodeDetector", Detector);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const video = {
      srcObject: null,
      play: vi.fn(async () => undefined),
    } as unknown as HTMLVideoElement;
    const scanner = new InviteScanner();
    const result = vi.fn();
    const status = vi.fn();
    const starting = scanner.start(video, result, status);
    await requested;
    scanner.stop();
    resolveStream?.({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await starting;

    expect(stopTrack).toHaveBeenCalledOnce();
    expect(video.play).not.toHaveBeenCalled();
    expect(result).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });
});
