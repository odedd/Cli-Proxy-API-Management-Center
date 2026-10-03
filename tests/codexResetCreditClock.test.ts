import { expect, test } from 'bun:test';
import { isCodexResetCreditSnapshotFresh } from '@/features/quota/providers/codex/resetCreditRequests';

const load = () => import('@/features/quota/providers/codex/resetCreditClock').catch(() => null);

test('metadata commits advance a stable freshness clock without waiting for a minute tick', async () => {
  let now = 0;
  let onCredits = () => {};
  let onTick = () => {};
  let notifications = 0;
  const module = await load();
  const clock = module?.createCodexResetCreditClock({
    now: () => now,
    subscribeCredits: (listener) => {
      onCredits = listener;
      return () => {};
    },
    subscribeTicks: (listener) => {
      onTick = listener;
      return () => {};
    },
  });
  const unsubscribe = clock?.subscribe(() => notifications++);
  now = 10;
  onCredits();
  expect(clock?.getSnapshot()).toBe(10);
  expect(notifications).toBe(1);
  now = 20;
  expect(clock?.getSnapshot()).toBe(10);
  const snapshot = {
    connectionRevision: 1,
    updatedAt: 10,
    data: { availableCount: 2, applicableAvailableCount: 0, credits: [], error: '' },
  };
  expect(isCodexResetCreditSnapshotFresh(snapshot, clock!.getSnapshot())).toBe(true);
  expect(
    isCodexResetCreditSnapshotFresh({ ...snapshot, updatedAt: 11 }, clock!.getSnapshot())
  ).toBe(false);
  onTick();
  expect(clock?.getSnapshot()).toBe(20);
  unsubscribe?.();
});

test('the freshness clock unsubscribes when the last consumer leaves and resyncs on remount', async () => {
  let now = 0;
  let detached = 0;
  const module = await load();
  const clock = module?.createCodexResetCreditClock({
    now: () => now,
    subscribeCredits: () => () => {
      detached++;
    },
    subscribeTicks: () => () => {
      detached++;
    },
  });
  const a = clock?.subscribe(() => {});
  const b = clock?.subscribe(() => {});
  a?.();
  expect(detached).toBe(0);
  b?.();
  expect(detached).toBe(2);
  now = 100;
  const c = clock?.subscribe(() => {});
  expect(clock?.getSnapshot()).toBe(100);
  c?.();
});
