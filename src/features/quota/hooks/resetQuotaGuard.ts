import type { AuthFileItem } from '@/types';
import { isDisabledAuthFile } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
  useQuotaStore,
} from '@/stores/useQuotaStore';
import {
  getCodexResetCreditKey,
  isCodexResetCreditSnapshotFresh,
} from '../providers/codex/resetCreditRequests';

interface Dependencies {
  files: () => AuthFileItem[] | undefined;
  revision: () => number;
  connected: () => boolean;
  disabled: () => boolean;
  now: () => number;
}
interface ResetOrigin {
  current: () => boolean;
  sameIdentity: () => boolean;
}

/** Origin-bound confirmation and a synchronous mutex; no provider calls or retries. */
export function createQuotaResetGuard(deps: Dependencies) {
  let locked = false;
  return {
    capture(file: AuthFileItem, eligible?: (current: AuthFileItem) => boolean): ResetOrigin {
      const revision = deps.revision();
      const generation = captureQuotaCacheGeneration(file.name);
      const identity = getCodexResetCreditKey(file);
      const latestFile = () => {
        const files = deps.files();
        return files === undefined ? file : files.find((candidate) => candidate.name === file.name);
      };
      const sameIdentity = () => {
        const latest = latestFile();
        return Boolean(
          deps.revision() === revision &&
          latest &&
          getCodexResetCreditKey(latest) === identity &&
          (latest.provider ?? latest.type) === (file.provider ?? file.type)
        );
      };
      return {
        sameIdentity,
        current: () => {
          const current = latestFile();
          if (
            !sameIdentity() ||
            !current ||
            isDisabledAuthFile(current) ||
            !deps.connected() ||
            deps.disabled() ||
            !commitIfQuotaCacheCurrent(generation, () => {})
          )
            return false;
          if (eligible) return eligible(current);
          const state = useQuotaStore.getState();
          const snapshot = state.codexResetCredits[identity];
          return Boolean(
            state.codexQuota[getQuotaCacheKey(current)]?.status !== 'loading' &&
            snapshot?.connectionRevision === revision &&
            isCodexResetCreditSnapshotFresh(snapshot, deps.now()) &&
            (snapshot.data?.availableCount ?? 0) > 0
          );
        },
      };
    },
    acquire(origin: ResetOrigin) {
      if (locked || !origin.current()) return false;
      locked = true;
      return true;
    },
    release() {
      locked = false;
    },
  };
}
