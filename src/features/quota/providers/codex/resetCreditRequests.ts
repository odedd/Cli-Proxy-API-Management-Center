import i18n from '@/i18n';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { isDisabledAuthFile, resolveCodexChatgptAccountId } from '@/utils/quota';
import { apiClient } from '@/services/api/client';
import {
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
  useQuotaStore,
  type CodexResetCreditSnapshot,
} from '@/stores/useQuotaStore';
import { fetchCodexResetCreditStatus, type CodexResetCreditsData } from './data';

export const CODEX_RESET_CREDIT_TTL_MS = 30 * 60_000;

export const getCodexResetCreditKey = (file: AuthFileItem): string =>
  `${file.name}\0${normalizeAuthIndex(file.auth_index ?? file.authIndex) ?? ''}\0${resolveCodexChatgptAccountId(file) ?? ''}`;

export function isCodexResetCreditSnapshotFresh(
  snapshot: CodexResetCreditSnapshot | undefined,
  now: number
): boolean {
  return Boolean(
    snapshot?.data &&
    !snapshot.error &&
    !snapshot.data.error &&
    snapshot.updatedAt !== undefined &&
    now >= snapshot.updatedAt &&
    now - snapshot.updatedAt < CODEX_RESET_CREDIT_TTL_MS &&
    !snapshot.data.credits.some((credit) => {
      const expiry = Date.parse(credit.expiresAt);
      return Number.isFinite(expiry) && expiry <= now;
    })
  );
}

interface Dependencies {
  request: (file: AuthFileItem) => Promise<CodexResetCreditsData>;
  now: () => number;
  revision: () => number;
}
interface ReadControl {
  nextReadAt: number;
  failures: number;
  rateLimited: boolean;
  retrying: boolean;
}
const defaults: Dependencies = {
  request: (file) => fetchCodexResetCreditStatus(file, i18n.t),
  now: () => Date.now(),
  revision: () => apiClient.getConnectionRevision(),
};

/** Separate tab-memory deadlines survive render clears; credit reads never replace usage. */
export function createCodexResetCreditFetcher(deps: Dependencies = defaults) {
  let revision = deps.revision();
  let active = 0;
  const queue: Array<() => void> = [];
  const controls = new Map<string, ReadControl>();
  const identities = new Map<string, { key: string }>();
  const inFlight = new Map<
    string,
    {
      promise: Promise<CodexResetCreditSnapshot | undefined>;
      credentialCurrent: () => boolean;
    }
  >();
  const syncSession = () => {
    const current = deps.revision();
    if (current !== revision) {
      revision = current;
      controls.clear();
      identities.clear();
    }
    return current;
  };
  const snapshot = (key: string) => {
    const cached = useQuotaStore.getState().codexResetCredits[key];
    return cached?.connectionRevision === deps.revision() ? cached : undefined;
  };
  const next = () => {
    while (active < 2 && queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };

  return {
    read(file: AuthFileItem): Promise<CodexResetCreditSnapshot | undefined> {
      if (
        !file.name.trim() ||
        !normalizeAuthIndex(file.auth_index ?? file.authIndex) ||
        isDisabledAuthFile(file)
      )
        return Promise.resolve(undefined);
      const session = syncSession();
      const key = getCodexResetCreditKey(file);
      let identity = identities.get(file.name);
      if (!identity || identity.key !== key) {
        identity = { key };
        identities.set(file.name, identity);
      }
      const generation = captureQuotaCacheGeneration(file.name);
      const requestKey = JSON.stringify([session, key]);
      const existing = inFlight.get(requestKey);
      if (existing?.credentialCurrent()) return existing.promise;
      const control = controls.get(key);
      if (control && deps.now() < control.nextReadAt) return Promise.resolve(snapshot(key));
      let credentialValid = true;
      const unsubscribe = useQuotaStore.subscribe((state, previous) => {
        if (
          state.cacheGeneration === previous.cacheGeneration &&
          (state.fileGenerations[file.name] ?? 0) !== (previous.fileGenerations[file.name] ?? 0)
        )
          credentialValid = false;
      });
      const credentialCurrent = () =>
        credentialValid && deps.revision() === session && identities.get(file.name) === identity;
      const current = () => credentialCurrent() && commitIfQuotaCacheCurrent(generation, () => {});
      const request = new Promise<CodexResetCreditSnapshot | undefined>((resolve) => {
        queue.push(() => {
          const execute = async () => {
            if (!current()) return undefined;
            const latest = controls.get(key);
            if (latest && deps.now() < latest.nextReadAt) return snapshot(key);
            let data: CodexResetCreditsData;
            try {
              data = await deps.request(file);
            } catch {
              data = {
                availableCount: null,
                applicableAvailableCount: null,
                credits: [],
                error: 'upstream',
              };
            }
            if (!credentialCurrent()) return undefined;
            const now = deps.now();
            let result: CodexResetCreditSnapshot;
            let control: ReadControl;
            if (data.error) {
              const rateLimited = data.httpStatus === 429;
              const failures = Math.min(
                (latest?.rateLimited === rateLimited ? latest.failures : 0) + 1,
                rateLimited ? 5 : 4
              );
              const floor = rateLimited
                ? Math.min(3_600_000, 300_000 * 2 ** (failures - 1))
                : Math.min(300_000, 60_000 * 2 ** (failures - 1));
              const retry =
                Number.isFinite(data.retryAfterSeconds) && data.retryAfterSeconds! >= 0
                  ? data.retryAfterSeconds! * 1000
                  : 0;
              control = {
                nextReadAt: now + Math.max(floor, retry),
                failures,
                rateLimited,
                retrying: true,
              };
              result = { ...snapshot(key), connectionRevision: session, error: true };
            } else {
              const expiries = data.credits
                .map((credit) => Date.parse(credit.expiresAt))
                .filter((expiry) => Number.isFinite(expiry) && expiry > now);
              control = {
                nextReadAt: Math.min(now + CODEX_RESET_CREDIT_TTL_MS, ...expiries),
                failures: 0,
                rateLimited: false,
                retrying: false,
              };
              result = { data, updatedAt: now, connectionRevision: session };
            }
            controls.set(key, control);
            return commitIfQuotaCacheCurrent(generation, () => {
              useQuotaStore.getState().setCodexResetCredits((prev) => ({ ...prev, [key]: result }));
            })
              ? result
              : undefined;
          };
          void execute().then((result) => {
            unsubscribe();
            if (inFlight.get(requestKey)?.promise === request) inFlight.delete(requestKey);
            active--;
            next();
            resolve(result);
          });
        });
      });
      inFlight.set(requestKey, { promise: request, credentialCurrent });
      next();
      return request;
    },
    invalidate(file: AuthFileItem) {
      syncSession();
      const key = getCodexResetCreditKey(file);
      if (identities.get(file.name)?.key === key) identities.delete(file.name);
      if (!controls.get(key)?.retrying) controls.delete(key);
      useQuotaStore.getState().setCodexResetCredits((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
  };
}

export const codexResetCreditFetcher = createCodexResetCreditFetcher();
