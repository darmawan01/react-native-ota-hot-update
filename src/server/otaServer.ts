import type { DownloadManager } from '../download';
import { inRollout } from './rollout';
import { verifyManifest, verifyRollback, type ManifestV3 } from './verify';
import type { OtaServerOption, OtaCheckResponse, OtaUpdateResult } from './otaTypes';

/**
 * The native/primitive operations the OTA flow drives. Injected so the flow is
 * unit-testable without the native module, and so `index.tsx` owns the wiring.
 */
export interface OtaNativeDeps {
  downloadBundleFile(
    dm: DownloadManager,
    uri: string,
    headers?: object,
    cb?: (received: string, total: string) => void,
  ): Promise<string>;
  setupBundlePath(
    path: string,
    extension?: string,
    version?: number,
    maxVersions?: number,
    metadata?: unknown,
  ): Promise<boolean>;
  getCurrentVersion(): Promise<number>;
  setCurrentVersion(version: number): Promise<boolean>;
  resetApp(): void;
  rollbackToPreviousBundle(): Promise<boolean>;
}

async function defaultHashFile(path: string): Promise<string> {
  // react-native-fs is a peer dependency — used to verify payload integrity.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const RNFS = require('react-native-fs');
  return RNFS.hash(path, 'sha256');
}

function buildCheckUrl(o: OtaServerOption): string {
  const base = o.server.replace(/\/+$/, '');
  const params = [
    `app=${encodeURIComponent(o.appId)}`,
    `channel=${encodeURIComponent(o.channel ?? '')}`,
  ];
  if (o.installId) params.push(`iid=${encodeURIComponent(o.installId)}`);
  if (o.applicationId) params.push(`pkg=${encodeURIComponent(o.applicationId)}`);
  return `${base}/check?${params.join('&')}`;
}

/** One telemetry event body, shaped for the platform's `/api/telemetry` sink. */
function telemetryBody(o: OtaServerOption, type: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type,
    installId: o.installId,
    channel: o.channel ?? '',
    model: o.device?.model,
    manufacturer: o.device?.manufacturer,
    os: o.device?.os,
    abi: o.device?.abi,
    versionCode: o.device?.versionCode ?? o.currentVersionCode,
    ...extra,
  };
}

/**
 * Fire-and-forget a telemetry event. Never throws — telemetry must not break the
 * update flow. Exported so the app can report a `boot` event on launch (which
 * registers the device + its current patch in the fleet).
 */
export async function reportOtaEvent(
  o: OtaServerOption,
  type: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  if (o.reportTelemetry === false) return;
  const fetchImpl = o.fetchImpl ?? fetch;
  const url = `${o.server.replace(/\/+$/, '')}/api/telemetry?app=${encodeURIComponent(o.appId)}`;
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...o.headers },
      body: JSON.stringify(telemetryBody(o, type, extra)),
    });
  } catch {
    // best-effort — swallow
  }
}

function maybeRestart(option: OtaServerOption, deps: OtaNativeDeps): void {
  if (option.restartAfterInstall) {
    setTimeout(() => deps.resetApp(), option.restartDelay ?? 300);
  }
}

/**
 * Build the `checkForOtaUpdate` flow against the OTA platform protocol:
 * `/check` → verify Ed25519 manifest → rollout + kill + version gates →
 * download → verify sha256 → native install. Honors the signed kill switch by
 * rolling the active bundle back when it's been killed server-side.
 */
export function createOtaServer(deps: OtaNativeDeps) {
  return async function checkForOtaUpdate(option: OtaServerOption): Promise<OtaUpdateResult> {
    const fetchImpl = option.fetchImpl ?? fetch;
    const fail = (reason: string, message: string, err?: unknown): OtaUpdateResult => {
      option.onError?.(message, err);
      return { status: 'error', reason };
    };

    let body: OtaCheckResponse;
    try {
      const res = await fetchImpl(buildCheckUrl(option), { headers: option.headers });
      if (!res.ok) return fail('network', `/check returned ${res.status}`);
      body = (await res.json()) as OtaCheckResponse;
    } catch (e) {
      return fail('network', 'failed to reach /check', e);
    }

    // Kill switch: if the running bundle was killed (validly signed), roll it
    // back before looking at any new patch.
    if (Array.isArray(body.rolledBack) && body.rolledBack.length) {
      if (verifyRollback(body.rolledBack, body.rolledBackSignature, option.publicKey)) {
        try {
          const current = await deps.getCurrentVersion();
          if (body.rolledBack.includes(current)) {
            await deps.rollbackToPreviousBundle();
            option.onRolledBack?.(body.rolledBack);
            maybeRestart(option, deps);
            return { status: 'rolled-back' };
          }
        } catch {
          // rollback is best-effort — fall through to the update checks
        }
      }
    }

    if (body.reason === 'app_identifier_mismatch') {
      return fail('app-identifier-mismatch', `app identifier mismatch (server expected ${body.expectedApp ?? '?'})`);
    }
    if (!body.hasUpdate || !body.patch) {
      option.onUpToDate?.();
      return { status: 'up-to-date' };
    }
    const patch = body.patch;

    // 1. Authenticity — the manifest must be signed by this app's key.
    const manifest: ManifestV3 = {
      version: patch.version,
      patchNumber: patch.patchNumber,
      targetVersionCode: patch.targetVersionCode,
      sha256: patch.sha256,
      rolloutPercent: patch.rolloutPercent,
      channel: patch.channel,
      delivery: patch.delivery ?? 'silent',
      annTitle: patch.announcement?.title,
      annBody: patch.announcement?.body,
      annSeverity: patch.announcement?.severity,
      annUrl: patch.announcement?.url,
    };
    if (!verifyManifest(patch.manifestVersion, manifest, patch.signature, option.publicKey)) {
      await reportOtaEvent(option, 'applyFinished', { version: patch.version, patchNumber: patch.patchNumber, ok: false, error: 'bad-signature' });
      return fail('bad-signature', 'manifest signature verification failed');
    }

    // 2. Never apply a killed patch.
    if (body.rolledBack?.includes(patch.patchNumber)) {
      return { status: 'skipped', reason: 'killed', patch };
    }
    // 3. Rollout slice.
    if (!inRollout(option.installId, patch.patchNumber, patch.rolloutPercent)) {
      return { status: 'skipped', reason: 'not-in-rollout', patch };
    }
    // 4. Native-compat gate.
    if (option.currentVersionCode != null && patch.targetVersionCode !== option.currentVersionCode) {
      return { status: 'skipped', reason: 'version-mismatch', patch };
    }
    // 5. Already installed?
    try {
      const current = await deps.getCurrentVersion();
      if (patch.patchNumber <= current) {
        option.onUpToDate?.();
        return { status: 'up-to-date', patch };
      }
    } catch {
      // if we can't read the current version, proceed with the install
    }

    option.onUpdateAvailable?.(patch);
    void reportOtaEvent(option, 'staged', { version: patch.version, patchNumber: patch.patchNumber });

    // Download the payload.
    let path: string;
    try {
      path = await deps.downloadBundleFile(option.downloadManager, patch.patchUrl, option.headers, option.onProgress);
    } catch (e) {
      return fail('network', 'failed to download payload', e);
    }
    if (!path) return fail('network', 'download produced no file');

    // Integrity — the signed manifest binds the sha256.
    if (option.verifyHash !== false) {
      try {
        const hasher = option.hashFile ?? defaultHashFile;
        const digest = (await hasher(path)).toLowerCase();
        if (digest !== patch.sha256.toLowerCase()) {
          await reportOtaEvent(option, 'applyFinished', { version: patch.version, patchNumber: patch.patchNumber, ok: false, error: 'sha256-mismatch' });
          return fail('sha256-mismatch', `payload sha256 mismatch (${digest} != ${patch.sha256})`);
        }
      } catch (e) {
        return fail('sha256-mismatch', 'failed to hash payload', e);
      }
    }

    // Install via the native bundle swap.
    void reportOtaEvent(option, 'applyStarted', { version: patch.version, patchNumber: patch.patchNumber });
    try {
      const ok = await deps.setupBundlePath(path, option.extensionBundle, patch.patchNumber, option.maxBundleVersions ?? 2, {
        version: patch.version,
        patchNumber: patch.patchNumber,
        channel: patch.channel,
      });
      if (!ok) {
        await reportOtaEvent(option, 'applyFinished', { version: patch.version, patchNumber: patch.patchNumber, ok: false, error: 'install-failed' });
        return fail('install-failed', 'native setupBundlePath returned false');
      }
      await deps.setCurrentVersion(patch.patchNumber);
    } catch (e) {
      await reportOtaEvent(option, 'applyFinished', { version: patch.version, patchNumber: patch.patchNumber, ok: false, error: 'install-failed' });
      return fail('install-failed', 'install failed', e);
    }

    // Confirm success so the fleet marks this device on the new patch.
    await reportOtaEvent(option, 'applyFinished', { version: patch.version, patchNumber: patch.patchNumber, ok: true });
    option.onInstalled?.(patch);
    maybeRestart(option, deps);
    return { status: 'updated', patch };
  };
}
