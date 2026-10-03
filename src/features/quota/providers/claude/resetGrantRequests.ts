import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { apiClient } from '@/services/api/client';
import {
  AnthropicResetGrantError,
  readClaudeResetGrants,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import {
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
  useQuotaStore,
  type ClaudeResetGrantSnapshot,
} from '@/stores/useQuotaStore';

export const CLAUDE_RESET_GRANT_TTL_MS = 30 * 60_000;
const RATE_LIMIT_FLOOR_MS = 5 * 60_000;
const RATE_LIMIT_CAP_MS = 60 * 60_000;
const ERROR_FLOOR_MS = 60_000;
const ERROR_CAP_MS = 5 * 60_000;

/** Stale balances remain displayable, but must not authorize a new redemption. */
export function isClaudeResetGrantSnapshotFresh(
  snapshot: ClaudeResetGrantSnapshot | undefined,
  now: number
): boolean {
  return Boolean(
    snapshot?.data &&
    snapshot.updatedAt !== undefined &&
    !snapshot.error &&
    now >= snapshot.updatedAt &&
    now - snapshot.updatedAt < CLAUDE_RESET_GRANT_TTL_MS
  );
}

/** Filename prefix permits existing file-scoped invalidation/pruning. */
export function getClaudeResetGrantKey(file: AuthFileItem): string {
  return `${file.name}\0${normalizeAuthIndex(file.authIndex ?? file.auth_index) ?? ''}`;
}

interface Dependencies {
  request: (authIndex: string) => Promise<AnthropicResetGrantStatus>;
  now: () => number;
  revision: () => number;
}
interface ReadControl {
  nextReadAt: number;
  rateLimits: number;
  errors: number;
  retrying: boolean;
}
const defaultDependencies: Dependencies = {
  request: readClaudeResetGrants,
  now: () => Date.now(),
  revision: () => apiClient.getConnectionRevision(),
};

/**
 * Tab-memory read ledger, deliberately outside the invalidatable render cache.
 * Cache clears, remounts and local polling cannot erase TTL/retry deadlines.
 * Two global slots (including old-session in-flight work), with guards before
 * dispatch and before every snapshot/ledger write. No claims or automatic retry.
 */
export function createClaudeResetGrantFetcher(deps: Dependencies = defaultDependencies) {
  let revision = deps.revision();
  let active = 0;
  const queue: Array<() => void> = [];
  const controls = new Map<string, ReadControl>();
  const identities = new Map<string, { authIndex: string }>();
  const inFlight = new Map<
    string,
    {
      promise: Promise<ClaudeResetGrantSnapshot | undefined>;
      credentialCurrent: () => boolean;
    }
  >();
  const syncSession = () => {
    const current = deps.revision();
    if (revision !== current) {
      revision = current;
      controls.clear();
      identities.clear();
    }
    return current;
  };
  const runNext = () => {
    while (active < 2 && queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };
  const snapshot = (key: string) => {
    const cached = useQuotaStore.getState().claudeResetGrants[key];
    return cached?.connectionRevision === deps.revision() ? cached : undefined;
  };

  return {
    read(file: AuthFileItem): Promise<ClaudeResetGrantSnapshot | undefined> {
      const authIndex = normalizeAuthIndex(file.authIndex ?? file.auth_index);
      if (!file.name.trim() || !authIndex) return Promise.resolve(undefined);
      const session = syncSession();
      let identity = identities.get(file.name);
      if (!identity || identity.authIndex !== authIndex) {
        identity = { authIndex };
        identities.set(file.name, identity);
      }
      const generation = captureQuotaCacheGeneration(file.name);
      const key = getClaudeResetGrantKey(file);
      const requestKey = JSON.stringify([session, key]);
      const existing = inFlight.get(requestKey);
      if (existing?.credentialCurrent()) return existing.promise;
      const control = controls.get(key);
      if (control && deps.now() < control.nextReadAt) return Promise.resolve(snapshot(key));
      let credentialValid = true;
      // Remember file mutation events even if a later generic clear resets fileGenerations.
      // Generic render invalidation may suppress a snapshot, but must not discard a
      // dispatched read's throttle result for the same credential/connection.
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
      const request = new Promise<ClaudeResetGrantSnapshot | undefined>((resolve) => {
        queue.push(() => {
          const execute = async () => {
            if (!current()) return undefined;
            // A queued read can be overtaken by a different render generation.
            const latest = controls.get(key);
            if (latest && deps.now() < latest.nextReadAt) return snapshot(key);
            let result: ClaudeResetGrantSnapshot;
            let next: ReadControl;
            try {
              const data = await deps.request(authIndex);
              if (!credentialCurrent()) return undefined;
              const now = deps.now();
              result = { data, updatedAt: now, connectionRevision: session };
              next = {
                nextReadAt: now + CLAUDE_RESET_GRANT_TTL_MS,
                rateLimits: 0,
                errors: 0,
                retrying: false,
              };
            } catch (error: unknown) {
              if (!credentialCurrent()) return undefined;
              const safe =
                error instanceof AnthropicResetGrantError
                  ? error
                  : new AnthropicResetGrantError('upstream');
              const rateLimited = safe.httpStatus === 429;
              const rateLimits = rateLimited ? Math.min((latest?.rateLimits ?? 0) + 1, 5) : 0;
              const errors = rateLimited ? 0 : Math.min((latest?.errors ?? 0) + 1, 4);
              const floor = rateLimited
                ? Math.min(RATE_LIMIT_CAP_MS, RATE_LIMIT_FLOOR_MS * 2 ** (rateLimits - 1))
                : Math.min(ERROR_CAP_MS, ERROR_FLOOR_MS * 2 ** (errors - 1));
              const delay = Math.max(floor, (safe.retryAfterSeconds ?? 0) * 1000);
              next = { nextReadAt: deps.now() + delay, rateLimits, errors, retrying: true };
              result = { ...snapshot(key), error: safe.code, connectionRevision: session };
            }
            // Both controls and render snapshots are owned by the captured identity.
            if (!credentialCurrent()) return undefined;
            controls.set(key, next);
            const committed = commitIfQuotaCacheCurrent(generation, () => {
              useQuotaStore.getState().setClaudeResetGrants((prev) => ({ ...prev, [key]: result }));
            });
            return committed ? result : undefined;
          };
          void execute().then((result) => {
            unsubscribe();
            if (inFlight.get(requestKey)?.promise === request) inFlight.delete(requestKey);
            active--;
            runNext();
            resolve(result);
          });
        });
      });
      inFlight.set(requestKey, { promise: request, credentialCurrent });
      runNext();
      return request;
    },
    /** Redemption invalidates observations, never a live retry deadline. */
    invalidate(file: AuthFileItem) {
      syncSession();
      const key = getClaudeResetGrantKey(file);
      const control = controls.get(key);
      if (control && !control.retrying) controls.delete(key);
      // Also reject a pre-redemption read still in flight.
      useQuotaStore.getState().clearQuotaCache([file.name]);
    },
  };
}

export const claudeResetGrantFetcher = createClaudeResetGrantFetcher();
