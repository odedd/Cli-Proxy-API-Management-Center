import type { AuthFileItem, CodexRateLimitResetCredit } from '@/types';
import type { CodexResetCreditSnapshot } from '@/stores/useQuotaStore';

export type CodexResetPresentation = {
  availableCount: number | null;
  credits: CodexRateLimitResetCredit[];
  canReset: boolean;
  loading?: boolean;
  busy?: boolean;
  stale?: boolean;
  onReset: () => void;
};

export const resolveQuotaResetEligibility = (
  fullQuotaAvailable: boolean,
  creditObservationAvailable?: boolean
): boolean => creditObservationAvailable ?? fullQuotaAvailable;

/** Credit observations stay independent of passive usage windows. */
export function getCodexRoutingResetPresentation(
  file: AuthFileItem,
  snapshot: CodexResetCreditSnapshot | undefined,
  options: {
    now: number;
    connectionRevision: number;
    fresh: boolean;
    canUseActions: boolean;
    busy: boolean;
    onReset: () => void;
  }
): CodexResetPresentation {
  const current =
    snapshot?.connectionRevision === options.connectionRevision ? snapshot : undefined;
  const rawCount = current?.data?.availableCount;
  const availableCount =
    typeof rawCount === 'number' && Number.isFinite(rawCount) ? rawCount : null;
  const fresh = Boolean(
    options.fresh &&
    current?.updatedAt !== undefined &&
    current.updatedAt <= options.now &&
    !current.error &&
    !current.data?.error
  );
  return {
    availableCount,
    credits: current?.data?.credits ?? [],
    stale: availableCount !== null && !fresh,
    loading: options.canUseActions && !file.disabled && !current?.data && !current?.error,
    busy: options.busy,
    canReset: Boolean(
      options.canUseActions &&
      !file.disabled &&
      !options.busy &&
      fresh &&
      availableCount !== null &&
      availableCount > 0
    ),
    onReset: options.onReset,
  };
}
