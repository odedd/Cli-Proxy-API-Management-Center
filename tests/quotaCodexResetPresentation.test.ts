import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { RoutingRows } from '@/features/quota/routing/RoutingRows';
import { getCodexRoutingResetPresentation } from '@/features/quota/routing/codexResetPresentation';
import { isCodexResetCreditSnapshotFresh } from '@/features/quota/providers/codex/resetCreditRequests';
import type { CodexResetCreditSnapshot } from '@/stores/useQuotaStore';
import { buildRoutingSummary } from '@/features/quota/routing/model';
import type { AuthFileItem } from '@/types';

const now = 1_800_000_000_000;
const file: AuthFileItem = { name: 'codex.json', provider: 'codex', email: 'test@example.com' };
const data = { availableCount: 2, applicableAvailableCount: 2, credits: [], error: '' };
const row = buildRoutingSummary('codex', [{ type: 'codex', file }], () => undefined, now).rows[0];

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Codex routing page reset authorization', () => {
  test.each([
    {
      label: 'fresh positive count',
      updatedAt: now,
      revision: 5,
      allowed: true,
      wantDisabled: false,
    },
    {
      label: 'old snapshot',
      updatedAt: now - 3_600_000,
      revision: 5,
      allowed: true,
      wantDisabled: true,
    },
    { label: 'future clock', updatedAt: now + 1, revision: 5, allowed: true, wantDisabled: true },
    {
      label: 'read error',
      updatedAt: now,
      revision: 5,
      error: true,
      allowed: true,
      wantDisabled: true,
    },
    {
      label: 'payload error',
      updatedAt: now,
      revision: 5,
      dataError: 'failed',
      allowed: true,
      wantDisabled: true,
    },
    { label: 'old connection', updatedAt: now, revision: 4, allowed: true, wantDisabled: true },
    { label: 'list unavailable', updatedAt: now, revision: 5, allowed: false, wantDisabled: true },
    {
      label: 'reset busy',
      updatedAt: now,
      revision: 5,
      busy: true,
      allowed: true,
      wantDisabled: true,
    },
    {
      label: 'disabled file',
      updatedAt: now,
      revision: 5,
      disabled: true,
      allowed: true,
      wantDisabled: true,
    },
    {
      label: 'unknown count',
      updatedAt: now,
      revision: 5,
      count: null,
      allowed: true,
      wantDisabled: true,
    },
    {
      label: 'zero count',
      updatedAt: now,
      revision: 5,
      count: 0,
      allowed: true,
      wantDisabled: true,
    },
  ])('$label', (fixture) => {
    const currentFile = { ...file, disabled: fixture.disabled };
    const snapshot: CodexResetCreditSnapshot = {
      connectionRevision: fixture.revision,
      updatedAt: fixture.updatedAt,
      error: fixture.error,
      data: {
        ...data,
        availableCount: 'count' in fixture ? fixture.count : 2,
        error: fixture.dataError ?? '',
      },
    };
    const codexReset = getCodexRoutingResetPresentation(currentFile, snapshot, {
      now,
      fresh: isCodexResetCreditSnapshotFresh(snapshot, now),
      connectionRevision: 5,
      canUseActions: fixture.allowed,
      busy: fixture.busy ?? false,
      onReset: () => undefined,
    });
    const html = renderToStaticMarkup(
      createElement(RoutingRows, {
        type: 'codex',
        resolvedTheme: 'light',
        now,
        showEmails: false,
        items: [
          {
            row: { ...row, entry: { type: 'codex', file: currentFile } },
            quotaStatus: 'idle',
            codexReset,
          },
        ],
      })
    );
    expect(html).toContain('<button');
    expect(html.includes('disabled=""')).toBe(fixture.wantDisabled);
    const count =
      fixture.revision !== 5 || ('count' in fixture && fixture.count === null)
        ? '—'
        : 'count' in fixture
          ? fixture.count
          : 2;
    expect(html).toContain(`${count} resets banked`);
    if (
      fixture.label === 'old snapshot' ||
      fixture.label === 'future clock' ||
      fixture.error ||
      fixture.dataError
    ) {
      expect(html).toContain('Stale');
    }
  });
});
