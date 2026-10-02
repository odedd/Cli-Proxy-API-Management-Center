/**
 * Routing view of Claude / Codex quota: which credential the backend is serving
 * from, which are held in reserve, and how much weekly headroom a provider has.
 *
 * Mirrors the backend's selection: the highest `priority` bucket wins and, under
 * `fill-first`, the first credential by name inside it. A credential stops being
 * eligible here only when its usage says it is capped; the 95% thresholds match
 * the dev2 priority updater (nearest reset first, weekly reserve, 5h cap).
 *
 * React-free — consumed directly by tests/quotaRouting.test.ts.
 */

import type { AuthFileItem } from '@/types';
import type { QuotaFileEntry } from '../logic';

export const ROUTED_PROVIDERS = ['claude', 'codex'] as const;
export type RoutedProvider = (typeof ROUTED_PROVIDERS)[number];

export const WEEKLY_RESERVE_PERCENT = 95;
export const FIVE_HOUR_CAP_PERCENT = 95;

export type RoutingStatus = 'serving' | 'next' | 'reserve' | 'capped' | 'unknown';

/** Only the fields routing reads; any provider's card state can be passed in. */
type RoutedQuota = {
  status?: string;
  windows?: ReadonlyArray<{ id: string; usedPercent: number | null; resetAtMs?: number | null }>;
};

export interface RoutingWindow {
  usedPercent: number;
  resetAtMs: number | null;
}

export interface RoutingRow {
  entry: QuotaFileEntry;
  priority: number;
  /** Usage was fetched successfully. */
  loaded: boolean;
  status: RoutingStatus;
  fiveHour: RoutingWindow | null;
  weekly: RoutingWindow | null;
}

export interface RoutingProviderSummary {
  type: RoutedProvider;
  rows: RoutingRow[];
  serving: RoutingRow | null;
  loadedCount: number;
  /** Sum of weekly remaining percent across loaded credentials. */
  weeklyRemaining: number;
  /** 100 per loaded credential. */
  weeklyCapacity: number;
  nextWeeklyReset: { atMs: number; row: RoutingRow } | null;
}

const WINDOW_IDS: Record<RoutedProvider, { fiveHour: string | null; weekly: string }> = {
  claude: { fiveHour: 'five-hour', weekly: 'seven-day' },
  // Codex Pro reports a single weekly window; a 5h window is kept if one reappears.
  codex: { fiveHour: 'five-hour', weekly: 'weekly' },
};

export const isRoutedProvider = (type: string): type is RoutedProvider =>
  (ROUTED_PROVIDERS as readonly string[]).includes(type);

export const credentialPriority = (file: AuthFileItem): number => {
  const value = Number(file.priority);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
};

/** A window counts only while its reset is in the future (or unknown). */
function readWindow(quota: RoutedQuota, id: string | null, now: number): RoutingWindow | null {
  if (!id) return null;
  const window = quota.windows?.find((item) => item.id === id);
  if (!window || window.usedPercent === null) return null;
  const resetAtMs = window.resetAtMs ?? null;
  if (resetAtMs !== null && resetAtMs <= now) return null;
  return { usedPercent: Math.max(0, Math.min(100, window.usedPercent)), resetAtMs };
}

function usageStatus(row: Omit<RoutingRow, 'status'>): RoutingStatus {
  if (!row.loaded) return 'unknown';
  const weekly = row.weekly?.usedPercent ?? 0;
  const fiveHour = row.fiveHour?.usedPercent ?? 0;
  if (weekly >= 100 || fiveHour >= FIVE_HOUR_CAP_PERCENT) return 'capped';
  if (weekly >= WEEKLY_RESERVE_PERCENT) return 'reserve';
  return 'next';
}

/** Backend order: priority descending, then credential name (fill-first picks the first). */
export const compareRoutingOrder = (a: QuotaFileEntry, b: QuotaFileEntry): number =>
  credentialPriority(b.file) - credentialPriority(a.file) || a.file.name.localeCompare(b.file.name);

export function buildRoutingSummary(
  type: RoutedProvider,
  entries: QuotaFileEntry[],
  quotaFor: (entry: QuotaFileEntry) => RoutedQuota | undefined,
  now: number
): RoutingProviderSummary {
  const ids = WINDOW_IDS[type];
  const rows: RoutingRow[] = entries
    .filter((entry) => entry.type === type && !entry.file.disabled)
    .sort(compareRoutingOrder)
    .map((entry) => {
      const quota = quotaFor(entry);
      const loaded = quota?.status === 'success';
      const base = {
        entry,
        priority: credentialPriority(entry.file),
        loaded,
        fiveHour: loaded && quota ? readWindow(quota, ids.fiveHour, now) : null,
        weekly: loaded && quota ? readWindow(quota, ids.weekly, now) : null,
      };
      return { ...base, status: usageStatus(base) };
    });

  // The backend skips only credentials it cannot use; unknown usage stays eligible.
  const serving = rows.find((row) => row.status !== 'capped') ?? null;
  if (serving) serving.status = 'serving';

  let loadedCount = 0;
  let weeklyRemaining = 0;
  let nextWeeklyReset: RoutingProviderSummary['nextWeeklyReset'] = null;
  for (const row of rows) {
    if (!row.loaded) continue;
    loadedCount += 1;
    weeklyRemaining += 100 - (row.weekly?.usedPercent ?? 0);
    const atMs = row.weekly?.resetAtMs ?? null;
    if (atMs !== null && (nextWeeklyReset === null || atMs < nextWeeklyReset.atMs)) {
      nextWeeklyReset = { atMs, row };
    }
  }

  return {
    type,
    rows,
    serving,
    loadedCount,
    weeklyRemaining: Math.round(weeklyRemaining),
    weeklyCapacity: loadedCount * 100,
    nextWeeklyReset,
  };
}

/** Status per credential cache key, for decorating cards outside the summary. */
export function routingStatusByName(summaries: RoutingProviderSummary[]): Map<string, RoutingRow> {
  const map = new Map<string, RoutingRow>();
  summaries.forEach((summary) => summary.rows.forEach((row) => map.set(row.entry.file.name, row)));
  return map;
}

/** `davidovoded@gmail.com` → `d•••@gmail.com`; non-emails pass through. */
export const maskEmail = (value: string): string => {
  const at = value.indexOf('@');
  return at > 0 ? `${value.slice(0, 1)}•••${value.slice(at)}` : value;
};
