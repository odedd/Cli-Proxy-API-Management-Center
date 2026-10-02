/**
 * Usage observed passively by the backend: CLIProxyAPI records the rate-limit
 * headers of every proxied Claude / Codex response on the credential
 * (`quota.signals` + `quota.observed_at` in the credentials list). Reading them
 * costs no upstream call and stays live for any account carrying traffic.
 *
 * React-free — consumed directly by tests/quotaRouting.test.ts.
 */

import type { AuthFileItem } from '@/types';
import type { RoutedProvider, RoutingWindow } from './model';

export interface ObservedUsage {
  observedAtMs: number;
  fiveHour: RoutingWindow | null;
  weekly: RoutingWindow | null;
  /** The provider reports the credential as blocked (weekly rejected / limit reached). */
  limited: boolean;
  /** Claude rejected the 5-hour window. */
  fiveHourRejected: boolean;
}

const FIVE_HOUR_MINUTES = 300;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Unix seconds or an ISO timestamp, to epoch ms. */
const toInstantMs = (value: unknown): number | null => {
  const seconds = toNumber(value);
  if (seconds !== null) return seconds * 1000;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

const headerLookup = (signals: Record<string, unknown>) => {
  const lower = new Map(Object.entries(signals).map(([key, value]) => [key.toLowerCase(), value]));
  return (name: string): unknown => lower.get(name.toLowerCase());
};

const makeWindow = (
  usedPercent: number | null,
  resetAtMs: number | null,
  now: number
): RoutingWindow | null => {
  if (usedPercent === null) return null;
  if (resetAtMs !== null && resetAtMs <= now) return null;
  return { usedPercent: Math.max(0, Math.min(100, usedPercent)), resetAtMs };
};

function readClaude(get: (name: string) => unknown, observedAtMs: number, now: number) {
  const utilization = (window: string) => {
    const fraction = toNumber(get(`Anthropic-Ratelimit-Unified-${window}-Utilization`));
    return fraction === null ? null : fraction * 100; // headers carry a 0..1 fraction
  };
  const reset = (window: string) => toInstantMs(get(`Anthropic-Ratelimit-Unified-${window}-Reset`));
  const rejected = (window: string) =>
    String(get(`Anthropic-Ratelimit-Unified-${window}-Status`) ?? '').toLowerCase() === 'rejected';

  const five = utilization('5h');
  const week = utilization('7d');
  if (five === null && week === null) return null;
  return {
    observedAtMs,
    fiveHour: makeWindow(five, reset('5h'), now),
    weekly: makeWindow(week, reset('7d'), now),
    limited: rejected('7d'),
    fiveHourRejected: rejected('5h'),
  };
}

function readCodex(get: (name: string) => unknown, observedAtMs: number, now: number) {
  let fiveHour: RoutingWindow | null = null;
  let weekly: RoutingWindow | null = null;
  let found = false;
  for (const slot of ['Primary', 'Secondary']) {
    const used = toNumber(get(`X-Codex-${slot}-Used-Percent`));
    const minutes = toNumber(get(`X-Codex-${slot}-Window-Minutes`));
    if (used === null || minutes === null) continue;
    found = true;
    let resetAtMs = toInstantMs(get(`X-Codex-${slot}-Reset-At`));
    if (resetAtMs === null) {
      const after = toNumber(get(`X-Codex-${slot}-Reset-After-Seconds`));
      resetAtMs = after === null ? null : observedAtMs + after * 1000;
    }
    const window = makeWindow(used, resetAtMs, now);
    if (minutes <= FIVE_HOUR_MINUTES) fiveHour = window;
    else weekly = window;
  }
  if (!found) return null;
  const limited =
    String(get('X-Codex-Limit-Reached') ?? '').toLowerCase() === 'true' ||
    String(get('X-Codex-Allowed') ?? '').toLowerCase() === 'false';
  return { observedAtMs, fiveHour, weekly, limited, fiveHourRejected: false };
}

export function readObservedUsage(
  type: RoutedProvider,
  file: AuthFileItem,
  now: number
): ObservedUsage | null {
  const quota = file.quota;
  if (!isRecord(quota) || !isRecord(quota.signals)) return null;
  const observedAtMs = toInstantMs(quota.observed_at ?? quota.observedAt);
  if (observedAtMs === null) return null;
  const get = headerLookup(quota.signals);
  return type === 'claude' ? readClaude(get, observedAtMs, now) : readCodex(get, observedAtMs, now);
}
