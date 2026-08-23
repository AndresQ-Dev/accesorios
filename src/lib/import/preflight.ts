import { createRequire } from 'node:module';
import { HttpError } from '../http/request';

type ZipEntry = { fileName: string; uncompressedSize: number };
type ZipFile = { entryCount: number; readEntry(): void; close(): void; on(event: 'entry' | 'end' | 'error', listener: (value?: ZipEntry | Error) => void): void };
const yauzl = createRequire(import.meta.url)('yauzl') as { fromBuffer(buffer: Buffer, options: { lazyEntries: boolean; validateEntrySizes: boolean }, callback: (error: Error | null, zip?: ZipFile) => void): void };

export const XLSX_LIMITS = { uploadBytes: 2 * 1024 * 1024, entries: 64, expandedBytes: 8 * 1024 * 1024, sheets: 1, rows: 10_000, columns: 5, cellLength: 512 };
const invalid = (message: string) => new HttpError(422, 'INVALID_XLSX', message);

export async function readXlsxUpload(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (!contentType.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests must use the XLSX content type.');
  if (!Number.isFinite(declaredLength) || declaredLength > XLSX_LIMITS.uploadBytes) throw new HttpError(413, 'XLSX_TOO_LARGE', 'XLSX upload exceeds the configured limit.');
  const reader = request.body?.getReader(); if (!reader) throw invalid('XLSX upload is required.');
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > XLSX_LIMITS.uploadBytes) throw new HttpError(413, 'XLSX_TOO_LARGE', 'XLSX upload exceeds the configured limit.'); chunks.push(value); }
  return Buffer.concat(chunks);
}

export function preflightXlsx(buffer: Buffer) {
  return new Promise<void>((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
    if (error || !zip) return reject(invalid('Upload is not a valid ZIP archive.'));
    if (zip.entryCount > XLSX_LIMITS.entries) return reject(invalid('XLSX archive contains too many entries.'));
    let expanded = 0;
    zip.on('error', () => reject(invalid('XLSX archive could not be read.')));
    zip.on('end', () => { zip.close(); resolve(); });
    zip.on('entry', (entry) => {
      if (!entry || entry instanceof Error) return reject(invalid('XLSX archive could not be read.'));
      expanded += entry.uncompressedSize;
      if (expanded > XLSX_LIMITS.expandedBytes || /(^|\/)vbaProject\.bin$/i.test(entry.fileName)) { zip.close(); return reject(invalid('XLSX archive exceeds safe limits or contains macros.')); }
      zip.readEntry();
    });
    zip.readEntry();
  }));
}
