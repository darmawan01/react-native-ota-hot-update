import { StyleSheet, View, Text, Button, Image, TouchableOpacity, Platform } from 'react-native';
import { useEffect, useState } from 'react';
import { useCheckVersion } from './useCheckVersion';
import BundleManagerScreen from './BundleManagerScreen';
import hotUpdate, { reportOtaEvent, type OtaServerOption } from 'react-native-ota-hot-update';
import ReactNativeBlobUtil from 'react-native-blob-util';

// Change this in the OTA-published bundle to prove an apply happened on screen.
const BUILD_MARKER = 'BASE-BUILD';

const otaOptions: OtaServerOption = {
  server: 'https://ota.beragam.id',
  appId: 'com.ota.test',
  publicKey: 'MCowBQYDK2VwAyEAMvooG68o4BjA+AU654kx0MRP/CpeTEBeDywqUEoq1BM=',
  installId: 'rn-e2e-emulator',
  applicationId: 'otahotupdate.example',
  downloadManager: ReactNativeBlobUtil,
  currentVersionCode: 1,
  device: { os: `${Platform.OS} ${Platform.Version}`, model: 'emulator' },
  restartAfterInstall: true,
  restartDelay: 1200,
  onError: (m) => console.log('OTA error:', m),
};

export default function App() {
  const { version } = useCheckVersion();
  const [showBundleManager, setShowBundleManager] = useState(false);
  const [ota, setOta] = useState('idle');

  // Register the device in the fleet on launch.
  useEffect(() => {
    void reportOtaEvent(otaOptions, 'boot');
  }, []);

  const checkOtaPlatform = async () => {
    setOta('checking…');
    try {
      const res = await hotUpdate.otaServer.checkForOtaUpdate(otaOptions);
      setOta(`${res.status}${res.reason ? ' (' + res.reason + ')' : ''}`);
    } catch (e: any) {
      setOta('threw: ' + String(e?.message ?? e));
    }
  };

  if (showBundleManager) {
    return (
      <View style={styles.fullScreen}>
        <BundleManagerScreen onBack={() => setShowBundleManager(false)} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Image source={require('./video-editing.png')} style={styles.img} />
      <Text testID="marker" style={styles.marker}>{BUILD_MARKER}</Text>
      <Text testID="ota-status" style={styles.versionText}>{`OTA: ${ota}`}</Text>
      <Button title={'check OTA Platform'} onPress={checkOtaPlatform} />
      <Text style={styles.versionText}>{`Version: ${version.state.version}`}</Text>
      <Button title={'check update OTA'} onPress={version.onCheckVersion} />
      <Button title={'rollback OTA'} onPress={version.rollBack} />
      <Button title={'check update Git'} onPress={version.onCheckGitVersion} />
      <Button title={'remove update Git'} onPress={version.removeGitUpdate} />

      <TouchableOpacity
        style={styles.bundleManagerButton}
        onPress={() => setShowBundleManager(true)}
      >
        <Text style={styles.bundleManagerButtonText}>📦 Bundle Manager</Text>
      </TouchableOpacity>

      {version.state.loading && <Text>Loading from git...</Text>}
      {!!version.state.progress && (
        <View style={styles.progress}>
          <View
            style={[
              styles.process,
              {
                width: `${version.state.progress}%`,
              },
            ]}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: "#cbcdc9"
  },
  fullScreen: {
    flex: 1,
    width: '100%',
  },
  box: {
    width: 60,
    height: 60,
    marginVertical: 20,
  },
  progress: {
    height: 10,
    width: '80%',
    marginTop: 20,
    borderRadius: 8,
    borderColor: 'grey',
    borderWidth: 1,
    overflow: 'hidden',
  },
  process: {
    height: 10,
    backgroundColor: 'blue',
  },
  img: {
    width: 180,
    height: 180,
    resizeMode: 'contain',
    marginBottom: 20,
  },
  versionText: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 10,
  },
  marker: {
    fontSize: 24,
    fontWeight: '800',
    color: '#b00020',
    marginBottom: 6,
  },
  bundleManagerButton: {
    marginTop: 20,
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
  },
  bundleManagerButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
