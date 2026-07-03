import { createOtaServer, type OtaNativeDeps } from '../otaServer';
import type { OtaServerOption, OtaPatch, OtaCheckResponse } from '../otaTypes';

const SPKI = 'MCowBQYDK2VwAyEAPM0kHP/Js2GARLl9A22GFFk9iwF8NA8d7odzOFUXZUs=';
const V2_SIG = 'e5+EwVn9ym1cZG+gBHF68izyOfHXFOpXtLcRTePvX32cr/X4TA1LYP4O09cn2jPr631bC6LuwXfh8IrWcub/Dw==';
const ROLLBACK_SIG = 'dpFXMB0E5VDlNCx3DuQ/qGYHYjyV3eI/USrZbTXweIK3BU4ihGrhLwjn4Q4U7kmO74I9D/fJTLP0LvaVZGzzBQ==';

const patch: OtaPatch = {
  version: '1.2.0+5',
  patchNumber: 5,
  targetVersionCode: 4,
  sha256: 'abc123',
  rolloutPercent: 100,
  channel: '',
  signature: V2_SIG,
  manifestVersion: 2,
  patchUrl: 'https://ota.example/payload/1.2.0+5?app=com.acme',
};

function makeDeps(over: Partial<OtaNativeDeps> = {}) {
  const calls = {
    setupBundlePath: [] as unknown[][],
    setCurrentVersion: [] as number[],
    rolledBack: 0,
    reset: 0,
  };
  const deps: OtaNativeDeps = {
    downloadBundleFile: async () => '/tmp/bundle.zip',
    setupBundlePath: async (...args) => {
      calls.setupBundlePath.push(args);
      return true;
    },
    getCurrentVersion: async () => 0,
    setCurrentVersion: async (v) => {
      calls.setCurrentVersion.push(v);
      return true;
    },
    resetApp: () => {
      calls.reset++;
    },
    rollbackToPreviousBundle: async () => {
      calls.rolledBack++;
      return true;
    },
    ...over,
  };
  return { deps, calls };
}

function makeOption(body: OtaCheckResponse, over: Partial<OtaServerOption> = {}): OtaServerOption {
  return {
    server: 'https://ota.example',
    appId: 'com.acme',
    publicKey: SPKI,
    installId: 'device-1',
    downloadManager: {} as any,
    hashFile: async () => 'ABC123', // matches sha256 'abc123' (case-insensitive)
    fetchImpl: (async () => ({ ok: true, json: async () => body })) as any,
    ...over,
  };
}

describe('checkForOtaUpdate', () => {
  it('verifies, downloads, checks sha256, and installs an update', async () => {
    const { deps, calls } = makeDeps();
    const onInstalled = jest.fn();
    const check = createOtaServer(deps);
    const res = await check(
      makeOption({ hasUpdate: true, patch, rolledBack: [], rolledBackSignature: '' }, { onInstalled, currentVersionCode: 4 }),
    );
    expect(res.status).toBe('updated');
    expect(res.patch?.patchNumber).toBe(5);
    expect(calls.setCurrentVersion).toEqual([5]);
    expect(calls.setupBundlePath[0]?.[2]).toBe(5); // version arg
    expect(onInstalled).toHaveBeenCalledTimes(1);
  });

  it('rejects a tampered manifest before downloading anything', async () => {
    const download = jest.fn(async () => '/tmp/bundle.zip');
    const { deps } = makeDeps({ downloadBundleFile: download });
    const onError = jest.fn();
    const check = createOtaServer(deps);
    const res = await check(
      makeOption({ hasUpdate: true, patch: { ...patch, patchNumber: 6 }, rolledBack: [], rolledBackSignature: '' }, { onError }),
    );
    expect(res.status).toBe('error');
    expect(res.reason).toBe('bad-signature');
    expect(download).not.toHaveBeenCalled();
  });

  it('fails closed on a sha256 mismatch', async () => {
    const { deps } = makeDeps();
    const check = createOtaServer(deps);
    const res = await check(
      makeOption({ hasUpdate: true, patch, rolledBack: [], rolledBackSignature: '' }, { hashFile: async () => 'deadbeef' }),
    );
    expect(res.status).toBe('error');
    expect(res.reason).toBe('sha256-mismatch');
  });

  it('skips a patch built for a different native version', async () => {
    const { deps, calls } = makeDeps();
    const check = createOtaServer(deps);
    const res = await check(
      makeOption({ hasUpdate: true, patch, rolledBack: [], rolledBackSignature: '' }, { currentVersionCode: 99 }),
    );
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('version-mismatch');
    expect(calls.setCurrentVersion).toEqual([]);
  });

  it('rolls the active bundle back when it has been killed', async () => {
    const { deps, calls } = makeDeps({ getCurrentVersion: async () => 5 });
    const onRolledBack = jest.fn();
    const check = createOtaServer(deps);
    const res = await check(
      makeOption(
        { hasUpdate: false, rolledBack: [5, 7], rolledBackSignature: ROLLBACK_SIG },
        { onRolledBack },
      ),
    );
    expect(res.status).toBe('rolled-back');
    expect(calls.rolledBack).toBe(1);
    expect(onRolledBack).toHaveBeenCalledWith([5, 7]);
  });

  it('reports staged → applyStarted → applyFinished(ok) telemetry on a successful update', async () => {
    const posts: { url: string; type?: string; ok?: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: any) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push({ url, type: body.type, ok: body.ok });
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => ({ hasUpdate: true, patch, rolledBack: [], rolledBackSignature: '' }) };
    }) as any;
    const { deps } = makeDeps();
    const res = await createOtaServer(deps)(
      makeOption({ hasUpdate: true, patch, rolledBack: [], rolledBackSignature: '' }, {
        fetchImpl,
        currentVersionCode: 4,
        device: { os: 'Android 14', model: 'Pixel' },
      }),
    );
    expect(res.status).toBe('updated');
    const telemetry = posts.filter((p) => p.url.includes('/api/telemetry'));
    expect(telemetry.map((t) => t.type)).toEqual(['staged', 'applyStarted', 'applyFinished']);
    expect(telemetry[2]?.ok).toBe(true);
  });

  it('respects reportTelemetry: false (no telemetry posts)', async () => {
    const posts: string[] = [];
    const fetchImpl = (async (url: string, init?: any) => {
      if (init?.method === 'POST') posts.push(url);
      return { ok: true, json: async () => ({ hasUpdate: true, patch, rolledBack: [], rolledBackSignature: '' }) };
    }) as any;
    const { deps } = makeDeps();
    await createOtaServer(deps)(makeOption({ hasUpdate: true, patch, rolledBack: [], rolledBackSignature: '' }, { fetchImpl, reportTelemetry: false }));
    expect(posts.filter((u) => u.includes('/api/telemetry'))).toEqual([]);
  });

  it('reports up-to-date when there is nothing to do', async () => {
    const { deps } = makeDeps();
    const onUpToDate = jest.fn();
    const check = createOtaServer(deps);
    const res = await check(makeOption({ hasUpdate: false, rolledBack: [], rolledBackSignature: '' }, { onUpToDate }));
    expect(res.status).toBe('up-to-date');
    expect(onUpToDate).toHaveBeenCalled();
  });

  it('surfaces an app identifier mismatch from the server', async () => {
    const { deps } = makeDeps();
    const check = createOtaServer(deps);
    const res = await check(
      makeOption({ hasUpdate: false, rolledBack: [], rolledBackSignature: '', reason: 'app_identifier_mismatch', expectedApp: 'com.acme' }),
    );
    expect(res.status).toBe('error');
    expect(res.reason).toBe('app-identifier-mismatch');
  });
});
