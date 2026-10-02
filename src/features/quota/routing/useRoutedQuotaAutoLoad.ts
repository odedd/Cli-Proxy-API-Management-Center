import { useEffect, useRef } from 'react';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { OBSERVED_FRESH_MS, isRoutedProvider } from './model';
import { readObservedUsage } from './signals';

/**
 * The routing summary needs usage for every routed credential (Claude, Codex),
 * not just the visible page. Credentials whose usage the backend observed
 * recently need no upstream call (the usage endpoints are rate limited); the
 * rest are fetched once per credential per visit. No polling.
 */
export function useRoutedQuotaAutoLoad(
  entries: QuotaFileEntry[],
  disabled: boolean,
  loadQuota: (targets: QuotaFileEntry[]) => Promise<void>
) {
  const attempted = useRef(new Set<string>());
  const session = useQuotaStore((state) => state.cacheGeneration);
  const fileGenerations = useQuotaStore((state) => state.fileGenerations);

  useEffect(() => {
    if (disabled) return;
    const store = useQuotaStore.getState();
    const now = Date.now();
    const targets = entries.filter(({ type, file }) => {
      if (!isRoutedProvider(type) || file.disabled) return false;
      const observed = readObservedUsage(type, file, now);
      if (observed && now - observed.observedAtMs < OBSERVED_FRESH_MS) return false;
      const key = JSON.stringify([session, fileGenerations[file.name] ?? 0, type, file.name]);
      if (attempted.current.has(key)) return false;
      attempted.current.add(key);
      const cached = (type === 'claude' ? store.claudeQuota : store.codexQuota)[
        getQuotaCacheKey(file)
      ];
      // Already loaded or in flight from an explicit refresh: leave it alone.
      return cached?.status !== 'loading' && cached?.status !== 'success';
    });
    if (targets.length > 0) void loadQuota(targets);
  }, [disabled, entries, fileGenerations, loadQuota, session]);
}
