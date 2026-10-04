import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import type { QuotaFileEntry } from '@/features/quota/logic';
import { buildRoutingSummary } from '@/features/quota/routing/model';
import { RoutingRows, type RoutingRowsItem } from '@/features/quota/routing/RoutingRows';
import type { AuthFileItem, ClaudeQuotaState } from '@/types';
import { parseAnthropicResetGrantStatus } from '@/services/api/claudeResetGrants';

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
  for (const type of ['claude', 'codex'] as const) {
    const renderWindows = (used: number | null, resetAtMs = now + HOUR) => {
      const account: QuotaFileEntry = {
        type,
        file: { name: `${type}.json`, provider: type },
      };
      const state = {
        status: 'success',
        windows: ['five-hour', type === 'claude' ? 'seven-day' : 'weekly'].map((id) => ({
          id,
          usedPercent: used,
          resetAtMs,
        })),
      };
      const summary = buildRoutingSummary(type, [account], () => state, now);
      return renderToStaticMarkup(
        createElement(RoutingRows, {
          type,
          items: [{ row: summary.rows[0], quotaStatus: 'success' }],
          resolvedTheme: 'light',
          now,
          showEmails: false,
        })
      );
    };

    test.each([
      { used: 0, remaining: 100 },
      { used: 35, remaining: 65 },
      { used: 70, remaining: 30 },
      { used: 70.2, remaining: 29.8 },
      { used: 94.8, remaining: 5.2 },
      { used: 95, remaining: 5 },
      { used: 100, remaining: 0 },
    ])(`${type} meters show remaining quota for %j`, ({ used, remaining }) => {
      const html = renderWindows(used);
      const percent = Math.round(remaining);
      expect(html.match(/role="meter"/g)).toHaveLength(2);
      expect(html.match(new RegExp(`aria-valuenow="${percent}"`, 'g'))).toHaveLength(2);
      expect(html.match(new RegExp(`aria-valuetext="${percent}% remaining"`, 'g'))).toHaveLength(2);
      expect(html).toContain(`width:${100 - used}%`);
      expect(html.match(/left:5%/g)).toHaveLength(2);
      expect(html).toContain('5% remaining (95% used)');
    });

    test.each([null, now - 1])(
      `${type} unknown or expired windows are not full remaining meters %j`,
      (missing) => {
        const html = missing === null ? renderWindows(null) : renderWindows(0, missing);
        expect(html).toContain('—');
        expect(html).not.toContain('role="meter"');
        expect(html).not.toContain('aria-valuenow');
        expect(html).not.toContain('width:100%');
        expect(html).not.toContain('left:5%');
      }
    );
  }

  test('renders ordered accounts and weekly-first meters without status or priority labels', () => {
    const entries = [
      entry('d.json', 'cap@example.com', 97),
      entry('c.json', 'res@example.com', 98),
      entry('b.json', 'next@example.com', 99),
      entry('a.json', 'top@example.com', 100),
    ];
    const states: Record<string, ClaudeQuotaState> = {
      'a.json': quota(33, 50),
      'b.json': quota(45, 60),
      'c.json': quota(null, 98),
      'd.json': quota(97, 20),
    };
    const summary = buildRoutingSummary('claude', entries, (e) => states[e.file.name], now);
    const items: RoutingRowsItem[] = summary.rows.map((row) => ({
      row,
      quotaStatus: 'success',
    }));

    const html = renderToStaticMarkup(
      createElement(RoutingRows, {
        type: 'claude',
        items,
        resolvedTheme: 'dark',
        now,
        showEmails: true,
      })
    );

    const emails = ['top@example.com', 'next@example.com', 'res@example.com', 'cap@example.com'];
    emails.forEach((email, index) => {
      expect(html).toContain(email);
      if (index > 0) expect(html.indexOf(emails[index - 1])).toBeLessThan(html.indexOf(email));
    });
    for (const label of ['Serving', 'Next', 'Reserve', 'Capped', 'p100', 'p99', 'p98', 'p97']) {
      expect(html).not.toContain(label);
    }
    const weekly = i18n.t('quota_routing.weekly');
    const fiveHour = i18n.t('quota_routing.five_hour');
    expect(html).toContain(weekly);
    expect(html).toContain(fiveHour);
    expect(html.indexOf(weekly)).toBeLessThan(html.indexOf(fiveHour));
    expect(html).toContain('67% remaining');
    expect(html).toContain('2% remaining');
    expect(html).toContain('No window running');
    expect(html).not.toContain('Refresh quota');
  });

  test('Claude balances are plain text, distinguish unknown/zero, and mark known stale reads', () => {
    const entries = [
      entry('a.json', 'bank@example.com', 100),
      entry('b.json', 'zero@example.com', 99),
      entry('c.json', 'unknown@example.com', 98),
    ];
    const summary = buildRoutingSummary('claude', entries, () => quota(20, 30), now);
    const status = parseAnthropicResetGrantStatus({
      eligible: true,
      grants: [
        {
          id: 'bank',
          resets_total: 2,
          resets_left: 2,
          paused: true,
          clears: ['five_hour', 'seven_day'],
        },
        { id: 'expired', resets_total: 2, resets_left: 2, ends_at: new Date(now).toISOString() },
        {
          id: 'future',
          resets_total: 2,
          resets_left: 2,
          starts_at: new Date(now + HOUR).toISOString(),
        },
      ],
    })!;
    const items: RoutingRowsItem[] = summary.rows.map((row, index) => ({
      row,
      quotaStatus: 'success',
      resetGrants:
        index < 2
          ? {
              connectionRevision: 1,
              updatedAt: now - HOUR,
              data: index === 0 ? status : { ...status, grants: [] },
              error: 'upstream',
            }
          : undefined,
    }));
    const html = renderToStaticMarkup(
      createElement(RoutingRows, {
        type: 'claude',
        items,
        resolvedTheme: 'dark',
        now,
        showEmails: true,
      })
    );
    expect(html).toContain('2 resets banked');
    expect(html).toContain('0 resets banked');
    expect(html).toContain('— resets banked');
    expect(html).toContain('Stale');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('pill');
    expect(html.indexOf('bank@example.com')).toBeLessThan(html.indexOf('2 resets banked'));
    expect(html.indexOf('2 resets banked')).toBeLessThan(html.indexOf('Weekly'));
    const codex = renderToStaticMarkup(
      createElement(RoutingRows, {
        type: 'codex',
        items,
        resolvedTheme: 'dark',
        now,
        showEmails: true,
      })
    );
    expect(codex).not.toContain('resets banked');
  });

  test('Codex shows server reset count with expiry details independently of passive usage', () => {
    const codexEntry: QuotaFileEntry = {
      type: 'codex',
      file: { name: 'private@example.com.json', provider: 'codex', email: 'private@example.com' },
    };
    const summary = buildRoutingSummary('codex', [codexEntry], () => undefined, now);
    const html = renderToStaticMarkup(
      createElement(RoutingRows, {
        type: 'codex',
        resolvedTheme: 'dark',
        now,
        showEmails: false,
        items: [
          {
            row: summary.rows[0],
            quotaStatus: 'idle',
            codexReset: {
              availableCount: 3,
              credits: [
                {
                  id: 'one',
                  status: 'available',
                  grantedAt: '',
                  expiresAt: new Date(now + HOUR).toISOString(),
                },
              ],
              canReset: true,
              onReset: () => undefined,
            },
          },
        ],
      })
    );
    expect(html).toContain('3 resets banked');
    expect(html).not.toContain('1 resets banked');
    expect(html).toContain('Manual reset expiry');
    expect(html).toContain('Reset 1');
    expect(html).toContain('<button');
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('aria-label="Reset quota: p•••@example.com (1)"');
    expect(html).not.toContain('private@example.com');
    expect(html).not.toContain('Refresh quota');
    expect(html).not.toContain('pill');
  });

  test.each([
    { count: null, canReset: true, want: '— resets banked' },
    { count: 0, canReset: true, want: '0 resets banked' },
    { count: 2, canReset: false, want: '2 resets banked' },
    { count: 2, canReset: true, stale: true, want: '2 resets banked' },
    { count: 2, canReset: true, loading: true, want: '2 resets banked' },
    { count: 2, canReset: true, busy: true, want: '2 resets banked' },
    { count: 2, canReset: true, disabled: true, want: '2 resets banked' },
  ])('Codex reset cannot be used for an unavailable count or action state %j', (fixture) => {
    const codexEntry: QuotaFileEntry = {
      type: 'codex',
      file: { name: 'codex.json', provider: 'codex', email: 'safe@example.com' },
    };
    const summary = buildRoutingSummary('codex', [codexEntry], () => quota(20, 30), now);
    codexEntry.file.disabled = fixture.disabled;
    const html = renderToStaticMarkup(
      createElement(RoutingRows, {
        type: 'codex',
        resolvedTheme: 'light',
        now,
        showEmails: false,
        items: [
          {
            row: summary.rows[0],
            quotaStatus: 'success',
            codexReset: {
              availableCount: fixture.count,
              credits: [
                {
                  id: 'one',
                  status: 'available',
                  grantedAt: '',
                  expiresAt: new Date(now + HOUR).toISOString(),
                },
              ],
              canReset: fixture.canReset,
              stale: fixture.stale,
              loading: fixture.loading,
              busy: fixture.busy,
              onReset: () => undefined,
            },
          },
        ],
      })
    );
    expect(html).toContain(fixture.want);
    expect(html).toContain('disabled=""');
    expect(html.indexOf(fixture.want)).toBeLessThan(html.indexOf('Weekly'));
    if (fixture.stale) expect(html).toContain('Stale');
    if (fixture.loading || fixture.busy) expect(html).toContain('aria-busy="true"');
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
        showEmails: false,
        items: [
          {
            row: summary.rows[0],
            quotaStatus: 'error',
            error: 'boom',
          },
        ],
      })
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('boom');
    expect(html).not.toContain('role="meter"');
    expect(html).toContain('x•••@example.com');

    const limited = renderToStaticMarkup(
      createElement(RoutingRows, {
        type: 'claude',
        resolvedTheme: 'light',
        now,
        showEmails: false,
        items: [
          {
            row: summary.rows[0],
            quotaStatus: 'error',
            error: 'Rate limited',
            errorStatus: 429,
          },
        ],
      })
    );
    expect(limited).toContain('rate limited');
    expect(html).not.toContain('x@example.com');
  });
});
