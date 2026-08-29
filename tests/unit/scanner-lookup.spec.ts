import { describe, expect, it, vi } from 'vitest';
import { lookupScannedBarcode } from '../../app/static/scanner-lookup.js';

describe('scanner catalog miss presentation boundary', () => {
  it('presents a final miss for plausible 13-digit and non-leading-zero 14-digit scans', async () => {
    const lookup = vi.fn().mockResolvedValue('not-found');
    const setInput = vi.fn();
    const onFinalNotFound = vi.fn();

    await lookupScannedBarcode('4440000015833', { lookup, setInput, onLeadingZeroFallback: vi.fn(), onFinalNotFound });
    await lookupScannedBarcode('44440000015833', { lookup, setInput, onLeadingZeroFallback: vi.fn(), onFinalNotFound });

    expect(lookup).toHaveBeenNthCalledWith(1, '4440000015833');
    expect(lookup).toHaveBeenNthCalledWith(2, '44440000015833');
    expect(setInput).toHaveBeenCalledWith('4440000015833');
    expect(setInput).toHaveBeenCalledWith('44440000015833');
    expect(onFinalNotFound).toHaveBeenCalledTimes(2);
  });

  it('waits for a leading-zero fallback miss before presenting and restores the original scanned code', async () => {
    const setInput = vi.fn();
    const onLeadingZeroFallback = vi.fn();
    const onFinalNotFound = vi.fn();
    const lookup = vi.fn().mockImplementation(async (query) => {
      expect(onFinalNotFound).not.toHaveBeenCalled();
      return query === '04440000015833' ? 'not-found' : 'not-found';
    });

    await lookupScannedBarcode('04440000015833', { lookup, setInput, onLeadingZeroFallback, onFinalNotFound });

    expect(lookup).toHaveBeenNthCalledWith(1, '04440000015833');
    expect(lookup).toHaveBeenNthCalledWith(2, '4440000015833');
    expect(onLeadingZeroFallback).toHaveBeenCalledWith({ originalLength: 14, retryLength: 13 });
    expect(setInput).toHaveBeenLastCalledWith('04440000015833');
    expect(onFinalNotFound).toHaveBeenCalledOnce();
  });

  it('never presents the scanner-only visual for matches or lookup errors', async () => {
    for (const outcome of ['matched', 'retry']) {
      const onFinalNotFound = vi.fn();
      await lookupScannedBarcode('4440000015833', {
        lookup: vi.fn().mockResolvedValue(outcome),
        setInput: vi.fn(),
        onLeadingZeroFallback: vi.fn(),
        onFinalNotFound,
      });
      expect(onFinalNotFound).not.toHaveBeenCalled();
    }
  });
});
