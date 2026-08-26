import type { ReadResult, ReaderOptions } from 'zxing-wasm/reader';

const readerWasm = '/static/vendor/zxing_reader.wasm';
const PLAUSIBLE_BARCODE = /^[0-9]{13,14}$/;
const DECODE_MAX_WIDTH = 640;
const RECOVERY_ACQUIRE_TIMEOUT_MS = 8000;
const IDLE_RETRY_DELAYS_MS = [250, 350, 500, 750, 1000] as const;
const DEGRADE_AFTER_IDLE_CYCLES = 4;
const OUTER_STALL_INTERVAL_MS = 1500;
const OUTER_STALL_CHECKS_LIMIT = 4;

export type ScannerState = 'insecure' | 'unsupported' | 'permission-denied' | 'camera-error' | 'scanning' | 'slow' | 'catalog-miss' | 'unreadable';
export type ScannerDecodeResult = 'matched' | 'not-found' | 'retry';
export type ScannerDiagnosticEvent = {
  event: string;
  details?: Record<string, unknown>;
};

type NativeDetector = {
  getSupportedFormats: () => Promise<string[]>;
  detect: (video: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>>;
};
type FallbackReader = { readBarcodes: (image: ImageData, options: ReaderOptions) => Promise<ReadResult[]> };

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
};

export type ScannerEnvironment = {
  secure: boolean;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  BarcodeDetector?: NativeDetector;
  loadFallback: () => Promise<FallbackReader>;
  snapshot: (video: HTMLVideoElement) => ImageData;
  clearFrame?: () => void;
  onState: (state: ScannerState) => void;
  onDecode: (text: string) => ScannerDecodeResult | Promise<ScannerDecodeResult>;
  onTorch?: (available: boolean) => void;
  onDiagnostic?: (event: ScannerDiagnosticEvent) => void;
  schedule?: (callback: () => void, milliseconds?: number) => number;
  clearSchedule?: (id: number) => void;
  now?: () => number;
  monitor?: (element: HTMLVideoElement, onStall: () => void) => () => void;
  timeout?: <T>(promise: Promise<T>, milliseconds: number) => Promise<T>;
};

export class ScannerClient {
  private active = false;
  private stream?: MediaStream;
  private timer?: number;
  private native?: NativeDetector;
  private fallback?: Promise<FallbackReader>;
  private stallMonitorStop?: () => void;
  private trackListeners?: Array<[MediaStreamTrack, EventListener]>;
  private streamRestarts = 0;
  private recovering = false;
  private idleStreak = 0;
  private readonly catalogAttempts = new Set<string>();

  constructor(private readonly video: HTMLVideoElement, private readonly environment: ScannerEnvironment) {}

  async start() {
    this.stop();
    this.streamRestarts = 0;
    this.diagnostic('start');
    if (!this.environment.secure) return this.environment.onState('insecure');
    if (!this.environment.getUserMedia) return this.environment.onState('unsupported');
    this.active = true;
    try {
      this.stream = await this.environment.getUserMedia(CAMERA_CONSTRAINTS);
      if (!this.active) return this.release();
      this.video.srcObject = this.stream;
      await this.video.play();
      await this.enableContinuousFocus();
      this.environment.onState('scanning');
      this.armStallMonitor();
      this.environment.onTorch?.(this.hasTorch());
      if (!this.active) return;
      await this.scanFallback();
    } catch (error) {
      this.stop();
      this.diagnostic('camera-error', { error: this.errorDetails(error) });
      this.environment.onState(error instanceof Error && error.name === 'NotAllowedError' ? 'permission-denied' : 'camera-error');
    }
  }

  stop() {
    if (this.active || this.stream || this.timer !== undefined) this.diagnostic('stop');
    this.active = false;
    this.disarmStallMonitor();
    if (this.timer !== undefined) this.environment.clearSchedule?.(this.timer);
    this.timer = undefined;
    this.native = undefined;
    this.fallback = undefined;
    this.idleStreak = 0;
    this.catalogAttempts.clear();
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
    try {
      const text = (await detector.detect(this.video)).find(({ rawValue }) => rawValue !== undefined && rawValue !== '')?.rawValue;
      if (text !== undefined && text !== '') {
        await this.finish(text);
        return;
      }
    } catch (error) { this.diagnostic('decode-error', { source: 'native', error: this.errorDetails(error) }); }
    this.diagnostic('frame-empty', { source: 'native' });
    this.idleStreak += 1;
    this.retry(() => this.scanNative(detector), true, this.idleRetryDelay());
  }

  private async scanFallback() {
    let reader: FallbackReader;
    const fullEffort = this.idleStreak < DEGRADE_AFTER_IDLE_CYCLES;
    this.diagnostic('scan-fallback', { fullEffort });
    try {
      reader = await (this.fallback ??= this.environment.loadFallback());
    } catch (error) {
      this.diagnostic('decode-error', { source: 'fallback-load', error: this.errorDetails(error), fullEffort });
      await this.startNativeRecovery();
      return;
    }
    try {
      const frame = this.environment.snapshot(this.video);
      let reads: ReadResult[];
      try {
        reads = await reader.readBarcodes(frame, {
        formats: ['ITF', 'ITF14'], maxNumberOfSymbols: 1, tryHarder: true,
        tryRotate: fullEffort, tryDenoise: fullEffort, returnErrors: true,
        });
      } catch (error) {
        this.diagnostic('decode-error', { source: 'fallback-read', error: this.errorDetails(error), fullEffort });
        this.retry(() => this.scanFallback());
        return;
      }
      const text = reads.find(({ isValid, text }) => isValid && text !== '')?.text;
      if (text === undefined || text === '') this.diagnostic('frame-empty', { fullEffort, reads: reads.length });
      await this.finish(text);
    } catch (error) {
      this.diagnostic('snapshot-error', { error: this.errorDetails(error), fullEffort });
      this.retry(() => this.scanFallback());
    }
    finally { this.environment.clearFrame?.(); }
  }

  private async startNativeRecovery() {
    this.native = await this.nativeDetector();
    if (!this.active) return;
    if (!this.native) {
      this.stop();
      this.environment.onState('unsupported');
      return;
    }
    await this.scanNative(this.native);
  }

  private async finish(text?: string) {
    if (!this.active) return;
    const rescan = () => this.native ? this.scanNative(this.native) : this.scanFallback();
    if (text === undefined || text === '') {
      this.idleStreak += 1;
      this.retry(rescan, true, this.idleRetryDelay());
      return;
    }
    if (!PLAUSIBLE_BARCODE.test(text)) {
      this.idleStreak += 1;
      this.diagnostic('frame-unreadable', { candidate: this.codeDetails(text), retryDelayMs: this.idleRetryDelay() });
      this.environment.onState('unreadable');
      this.retry(rescan, false, this.idleRetryDelay());
      return;
    }
    if (this.catalogAttempts.has(text)) {
      this.idleStreak += 1;
      this.diagnostic('catalog-retry', { candidate: this.codeDetails(text), retryDelayMs: this.idleRetryDelay() });
      this.retry(rescan, false, this.idleRetryDelay());
      return;
    }
    this.catalogAttempts.add(text);
    this.idleStreak = 0;
    this.diagnostic('plausible-candidate', { candidate: this.codeDetails(text) });
    const outcome = await this.environment.onDecode(text);
    if (outcome === 'matched') { this.stop(); return; }
    if (!this.active) return;
    if (outcome === 'not-found') {
      this.diagnostic('catalog-miss', { candidate: this.codeDetails(text) });
      this.environment.onState('catalog-miss');
      this.stop();
      return;
    }
    this.retry(rescan, false);
  }

  private idleRetryDelay() {
    const index = Math.max(0, Math.min(this.idleStreak - 1, IDLE_RETRY_DELAYS_MS.length - 1));
    return IDLE_RETRY_DELAYS_MS[index];
  }

  private retry(callback: () => void, reportSlow = true, delayMs?: number) {
    if (!this.active) return;
    if (reportSlow) this.environment.onState('slow');
    this.diagnostic('retry', { reportSlow, retryDelayMs: delayMs ?? 250 });
    this.timer = (this.environment.schedule ?? ((next, milliseconds) => window.setTimeout(next, milliseconds ?? 250)))(callback, delayMs);
  }

  private hasTorch() {
    const track = this.stream?.getVideoTracks()[0] as unknown as { getCapabilities?: () => { torch?: boolean } } | undefined;
    return Boolean(track?.getCapabilities?.().torch);
  }

  private armStallMonitor() {
    this.disarmStallMonitor();
    const listeners: Array<[MediaStreamTrack, EventListener]> = [];
    this.stream?.getVideoTracks().forEach((track) => {
      const onEnded = () => { this.diagnostic('track-ended'); this.recover(); };
      track.addEventListener?.('ended', onEnded);
      listeners.push([track, onEnded]);
    });
    this.trackListeners = listeners;
    this.stallMonitorStop = this.environment.monitor?.(this.video, () => { this.diagnostic('monitor-stall'); this.recover(); });
  }

  /** Public single entry point so any liveness source can request bounded recovery. */
  recover() {
    void this.recoverStream();
  }

  private async recoverStream() {
    if (!this.active || this.recovering) return;
    this.recovering = true;
    this.diagnostic('recover-start');
    try {
      this.disarmStallMonitor();
      if (this.streamRestarts >= 1) {
        this.stop();
        this.diagnostic('recover-fail', { reason: 'restart-limit' });
        this.diagnostic('camera-error', { reason: 'restart-limit' });
        this.environment.onState('camera-error');
        return;
      }
      this.streamRestarts += 1;
      const previous = this.stream;
      this.stream = await this.withRecoveryTimeout(this.environment.getUserMedia!(CAMERA_CONSTRAINTS));
      previous?.getTracks().forEach((track) => track.stop());
      if (!this.active) return this.release();
      this.video.srcObject = this.stream;
      await this.video.play();
      await this.enableContinuousFocus();
      this.armStallMonitor();
      this.diagnostic('recover-ok');
    } catch (error) {
      this.stop();
      this.diagnostic('recover-fail', { error: this.errorDetails(error) });
      this.diagnostic('camera-error', { error: this.errorDetails(error) });
      this.environment.onState('camera-error');
    } finally {
      this.recovering = false;
    }
  }

  private withRecoveryTimeout(acquisition: Promise<MediaStream>) {
    const timeout = this.environment.timeout;
    return timeout ? timeout(acquisition, RECOVERY_ACQUIRE_TIMEOUT_MS) : acquisition;
  }

  private disarmStallMonitor() {
    this.trackListeners?.forEach(([track, listener]) => track.removeEventListener?.('ended', listener));
    this.trackListeners = undefined;
    this.stallMonitorStop?.();
    this.stallMonitorStop = undefined;
  }

  private async enableContinuousFocus() {
    const track = this.stream?.getVideoTracks()[0] as unknown as {
      getCapabilities?: () => { focusMode?: string[] };
      applyConstraints?: (constraints: MediaTrackConstraints) => Promise<void>;
    } | undefined;
    if (!track?.getCapabilities || !track.applyConstraints) return;
    try {
      if (!track.getCapabilities().focusMode?.includes('continuous')) return;
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
    }
    catch { /* Unsupported focus constraints must not interrupt camera scanning. */ }
  }

  private release() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.video.pause();
    this.video.srcObject = null;
  }

  private diagnostic(event: string, details: Record<string, unknown> = {}) {
    this.environment.onDiagnostic?.({ event, details: { ...this.videoDetails(), ...details } });
  }

  private videoDetails() {
    const track = this.stream?.getVideoTracks()[0];
    return {
      video: {
        readyState: this.video.readyState,
        paused: this.video.paused,
        currentTime: Math.round((this.video.currentTime || 0) * 10) / 10,
        width: this.video.videoWidth,
        height: this.video.videoHeight,
      },
      track: track ? { readyState: track.readyState, muted: track.muted, enabled: track.enabled } : undefined,
      idleStreak: this.idleStreak,
      streamRestarts: this.streamRestarts,
    };
  }

  private errorDetails(error: unknown) {
    if (!(error instanceof Error)) return { name: 'UnknownError', category: 'unknown' };
    return { name: error.name || 'Error', category: (error.message || error.name || 'error').slice(0, 80) };
  }

  private codeDetails(text: string) {
    return {
      length: text.length,
      digits: /^\d+$/.test(text),
      prefix: text.length > 2 ? `${text.slice(0, 2)}…` : text,
      suffix: text.length > 2 ? `…${text.slice(-2)}` : text,
      format: text.length === 14 ? 'ITF14' : text.length === 13 ? 'ITF13' : 'unknown',
    };
  }
}

export function createBrowserScanner(video: HTMLVideoElement, handlers: Pick<ScannerEnvironment, 'onState' | 'onDecode' | 'onTorch' | 'onDiagnostic'>) {
  const canvas = document.createElement('canvas');
  const BarcodeDetector = (globalThis as typeof globalThis & { BarcodeDetector?: { getSupportedFormats: () => Promise<string[]>; new(options: { formats: string[] }): { detect: (video: HTMLVideoElement) => Promise<Array<{ rawValue?: string }>> } } }).BarcodeDetector;
  let fallbackReader: Promise<FallbackReader> | undefined;
  const client = new ScannerClient(video, {
    secure: globalThis.isSecureContext,
    getUserMedia: navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices),
    timeout: (promise, milliseconds) => {
      let loser = promise;
      return Promise.race([
        promise,
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error('recovery-acquire-timeout')), milliseconds)),
      ]).finally(() => { loser.catch(() => {}); });
    },
    BarcodeDetector: BarcodeDetector && { getSupportedFormats: () => BarcodeDetector.getSupportedFormats(), detect: (source) => new BarcodeDetector({ formats: ['itf'] }).detect(source) },
    loadFallback: async () => {
      fallbackReader ??= (async () => {
        const reader = await import('zxing-wasm/reader');
        await reader.prepareZXingModule({ fireImmediately: true, overrides: { locateFile: (path: string) => path.endsWith('.wasm') ? readerWasm : path } });
        return reader;
      })();
      return fallbackReader;
    },
    snapshot: (source) => { if (!source.videoWidth || !source.videoHeight || source.readyState < 2) throw new Error('frame-not-ready'); const scale = Math.min(1, DECODE_MAX_WIDTH / source.videoWidth); canvas.width = Math.max(1, Math.round(source.videoWidth * scale)); canvas.height = Math.max(1, Math.round(source.videoHeight * scale)); const context = canvas.getContext('2d'); if (!context) throw new Error('canvas-unavailable'); context.drawImage(source, 0, 0, canvas.width, canvas.height); return context.getImageData(0, 0, canvas.width, canvas.height); },
    clearFrame: () => { canvas.width = 0; canvas.height = 0; },
    monitor: (element, onStall) => {
      let stalledChecks = 0;
      let baseline = element.currentTime;
      const interval = window.setInterval(() => {
        const healthy = !element.paused && element.readyState >= 2 && element.currentTime !== baseline;
        baseline = element.currentTime;
        stalledChecks = healthy ? 0 : stalledChecks + 1;
        if (stalledChecks >= 8) { window.clearInterval(interval); onStall(); }
      }, 500);
      return () => window.clearInterval(interval);
    },
    ...handlers,
  });
  let outerLastTime = -1;
  let outerStaleChecks = 0;
  window.setInterval(() => {
    if (!video.srcObject) { outerStaleChecks = 0; return; }
    const advanced = !video.paused && video.readyState >= 2 && video.currentTime !== outerLastTime;
    outerLastTime = video.currentTime;
    outerStaleChecks = advanced ? 0 : outerStaleChecks + 1;
    if (outerStaleChecks >= OUTER_STALL_CHECKS_LIMIT) { outerStaleChecks = 0; handlers.onDiagnostic?.({ event: 'outer-watchdog-stall', details: { video: { readyState: video.readyState, paused: video.paused, currentTime: Math.round((video.currentTime || 0) * 10) / 10, width: video.videoWidth, height: video.videoHeight } } }); client.recover(); }
  }, OUTER_STALL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !video.srcObject) return;
    outerStaleChecks = 0;
    if (video.paused || video.readyState < 2) client.recover();
  });
  return client;
}
