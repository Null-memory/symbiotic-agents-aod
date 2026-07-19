import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { colors } from '@/theme';

const icons = { runs: 'pulse-outline', groups: 'people-outline', tasks: 'list-outline', delivery: 'git-merge-outline' } as const;

export default function TabsLayout() {
  return <Tabs screenOptions={({ route }) => ({ headerShown: false, tabBarActiveTintColor: colors.accent, tabBarInactiveTintColor: colors.muted, tabBarStyle: { height: 74, paddingTop: 8, paddingBottom: 12, borderTopColor: colors.border, backgroundColor: colors.surface }, tabBarLabelStyle: { fontSize: 11, fontWeight: '700' }, tabBarIcon: ({ color, size }) => <Ionicons name={icons[route.name as keyof typeof icons] || 'ellipse-outline'} color={color} size={size} /> })}>
    <Tabs.Screen name="runs" options={{ title: '运行' }} />
    <Tabs.Screen name="groups" options={{ title: '群组' }} />
    <Tabs.Screen name="tasks" options={{ title: '任务' }} />
    <Tabs.Screen name="delivery" options={{ title: '交付' }} />
  </Tabs>;
}
