import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

export class InviteScanner {
  #stream: MediaStream | undefined;
  #controls: IScannerControls | undefined;
  #frame = 0;
  #stopped = false;
  #generation = 0;

  async start(
    video: HTMLVideoElement,
    onResult: (text: string) => void,
    onStatus: (text: string) => void,
  ): Promise<void> {
    this.stop();
    const generation = this.#generation;
    this.#stopped = false;
    const Detector = (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor })
      .BarcodeDetector;
    if (Detector) {
      try {
        const formats = (await Detector.getSupportedFormats?.()) ?? ["qr_code"];
        if (generation !== this.#generation) return;
        if (formats.includes("qr_code")) {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false,
          });
          if (generation !== this.#generation) {
            for (const track of stream.getTracks()) track.stop();
            return;
          }
          this.#stream = stream;
          video.srcObject = this.#stream;
          await video.play();
          if (generation !== this.#generation) {
            for (const track of stream.getTracks()) track.stop();
            if (this.#stream === stream) this.#stream = undefined;
            video.srcObject = null;
            return;
          }
          const detector = new Detector({ formats: ["qr_code"] });
          onStatus("Camera active with local BarcodeDetector. Nothing is uploaded.");
          const scan = async (): Promise<void> => {
            if (this.#stopped || generation !== this.#generation) return;
            try {
              const codes = await detector.detect(video);
              const value = codes[0]?.rawValue;
              if (value) {
                this.stop();
                onResult(value);
                return;
              }
            } catch {
              // A frame can be unavailable while the camera warms up.
            }
            this.#frame = requestAnimationFrame(() => void scan());
          };
          await scan();
          return;
        }
      } catch {
        if (generation !== this.#generation) return;
        cancelAnimationFrame(this.#frame);
        for (const track of this.#stream?.getTracks() ?? []) track.stop();
        this.#stream = undefined;
        video.srcObject = null;
      }
    }
    if (generation !== this.#generation) return;
    const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 150 });
    onStatus("Camera active with bundled ZXing decoder. Nothing is uploaded.");
    const controls = await reader.decodeFromVideoDevice(undefined, video, (result) => {
      if (result && generation === this.#generation) {
        const text = result.getText();
        this.stop();
        onResult(text);
      }
    });
    if (generation !== this.#generation) {
      controls.stop();
      return;
    }
    this.#controls = controls;
  }

  stop(): void {
    this.#generation += 1;
    this.#stopped = true;
    cancelAnimationFrame(this.#frame);
    this.#controls?.stop();
    this.#controls = undefined;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = undefined;
  }
}
