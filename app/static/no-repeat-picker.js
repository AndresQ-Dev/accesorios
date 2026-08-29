export const SCANNER_NO_MATCH_IMAGES = Object.freeze([
  '/static/images/scanner-no-match/01.png',
  '/static/images/scanner-no-match/02.png',
  '/static/images/scanner-no-match/04.png',
  '/static/images/scanner-no-match/05.png',
]);

export function createNoRepeatPicker(manifest, random = Math.random) {
  if (!Array.isArray(manifest) || manifest.length === 0) throw new Error('The image manifest must not be empty.');
  if (new Set(manifest).size !== manifest.length) throw new Error('The image manifest must contain unique entries.');

  let remaining = [];
  let previous;

  function refill() {
    remaining = [...manifest];
    for (let index = remaining.length - 1; index > 0; index -= 1) {
      const randomIndex = Math.min(index, Math.floor(random() * (index + 1)));
      [remaining[index], remaining[randomIndex]] = [remaining[randomIndex], remaining[index]];
    }
    if (remaining.length > 1 && remaining[0] === previous) {
      [remaining[0], remaining[1]] = [remaining[1], remaining[0]];
    }
  }

  return () => {
    if (remaining.length === 0) refill();
    previous = remaining.shift();
    return previous;
  };
}

export const pickScannerNoMatchImage = createNoRepeatPicker(SCANNER_NO_MATCH_IMAGES);
