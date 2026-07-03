import { Buffer } from 'buffer';

/**
 * Staged-rollout bucket math — byte-identical to the OTA platform server
 * (`src/lib/rollout.ts`) and the flutter_patcher device gate, so the server's
 * push targeting and this client agree on who's in a rollout slice.
 *
 * `crc32("<installId>:<patchNumber>") % 100 < rolloutPercent`. Standard IEEE
 * CRC-32 (matches Kotlin `java.util.zip.CRC32`).
 */
export function crc32(input: string): number {
  const bytes = Buffer.from(input, 'utf8');
  let crc = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let k = 0; k < 8; k++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

/** The device's 0..99 rollout bucket for a patch. */
export function rolloutBucket(installId: string, patchNumber: number): number {
  return crc32(`${installId}:${patchNumber}`) % 100;
}

/** Whether this install falls inside a `rolloutPercent` slice for a patch. */
export function inRollout(installId: string, patchNumber: number, rolloutPercent: number): boolean {
  if (rolloutPercent >= 100) return true;
  if (rolloutPercent <= 0) return false;
  return rolloutBucket(installId, patchNumber) < rolloutPercent;
}
