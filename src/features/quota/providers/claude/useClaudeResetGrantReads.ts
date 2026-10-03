import { useEffect } from 'react';
import type { AuthFileItem } from '@/types';
import { useAuthStore } from '@/stores/useAuthStore';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { apiClient } from '@/services/api/client';
import { claudeResetGrantFetcher } from './resetGrantRequests';

/** Local cache consultation only; the fetcher owns upstream TTL/retry decisions.
 * Deliberately not driven by useNow: that clock only computes local balances.
 */
export function useClaudeResetGrantReads(
  files: AuthFileItem[],
  enabled: boolean,
  refreshToken?: unknown
) {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const cacheGeneration = useQuotaStore((state) => state.cacheGeneration);
  const fileGenerations = useQuotaStore((state) => state.fileGenerations);
  const snapshots = useQuotaStore((state) => state.claudeResetGrants);
  const revision = apiClient.getConnectionRevision();
  useEffect(() => {
    if (!enabled || connectionStatus !== 'connected') return;
    const read = () => {
      if (
        revision !== apiClient.getConnectionRevision() ||
        useAuthStore.getState().connectionStatus !== 'connected'
      )
        return;
      for (const file of files) void claudeResetGrantFetcher.read(file);
    };
    read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') read();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [files, enabled, connectionStatus, revision, cacheGeneration, fileGenerations, refreshToken]);
  return snapshots;
}
