import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  package: await readFile(new URL('./package.json', import.meta.url), 'utf8'),
  layout: await readFile(new URL('./app/(tabs)/_layout.tsx', import.meta.url), 'utf8'),
  client: await readFile(new URL('./src/api/client.ts', import.meta.url), 'utf8'),
  stream: await readFile(new URL('./src/api/stream.ts', import.meta.url), 'utf8'),
  store: await readFile(new URL('./src/store.tsx', import.meta.url), 'utf8'),
  connect: await readFile(new URL('./src/screens/connect.tsx', import.meta.url), 'utf8'),
  detail: await readFile(new URL('./app/detail/[type].tsx', import.meta.url), 'utf8'),
  appConfig: await readFile(new URL('./app.json', import.meta.url), 'utf8'),
  cleartextPlugin: await readFile(new URL('./plugins/with-cleartext-aod.js', import.meta.url), 'utf8'),
};
const packageJson = JSON.parse(files.package);
assert.equal(packageJson.main, 'expo-router/entry');
for (const dependency of ['expo-secure-store', 'expo-router', 'react-native-sse', 'react-native-web']) assert.ok(packageJson.dependencies[dependency], `missing ${dependency}`);
for (const tab of ['runs', 'groups', 'tasks', 'delivery']) assert.match(files.layout, new RegExp(`name="${tab}"`));
assert.match(files.client, /Authorization|authorization/);
assert.match(files.client, /SecureStore/);
assert.match(files.client, /loginMobile/);
assert.match(files.client, /\/api\/mobile\/login/);
assert.match(files.client, /\/api\/mobile\/status/);
assert.match(files.client, /http:\/\//);
assert.match(files.client, /MOBILE_NETWORK_UNREACHABLE/);
assert.match(files.stream, /Last-Event-ID|lastEventId/);
assert.match(files.stream, /authorization/);
assert.match(files.stream, /retryDelayMs/);
assert.match(files.store, /connectionPhase/);
assert.match(files.store, /AppState/);
assert.match(files.connect, /loginMobile/);
assert.match(files.connect, /用户名/);
assert.match(files.connect, /密码/);
assert.match(files.connect, /局域网、Tailscale 或 VPN 地址/);
assert.match(files.connect, /192\.168\.1\.10:4830/);
assert.equal(files.connect.includes('CameraView'), false);
assert.equal(files.connect.includes('二维码'), false);
assert.match(files.detail, /ConfirmButton/);
assert.match(files.detail, /\/api\/tasks\/\$\{params\.id\}\/artifacts/);
assert.match(files.detail, /成品输出/);
assert.match(files.detail, /正在等待人工合并/);
assert.match(files.detail, /SegmentedControl/);
assert.match(files.detail, /statusLabel/);
assert.equal(JSON.parse(files.appConfig).expo.plugins.includes('./plugins/with-cleartext-aod'), true);
assert.match(files.cleartextPlugin, /android:usesCleartextTraffic/);
console.log('AOD mobile contract test passed');
