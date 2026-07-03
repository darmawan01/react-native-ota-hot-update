import nacl from 'tweetnacl';
import { sha256 } from 'js-sha256';
import { Buffer } from 'buffer';

/**
 * Ed25519 manifest verification for the OTA platform wire protocol.
 *
 * These canonical strings MUST stay byte-identical to the server's `Signer`
 * (ota-platform `src/lib/signing.ts`) and the flutter_patcher device verifier —
 * a single differing byte makes the signature fail. See docs/protocol.md.
 */

/** Extract the raw 32-byte Ed25519 public key from an SPKI DER (base64) key. */
export function spkiToRawEd25519(spkiBase64: string): Uint8Array {
  const der = Buffer.from(spkiBase64.trim(), 'base64');
  // SPKI for Ed25519 = 12-byte header + 32-byte key. Take the trailing 32 bytes.
  if (der.length < 32) throw new Error('invalid Ed25519 public key (too short)');
  return new Uint8Array(der.subarray(der.length - 32));
}

/** Verify a base64 Ed25519 signature over the UTF-8 bytes of `message`. */
export function verifySignature(message: string, signatureBase64: string, spkiBase64: string): boolean {
  try {
    const pub = spkiToRawEd25519(spkiBase64);
    const sig = new Uint8Array(Buffer.from(signatureBase64, 'base64'));
    if (sig.length !== 64) return false;
    const msg = new Uint8Array(Buffer.from(message, 'utf8'));
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}

export interface ManifestBase {
  version: string;
  patchNumber: number;
  targetVersionCode: number;
  sha256: string;
  rolloutPercent: number;
  channel: string;
}

export interface ManifestV3 extends ManifestBase {
  delivery: 'silent' | 'notify' | 'custom';
  annTitle?: string | null;
  annBody?: string | null;
  annSeverity?: string | null;
  annUrl?: string | null;
}

const oneLine = (s: string | null | undefined) => (s ?? '').replace(/[\r\n]+/g, ' ');

export function manifestV1String(p: Pick<ManifestBase, 'version' | 'patchNumber' | 'targetVersionCode' | 'sha256'>): string {
  return (
    'flutter_patcher.manifest.v1\n' +
    `version=${p.version}\n` +
    `patchNumber=${p.patchNumber}\n` +
    `targetVersionCode=${p.targetVersionCode}\n` +
    `sha256=${p.sha256.toLowerCase()}`
  );
}

export function manifestV2String(p: ManifestBase): string {
  return (
    'flutter_patcher.manifest.v2\n' +
    `version=${p.version}\n` +
    `patchNumber=${p.patchNumber}\n` +
    `targetVersionCode=${p.targetVersionCode}\n` +
    `sha256=${p.sha256.toLowerCase()}\n` +
    `rolloutPercent=${p.rolloutPercent}\n` +
    `channel=${p.channel}`
  );
}

export function manifestV3String(p: ManifestV3, severityOverride?: string): string {
  const bodySha = p.annBody ? sha256(p.annBody) : '';
  const severity = severityOverride !== undefined ? severityOverride : oneLine(p.annSeverity);
  return (
    'flutter_patcher.manifest.v3\n' +
    `version=${p.version}\n` +
    `patchNumber=${p.patchNumber}\n` +
    `targetVersionCode=${p.targetVersionCode}\n` +
    `sha256=${p.sha256.toLowerCase()}\n` +
    `rolloutPercent=${p.rolloutPercent}\n` +
    `channel=${p.channel}\n` +
    `delivery=${p.delivery}\n` +
    `annTitle=${oneLine(p.annTitle)}\n` +
    `annSeverity=${severity}\n` +
    `annUrl=${oneLine(p.annUrl)}\n` +
    `annBodySha256=${bodySha}`
  );
}

/**
 * Verify a patch manifest from a `/check` response against the app's public key.
 * Picks the canonical form by `manifestVersion` (2 or 3).
 *
 * v3 note: the server signs a *null* severity as "" but the `/check` response
 * defaults it to "info". If the primary check fails on a v3 manifest whose
 * severity is "info", we retry once with "" to cover that server default.
 */
export function verifyManifest(
  manifestVersion: number,
  patch: ManifestV3,
  signatureBase64: string,
  spkiBase64: string,
): boolean {
  if (manifestVersion >= 3) {
    if (verifySignature(manifestV3String(patch), signatureBase64, spkiBase64)) return true;
    if ((patch.annSeverity ?? '') === 'info') {
      return verifySignature(manifestV3String(patch, ''), signatureBase64, spkiBase64);
    }
    return false;
  }
  return verifySignature(manifestV2String(patch), signatureBase64, spkiBase64);
}

/** Canonical string for the rollback (kill switch) list. */
export function rollbackString(patchNumbers: number[]): string {
  const sorted = [...new Set(patchNumbers)].sort((a, b) => a - b);
  return `flutter_patcher.rollback.v1\npatchNumbers=${sorted.join(',')}`;
}

/** Verify the signed kill-switch list from a `/check` response. */
export function verifyRollback(patchNumbers: number[], signatureBase64: string, spkiBase64: string): boolean {
  if (!patchNumbers.length) return true; // nothing claimed → nothing to forge
  return verifySignature(rollbackString(patchNumbers), signatureBase64, spkiBase64);
}
