import { useEffect, useSyncExternalStore } from 'react';
import type { AuthFileItem } from '@/types';
import { apiClient } from '@/services/api/client';
import { useAuthStore } from '@/stores/useAuthStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { codexResetCreditFetcher } from './resetCreditRequests';
import { CODEX_RESET_CREDIT_CLOCK } from './resetCreditClock';

export function useCodexResetCreditReads(
  files: AuthFileItem[],
  enabled: boolean,
  refreshToken?: unknown
) {
  const connection = useAuthStore((state) => state.connectionStatus);
  const generation = useQuotaStore((state) => state.cacheGeneration);
  const fileGenerations = useQuotaStore((state) => state.fileGenerations);
  const snapshots = useQuotaStore((state) => state.codexResetCredits);
  const revision = apiClient.getConnectionRevision();
  useEffect(() => {
    if (!enabled || connection !== 'connected') return;
    const consult = () => {
      if (
        apiClient.getConnectionRevision() !== revision ||
        useAuthStore.getState().connectionStatus !== 'connected'
      )
        return;
      files.forEach((file) => void codexResetCreditFetcher.read(file));
    };
    consult();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') consult();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [connection, enabled, files, generation, fileGenerations, refreshToken, revision, snapshots]);
  const now = useSyncExternalStore(
    CODEX_RESET_CREDIT_CLOCK.subscribe,
    CODEX_RESET_CREDIT_CLOCK.getSnapshot,
    CODEX_RESET_CREDIT_CLOCK.getSnapshot
  );
  return { snapshots, now };
}
