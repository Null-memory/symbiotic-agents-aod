import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { completePairing, parsePairingPayload } from '@/api/client';
import type { MobilePairingPayload } from '@/api/types';
import { ErrorState, PrimaryButton, Screen, SecondaryButton, styles as baseStyles } from '@/components';
import { colors, radius, spacing } from '@/theme';
import { useMobile } from '@/store';

export function ConnectScreen() {
  const { error: storeError, connect: setConnection } = useMobile();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [rawPayload, setRawPayload] = useState<MobilePairingPayload | null>(null);
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('我的 Android');
  const [error, setError] = useState<string | null>(storeError);
  const [busy, setBusy] = useState(false);

  const applyPairing = (payload: MobilePairingPayload) => {
    setRawPayload(payload);
    setUrl(payload.url);
    setCode(payload.code);
    setScanning(false);
    setScanned(false);
    setError(null);
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = rawPayload || parsePairingPayload(JSON.stringify({ type: 'aod-mobile-pairing', version: 1, url: url.trim(), code: code.trim(), expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }));
      const connection = await completePairing(payload, deviceName);
      setConnection(connection);
      // Root route observes the SecureStore-backed connection on next mount.
      const { router } = await import('expo-router');
      router.replace('/(tabs)/runs');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '配对失败。'); }
    finally { setBusy(false); }
  };

  const openScanner = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) { setError('需要相机权限才能扫描配对二维码。'); return; }
    }
    setError(null);
    setScanning(true);
  };

  if (scanning) return <View style={connectStyles.camera}><CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scanned ? undefined : result => { setScanned(true); try { applyPairing(parsePairingPayload(result.data)); } catch (reason) { setError(reason instanceof Error ? reason.message : '二维码无效。'); setScanned(false); } }} /><View style={connectStyles.cameraShade}><View style={connectStyles.scanBox} /><Text style={connectStyles.cameraHint}>将桌面端二维码放入框内</Text><SecondaryButton label="取消扫描" onPress={() => setScanning(false)} icon="close-outline" /></View></View>;

  return <Screen scroll={false} contentContainerStyle={connectStyles.screen}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={connectStyles.wrap}><View style={connectStyles.brand}><View style={connectStyles.mark}><Text style={connectStyles.markText}>A/</Text></View><Text style={connectStyles.brandText}>AOD MOBILE</Text></View><Text style={connectStyles.eyebrow}>ANDROID COMPANION</Text><Text style={connectStyles.title}>连接你的本机协作器</Text><Text style={connectStyles.copy}>在 Windows 桌面端打开“手机连接”，通过 Tailscale 扫描一次性二维码。</Text>{error ? <ErrorState message={error} /> : null}<View style={connectStyles.panel}><View style={connectStyles.panelHead}><Text style={connectStyles.panelTitle}>扫码配对</Text><Ionicons name="qr-code-outline" size={23} color={colors.accent} /></View><PrimaryButton label="扫描桌面二维码" onPress={openScanner} icon="scan-outline" /></View><View style={connectStyles.divider}><View /><Text>或手动输入</Text><View /></View><View style={connectStyles.form}><TextInput value={url} onChangeText={value => { setUrl(value); setRawPayload(null); }} placeholder="AOD 地址，例如 http://100.x.x.x:4826" autoCapitalize="none" autoCorrect={false} keyboardType="url" style={connectStyles.input} /><TextInput value={code} onChangeText={value => { setCode(value.toUpperCase()); setRawPayload(null); }} placeholder="配对码" autoCapitalize="characters" autoCorrect={false} style={[connectStyles.input, connectStyles.code]} /><TextInput value={deviceName} onChangeText={setDeviceName} placeholder="设备名称" style={connectStyles.input} /><PrimaryButton label={busy ? '正在连接…' : '连接 AOD'} onPress={connect} disabled={busy || !url.trim() || !code.trim()} icon="link-outline" /></View></KeyboardAvoidingView></Screen>;
}

const connectStyles = StyleSheet.create({
  screen: { justifyContent: 'center' },
  wrap: { width: '100%', maxWidth: 520, alignSelf: 'center' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xl },
  mark: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: radius.control, backgroundColor: colors.live },
  markText: { color: colors.accentBright, fontFamily: 'Courier New', fontWeight: '800' },
  brandText: { color: colors.text, fontFamily: 'Courier New', fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  eyebrow: { color: colors.accent, fontFamily: 'Courier New', fontSize: 10, fontWeight: '700', letterSpacing: 1.2 },
  title: { color: colors.text, fontSize: 30, fontWeight: '900', lineHeight: 36, marginTop: 6 },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 22, marginTop: spacing.sm, marginBottom: spacing.xl },
  panel: { gap: spacing.md, padding: spacing.md, borderRadius: radius.panel, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  panelTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginVertical: spacing.lg },
  form: { gap: spacing.sm },
  input: { minHeight: 50, paddingHorizontal: spacing.md, borderRadius: radius.control, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, fontSize: 14 },
  code: { fontFamily: 'Courier New', letterSpacing: 2 },
  camera: { flex: 1, backgroundColor: '#050909' },
  cameraShade: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'flex-end', gap: spacing.lg, padding: spacing.xl, backgroundColor: 'rgba(0,0,0,.22)' },
  scanBox: { width: 250, height: 250, borderWidth: 2, borderColor: colors.accentBright, borderRadius: radius.panel, marginBottom: 'auto', marginTop: 120 },
  cameraHint: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
