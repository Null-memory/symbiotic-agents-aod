const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = config => withAndroidManifest(config, androidConfig => {
  const application = androidConfig.modResults.manifest.application?.[0];
  if (!application) throw new Error('Android application manifest entry is missing.');
  application.$['android:usesCleartextTraffic'] = 'true';
  return androidConfig;
});
