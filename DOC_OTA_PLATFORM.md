# OTA Platform client (signed `/check` protocol)

This fork adds a first-class client for the self-hosted **OTA platform** — the
multi-app console + server that speaks the signed `flutter_patcher` wire protocol
(now serving React Native bundles too). On top of the upstream download/install
engine it adds what a production rollout needs:

- **Authenticity** — every update manifest is Ed25519-signed by the app's key and
  verified on device before anything is downloaded.
- **Integrity** — the downloaded payload is checked against the signed sha256.
- **Staged rollout** — the device honors the patch's `rolloutPercent` using the
  same CRC-32 bucketing the server uses for push targeting.
- **Kill switch** — if the running bundle is killed server-side (signed), the
  client rolls back automatically.
- **Native-version gate** — a bundle built for a different native build is skipped.
- **Identifier check** — the device reports its real `applicationId`; a mismatch
  is surfaced.

The low-level `hotUpdate.downloadBundleUri(...)` and the git flow are unchanged.

## Install

```sh
yarn add react-native-ota-hot-update react-native-fs react-native-blob-util
```

`react-native-fs` (payload hashing) and a download engine
(`react-native-blob-util` / `rn-fetch-blob`) are peer dependencies. Ed25519
verification (`tweetnacl`) and the manifest hash (`js-sha256`) are bundled.

## Usage

```ts
import hotUpdate from 'react-native-ota-hot-update';
import ReactNativeBlobUtil from 'react-native-blob-util';
import DeviceInfo from 'react-native-device-info';

const result = await hotUpdate.otaServer.checkForOtaUpdate({
  server: 'https://ota.beragam.id',
  appId: 'com.acme.app',
  // The app's Ed25519 public key (SPKI base64), copied from the console.
  publicKey: 'MCowBQYDK2VwAyEA…',
  installId: await DeviceInfo.getUniqueId(),        // stable per-install id
  applicationId: DeviceInfo.getBundleId(),          // sent as `pkg` for drift checks
  currentVersionCode: Number(DeviceInfo.getBuildNumber()), // native-compat gate
  channel: '',                                       // '' = stable
  userId: currentUser?.id,                           // optional, sent as `uid` for user targeting
  downloadManager: ReactNativeBlobUtil,
  restartAfterInstall: true,

  onUpdateAvailable: (p) => console.log('update', p.version),
  onInstalled: (p) => console.log('installed', p.patchNumber),
  onRolledBack: (killed) => console.log('rolled back', killed),
  onUpToDate: () => console.log('up to date'),
  onError: (msg, err) => console.warn('ota error', msg, err),
});

// result.status: 'updated' | 'up-to-date' | 'skipped' | 'rolled-back' | 'error'
// result.reason (when skipped/error): 'not-in-rollout' | 'killed' |
//   'version-mismatch' | 'already-installed' | 'app-identifier-mismatch' |
//   'bad-signature' | 'sha256-mismatch' | 'install-failed' | 'network'
```

Call it on launch (and/or on resume). When `status` is `'updated'` and you didn't
set `restartAfterInstall`, apply the new bundle at your next opportunity with
`hotUpdate.resetApp()`.

## How verification works

The client `GET`s `/<server>/check?app=<appId>&channel=<c>&iid=<installId>&pkg=<applicationId>`
(plus `&uid=<userId>` when set) and validates the response before trusting it:

1. **Signature.** The manifest (`version`, `patchNumber`, `targetVersionCode`,
   `sha256`, `rolloutPercent`, `channel`, and for v3 the delivery/announcement)
   is rebuilt into the exact canonical string the server signs and verified with
   the app's public key. A single altered field fails the check.
2. **Kill switch.** The `rolledBack` list is signature-checked; a killed active
   bundle is rolled back, and a killed patch is never applied.
3. **Rollout.** `crc32("<installId>:<patchNumber>") % 100 < rolloutPercent`
   decides whether this device is in the slice.
4. **Native gate.** If `currentVersionCode` is provided it must equal the patch's
   `targetVersionCode`.
5. **Integrity.** The downloaded bytes are hashed (sha256) and compared to the
   signed value before the native install runs.

The signing/verification primitives are also exported directly
(`verifyManifest`, `verifySignature`, `verifyRollback`, `inRollout`, `crc32`) for
custom flows or testing.

## Notes

- The server's public key never changes for an app; pin it in your build. If you
  also pin the TLS cert, run the platform with `S3_PROXY_DOWNLOADS=true` so the
  payload streams through the app instead of a bucket redirect.
- `installId` should be stable across launches — it drives both rollout bucketing
  and (on the server) device/drift tracking.
