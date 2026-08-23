import { describe, expect, it, vi } from 'vitest';
import { ScannerClient } from '../../src/client/scanner';

const stream = () => {
  const tracks = [{ stop: vi.fn() }];
  return { getTracks: () => tracks, getVideoTracks: () => [] } as unknown as MediaStream;
};
const video = () => ({ srcObject: null, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }) as unknown as HTMLVideoElement;

describe('private ITF scanner', () => {
  it('uses native detection only when ITF is reported and releases the camera after a decode', async () => {
    const media = stream(); const states: string[] = []; const decoded = vi.fn();
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(media),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['itf']), detect: vi.fn().mockResolvedValue([{ rawValue: '04440000015833' }]) },
      loadFallback: vi.fn(), snapshot: vi.fn(), onState: (state) => states.push(state), onDecode: decoded,
    });

    await client.start();

    expect(decoded).toHaveBeenCalledWith('04440000015833');
    expect(media.getTracks()[0].stop).toHaveBeenCalledOnce();
    expect(states).toContain('scanning');
  });

  it('lazy-loads an ITF-only fallback when native ITF is unavailable', async () => {
    const readBarcodes = vi.fn().mockResolvedValue([{ text: '04440000015833' }]); const clearFrame = vi.fn();
    const client = new ScannerClient(video(), {
      secure: true, getUserMedia: vi.fn().mockResolvedValue(stream()),
      BarcodeDetector: { getSupportedFormats: vi.fn().mockResolvedValue(['qr_code']), detect: vi.fn() },
      loadFallback: vi.fn().mockResolvedValue({ readBarcodes }), snapshot: vi.fn().mockReturnValue({}), clearFrame, onState: vi.fn(), onDecode: vi.fn(),
    });

    await client.start();

    expect(readBarcodes).toHaveBeenCalledWith({}, expect.objectContaining({ formats: ['ITF'] }));
    expect(clearFrame).toHaveBeenCalled();
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
      loadFallback: vi.fn(), snapshot: vi.fn(), onState: vi.fn(), onDecode: vi.fn(), schedule: () => 1, clearSchedule: vi.fn(),
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
    }).start();

    expect(states).toEqual(expect.arrayContaining(['unsupported', 'permission-denied', 'slow']));
  });
});
