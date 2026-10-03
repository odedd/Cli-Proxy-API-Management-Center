import { afterEach, expect, test } from 'bun:test';
import type { AuthFileItem } from '@/types';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { getCodexResetCreditKey } from '@/features/quota/providers/codex/resetCreditRequests';

const file: AuthFileItem = { name: 'codex.json', provider: 'codex', authIndex: '7' };
const load = () => import('@/features/quota/hooks/resetQuotaGuard').catch(() => null);
afterEach(() => useQuotaStore.getState().clearQuotaCache());

async function setup() {
  let revision = 1;
  let files = [file];
  let connected = true;
  let disabled = false;
  let now = 0;
  const module = await load();
  const guard = module?.createQuotaResetGuard?.({
    revision: () => revision,
    files: () => files,
    connected: () => connected,
    disabled: () => disabled,
    now: () => now,
  });
  const seed = (count = 2) =>
    useQuotaStore.getState().setCodexResetCredits({
      [getCodexResetCreditKey(file)]: {
        connectionRevision: 1,
        updatedAt: 0,
        data: { availableCount: count, applicableAvailableCount: 0, credits: [], error: '' },
      },
    });
  seed();
  return {
    guard,
    seed,
    setRevision: () => revision++,
    replace: (f: AuthFileItem[]) => (files = f),
    disconnect: () => (connected = false),
    disable: () => (disabled = true),
    expire: () => (now = 1_800_000),
  };
}

test('a current positive count permits confirmation and a synchronous lock prevents duplicate POSTs', async () => {
  const h = await setup();
  const origin = h.guard?.capture(file);
  expect(origin?.current()).toBe(true);
  expect(h.guard?.acquire(origin!)).toBe(true);
  expect(h.guard?.acquire(origin!)).toBe(false);
  h.guard?.release();
  expect(h.guard?.acquire(origin!)).toBe(true);
});

test('an old confirmation cannot authorize a reset after switching connections', async () => {
  const h = await setup();
  const origin = h.guard?.capture(file);
  h.setRevision();
  expect(origin?.current()).toBe(false);
  expect(h.guard?.acquire(origin!)).toBe(false);
});

test('confirmation rechecks credential removal, replacement and disabled state', async () => {
  for (const replacement of [[], [{ ...file, authIndex: '8' }], [{ ...file, disabled: true }]]) {
    const h = await setup();
    const origin = h.guard?.capture(file);
    h.replace(replacement);
    expect(origin?.current()).toBe(false);
  }
});

test('confirmation rejects stale, depleted, disconnected and disabled observations', async () => {
  for (const change of ['expire', 'zero', 'disconnect', 'disable'] as const) {
    const h = await setup();
    const origin = h.guard?.capture(file);
    if (change === 'zero') h.seed(0);
    else h[change]();
    expect(origin?.current()).toBe(false);
  }
});

test('cache invalidation between click and confirmation invalidates the origin', async () => {
  const h = await setup();
  const origin = h.guard?.capture(file);
  useQuotaStore.getState().clearQuotaCache(['codex.json']);
  h.seed();
  expect(origin?.current()).toBe(false);
});
