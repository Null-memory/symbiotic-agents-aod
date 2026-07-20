import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type ScrollViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, spacing, typography } from './theme';

export function Screen({ children, refreshing = false, onRefresh, scroll = true, ...props }: { children: React.ReactNode; refreshing?: boolean; onRefresh?: () => void; scroll?: boolean } & ScrollViewProps) {
  const content = scroll ? <ScrollView {...props} contentContainerStyle={[styles.screenContent, props.contentContainerStyle]} refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} /> : undefined}>{children}</ScrollView> : <View style={[styles.screenContent, props.contentContainerStyle]}>{children}</View>;
  return <SafeAreaView edges={['top', 'left', 'right']} style={styles.safe}>{content}</SafeAreaView>;
}

export function Header({ title, eyebrow, action }: { title: string; eyebrow?: string; action?: React.ReactNode }) {
  return <View style={styles.header}><View style={styles.headerCopy}>{eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}<Text style={styles.title}>{title}</Text></View>{action}</View>;
}

export function StatusPill({ value, tone = 'accent' }: { value: string; tone?: 'accent' | 'warning' | 'danger' | 'muted' }) {
  return <Text style={[styles.pill, tone === 'warning' && styles.pillWarning, tone === 'danger' && styles.pillDanger, tone === 'muted' && styles.pillMuted]}>{value}</Text>;
}

export function SegmentedControl({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <View style={styles.segmented}>{options.map(option => <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected: option.value === value }} onPress={() => onChange(option.value)} style={[styles.segment, option.value === value && styles.segmentActive]}><Text style={[styles.segmentText, option.value === value && styles.segmentTextActive]}>{option.label}</Text></Pressable>)}</View>;
}

export function Card({ children, onPress, style }: { children: React.ReactNode; onPress?: () => void; style?: any }) {
  const content = <View style={[styles.card, style]}>{children}</View>;
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => [pressed && styles.pressed]}>{content}</Pressable> : content;
}

export function Metric({ label, value }: { label: string; value: string | number }) {
  return <View style={styles.metric}><Text style={styles.metricLabel}>{label}</Text><Text style={styles.metricValue}>{value}</Text></View>;
}

export function PrimaryButton({ label, onPress, disabled = false, icon = 'arrow-forward-outline' }: { label: string; onPress: () => void; disabled?: boolean; icon?: keyof typeof Ionicons.glyphMap }) {
  return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, styles.primary, disabled && styles.disabled, pressed && !disabled && styles.buttonPressed]}><Text style={styles.primaryText}>{label}</Text><Ionicons name={icon} size={17} color="#fff" /></Pressable>;
}

export function SecondaryButton({ label, onPress, disabled = false, icon = 'chevron-forward-outline' }: { label: string; onPress: () => void; disabled?: boolean; icon?: keyof typeof Ionicons.glyphMap }) {
  return <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, styles.secondary, disabled && styles.disabled, pressed && !disabled && styles.buttonPressed]}><Text style={styles.secondaryText}>{label}</Text><Ionicons name={icon} size={17} color={colors.accent} /></Pressable>;
}

export function ConfirmButton({ label, message, onConfirm, tone = 'primary' }: { label: string; message: string; onConfirm: () => void; tone?: 'primary' | 'secondary' | 'danger' }) {
  const action = () => Alert.alert('确认操作', message, [{ text: '取消', style: 'cancel' }, { text: label, style: tone === 'danger' ? 'destructive' : 'default', onPress: onConfirm }]);
  return tone === 'primary' ? <PrimaryButton label={label} onPress={action} /> : <SecondaryButton label={label} onPress={action} icon={tone === 'danger' ? 'warning-outline' : 'checkmark-outline'} />;
}

export function EmptyState({ title, copy, action }: { title: string; copy?: string; action?: React.ReactNode }) {
  return <View style={styles.empty}><Ionicons name="radio-outline" size={28} color={colors.muted} /><Text style={styles.emptyTitle}>{title}</Text>{copy ? <Text style={styles.emptyCopy}>{copy}</Text> : null}{action}</View>;
}

export function LoadingState() {
  return <View style={styles.center}><ActivityIndicator color={colors.accent} /><Text style={styles.emptyCopy}>正在连接 AOD…</Text></View>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Card style={styles.errorCard}><Ionicons name="alert-circle-outline" size={22} color={colors.danger} /><Text style={styles.errorTitle}>连接异常</Text><Text style={styles.emptyCopy}>{message}</Text>{onRetry ? <SecondaryButton label="重试" onPress={onRetry} icon="refresh-outline" /> : null}</Card>;
}

export function BackHeader({ title }: { title: string }) {
  return <View style={styles.backHeader}><Pressable accessibilityRole="button" accessibilityLabel="返回" hitSlop={8} onPress={() => router.back()} style={styles.backButton}><Ionicons name="arrow-back" size={22} color={colors.text} /></Pressable><Text style={styles.backTitle}>{title}</Text></View>;
}

export const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  screenContent: { flexGrow: 1, padding: spacing.lg, paddingBottom: spacing.xxl },
  header: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: spacing.md, marginBottom: spacing.lg },
  headerCopy: { flex: 1 },
  eyebrow: { color: colors.accent, fontFamily: typography.mono, fontSize: 10, fontWeight: '700', letterSpacing: 1.1, marginBottom: 4 },
  title: { color: colors.text, fontSize: typography.title, fontWeight: '800', letterSpacing: 0 },
  backHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginBottom: spacing.lg },
  backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.control, backgroundColor: colors.surface },
  backTitle: { flex: 1, color: colors.text, fontSize: 21, fontWeight: '800' },
  card: { gap: spacing.sm, padding: spacing.md, marginBottom: spacing.sm, borderRadius: radius.panel, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  cardLine: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  cardTitle: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '800', lineHeight: 20 },
  meta: { color: colors.muted, fontFamily: typography.mono, fontSize: 10, lineHeight: 16 },
  description: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  metricsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  pressed: { opacity: 0.76, transform: [{ scale: 0.99 }] },
  metric: { flex: 1, minWidth: 88, padding: spacing.sm, borderRadius: radius.control, backgroundColor: colors.surfaceSubtle },
  metricLabel: { color: colors.muted, fontSize: 10 },
  metricValue: { color: colors.text, fontFamily: typography.mono, fontSize: 16, fontWeight: '700', marginTop: 4 },
  pill: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: '#e1f3ef', color: colors.accent, fontFamily: typography.mono, fontSize: 10, fontWeight: '700' },
  pillWarning: { backgroundColor: '#fff3dc', color: colors.warning },
  pillDanger: { backgroundColor: '#fff0ee', color: colors.danger },
  pillMuted: { backgroundColor: colors.surfaceSubtle, color: colors.muted },
  segmented: { flexDirection: 'row', gap: 4, padding: 4, marginBottom: spacing.sm, borderRadius: radius.control, backgroundColor: colors.surfaceSubtle },
  segment: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.sm, borderRadius: 8 },
  segmentActive: { backgroundColor: colors.surface },
  segmentText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  segmentTextActive: { color: colors.accent },
  button: { minHeight: 48, paddingHorizontal: spacing.md, borderRadius: radius.control, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  primary: { backgroundColor: colors.command },
  secondary: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  primaryText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  secondaryText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.78 },
  empty: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, paddingVertical: 48 },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  emptyCopy: { color: colors.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  errorCard: { alignItems: 'center', borderColor: '#efc9c5', backgroundColor: '#fff7f6' },
  errorTitle: { color: colors.danger, fontSize: 15, fontWeight: '800' },
});
