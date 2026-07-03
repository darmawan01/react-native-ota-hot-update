import type { DownloadManager } from '../download';

/** A patch as returned by the OTA platform `/check` endpoint. */
export interface OtaPatch {
  version: string;
  patchNumber: number;
  targetVersionCode: number;
  sha256: string;
  rolloutPercent: number;
  channel: string;
  signature: string;
  manifestVersion: number;
  patchUrl: string;
  delivery?: 'silent' | 'notify' | 'custom';
  announcement?: {
    title: string;
    body: string;
    severity: string;
    url: string | null;
  } | null;
}

/** The raw `/check` response body. */
export interface OtaCheckResponse {
  hasUpdate: boolean;
  patch?: OtaPatch;
  rolledBack: number[];
  rolledBackSignature: string;
  reason?: string;
  expectedApp?: string;
}

export type OtaUpdateStatus =
  | 'updated'
  | 'up-to-date'
  | 'skipped'
  | 'rolled-back'
  | 'error';

export interface OtaUpdateResult {
  status: OtaUpdateStatus;
  patch?: OtaPatch;
  /** Why an update was skipped or failed: 'not-in-rollout' | 'killed' | 'version-mismatch' | 'already-installed' | 'app-identifier-mismatch' | 'bad-signature' | 'sha256-mismatch' | 'install-failed' | 'network' */
  reason?: string;
}

export interface OtaServerOption {
  /** Base URL of the OTA platform, e.g. `https://ota.beragam.id`. */
  server: string;
  /** The app id this device checks as (e.g. `com.acme.app`). */
  appId: string;
  /** The app's Ed25519 public key (SPKI base64), pasted from the console. */
  publicKey: string;
  /** Stable per-install id — used for rollout bucketing and drift/telemetry. */
  installId: string;
  /** Release channel; defaults to the default/stable channel (""). */
  channel?: string;
  /** The device's real applicationId; sent as `pkg` so the server can flag drift. */
  applicationId?: string;
  /**
   * The native build number the running binary was shipped with. When set, a
   * patch is only applied if its `targetVersionCode` matches — a bundle built
   * for a different native base is skipped rather than risking a crash.
   */
  currentVersionCode?: number;

  /** The download engine (react-native-blob-util / rn-fetch-blob), as upstream. */
  downloadManager: DownloadManager;
  /** Extra request headers (auth, etc.) for `/check` and the payload download. */
  headers?: Record<string, string>;

  /** Verify the downloaded bytes against the manifest sha256. Default: true. */
  verifyHash?: boolean;
  /** Override the sha256 file hasher (defaults to react-native-fs). */
  hashFile?: (path: string) => Promise<string>;

  /** Restart the app after a successful install. Default: false. */
  restartAfterInstall?: boolean;
  /** Delay (ms) before restart. Default: 300. */
  restartDelay?: number;
  /** Bundle file extension, e.g. `.jsbundle`. */
  extensionBundle?: string;
  /** How many bundle versions to keep. Default: 2. */
  maxBundleVersions?: number;

  /** `fetch` override (for tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;

  // ---- callbacks ----
  /** An applicable update is available and verified (before download). */
  onUpdateAvailable?(patch: OtaPatch): void;
  /** No applicable update. */
  onUpToDate?(): void;
  /** Download progress. */
  onProgress?(received: string, total: string): void;
  /** Update downloaded, verified, and installed. */
  onInstalled?(patch: OtaPatch): void;
  /** The active bundle was killed server-side and rolled back. */
  onRolledBack?(killed: number[]): void;
  /** Any failure (network, signature, sha256, install). */
  onError?(message: string, error?: unknown): void;
}
