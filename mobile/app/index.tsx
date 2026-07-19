import { Redirect } from 'expo-router';
import React from 'react';
import { LoadingState } from '@/components';
import { ConnectScreen } from '@/screens/connect';
import { useMobile } from '@/store';

export default function Index() {
  const { connection, loading } = useMobile();
  if (loading && !connection) return <LoadingState />;
  return connection ? <Redirect href="/(tabs)/runs" /> : <ConnectScreen />;
}
