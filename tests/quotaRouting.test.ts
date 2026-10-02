import { describe, expect, test } from 'bun:test';
import { sortQuotaEntries, type QuotaFileEntry } from '@/features/quota/logic';
import { readObservedUsage } from '@/features/quota/routing/signals';
import {
  buildRoutingSummary,
  credentialPriority,
  routingStatusByName,
} from '@/features/quota/routing/model';
import type { AuthFileItem, ClaudeQuotaState, CodexQuotaState } from '@/types';

const NOW = Date.UTC(2026, 9, 2, 5, 12);
const HOUR = 3_600_000;

const entry = (
  name: string,
  type: QuotaFileEntry['type'],
  extra: Partial<AuthFileItem> = {}
): QuotaFileEntry => ({ type, file: { name, provider: type, ...extra } as AuthFileItem });

const claude = (fiveHour: number | null, weekly: number, fiveResetH = 2): ClaudeQuotaState => ({
  status: 'success',
  windows: [
    ...(fiveHour === null
      ? []
      : [
          {
            id: 'five-hour',
            label: '5h',
            usedPercent: fiveHour,
            resetLabel: '',
            resetAtMs: NOW + fiveResetH * HOUR,
          },
        ]),
    {
      id: 'seven-day',
      label: '7d',
      usedPercent: weekly,
      resetLabel: '',
      resetAtMs: NOW + 48 * HOUR,
    },
  ],
});

const codex = (weekly: number, resetH: number): CodexQuotaState => ({
  status: 'success',
  windows: [
    {
      id: 'weekly',
      label: 'wk',
      usedPercent: weekly,
      resetLabel: '',
      resetAtMs: NOW + resetH * HOUR,
    },
  ],
});

describe('credentialPriority', () => {
  test('reads numeric priority and defaults to 0', () => {
    expect(credentialPriority({ name: 'a', priority: 100 } as AuthFileItem)).toBe(100);
    expect(credentialPriority({ name: 'a' } as AuthFileItem)).toBe(0);
    expect(credentialPriority({ name: 'a', priority: '7' } as unknown as AuthFileItem)).toBe(7);
  });
});

describe('buildRoutingSummary', () => {
  test('serves the highest-priority usable credential and labels the rest', () => {
    const entries = [
      entry('claude-reserve.json', 'claude', { priority: 99 }),
      entry('claude-top.json', 'claude', { priority: 100 }),
      entry('claude-capped.json', 'claude', { priority: 98 }),
      entry('claude-unloaded.json', 'claude', { priority: 97 }),
    ];
    const quota: Record<string, ClaudeQuotaState> = {
      'claude-top.json': claude(28, 49),
      'claude-reserve.json': claude(0, 98),
      'claude-capped.json': claude(96, 40),
    };
    const summary = buildRoutingSummary('claude', entries, (e) => quota[e.file.name], NOW);

    expect(summary.rows.map((r) => [r.entry.file.name, r.status])).toEqual([
      ['claude-top.json', 'serving'],
      ['claude-reserve.json', 'reserve'],
      ['claude-capped.json', 'capped'],
      ['claude-unloaded.json', 'unknown'],
    ]);
    expect(summary.loadedCount).toBe(3);
    expect(summary.weeklyRemaining).toBe(51 + 2 + 60);
    expect(summary.weeklyCapacity).toBe(300);
    expect(summary.nextWeeklyReset?.atMs).toBe(NOW + 48 * HOUR);
  });

  test('falls through capped credentials to the next eligible one', () => {
    const entries = [
      entry('a.json', 'claude', { priority: 100 }),
      entry('b.json', 'claude', { priority: 99 }),
    ];
    const quota: Record<string, ClaudeQuotaState> = {
      'a.json': claude(97, 10),
      'b.json': claude(5, 96),
    };
    const summary = buildRoutingSummary('claude', entries, (e) => quota[e.file.name], NOW);
    expect(summary.serving?.entry.file.name).toBe('b.json');
    expect(summary.rows[0].status).toBe('capped');
  });

  test('ignores expired windows and weekly exhaustion caps codex', () => {
    const entries = [
      entry('codex-full.json', 'codex', { priority: 100 }),
      entry('codex-ok.json', 'codex', { priority: 99 }),
    ];
    const quota: Record<string, CodexQuotaState> = {
      'codex-full.json': codex(100, 30),
      'codex-ok.json': codex(92, 36),
    };
    const summary = buildRoutingSummary('codex', entries, (e) => quota[e.file.name], NOW);
    expect(summary.rows.map((r) => r.status)).toEqual(['capped', 'serving']);

    const expired = buildRoutingSummary(
      'claude',
      [entry('x.json', 'claude')],
      () => claude(99, 10, -1),
      NOW
    );
    expect(expired.rows[0].fiveHour).toBeNull();
    expect(expired.rows[0].status).toBe('serving');
  });

  test('ties break by name like fill-first, and disabled credentials are skipped', () => {
    const entries = [
      entry('b.json', 'codex'),
      entry('a.json', 'codex'),
      entry('0-off.json', 'codex', { disabled: true }),
    ];
    const summary = buildRoutingSummary('codex', entries, () => undefined, NOW);
    expect(summary.rows.map((r) => r.entry.file.name)).toEqual(['a.json', 'b.json']);
    expect(summary.serving?.entry.file.name).toBe('a.json');
    expect(summary.loadedCount).toBe(0);
    expect(routingStatusByName([summary]).get('b.json')?.status).toBe('unknown');
  });
});

describe('priority sort mode', () => {
  test('keeps provider groups and orders each by backend pick order', () => {
    const entries = [
      entry('claude-b.json', 'claude', { priority: 1 }),
      entry('claude-a.json', 'claude', { priority: 5 }),
      entry('codex-z.json', 'codex'),
      entry('codex-y.json', 'codex'),
      entry('kimi-a.json', 'kimi', { priority: 9 }),
    ];
    const sorted = sortQuotaEntries(entries, 'priority', () => null);
    expect(sorted.map((e) => e.file.name)).toEqual([
      'claude-a.json',
      'claude-b.json',
      'codex-y.json',
      'codex-z.json',
      'kimi-a.json',
    ]);
  });
});

describe('observed (live) usage', () => {
  const claudeSignals = (
    fiveHour: string,
    weekly: string,
    observedAgoMs = 60_000,
    status5h = 'allowed'
  ) => ({
    signals: {
      'Anthropic-Ratelimit-Unified-5h-Utilization': fiveHour,
      'Anthropic-Ratelimit-Unified-5h-Reset': String((NOW + 2 * HOUR) / 1000),
      'Anthropic-Ratelimit-Unified-5h-Status': status5h,
      'Anthropic-Ratelimit-Unified-7d-Utilization': weekly,
      'Anthropic-Ratelimit-Unified-7d-Reset': String((NOW + 40 * HOUR) / 1000),
    },
    observed_at: new Date(NOW - observedAgoMs).toISOString(),
  });

  test('parses Claude fractions and Codex windows from recorded headers', () => {
    const claudeUsage = readObservedUsage(
      'claude',
      { name: 'c', quota: claudeSignals('0.35', '0.5') } as unknown as AuthFileItem,
      NOW
    );
    expect(claudeUsage?.fiveHour?.usedPercent).toBeCloseTo(35);
    expect(claudeUsage?.weekly?.usedPercent).toBeCloseTo(50);
    expect(claudeUsage?.weekly?.resetAtMs).toBe(NOW + 40 * HOUR);

    const codexUsage = readObservedUsage(
      'codex',
      {
        name: 'x',
        quota: {
          signals: {
            'X-Codex-Primary-Used-Percent': '92',
            'X-Codex-Primary-Window-Minutes': '10080',
            'X-Codex-Primary-Reset-After-Seconds': '3600',
          },
          observed_at: new Date(NOW).toISOString(),
        },
      } as unknown as AuthFileItem,
      NOW
    );
    expect(codexUsage?.fiveHour).toBeNull();
    expect(codexUsage?.weekly).toEqual({ usedPercent: 92, resetAtMs: NOW + HOUR });
    expect(readObservedUsage('claude', { name: 'n' } as AuthFileItem, NOW)).toBeNull();
  });

  test('fresh live usage wins over the endpoint and fills in when the endpoint failed', () => {
    const live = entry('a.json', 'claude', { priority: 100, quota: claudeSignals('0.10', '0.20') });
    const failed: ClaudeQuotaState = { status: 'error', windows: [], errorStatus: 429 };
    const summary = buildRoutingSummary('claude', [live], () => failed, NOW);
    expect(summary.rows[0].source).toBe('live');
    expect(summary.rows[0].weekly?.usedPercent).toBeCloseTo(20);
    expect(summary.loadedCount).toBe(1);

    const stale = entry('b.json', 'claude', { quota: claudeSignals('0.10', '0.20', 2 * HOUR) });
    const fetched = buildRoutingSummary('claude', [stale], () => claude(40, 60), NOW);
    expect(fetched.rows[0].source).toBe('api');
    expect(fetched.rows[0].weekly?.usedPercent).toBe(60);
  });

  test('a rejected 5-hour window caps the credential', () => {
    const entries = [
      entry('a.json', 'claude', {
        priority: 100,
        quota: claudeSignals('0.5', '0.2', 1000, 'rejected'),
      }),
      entry('b.json', 'claude', { priority: 99, quota: claudeSignals('0.1', '0.2') }),
    ];
    const summary = buildRoutingSummary('claude', entries, () => undefined, NOW);
    expect(summary.rows.map((r) => r.status)).toEqual(['capped', 'serving']);
  });
});
