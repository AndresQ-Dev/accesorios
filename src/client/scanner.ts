import type { ReadResult, ReaderOptions } from 'zxing-wasm/reader';

const readerWasm = new URL('zxing-wasm/reader/zxing_reader.wasm', import.meta.url).href;

export type ScannerState = 'insecure' | 'unsupported' | 'permission-denied' | 'camera-error' | 'scanning' | 'slow';

type NativeDetector = {
  getSupportedFormats: () => Promise<string[]>;
  detect: (video: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
};
type FallbackReader = { readBarcodes: (image: ImageData, options: ReaderOptions) => Promise<ReadResult[]> };

export type ScannerEnvironment = {
  secure: boolean;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  BarcodeDetector?: NativeDetector;
  loadFallback: () => Promise<FallbackReader>;
  snapshot: (video: HTMLVideoElement) => ImageData;
  clearFrame?: () => void;
  onState: (state: ScannerState) => void;
  onDecode: (text: string) => void;
  onTorch?: (available: boolean) => void;
  schedule?: (callback: () => void) => number;
  clearSchedule?: (id: number) => void;
};

export class ScannerClient {
  private active = false;
  private stream?: MediaStream;
  private timer?: number;
  private native?: NativeDetector;

  constructor(private readonly video: HTMLVideoElement, private readonly environment: ScannerEnvironment) {}

  async start() {
    this.stop();
    if (!this.environment.secure) return this.environment.onState('insecure');
    if (!this.environment.getUserMedia) return this.environment.onState('unsupported');
    this.active = true;
    try {
      this.stream = await this.environment.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (!this.active) return this.release();
      this.video.srcObject = this.stream;
      await this.video.play();
      this.environment.onState('scanning');
      this.environment.onTorch?.(this.hasTorch());
      this.native = await this.nativeDetector();
      if (!this.active) return;
      if (this.native) await this.scanNative(this.native); else await this.scanFallback();
    } catch (error) {
      this.stop();
      this.environment.onState(error instanceof Error && error.name === 'NotAllowedError' ? 'permission-denied' : 'camera-error');
    }
  }

  stop() {
    this.active = false;
    if (this.timer !== undefined) this.environment.clearSchedule?.(this.timer);
    this.timer = undefined;
    this.native = undefined;
    this.environment.clearFrame?.();
    this.release();
  }

  async toggleTorch(enabled: boolean) {
    const track = this.stream?.getVideoTracks()[0] as MediaStreamTrack & { applyConstraints?: (constraints: MediaTrackConstraints) => Promise<void> } | undefined;
    if (!track || !this.hasTorch() || !track.applyConstraints) return false;
    await track.applyConstraints({ advanced: [{ torch: enabled } as MediaTrackConstraintSet] });
    return true;
  }

  private async nativeDetector() {
    const detector = this.environment.BarcodeDetector;
    try { return detector && (await detector.getSupportedFormats()).includes('itf') ? detector : undefined; }
    catch { return undefined; }
  }

  private async scanNative(detector: NativeDetector) {
    try { this.finish((await detector.detect(this.video)).find(({ rawValue }) => rawValue)?.rawValue); }
    catch { this.retry(() => this.scanNative(detector)); }
  }

  private async scanFallback() {
    try {
      const reader = await this.environment.loadFallback(); const frame = this.environment.snapshot(this.video);
      this.finish((await reader.readBarcodes(frame, { formats: ['ITF'], maxNumberOfSymbols: 1, tryHarder: true }))[0]?.text);
    } catch { this.stop(); this.environment.onState('unsupported'); }
    finally { this.environment.clearFrame?.(); }
  }

  private finish(text?: string) {
    if (!this.active) return;
    if (text) { this.stop(); this.environment.onDecode(text); return; }
    this.retry(() => this.native ? void this.scanNative(this.native) : void this.scanFallback());
  }

  private retry(callback: () => void) {
    if (!this.active) return;
    this.environment.onState('slow');
    this.timer = (this.environment.schedule ?? ((next) => window.setTimeout(next, 250)))(callback);
  }

  private hasTorch() {
    const track = this.stream?.getVideoTracks()[0] as unknown as { getCapabilities?: () => { torch?: boolean } } | undefined;
    return Boolean(track?.getCapabilities?.().torch);
  }

  private release() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
  }
}

export function createBrowserScanner(video: HTMLVideoElement, handlers: Pick<ScannerEnvironment, 'onState' | 'onDecode' | 'onTorch'>) {
  const canvas = document.createElement('canvas');
  const BarcodeDetector = (globalThis as typeof globalThis & { BarcodeDetector?: { getSupportedFormats: () => Promise<string[]>; new(options: { formats: string[] }): { detect: (video: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } } }).BarcodeDetector;
  return new ScannerClient(video, {
    secure: globalThis.isSecureContext, getUserMedia: navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices),
    BarcodeDetector: BarcodeDetector && { getSupportedFormats: () => BarcodeDetector.getSupportedFormats(), detect: (source) => new BarcodeDetector({ formats: ['itf'] }).detect(source) },
    loadFallback: async () => {
      const reader = await import('zxing-wasm/reader');
      reader.prepareZXingModule({ overrides: { locateFile: (path: string) => path.endsWith('.wasm') ? readerWasm : path } });
      return reader;
    },
    snapshot: (source) => { canvas.width = source.videoWidth; canvas.height = source.videoHeight; const context = canvas.getContext('2d'); if (!context) throw new Error('canvas-unavailable'); context.drawImage(source, 0, 0); return context.getImageData(0, 0, canvas.width, canvas.height); },
    clearFrame: () => { canvas.width = 0; canvas.height = 0; },
    ...handlers,
  });
}
