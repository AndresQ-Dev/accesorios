export async function lookupScannedBarcode(text, {
  lookup,
  setInput,
  onLeadingZeroFallback,
  onFinalNotFound,
}) {
  setInput(text);
  const hasLeadingZeroFallback = /^0[0-9]{13}$/.test(text);
  const originalOutcome = await lookup(text);
  if (originalOutcome !== 'not-found') return originalOutcome;

  if (!hasLeadingZeroFallback) {
    onFinalNotFound();
    return originalOutcome;
  }

  const withoutLeadingZero = text.slice(1);
  onLeadingZeroFallback({ originalLength: text.length, retryLength: withoutLeadingZero.length });
  const fallbackOutcome = await lookup(withoutLeadingZero);
  setInput(text);
  if (fallbackOutcome === 'not-found') onFinalNotFound();
  return fallbackOutcome;
}
