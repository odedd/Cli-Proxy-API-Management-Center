import { afterEach, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import type { AuthFileItem } from '@/types';
import { apiCallApi, type ApiCallResult } from '@/services/api';
import * as data from '@/features/quota/providers/codex/data';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { CODEX_RATE_LIMIT_RESET_CREDITS_URL } from '@/utils/quota';

const t = ((key: string) => key) as TFunction;
const original = apiCallApi.request;
const file: AuthFileItem = { name: 'codex.json', authIndex: '7' };
const response = (statusCode: number, body: unknown, header = {}): ApiCallResult => ({
  statusCode,
  body,
  bodyText: JSON.stringify(body),
  header,
});
const credits = (availableCount = 2) => ({
  availableCount,
  applicableAvailableCount: 0,
  credits: [],
  error: '',
});
const load = async () =>
  import('@/features/quota/providers/codex/resetCreditRequests').catch(() => null);

afterEach(() => {
  apiCallApi.request = original;
  useQuotaStore.getState().clearQuotaCache();
});

test('credit-only reads preserve authoritative counts without requesting usage', async () => {
  const requests: string[] = [];
  apiCallApi.request = async (request) => {
    requests.push(`${request.method} ${request.url}`);
    expect(request.authIndex).toBe('7');
    expect(request.header?.['OpenAI-Beta']).toBe('codex-1');
    return response(200, { available_count: 2, applicable_available_count: 0, credits: [] });
  };
  const result = await data.fetchCodexResetCreditStatus?.(file, t);
  expect(result?.availableCount).toBe(2);
  expect(result?.applicableAvailableCount).toBe(0);
  expect(requests).toEqual([`GET ${CODEX_RATE_LIMIT_RESET_CREDITS_URL}`]);
});

test('failed credit reads expose sanitized status and Retry-After, not provider bodies', async () => {
  apiCallApi.request = async () =>
    response(429, { error: 'private-provider-detail' }, { 'Retry-After': ['7200'] });
  const result = await data.fetchCodexResetCreditStatus?.(file, t);
  expect(result?.httpStatus).toBe(429);
  expect(result?.retryAfterSeconds).toBe(7200);
  expect(result?.availableCount).toBeNull();
  expect(JSON.stringify(result)).not.toContain('private-provider-detail');
});

test('invalid negative or fractional counts cannot authorize credit use', async () => {
  for (const count of [-1, 0.5]) {
    apiCallApi.request = async () => response(200, { available_count: count, credits: [] });
    const result = await data.fetchCodexResetCreditStatus?.(file, t);
    expect(result?.availableCount).toBeNull();
    expect(result?.error).toBeTruthy();
  }
});

test('the separate credit cache clears by filename without replacing passive quota windows', () => {
  useQuotaStore.getState().setCodexQuota({ 'codex.json': { status: 'success', windows: [] } });
  useQuotaStore.getState().setCodexResetCredits?.({
    ['codex.json\0' + '7\0']: { connectionRevision: 1, updatedAt: 0, data: credits(0) },
  });
  expect(
    useQuotaStore.getState().codexResetCredits?.['codex.json\0' + '7\0']?.data?.availableCount
  ).toBe(0);
  expect(useQuotaStore.getState().codexQuota['codex.json']?.status).toBe('success');
  useQuotaStore.getState().clearQuotaCache(['codex.json']);
  expect(useQuotaStore.getState().codexResetCredits).toEqual({});
});

test('shared reads deduplicate identity and preserve successful zero through cache clears', async () => {
  const module = await load();
  let now = 0;
  let calls = 0;
  const fetcher = module?.createCodexResetCreditFetcher?.({
    now: () => now,
    revision: () => 1,
    request: async () => {
      calls++;
      return credits(0);
    },
  });
  const a = fetcher?.read(file);
  const b = fetcher?.read({ ...file, authIndex: 7 });
  expect((await a)?.data?.availableCount).toBe(0);
  expect(a).toBe(b);
  now = 1_799_999;
  useQuotaStore.getState().clearQuotaCache();
  await fetcher?.read(file);
  expect(calls).toBe(1);
  now++;
  await fetcher?.read(file);
  expect(calls).toBe(2);
});

test('429 retry deadlines survive invalidation and double after repeated failures', async () => {
  const module = await load();
  let now = 0;
  let calls = 0;
  const fetcher = module?.createCodexResetCreditFetcher?.({
    now: () => now,
    revision: () => 1,
    request: async () => {
      calls++;
      return {
        ...credits(),
        availableCount: null,
        error: 'upstream',
        httpStatus: 429,
        retryAfterSeconds: 0,
      };
    },
  });
  await fetcher?.read(file);
  fetcher?.invalidate(file);
  useQuotaStore.getState().clearQuotaCache();
  now = 299_999;
  await fetcher?.read(file);
  expect(calls).toBe(1);
  now++;
  await fetcher?.read(file);
  expect(calls).toBe(2);
  now += 599_999;
  await fetcher?.read(file);
  expect(calls).toBe(2);
});

test('session switches reject in-flight metadata and do not write replacement quota state', async () => {
  const module = await load();
  let revision = 1;
  let finish!: (value: ReturnType<typeof credits>) => void;
  const pending = new Promise<ReturnType<typeof credits>>((resolve) => {
    finish = resolve;
  });
  const fetcher = module?.createCodexResetCreditFetcher?.({
    now: () => 0,
    revision: () => revision,
    request: () => pending,
  });
  const old = fetcher?.read(file);
  revision++;
  useQuotaStore.getState().clearQuotaCache();
  finish(credits());
  expect(await old).toBeUndefined();
  expect(useQuotaStore.getState().codexResetCredits).toEqual({});
});

test('redemption invalidation rejects old metadata without erasing full quota windows', async () => {
  const module = await load();
  const fetcher = module?.createCodexResetCreditFetcher?.({
    now: () => 0,
    revision: () => 1,
    request: async () => credits(),
  });
  await fetcher?.read(file);
  expect(Object.keys(useQuotaStore.getState().codexResetCredits ?? {})).toHaveLength(1);
  useQuotaStore.getState().setCodexQuota({ 'codex.json': { status: 'success', windows: [] } });
  fetcher?.invalidate(file);
  expect(useQuotaStore.getState().codexResetCredits).toEqual({});
  expect(useQuotaStore.getState().codexQuota['codex.json']?.status).toBe('success');
});

test('longer Retry-After wins over the five-minute rate-limit floor', async () => {
  const module = await load();
  let now = 0;
  let calls = 0;
  const fetcher = module?.createCodexResetCreditFetcher?.({
    now: () => now,
    revision: () => 1,
    request: async () => {
      calls++;
      return {
        ...credits(),
        availableCount: null,
        error: 'upstream',
        httpStatus: 429,
        retryAfterSeconds: 7200,
      };
    },
  });
  await fetcher?.read(file);
  now = 7_199_999;
  await fetcher?.read(file);
  expect(calls).toBe(1);
  now++;
  await fetcher?.read(file);
  expect(calls).toBe(2);
});

test('credit reads have two slots and invalidated queued credentials never dispatch', async () => {
  const module = await load();
  let finish!: (value: ReturnType<typeof credits>) => void;
  const pending = new Promise<ReturnType<typeof credits>>((resolve) => {
    finish = resolve;
  });
  const requested: string[] = [];
  const fetcher = module?.createCodexResetCreditFetcher?.({
    now: () => 0,
    revision: () => 1,
    request: async (file) => {
      requested.push(file.name);
      return pending;
    },
  });
  const a = fetcher?.read(file);
  const b = fetcher?.read({ ...file, name: 'b.json' });
  const c = fetcher?.read({ ...file, name: 'c.json' });
  expect(requested).toEqual(['codex.json', 'b.json']);
  useQuotaStore.getState().clearQuotaCache(['c.json']);
  finish(credits());
  await Promise.all([a, b, c]);
  expect(requested).toEqual(['codex.json', 'b.json']);
});

test('redemption invalidation cannot let an older in-flight balance restore spent credits', async () => {
  const module = await load();
  let finish!: (value: ReturnType<typeof credits>) => void;
  const pending = new Promise<ReturnType<typeof credits>>((resolve) => {
    finish = resolve;
  });
  const fetcher = module?.createCodexResetCreditFetcher?.({
    now: () => 0,
    revision: () => 1,
    request: () => pending,
  });
  const old = fetcher?.read(file);
  fetcher?.invalidate(file);
  finish(credits());
  expect(await old).toBeUndefined();
  expect(useQuotaStore.getState().codexResetCredits).toEqual({});
});
