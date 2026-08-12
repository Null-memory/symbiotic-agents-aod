import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { loginMobile } from '@/api/client';
import { ErrorState, PrimaryButton, Screen } from '@/components';
import { colors, radius, spacing } from '@/theme';
import { useMobile } from '@/store';

export function ConnectScreen() {
  const { error: storeError, connect: setConnection } = useMobile();
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName, setDeviceName] = useState('我的 Android');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const connection = await loginMobile(url, username, password, deviceName);
      setConnection(connection);
      setPassword('');
      const { router } = await import('expo-router');
      router.replace('/(tabs)/runs');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败。'); }
    finally { setBusy(false); }
  };

  const visibleError = error || storeError;
  return <Screen scroll={false} contentContainerStyle={connectStyles.screen}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={connectStyles.wrap}><View style={connectStyles.brand}><View style={connectStyles.mark}><Text style={connectStyles.markText}>A/</Text></View><Text style={connectStyles.brandText}>AOD MOBILE</Text></View><Text style={connectStyles.eyebrow}>ANDROID COMPANION</Text><Text style={connectStyles.title}>连接你的本机协作器</Text><Text style={connectStyles.copy}>在 Windows 桌面端设置移动账号，然后使用“手机连接”里显示的局域网、Tailscale 或 VPN 地址登录。</Text>{visibleError ? <ErrorState message={visibleError} /> : null}<View style={connectStyles.panel}><View style={connectStyles.panelHead}><Text style={connectStyles.panelTitle}>账号登录</Text><Ionicons name="lock-closed-outline" size={22} color={colors.accent} /></View><Text style={connectStyles.panelHint}>登录成功后，设备会保存独立会话。撤销设备后需要重新登录。</Text><View style={connectStyles.form}><TextInput value={url} onChangeText={setUrl} placeholder="AOD 地址，例如 http://192.168.1.10:4821" autoCapitalize="none" autoCorrect={false} keyboardType="url" style={connectStyles.input} /><TextInput value={username} onChangeText={setUsername} placeholder="用户名" autoCapitalize="none" autoCorrect={false} autoComplete="username" style={connectStyles.input} /><TextInput value={password} onChangeText={setPassword} placeholder="密码" secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="password" style={connectStyles.input} /><TextInput value={deviceName} onChangeText={setDeviceName} placeholder="设备名称" style={connectStyles.input} /><PrimaryButton label={busy ? '正在登录…' : '登录 AOD'} onPress={connect} disabled={busy || !url.trim() || !username.trim() || !password} icon="log-in-outline" /></View></View></KeyboardAvoidingView></Screen>;
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
  panelHint: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  form: { gap: spacing.sm },
  input: { minHeight: 50, paddingHorizontal: spacing.md, borderRadius: radius.control, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, color: colors.text, fontSize: 14 },
});
