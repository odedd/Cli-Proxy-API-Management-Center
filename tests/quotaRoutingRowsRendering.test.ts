import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import type { QuotaFileEntry } from '@/features/quota/logic';
import { buildRoutingSummary } from '@/features/quota/routing/model';
import { RoutingRows, type RoutingRowsItem } from '@/features/quota/routing/RoutingRows';
import type { AuthFileItem, ClaudeQuotaState } from '@/types';

const now = Date.now();
const HOUR = 3_600_000;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

const entry = (name: string, email: string, priority: number): QuotaFileEntry => ({
  type: 'claude',
  file: { name, provider: 'claude', email, priority } as AuthFileItem,
});

const quota = (fiveHour: number | null, weekly: number): ClaudeQuotaState => ({
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
            resetAtMs: now + 2 * HOUR,
          },
        ]),
    {
      id: 'seven-day',
      label: '7d',
      usedPercent: weekly,
      resetLabel: '',
      resetAtMs: now + 30 * HOUR,
    },
  ],
});

describe('RoutingRows', () => {
  test('renders ranked rows with pills, priorities and used-percent meters', () => {
    const entries = [
      entry('a.json', 'top@example.com', 100),
      entry('b.json', 'res@example.com', 99),
    ];
    const states: Record<string, ClaudeQuotaState> = {
      'a.json': quota(33, 50),
      'b.json': quota(null, 98),
    };
    const summary = buildRoutingSummary('claude', entries, (e) => states[e.file.name], now);
    const items: RoutingRowsItem[] = summary.rows.map((row) => ({
      row,
      quotaStatus: 'success',
      canRefresh: true,
      onRefresh: () => undefined,
      details: null,
    }));

    const html = renderToStaticMarkup(
      createElement(RoutingRows, { type: 'claude', items, resolvedTheme: 'dark', now })
    );

    expect(html.indexOf('top@example.com')).toBeLessThan(html.indexOf('res@example.com'));
    expect(html).toContain('Serving');
    expect(html).toContain('Reserve');
    expect(html).toContain('p100');
    expect(html).toContain('33% used');
    expect(html).toContain('98% used');
    expect(html).toContain('No window running');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Refresh quota for top@example.com"');
  });

  test('shows the load error instead of meters', () => {
    const summary = buildRoutingSummary(
      'claude',
      [entry('a.json', 'x@example.com', 0)],
      () => undefined,
      now
    );
    const html = renderToStaticMarkup(
      createElement(RoutingRows, {
        type: 'claude',
        resolvedTheme: 'light',
        now,
        items: [
          {
            row: summary.rows[0],
            quotaStatus: 'error',
            error: 'boom',
            canRefresh: true,
            onRefresh: () => undefined,
            details: null,
          },
        ],
      })
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('boom');
    expect(html).not.toContain('% used');
  });
});
