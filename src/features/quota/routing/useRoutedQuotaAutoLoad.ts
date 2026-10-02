import { useEffect, useRef } from 'react';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { isRoutedProvider } from './model';

/**
 * The routing summary needs usage for every routed credential (Claude, Codex),
 * not just the visible page, so fetch each once per credential per visit.
 * Mirrors useDevinQuotaAutoLoad: no polling; refresh stays manual afterwards.
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
    const targets = entries.filter(({ type, file }) => {
      if (!isRoutedProvider(type) || file.disabled) return false;
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
