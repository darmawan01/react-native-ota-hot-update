import {
  verifyManifest,
  verifyRollback,
  verifySignature,
  spkiToRawEd25519,
  manifestV2String,
  type ManifestV3,
} from '../verify';

// Vector generated with the server's exact Ed25519 scheme (ota-platform
// src/lib/signing.ts) from a fixed seed, so this proves byte-for-byte parity.
const SPKI = 'MCowBQYDK2VwAyEAPM0kHP/Js2GARLl9A22GFFk9iwF8NA8d7odzOFUXZUs=';
const V2_SIG = 'e5+EwVn9ym1cZG+gBHF68izyOfHXFOpXtLcRTePvX32cr/X4TA1LYP4O09cn2jPr631bC6LuwXfh8IrWcub/Dw==';
const ROLLBACK_SIG = 'dpFXMB0E5VDlNCx3DuQ/qGYHYjyV3eI/USrZbTXweIK3BU4ihGrhLwjn4Q4U7kmO74I9D/fJTLP0LvaVZGzzBQ==';

const patch: ManifestV3 = {
  version: '1.2.0+5',
  patchNumber: 5,
  targetVersionCode: 4,
  sha256: 'abc123',
  rolloutPercent: 100,
  channel: '',
  delivery: 'silent',
};

describe('verify', () => {
  it('extracts a 32-byte raw key from SPKI', () => {
    expect(spkiToRawEd25519(SPKI)).toHaveLength(32);
  });

  it('builds the exact v2 canonical string', () => {
    expect(manifestV2String(patch)).toBe(
      'flutter_patcher.manifest.v2\nversion=1.2.0+5\npatchNumber=5\ntargetVersionCode=4\nsha256=abc123\nrolloutPercent=100\nchannel=',
    );
  });

  it('verifies a genuine v2 manifest signature', () => {
    expect(verifyManifest(2, patch, V2_SIG, SPKI)).toBe(true);
  });

  it('rejects a tampered manifest', () => {
    expect(verifyManifest(2, { ...patch, sha256: 'deadbeef' }, V2_SIG, SPKI)).toBe(false);
    expect(verifyManifest(2, { ...patch, patchNumber: 6 }, V2_SIG, SPKI)).toBe(false);
  });

  it('rejects a signature from the wrong key', () => {
    const otherKey = 'MCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9wYqiqfkgB4qQ+9ykUxLQY1sM=';
    expect(verifyManifest(2, patch, V2_SIG, otherKey)).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    expect(verifySignature('x', 'not-base64!!', SPKI)).toBe(false);
    expect(verifySignature('x', '', SPKI)).toBe(false);
  });

  it('verifies the signed kill-switch list (order-independent)', () => {
    expect(verifyRollback([5, 7], ROLLBACK_SIG, SPKI)).toBe(true);
    expect(verifyRollback([7, 5], ROLLBACK_SIG, SPKI)).toBe(true); // sorted before signing
    expect(verifyRollback([5, 8], ROLLBACK_SIG, SPKI)).toBe(false);
  });

  it('treats an empty kill list as trivially valid', () => {
    expect(verifyRollback([], '', SPKI)).toBe(true);
  });
});
