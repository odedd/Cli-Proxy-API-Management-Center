/**
 * Ranked rows for one routed provider: rank, account, then the two windows
 * routing decides on (weekly, 5-hour) as remaining-percent meters with the
 * equivalent remaining routing thresholds marked.
 */

import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { Button } from '@/components/ui/Button';
import { resolveTimeZoneLabel } from '@/utils/time/timezone';
import type { ClaudeResetGrantSnapshot } from '@/stores/useQuotaStore';
import type { CodexResetPresentation } from './codexResetPresentation';
import { bankedClaudeResets } from '../providers/claude/selectResetGrant';
import { CLAUDE_RESET_GRANT_TTL_MS } from '../providers/claude/resetGrantRequests';
import { buildResetDisplay, parseIsoToMs, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import {
  FIVE_HOUR_CAP_PERCENT,
  WEEKLY_RESERVE_PERCENT,
  maskEmail,
  type RoutingRow,
  type RoutingWindow,
  type RoutedProvider,
} from './model';
import { remainingMeterFill } from './remainingMeter';
import styles from './RoutingRows.module.scss';

export type RoutingRowsItem = {
  row: RoutingRow;
  quotaStatus: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
  errorStatus?: number;
  resetGrants?: ClaudeResetGrantSnapshot;
  codexReset?: CodexResetPresentation;
};

export type RoutingRowsProps = {
  type: RoutedProvider;
  items: RoutingRowsItem[];
  resolvedTheme: ResolvedTheme;
  now: number;
  showEmails: boolean;
};

export function RoutingRows({ type, items, resolvedTheme, now, showEmails }: RoutingRowsProps) {
  const { t, i18n } = useTranslation();
  if (items.length === 0) return null;

  const resetText = (atMs: number | null) => {
    const display = buildResetDisplay(null, atMs, now, i18n.resolvedLanguage);
    if (!display) return null;
    return display.relative ? `${display.relative} · ${display.absolute}` : display.absolute;
  };

  const meter = (
    key: string,
    label: string,
    window: RoutingWindow | null,
    threshold: number,
    emptyNote: string
  ) => {
    const remaining =
      window && Number.isFinite(window.usedPercent)
        ? Math.max(0, Math.min(100, 100 - window.usedPercent))
        : null;
    const valueText =
      remaining === null
        ? '—'
        : t('quota_routing.remaining_percent', { remaining: Math.round(remaining) });
    return (
      <div key={key} className={styles.meter}>
        <div className={styles.meterHead}>
          <span className={styles.meterLabel}>{label}</span>
          <span className={styles.meterValue}>{valueText}</span>
        </div>
        <div
          className={styles.track}
          role={remaining === null ? undefined : 'meter'}
          aria-label={remaining === null ? undefined : label}
          aria-valuemin={remaining === null ? undefined : 0}
          aria-valuemax={remaining === null ? undefined : 100}
          aria-valuenow={remaining === null ? undefined : Math.round(remaining)}
          aria-valuetext={remaining === null ? undefined : valueText}
        >
          {remaining !== null && (
            <span
              className={`${styles.fill} ${styles[remainingMeterFill(remaining, threshold)]}`}
              style={{ width: `${remaining}%` }}
            />
          )}
          {remaining !== null && (
            <span
              className={styles.tick}
              style={{ left: `${100 - threshold}%` }}
              title={t('quota_routing.remaining_threshold_hint', {
                remaining: 100 - threshold,
                threshold,
              })}
            />
          )}
        </div>
        <div className={styles.meterNote}>
          {window ? (resetText(window.resetAtMs) ?? emptyNote) : emptyNote}
        </div>
      </div>
    );
  };

  const iconSrc = getAuthFileIcon(type, resolvedTheme);

  return (
    <section className={styles.section} aria-label={getTypeLabel(t, type)}>
      <header className={styles.sectionHead}>
        {iconSrc && <img src={iconSrc} alt="" className={styles.sectionIcon} />}
        <h2 className={styles.sectionTitle}>{getTypeLabel(t, type)}</h2>
        <span className={styles.sectionHint}>{t('quota_routing.ranked_by_priority')}</span>
      </header>
      <ol className={styles.list}>
        {items.map((item, index) => {
          const { row } = item;
          const file = row.entry.file;
          const name = file.name;
          const rawEmail = typeof file.email === 'string' && file.email.trim() ? file.email : null;
          const email = rawEmail && !showEmails ? maskEmail(rawEmail) : rawEmail;
          const displayName =
            email ??
            (showEmails ? getQuotaDisplayName(file) : maskEmail(getQuotaDisplayName(file)));
          const codexReset = type === 'codex' ? item.codexReset : undefined;
          const codexBusy = Boolean(codexReset?.busy || codexReset?.loading);
          const codexCanReset = Boolean(
            codexReset?.canReset &&
            codexReset.availableCount !== null &&
            codexReset.availableCount > 0 &&
            !codexReset.stale &&
            !codexBusy &&
            !file.disabled
          );
          const balance = bankedClaudeResets(item.resetGrants?.data, now);
          const updatedAt = item.resetGrants?.updatedAt;
          const stale =
            balance !== null &&
            (Boolean(item.resetGrants?.error) ||
              updatedAt === undefined ||
              now - updatedAt >= CLAUDE_RESET_GRANT_TTL_MS);
          const updated =
            updatedAt === undefined
              ? ''
              : t('claude_reset.banked_updated', {
                  updated: new Date(updatedAt).toLocaleString(i18n.resolvedLanguage),
                });
          return (
            <li
              key={name}
              className={`${styles.item} ${row.status === 'serving' ? styles.itemServing : ''}`}
            >
              <div className={styles.row}>
                <div className={styles.account}>
                  <span className={styles.rank} aria-hidden="true">
                    {index + 1}
                  </span>
                  <div className={styles.accountText}>
                    <span className={styles.accountName} title={displayName}>
                      {displayName}
                    </span>
                    {codexReset && (
                      <>
                        <div className={styles.resetActions}>
                          <span
                            className={styles.bankedResets}
                            title={[
                              t(
                                codexReset.availableCount === null
                                  ? 'codex_quota.banked_unknown'
                                  : 'codex_quota.banked_hint'
                              ),
                              codexReset.stale ? t('codex_quota.banked_stale') : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          >
                            {t('codex_quota.banked_count', {
                              count: codexReset.availableCount ?? '—',
                            })}
                            {codexReset.stale && ` · ${t('codex_quota.banked_stale')}`}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className={styles.resetButton}
                            disabled={!codexCanReset}
                            loading={codexBusy}
                            aria-busy={codexBusy}
                            aria-label={t('codex_quota.reset_account_label', {
                              name: displayName,
                              index: index + 1,
                            })}
                            onClick={() => {
                              if (codexCanReset) codexReset.onReset();
                            }}
                          >
                            {t('codex_quota.reset_button')}
                          </Button>
                        </div>
                        {codexReset.credits.length > 0 && (
                          <details className={styles.resetDetails}>
                            <summary>
                              {t('codex_quota.reset_credits_expiry_label', {
                                timezone: resolveTimeZoneLabel(),
                              })}
                            </summary>
                            <ul>
                              {codexReset.credits.map((credit, creditIndex) => {
                                const expiry = buildResetDisplay(
                                  credit.expiresAt,
                                  parseIsoToMs(credit.expiresAt),
                                  now,
                                  i18n.resolvedLanguage
                                );
                                return (
                                  <li key={credit.id || creditIndex}>
                                    {t('codex_quota.reset_credit_number', {
                                      index: creditIndex + 1,
                                    })}
                                    {' · '}
                                    {expiry
                                      ? [expiry.relative, expiry.absolute]
                                          .filter(Boolean)
                                          .join(' · ')
                                      : '—'}
                                  </li>
                                );
                              })}
                            </ul>
                          </details>
                        )}
                      </>
                    )}
                    {type === 'claude' && (
                      <span
                        className={styles.bankedResets}
                        title={[
                          t(
                            balance === null
                              ? 'claude_reset.banked_unknown'
                              : 'claude_reset.banked_hint'
                          ),
                          stale ? t('claude_reset.banked_stale') : '',
                          updated,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      >
                        {t('claude_reset.banked_count', { count: balance ?? '—' })}
                        {stale && ` · ${t('claude_reset.banked_stale')}`}
                      </span>
                    )}
                  </div>
                </div>

                {row.loaded ? (
                  <>
                    {meter(
                      'weekly',
                      t('quota_routing.weekly'),
                      row.weekly,
                      WEEKLY_RESERVE_PERCENT,
                      t('quota_routing.no_weekly_reset')
                    )}
                    {meter(
                      'five',
                      t('quota_routing.five_hour'),
                      row.fiveHour,
                      FIVE_HOUR_CAP_PERCENT,
                      type === 'codex'
                        ? t('quota_routing.five_hour_none')
                        : t('quota_routing.five_hour_idle')
                    )}
                  </>
                ) : (
                  <div
                    className={`${styles.state} ${item.quotaStatus === 'error' ? styles.stateError : ''}`}
                    role={item.quotaStatus === 'error' ? 'alert' : undefined}
                  >
                    {item.quotaStatus === 'loading'
                      ? t('quota_routing.loading')
                      : item.quotaStatus === 'error' && item.errorStatus === 429
                        ? t('quota_routing.rate_limited')
                        : item.quotaStatus === 'error'
                          ? resolveQuotaErrorMessage(
                              t,
                              item.errorStatus,
                              item.error || t('common.unknown_error')
                            )
                          : t('quota_routing.not_loaded')}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
