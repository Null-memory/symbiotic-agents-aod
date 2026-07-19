import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { MobileProvider } from '@/store';
import { colors } from '@/theme';

export default function RootLayout() {
  return <MobileProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.canvas } }} /></MobileProvider>;
}
