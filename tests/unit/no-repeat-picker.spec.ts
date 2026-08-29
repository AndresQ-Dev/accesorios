import { describe, expect, it, vi } from 'vitest';
import { createNoRepeatPicker, SCANNER_NO_MATCH_IMAGES } from '../../app/static/no-repeat-picker.js';

describe('scanner no-match image picker', () => {
  it('uses every distinct manifest image once before starting another cycle without a boundary repeat', () => {
    const random = vi.fn().mockReturnValue(0);
    const picker = createNoRepeatPicker(SCANNER_NO_MATCH_IMAGES, random);
    const firstCycle = SCANNER_NO_MATCH_IMAGES.map(() => picker());
    const secondCycle = SCANNER_NO_MATCH_IMAGES.map(() => picker());

    expect(new Set(SCANNER_NO_MATCH_IMAGES)).toHaveLength(SCANNER_NO_MATCH_IMAGES.length);
    expect(new Set(firstCycle)).toHaveLength(SCANNER_NO_MATCH_IMAGES.length);
    expect(new Set(secondCycle)).toHaveLength(SCANNER_NO_MATCH_IMAGES.length);
    expect(secondCycle[0]).not.toBe(firstCycle.at(-1));
    expect(random).toHaveBeenCalled();
  });

  it('rejects an empty or visually duplicate manifest', () => {
    expect(() => createNoRepeatPicker([])).toThrow('must not be empty');
    expect(() => createNoRepeatPicker(['one.png', 'one.png'])).toThrow('must contain unique entries');
  });
});
