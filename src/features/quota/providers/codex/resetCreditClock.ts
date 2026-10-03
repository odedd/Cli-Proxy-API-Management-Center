import { MINUTE_CLOCK, type SharedClock } from '@/utils/time/sharedClock';
import { useQuotaStore } from '@/stores/useQuotaStore';

type Subscribe = SharedClock['subscribe'];

/** Fresh responses must not wait for the countdown clock's next minute tick. */
export function createCodexResetCreditClock(options: {
  now: () => number;
  subscribeCredits: Subscribe;
  subscribeTicks: Subscribe;
}): SharedClock {
  let current = options.now();
  const listeners = new Set<() => void>();
  let detach: (() => void) | undefined;
  const tick = () => {
    current = options.now();
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      if (!detach) {
        current = options.now();
        const credits = options.subscribeCredits(tick);
        const ticks = options.subscribeTicks(tick);
        detach = () => {
          credits();
          ticks();
        };
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          detach?.();
          detach = undefined;
        }
      };
    },
  };
}

export const CODEX_RESET_CREDIT_CLOCK = createCodexResetCreditClock({
  now: () => Date.now(),
  subscribeTicks: MINUTE_CLOCK.subscribe,
  subscribeCredits: (listener) =>
    useQuotaStore.subscribe((state, previous) => {
      if (state.codexResetCredits !== previous.codexResetCredits) listener();
    }),
});
