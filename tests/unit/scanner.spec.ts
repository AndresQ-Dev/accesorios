import { describe, expect, it, vi } from 'vitest';
import { ScannerClient } from '../../src/client/scanner';

const stream = (videoTrack?: { stop: ReturnType<typeof vi.fn>; getCapabilities?: () => { focusMode?: string[] }; applyConstraints?: ReturnType<typeof vi.fn> }) => {
  const tracks = videoTrack ? [videoTrack] : [{ stop: vi.fn() }];
  return { getTracks: () => tracks, getVideoTracks: () => videoTrack ? [videoTrack] : [] } as unknown as MediaStream;
};
const video = () => ({ srcObject: null, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }) as unknown as HTMLVideoElement;
const scheduledCallbacks = () => {
  const callbacks: Array<() => void> = [];
  return {
    callbacks,
    schedule: (callback: () => void) => { callbacks.push(callback); return callbacks.length; },
    runNext: async () => { await callbacks.shift()?.(); },
  };
};

describe('private ITF scanner', () => {
  it('starts ZXing as the primary ITF reader even when native detection is available', async () => {
    const media = stream(); const scheduler = scheduledCallbacks(); const readBarcodes = vi.fn().mockResolvedValue([]); const native = {
      getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn().mockResolvedValue([{ rawValue: 'unstable-native-value' }]),
    }; const getUserMedia = vi.fn().mockResolvedValue(media);
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia, BarcodeDetector: native,
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes }), snapshot: vi.fn().mockReturnValue({}), onState: vi.fn(), onDecode: vi.fn(), schedule: scheduler.schedule,
    });

    await client.start();

    expect(readBarcodes).toHaveBeenCalledWith({}, expect.objectContaining({ formats: ['ITF', 'ITF14'] }));
    expect(native.getSupportedFormats).not.toHaveBeenCalled();
    expect(native.detect).not.toHaveBeenCalled();
    expect(getUserMedia)
      .toHaveBeenCalledWith({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  });

  it('passes the fixture-equivalent ITF raw value to alias/catalog lookup and closes on match', async () => {
    const media = stream(); const decoded = vi.fn().mockResolvedValue('matched'); const readBarcodes = vi.fn().mockResolvedValue([{ isValid: true, text: '04440000015833' }]);
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: { getSupportedFormats: vi.fn(), detect: vi.fn() },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes }), snapshot: vi.fn().mockReturnValue({}), onState: vi.fn(), onDecode: decoded,
    });

    await client.start();

    expect(decoded).toHaveBeenCalledOnce();
    expect(decoded).toHaveBeenCalledWith('04440000015833');
    expect(media.getTracks()[0].stop).toHaveBeenCalledOnce();
  });

  it('initializes the ITF-family ZXing reader once per scan session', async () => {
    const scheduler = scheduledCallbacks(); const readBarcodes = vi.fn().mockResolvedValue([]); const clearFrame = vi.fn(); const loadFallback = vi.fn().mockResolvedValue({ readBarcodes });
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(stream()),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn() },
      loadFallback, snapshot: vi.fn().mockReturnValue({}), clearFrame, onState: vi.fn(), onDecode: vi.fn(), schedule: scheduler.schedule,
    });

    await client.start();
    await scheduler.runNext();

    expect(readBarcodes).toHaveBeenCalledWith({}, expect.objectContaining({ formats: ['ITF', 'ITF14'], tryHarder: true, tryRotate: true, tryDenoise: true, returnErrors: true }));
    expect(loadFallback).toHaveBeenCalledOnce();
    expect(clearFrame).toHaveBeenCalled();
  });

  it('uses native detection only after ZXing initialization genuinely fails', async () => {
    const media = stream(); const decoded = vi.fn().mockResolvedValue('matched'); const native = {
      getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn().mockResolvedValue([{ rawValue: '04440000015833' }]),
    };
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: native, loadFallback: vi.fn().mockRejectedValue(new Error('wasm-unavailable')), snapshot: vi.fn(), onState: vi.fn(), onDecode: decoded,
    });

    await client.start();

    expect(native.getSupportedFormats).toHaveBeenCalledOnce();
    expect(native.detect).toHaveBeenCalledOnce();
    expect(decoded).toHaveBeenCalledWith('04440000015833');
    expect(media.getTracks()[0].stop).toHaveBeenCalledOnce();
  });

  it('keeps native recovery scanning after empty frames instead of declaring unsupported', async () => {
    const media = stream(); const scheduler = scheduledCallbacks(); const states: string[] = [];
    const native = {
      getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn().mockResolvedValue([]),
    };
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: native, loadFallback: vi.fn().mockRejectedValue(new Error('wasm-unavailable')), snapshot: vi.fn(), onState: (state) => states.push(state), onDecode: vi.fn(), schedule: scheduler.schedule,
    });

    await client.start();
    await scheduler.runNext();
    await scheduler.runNext();
    await scheduler.runNext();
    await scheduler.runNext();

    expect(native.detect).toHaveBeenCalledTimes(5);
    expect(states).toContain('slow');
    expect(states).not.toContain('unsupported');
    expect(media.getTracks()[0].stop).not.toHaveBeenCalled();
  });

  it('retries transient fallback frame errors without reporting unsupported or stopping the camera', async () => {
    const media = stream(); const scheduler = scheduledCallbacks(); const states: string[] = []; const readBarcodes = vi.fn().mockRejectedValueOnce(new Error('decoder-not-ready')).mockResolvedValue([]);
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn() },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes }), snapshot: vi.fn().mockReturnValue({}), clearFrame: vi.fn(), onState: (state) => states.push(state), onDecode: vi.fn(), schedule: scheduler.schedule,
    });

    await client.start();

    expect(states).toContain('slow');
    expect(states).not.toContain('unsupported');
    expect(media.getTracks()[0].stop).not.toHaveBeenCalled();
  });

  it('reports unsupported and stops when ZXing initialization and native recovery both fail', async () => {
    const media = stream(); const states: string[] = [];
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['qr_code']), detect: vi.fn() },
      loadFallback: vi.fn().mockRejectedValue(new Error('wasm-unavailable')), snapshot: vi.fn(), onState: (state) => states.push(state), onDecode: vi.fn(), schedule: vi.fn(),
    });

    await client.start();

    expect(states.filter((state) => state === 'unsupported')).toHaveLength(1);
    expect(media.getTracks()[0].stop).toHaveBeenCalledOnce();
  });

  it('reports unreadable for implausible reads and only accepts 13-14 digit numeric codes', async () => {
    const media = stream(); const scheduler = scheduledCallbacks(); const states: string[] = []; const lookup = vi.fn().mockResolvedValue('matched');
    const readBarcodes = vi.fn()
      .mockResolvedValueOnce([{ isValid: true, text: '0000' }])
      .mockResolvedValueOnce([{ isValid: true, text: '04440000015833x' }])
      .mockResolvedValue([{ isValid: true, text: '4440000015833' }]);
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn() },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes }), snapshot: vi.fn().mockReturnValue({}), onState: (state) => states.push(state), onDecode: lookup, schedule: scheduler.schedule,
    });

    await client.start();
    await scheduler.runNext();
    await scheduler.runNext();

    expect(states.filter((state) => state === 'unreadable')).toHaveLength(2);
    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith('4440000015833');
    expect(media.getTracks()[0].stop).toHaveBeenCalledOnce();
  });

  it('backs off and reduces decoder effort while idle without a readable code', async () => {
    const media = stream(); const callbacks: Array<() => void> = []; const delays: Array<number | undefined> = [];
    const schedule = (callback: () => void, milliseconds?: number) => { callbacks.push(callback); delays.push(milliseconds); return callbacks.length; };
    const runNext = async () => { await callbacks.shift()?.(); };
    const readBarcodes = vi.fn().mockResolvedValue([]);
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn() },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes }), snapshot: vi.fn().mockReturnValue({}), onState: vi.fn(), onDecode: vi.fn(), schedule,
    });

    await client.start();
    for (let cycle = 0; cycle < 6; cycle += 1) await runNext();

    expect(delays.slice(0, 6)).toEqual([250, 350, 500, 750, 1000, 1000]);
    const lastOptions = readBarcodes.mock.calls.at(-1)![1];
    expect(lastOptions.tryRotate).toBe(false);
    expect(lastOptions.tryDenoise).toBe(false);
    expect(media.getTracks()[0].stop).not.toHaveBeenCalled();
  });

  it('recovers once when the camera track ends and reports camera-error on a second loss', async () => {
    const makeStream = () => {
      const handlers: Array<() => void> = [];
      const track = { stop: vi.fn(), addEventListener: (_: string, listener: () => void) => handlers.push(listener), removeEventListener: vi.fn() };
      return { stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream, handlers };
    };
    const first = makeStream(); const second = makeStream();
    const getUserMedia = vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const states: string[] = [];
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia,
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn() },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes: vi.fn().mockResolvedValue([]) }), snapshot: vi.fn().mockReturnValue({}), onState: (state) => states.push(state), onDecode: vi.fn(), schedule: vi.fn(),
    });

    await client.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    first.handlers[0]!();
    await vi.waitFor(() => expect(second.handlers).toHaveLength(1));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(first.stream.getTracks()[0].stop).toHaveBeenCalled();

    second.handlers[0]!();
    await vi.waitFor(() => expect(states).toContain('camera-error'));
    expect(second.stream.getTracks()[0].stop).toHaveBeenCalled();
  });

  it('keeps scanning after a catalog miss while deduplicating the same candidate', async () => {
    const media = stream(); const scheduler = scheduledCallbacks(); const states: string[] = []; const lookup = vi.fn().mockResolvedValue('not-found');
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn() },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes: vi.fn().mockResolvedValue([{ isValid: true, text: '04440000015833' }]) }), snapshot: vi.fn().mockReturnValue({}), onState: (state) => states.push(state), onDecode: lookup, schedule: scheduler.schedule,
    });

    await client.start(); await scheduler.runNext(); await scheduler.runNext();

    expect(lookup).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledWith('04440000015833');
    expect(states).toContain('catalog-miss');
    expect(media.getTracks()[0].stop).not.toHaveBeenCalled();
    expect(scheduler.callbacks).toHaveLength(1);
  });

  it('emits safe diagnostic events without raw barcode values', async () => {
    const media = stream(); const scheduler = scheduledCallbacks(); const diagnostics: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn() },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes: vi.fn().mockResolvedValue([{ isValid: true, text: '04440000015833' }]) }),
      snapshot: vi.fn().mockReturnValue({}), onState: vi.fn(), onDecode: vi.fn().mockResolvedValue('not-found'), schedule: scheduler.schedule,
      onDiagnostic: (event) => diagnostics.push(event),
    });

    await client.start();

    const names = diagnostics.map(({ event }) => event);
    expect(names).toEqual(expect.arrayContaining(['start', 'scan-fallback', 'plausible-candidate', 'catalog-miss', 'retry']));
    const text = JSON.stringify(diagnostics);
    expect(text).not.toContain('04440000015833');
    expect(text).toContain('"length":14');
    expect(text).toContain('"digits":true');
  });

  it('keeps scanning after a lookup retry without looping the same decoded candidate', async () => {
    const media = stream(); const scheduler = scheduledCallbacks(); const lookup = vi.fn().mockResolvedValue('retry');
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn() },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes: vi.fn().mockResolvedValue([{ isValid: true, text: '04440000015833' }]) }), snapshot: vi.fn().mockReturnValue({}), onState: vi.fn(), onDecode: lookup, schedule: scheduler.schedule,
    });

    await client.start(); await scheduler.runNext(); await scheduler.runNext();

    expect(lookup).toHaveBeenCalledOnce();
    expect(media.getTracks()[0].stop).not.toHaveBeenCalled();
  });

  it('does not request a camera from an insecure page and releases it on cancellation', async () => {
    const getUserMedia = vi.fn(); const insecure = new ScannerClient(video(), {
      secure: false, getUserMedia, loadFallback: vi.fn(), snapshot: vi.fn(), onState: vi.fn(), onDecode: vi.fn(),
    });
    await insecure.start();
    expect(getUserMedia).not.toHaveBeenCalled();

    const media = stream(); const active = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn().mockResolvedValue([]) },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes: vi.fn().mockResolvedValue([]) }), snapshot: vi.fn().mockReturnValue({}), onState: vi.fn(), onDecode: vi.fn(), schedule: () => 1, clearSchedule: vi.fn(),
    });
    await active.start(); active.stop();
    expect(media.getTracks()[0].stop).toHaveBeenCalledOnce();
  });

  it('reports unsupported, denied, and slow-scan recovery states', async () => {
    const states: string[] = []; const common = { loadFallback: vi.fn(), snapshot: vi.fn(), onState: (state: string) => states.push(state), onDecode: vi.fn() };
    await new ScannerClient(video(), { secure: true, ...common }).start();
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    await new ScannerClient(video(), { secure: true, ...common, getUserMedia: vi.fn().mockRejectedValue(denied) }).start();
    await new ScannerClient(video(), {
      secure: true, ...common, getUserMedia: vi.fn().mockResolvedValue(stream()), schedule: () => 1,
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn().mockResolvedValue([]) },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes: vi.fn().mockResolvedValue([]) }), snapshot: vi.fn().mockReturnValue({}),
    }).start();

    expect(states).toEqual(expect.arrayContaining(['unsupported', 'permission-denied', 'slow']));
  });

  it('applies continuous focus only when supported and keeps scanning if the constraint is rejected', async () => {
    const focusTrack = {
      stop: vi.fn(), getCapabilities: vi.fn().mockReturnValue({ focusMode: ['continuous'] }), applyConstraints: vi.fn().mockRejectedValue(new Error('constraint-unsupported')),
    }; const media = stream(focusTrack); const readBarcodes = vi.fn().mockResolvedValue([]); const states: string[] = [];
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media), loadFallback: vi.fn().mockResolvedValue({ readBarcodes }), snapshot: vi.fn().mockReturnValue({}), onState: (state) => states.push(state), onDecode: vi.fn(), schedule: vi.fn(),
    });

    await client.start();

    expect(focusTrack.applyConstraints).toHaveBeenCalledWith({ advanced: [{ focusMode: 'continuous' }] });
    expect(readBarcodes).toHaveBeenCalledOnce();
    expect(states).toContain('scanning');
    expect(states).not.toContain('camera-error');
  });

  it('keeps scanning when focus capabilities cannot be read', async () => {
    const focusTrack = { stop: vi.fn(), getCapabilities: vi.fn().mockImplementation(() => { throw new Error('capabilities-unavailable'); }), applyConstraints: vi.fn() };
    const states: string[] = []; const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(stream(focusTrack)), loadFallback: vi.fn().mockResolvedValue({ readBarcodes: vi.fn().mockResolvedValue([]) }), snapshot: vi.fn().mockReturnValue({}), onState: (state) => states.push(state), onDecode: vi.fn(), schedule: vi.fn(),
    });

    await client.start();

    expect(focusTrack.applyConstraints).not.toHaveBeenCalled();
    expect(states).toContain('scanning');
    expect(states).not.toContain('camera-error');
  });
});
