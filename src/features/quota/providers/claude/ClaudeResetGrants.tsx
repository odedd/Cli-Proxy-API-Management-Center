import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import {
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
  useQuotaStore,
} from '@/stores/useQuotaStore';
import { useClaudeResetGrantReads } from './useClaudeResetGrantReads';
import {
  claudeResetGrantFetcher,
  getClaudeResetGrantKey,
  isClaudeResetGrantSnapshotFresh,
} from './resetGrantRequests';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/quota';
import { resetGrantOperations, RETRY_WINDOW_MS } from './resetGrantOperations';
import { bankedClaudeResets, selectResetGrant } from './selectResetGrant';

/** Shared observations; the session-scoped journal owns spending and ambiguous retries. */
export function useClaudeResetGrants(
  file: AuthFileItem,
  enabled: boolean,
  disabled: boolean,
  refreshToken: unknown,
  onRefresh: () => void
) {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [session] = useState(() => apiClient.getConnectionRevision());
  const sessionActive =
    connectionStatus === 'connected' && session === apiClient.getConnectionRevision();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const authIndex = normalizeAuthIndex(file.authIndex ?? file.auth_index);
  const key = JSON.stringify([file.name, authIndex]);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const files = useMemo(() => [file], [file]);
  const readRefreshToken = useMemo(() => [refreshToken, reload], [refreshToken, reload]);
  const snapshots = useClaudeResetGrantReads(
    files,
    enabled && !disabled && sessionActive,
    readRefreshToken
  );
  const snapshot = snapshots[getClaudeResetGrantKey(file)];
  const status =
    enabled && sessionActive && snapshot?.connectionRevision === session
      ? snapshot.data
      : undefined;
  const message = snapshot?.connectionRevision === session && snapshot.error ? 'read_error' : '';
  const cacheGeneration = useQuotaStore((state) => state.cacheGeneration);
  const fileGeneration = useQuotaStore((state) => state.fileGenerations[file.name] ?? 0);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [
    key,
    enabled,
    disabled,
    sessionActive,
    refreshToken,
    reload,
    cacheGeneration,
    fileGeneration,
  ]);

  const operation = resetGrantOperations.inspect(key);
  const pending = operation && !operation.code ? operation : undefined;
  const expired = Boolean(pending && now - pending.createdAt >= RETRY_WINDOW_MS);
  const selected = pending?.grantId ?? (status ? selectResetGrant(status, now)?.id : undefined);
  const blocked =
    disabled ||
    !sessionActive ||
    !authIndex ||
    busy ||
    expired ||
    !selected ||
    (!pending && (!status || !isClaudeResetGrantSnapshotFresh(snapshot, now)));
  const confirm = () => {
    if (blocked || lock.current || !selected || !authIndex) return;
    const version = generation.current;
    const cache = captureQuotaCacheGeneration(file.name);
    const accountCurrent = () =>
      session === apiClient.getConnectionRevision() && commitIfQuotaCacheCurrent(cache, () => {});
    const current = () => version === generation.current && accountCurrent();
    showConfirmation({
      title: t('claude_reset.title'),
      message: t(pending ? 'claude_reset.retry_confirm' : 'claude_reset.confirm_text', {
        name: file.name,
      }),
      confirmText: t(pending ? 'claude_reset.retry' : 'claude_reset.confirm'),
      variant: 'primary',
      onConfirm: async () => {
        if (!current() || lock.current || useAuthStore.getState().connectionStatus !== 'connected')
          return;
        const latest = useQuotaStore.getState().claudeResetGrants[getClaudeResetGrantKey(file)];
        const at = Date.now();
        if (
          !pending &&
          (!latest?.data ||
            latest.connectionRevision !== session ||
            !isClaudeResetGrantSnapshotFresh(latest, at) ||
            selectResetGrant(latest.data, at)?.id !== selected)
        )
          return;
        lock.current = true;
        setBusy(true);
        try {
          const answer = await resetGrantOperations.run(key, authIndex, selected);
          if (!current()) return;
          showNotification(
            t(`claude_reset.${answer.unresolved ? 'unknown' : answer.code}`),
            !answer.unresolved && (answer.code === 'reset' || answer.code === 'already_used')
              ? 'success'
              : 'error'
          );
        } catch {
          if (!current()) return;
          const unresolved = resetGrantOperations.inspect(key);
          showNotification(
            t(`claude_reset.${unresolved && !unresolved.code ? 'unknown' : 'blocked'}`),
            'error'
          );
        } finally {
          lock.current = false;
          // A concurrent page-wide refresh can invalidate this read generation.
          // Release the local lock regardless, but never refresh a replacement account.
          setBusy(false);
          setReload((value) => value + 1);
          const refreshCurrent = current();
          // Even an unmounted card must retire a possibly spent observation.
          if (accountCurrent()) claudeResetGrantFetcher.invalidate(file);
          if (refreshCurrent) onRefresh();
        }
      },
    });
  };
  return {
    count: bankedClaudeResets(status, now),
    busy,
    blocked,
    confirm,
    message: pending ? (expired ? 'expired' : 'unknown') : message,
    buttonLabel: pending ? 'retry' : 'use',
  };
}
