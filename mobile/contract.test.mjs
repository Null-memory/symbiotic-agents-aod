import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const files = {
  package: await readFile(new URL('./package.json', import.meta.url), 'utf8'),
  layout: await readFile(new URL('./app/(tabs)/_layout.tsx', import.meta.url), 'utf8'),
  client: await readFile(new URL('./src/api/client.ts', import.meta.url), 'utf8'),
  stream: await readFile(new URL('./src/api/stream.ts', import.meta.url), 'utf8'),
  connect: await readFile(new URL('./src/screens/connect.tsx', import.meta.url), 'utf8'),
  detail: await readFile(new URL('./app/detail/[type].tsx', import.meta.url), 'utf8'),
};
const packageJson = JSON.parse(files.package);
assert.equal(packageJson.main, 'expo-router/entry');
for (const dependency of ['expo-camera', 'expo-secure-store', 'expo-router', 'react-native-sse']) assert.ok(packageJson.dependencies[dependency], `missing ${dependency}`);
for (const tab of ['runs', 'groups', 'tasks', 'delivery']) assert.match(files.layout, new RegExp(`name="${tab}"`));
assert.match(files.client, /Authorization|authorization/);
assert.match(files.client, /SecureStore/);
assert.match(files.stream, /Last-Event-ID|lastEventId/);
assert.match(files.stream, /authorization/);
assert.match(files.connect, /CameraView/);
assert.match(files.connect, /parsePairingPayload/);
assert.match(files.detail, /ConfirmButton/);
console.log('AOD mobile contract test passed');
