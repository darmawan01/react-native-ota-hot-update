import { crc32, rolloutBucket, inRollout } from '../rollout';

describe('rollout', () => {
  it('computes standard IEEE CRC-32 (matches the server + Kotlin)', () => {
    expect(crc32('abc')).toBe(891568578); // 0x352441C2
    expect(crc32('')).toBe(0);
  });

  it('buckets are 0..99 and deterministic', () => {
    const b = rolloutBucket('device-xyz', 5);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(100);
    expect(rolloutBucket('device-xyz', 5)).toBe(b); // stable
  });

  it('100% includes everyone, 0% no one', () => {
    expect(inRollout('anyone', 1, 100)).toBe(true);
    expect(inRollout('anyone', 1, 0)).toBe(false);
  });

  it('inRollout agrees with the bucket threshold', () => {
    const id = 'device-xyz';
    const b = rolloutBucket(id, 5);
    expect(inRollout(id, 5, b + 1)).toBe(true); // bucket < percent
    expect(inRollout(id, 5, b)).toBe(false); // bucket not < percent
  });
});
