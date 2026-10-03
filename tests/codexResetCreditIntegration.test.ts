import { afterEach, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import { apiCallApi, type ApiCallResult } from '@/services/api';
import { CODEX_CONFIG } from '@/features/quota/providers/codex/data';
import {
  codexResetCreditFetcher,
  getCodexResetCreditKey,
} from '@/features/quota/providers/codex/resetCreditRequests';
import { useQuotaStore } from '@/stores/useQuotaStore';
import {
  CODEX_USAGE_URL,
  CODEX_RATE_LIMIT_RESET_CREDITS_URL,
  CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL,
} from '@/utils/quota';

const t = ((key: string) => key) as TFunction;
const original = apiCallApi.request;
const response = (statusCode: number, body: unknown): ApiCallResult => ({
  statusCode,
  body,
  bodyText: JSON.stringify(body),
  header: {},
});
const usage = { rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 604800 } } };
afterEach(() => {
  apiCallApi.request = original;
  useQuotaStore.getState().clearQuotaCache();
});

test('full quota reads share the metadata rate-limit deadline', async () => {
  const file = { name: 'integration-throttle.json', authIndex: '71' };
  let reads = 0;
  apiCallApi.request = async (request) => {
    if (request.url === CODEX_USAGE_URL) return response(200, usage);
    if (request.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL) {
      reads++;
      return response(429, {});
    }
    throw new Error('Unexpected request');
  };
  await codexResetCreditFetcher.read(file);
  await CODEX_CONFIG.fetchQuota(file, t);
  expect(reads).toBe(1);
});

test('full cards use the same successful zero observation as ranked rows', async () => {
  const file = { name: 'integration-zero.json', authIndex: '72' };
  let count = 0;
  apiCallApi.request = async (request) => {
    if (request.url === CODEX_USAGE_URL) return response(200, usage);
    if (request.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL)
      return response(200, { available_count: count, credits: [] });
    throw new Error('Unexpected request');
  };
  await codexResetCreditFetcher.read(file);
  count = 3;
  const data = await CODEX_CONFIG.fetchQuota(file, t);
  expect(data.rateLimitResetCreditsAvailableCount).toBe(0);
  expect(CODEX_CONFIG.canResetQuota!(CODEX_CONFIG.buildSuccessState(data))).toBe(false);
});

test('consumption invalidates the old observation before the full refresh reads credits', async () => {
  const file = { name: 'integration-consume.json', authIndex: '73' };
  let count = 1;
  let posts = 0;
  apiCallApi.request = async (request) => {
    if (request.url === CODEX_USAGE_URL) return response(200, usage);
    if (request.url === CODEX_RATE_LIMIT_RESET_CREDITS_URL)
      return response(200, { available_count: count, credits: [] });
    if (request.url === CODEX_RATE_LIMIT_RESET_CREDITS_CONSUME_URL) {
      posts++;
      count = 0;
      return response(200, {});
    }
    throw new Error('Unexpected request');
  };
  await codexResetCreditFetcher.read(file);
  const result = await CODEX_CONFIG.resetQuota!(file, t);
  expect(posts).toBe(1);
  expect(result.rateLimitResetCreditsAvailableCount).toBe(0);
  expect(
    useQuotaStore.getState().codexResetCredits[getCodexResetCreditKey(file)]?.data?.availableCount
  ).toBe(0);
});
