import { afterEach, expect, test } from 'bun:test';
import type { AuthFileItem } from '@/types';
import {
  AnthropicResetGrantError,
  parseAnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import { useQuotaStore } from '@/stores/useQuotaStore';
import {
  createClaudeResetGrantFetcher,
  getClaudeResetGrantKey,
  CLAUDE_RESET_GRANT_TTL_MS,
  isClaudeResetGrantSnapshotFresh,
} from '@/features/quota/providers/claude/resetGrantRequests';
import { bankedClaudeResets } from '@/features/quota/providers/claude/selectResetGrant';

const file = (name = 'a.json', authIndex: string | number = '1'): AuthFileItem => ({
  name,
  authIndex,
});
const status = (left = 2) =>
  parseAnthropicResetGrantStatus({
    eligible: true,
    grants: [
      { id: 'bank', resets_total: 2, resets_left: left, clears: ['five_hour', 'seven_day'] },
    ],
  })!;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function setup() {
  let now = 0;
  let revision = 1;
  let calls = 0;
  const deps = {
    now: () => now,
    revision: () => revision,
    request: async (_authIndex: string) => {
      calls++;
      return status();
    },
  };
  const fetcher = createClaudeResetGrantFetcher(deps);
  return {
    deps,
    fetcher,
    advance: (ms: number) => {
      now += ms;
    },
    nextSession: () => {
      revision++;
    },
    calls: () => calls,
  };
}
afterEach(() => useQuotaStore.getState().clearQuotaCache());

test('stale/error snapshots can display balances but cannot authorize new redemptions', () => {
  const snapshot = { data: status(), updatedAt: 0, connectionRevision: 1 };
  expect(isClaudeResetGrantSnapshotFresh(snapshot, CLAUDE_RESET_GRANT_TTL_MS - 1)).toBe(true);
  expect(isClaudeResetGrantSnapshotFresh(snapshot, CLAUDE_RESET_GRANT_TTL_MS)).toBe(false);
  expect(isClaudeResetGrantSnapshotFresh({ ...snapshot, error: 'upstream' }, 1)).toBe(false);
  expect(isClaudeResetGrantSnapshotFresh({ connectionRevision: 1 }, 1)).toBe(false);
  expect(isClaudeResetGrantSnapshotFresh(undefined, 1)).toBe(false);
  expect(isClaudeResetGrantSnapshotFresh(snapshot, -1)).toBe(false);
  expect(bankedClaudeResets(snapshot.data, CLAUDE_RESET_GRANT_TTL_MS)).toBe(2);
});

test('shared reads deduplicate normalized identity and cache valid zero for 30 minutes', async () => {
  const h = setup();
  h.deps.request = async () => status(0);
  const a = h.fetcher.read(file());
  const b = h.fetcher.read(file('a.json', 1));
  expect(a).toBe(b);
  expect((await a)?.data?.grants[0].resetsLeft).toBe(0);
  expect(getClaudeResetGrantKey(file())).toBe('a.json\0' + '1');
  h.deps.request = async () => {
    throw new Error('must not refetch');
  };
  h.advance(CLAUDE_RESET_GRANT_TTL_MS - 1);
  expect((await h.fetcher.read(file()))?.data?.grants[0].resetsLeft).toBe(0);
  h.advance(1);
  expect((await h.fetcher.read(file()))?.error).toBe('upstream');
});

test('429 floor doubles to one hour, honors longer headers and survives generic invalidation', async () => {
  const h = setup();
  let calls = 0;
  let retry = 0;
  h.deps.request = async () => {
    calls++;
    throw new AnthropicResetGrantError('upstream', 429, retry);
  };
  for (const delay of [300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000]) {
    await h.fetcher.read(file());
    const attempted = calls;
    useQuotaStore.getState().clearQuotaCache();
    useQuotaStore.getState().clearQuotaCache(['a.json']);
    h.fetcher.invalidate(file());
    h.advance(delay - 1);
    expect(await h.fetcher.read(file())).toBeUndefined();
    expect(calls).toBe(attempted);
    h.advance(1);
  }
  retry = 7200;
  await h.fetcher.read(file());
  const attempted = calls;
  h.advance(3_600_000);
  await h.fetcher.read(file());
  expect(calls).toBe(attempted);
  h.advance(3_600_000);
  await h.fetcher.read(file());
  expect(calls).toBe(attempted + 1);
});

test('other failures have a bounded floor and retain known stale data', async () => {
  const h = setup();
  await h.fetcher.read(file());
  h.advance(CLAUDE_RESET_GRANT_TTL_MS);
  let calls = 0;
  h.deps.request = async () => {
    calls++;
    throw new Error('private detail');
  };
  const failed = await h.fetcher.read(file());
  expect(failed?.data?.grants[0].resetsLeft).toBe(2);
  expect(failed?.error).toBe('upstream');
  expect(JSON.stringify(failed)).not.toContain('private');
  for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
    const attempted = calls;
    h.advance(delay - 1);
    await h.fetcher.read(file());
    expect(calls).toBe(attempted);
    h.advance(1);
    await h.fetcher.read(file());
    expect(calls).toBe(attempted + 1);
  }
});

test('manual clears cannot bypass successful TTL; explicit redemption invalidation can', async () => {
  const h = setup();
  await h.fetcher.read(file());
  useQuotaStore.getState().clearQuotaCache();
  expect(await h.fetcher.read(file())).toBeUndefined();
  expect(h.calls()).toBe(1);
  h.fetcher.invalidate(file());
  await h.fetcher.read(file());
  expect(h.calls()).toBe(2);
});

test('generic cache clears during a read cannot duplicate it or lose its eventual 429 deadline', async () => {
  const h = setup();
  const pending = deferred<ReturnType<typeof status>>();
  let calls = 0;
  h.deps.request = async () => {
    calls++;
    await pending.promise;
    throw new AnthropicResetGrantError('upstream', 429, 0);
  };
  const first = h.fetcher.read(file());
  useQuotaStore.getState().clearQuotaCache();
  const second = h.fetcher.read(file());
  expect(calls).toBe(1);
  pending.resolve(status());
  expect(await first).toBeUndefined();
  expect(await second).toBeUndefined();
  await h.fetcher.read(file());
  expect(calls).toBe(1);
  h.advance(300_000);
  await h.fetcher.read(file());
  expect(calls).toBe(2);
});

test('global concurrency is two and stale queued jobs never dispatch', async () => {
  const h = setup();
  const pending = deferred<ReturnType<typeof status>>();
  const calls: string[] = [];
  h.deps.request = async (authIndex) => {
    calls.push(authIndex);
    return pending.promise;
  };
  const a = h.fetcher.read(file('a.json', 'a'));
  const b = h.fetcher.read(file('b.json', 'b'));
  const c = h.fetcher.read(file('c.json', 'c'));
  expect(calls).toEqual(['a', 'b']);
  useQuotaStore.getState().clearQuotaCache(['c.json']);
  pending.resolve(status());
  await Promise.all([a, b, c]);
  expect(calls).toEqual(['a', 'b']);
  expect(
    useQuotaStore.getState().claudeResetGrants[getClaudeResetGrantKey(file('c.json', 'c'))]
  ).toBeUndefined();
});

test('file generation invalidates in-flight results but unrelated file changes do not', async () => {
  const h = setup();
  const pending = deferred<ReturnType<typeof status>>();
  h.deps.request = () => pending.promise;
  const a = h.fetcher.read(file());
  const b = h.fetcher.read(file('b.json'));
  useQuotaStore.getState().clearQuotaCache(['a.json']);
  pending.resolve(status());
  expect(await a).toBeUndefined();
  expect((await b)?.data).toEqual(status());
  expect(
    useQuotaStore.getState().claudeResetGrants[getClaudeResetGrantKey(file())]
  ).toBeUndefined();
});

test('filename auth-index ABA rejects old queued identities even without a cache clear', async () => {
  const h = setup();
  const pending = deferred<ReturnType<typeof status>>();
  const calls: string[] = [];
  h.deps.request = async (authIndex) => {
    calls.push(authIndex);
    return pending.promise;
  };
  const old = h.fetcher.read(file('a.json', 'old'));
  const occupied = h.fetcher.read(file('b.json', 'busy'));
  const changed = h.fetcher.read(file('a.json', 'changed'));
  const replacement = h.fetcher.read(file('a.json', 'old'));
  pending.resolve(status());
  expect(await old).toBeUndefined();
  await occupied;
  expect(await changed).toBeUndefined();
  expect((await replacement)?.data).toEqual(status());
  expect(calls).toEqual(['old', 'busy', 'old']);
});

test('file mutation followed by a generic generation reset cannot revive old work or throttle replacement', async () => {
  const h = setup();
  const pending = deferred<ReturnType<typeof status>>();
  h.deps.request = async () => {
    await pending.promise;
    throw new AnthropicResetGrantError('upstream', 429);
  };
  const old = h.fetcher.read(file());
  useQuotaStore.getState().clearQuotaCache(['a.json']);
  useQuotaStore.getState().clearQuotaCache();
  pending.resolve(status());
  expect(await old).toBeUndefined();
  h.deps.request = async () => status();
  expect((await h.fetcher.read(file()))?.data).toEqual(status());
});

test('connection ABA rejects queued and completed work and does not throttle replacement', async () => {
  const h = setup();
  const pending = deferred<ReturnType<typeof status>>();
  const calls: string[] = [];
  h.deps.request = async (authIndex) => {
    calls.push(authIndex);
    return pending.promise;
  };
  const a = h.fetcher.read(file('a.json', 'a'));
  const b = h.fetcher.read(file('b.json', 'b'));
  const c = h.fetcher.read(file('c.json', 'c'));
  h.nextSession();
  h.nextSession();
  useQuotaStore.getState().clearQuotaCache();
  const replacement = h.fetcher.read(file('a.json', 'a'));
  pending.resolve(status());
  expect(await a).toBeUndefined();
  expect(await b).toBeUndefined();
  expect(await c).toBeUndefined();
  expect((await replacement)?.data).toEqual(status());
  expect(calls).toEqual(['a', 'b', 'a']);
});

test('reset render cache follows filename invalidation and never clears unrelated balances', async () => {
  const h = setup();
  await h.fetcher.read(file());
  await h.fetcher.read(file('b.json'));
  useQuotaStore.getState().clearQuotaCache(['a.json']);
  const snapshots = useQuotaStore.getState().claudeResetGrants;
  expect(snapshots[getClaudeResetGrantKey(file())]).toBeUndefined();
  expect(snapshots[getClaudeResetGrantKey(file('b.json'))]?.data).toEqual(status());
  useQuotaStore.getState().clearQuotaCache();
  expect(useQuotaStore.getState().claudeResetGrants).toEqual({});
});

test('ranked page and card share read hook; only confirmed card actions invalidate after redemption', async () => {
  const page = await Bun.file('src/features/quota/QuotaPage.tsx').text();
  const card = await Bun.file('src/features/quota/providers/claude/ClaudeResetGrants.tsx').text();
  const hook = await Bun.file(
    'src/features/quota/providers/claude/useClaudeResetGrantReads.ts'
  ).text();
  expect(page).toContain('useClaudeResetGrantReads(');
  expect(page).toContain('getClaudeResetGrantKey(entry.file)');
  expect(page).toContain('setClaudeResetGrants(');
  expect(card).toContain('useClaudeResetGrantReads(');
  expect(card).not.toContain('readClaudeResetGrants(');
  expect(card).toContain('claudeResetGrantFetcher.invalidate(file)');
  expect(card.indexOf('resetGrantOperations.run(')).toBeGreaterThan(card.indexOf('onConfirm:'));
  expect(hook).not.toContain('claimClaudeResetGrant');
  expect(hook).not.toContain('const now = useNow');
});

test('banked balance counts each grant once irrespective of scope/pause/usability and local dates', () => {
  const base = status();
  const grant = base.grants[0];
  const snapshot = {
    ...base,
    grants: [
      { ...grant, id: 'paused', paused: true },
      { ...grant, id: 'future', startsAt: new Date(1000).toISOString() },
      { ...grant, id: 'expired', endsAt: new Date(1000).toISOString() },
    ],
  };
  expect(bankedClaudeResets(snapshot, 0)).toBe(4);
  expect(bankedClaudeResets(snapshot, 1000)).toBe(4);
  expect(bankedClaudeResets(null, 1000)).toBeNull();
  expect(bankedClaudeResets(status(0), 1000)).toBe(0);
});
