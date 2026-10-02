/**
 * Routing strip + per-provider headroom cards for the routed providers (Claude, Codex).
 *
 * The strip names the backend strategy and the credential each provider is serving
 * from; each card sums weekly remaining across loaded credentials, one segment per
 * credential in routing order, plus the nearest weekly reset.
 */

import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { buildResetDisplay } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { getAuthFileIcon, getTypeLabel } from '@/features/authFiles/constants';
import {
  FIVE_HOUR_CAP_PERCENT,
  WEEKLY_RESERVE_PERCENT,
  maskEmail,
  type RoutingProviderSummary,
  type RoutingRow,
} from './model';
import styles from './RoutingSummary.module.scss';

export type RoutingSummaryProps = {
  summaries: RoutingProviderSummary[];
  strategy: string | null;
  resolvedTheme: ResolvedTheme;
  now: number;
  showEmails: boolean;
};

/** The strip and notes name accounts; the email reads better than the auth filename. */
const accountLabel = (row: RoutingRow, showEmails: boolean): string => {
  const email = typeof row.entry.file.email === 'string' ? row.entry.file.email.trim() : '';
  if (!email) return getQuotaDisplayName(row.entry.file);
  return showEmails ? email : maskEmail(email);
};

const remainingClass = (remaining: number): string =>
  remaining >= 30
    ? styles.fillHigh
    : remaining > 100 - WEEKLY_RESERVE_PERCENT
      ? styles.fillMedium
      : styles.fillLow;

export function RoutingSummary({
  summaries,
  strategy,
  resolvedTheme,
  now,
  showEmails,
}: RoutingSummaryProps) {
  const { t, i18n } = useTranslation();
  if (summaries.length === 0) return null;

  const resetText = (atMs: number | null | undefined) => {
    const display = buildResetDisplay(null, atMs, now, i18n.resolvedLanguage);
    if (!display) return null;
    return display.relative ? `${display.relative} · ${display.absolute}` : display.absolute;
  };

  const servingLabel = (row: RoutingRow | null) =>
    row ? accountLabel(row, showEmails) : t('quota_routing.none_available');

  return (
    <section className={styles.routing} aria-label={t('quota_routing.title')}>
      <div className={styles.strip}>
        <span className={styles.stripTitle}>{t('quota_routing.title')}</span>
        <span className={styles.stripItem}>
          <span className={styles.stripLabel}>{t('quota_routing.strategy')}</span>
          <span className={styles.stripValue}>{strategy || 'round-robin'}</span>
        </span>
        {summaries.map((summary) => (
          <span key={summary.type} className={styles.stripItem}>
            <span className={styles.stripLabel}>
              {t('quota_routing.serving', { provider: getTypeLabel(t, summary.type) })}
            </span>
            <span className={`${styles.stripValue} ${styles.stripServing}`}>
              {servingLabel(summary.serving)}
            </span>
          </span>
        ))}
        <span className={styles.stripRules}>
          {t('quota_routing.rules', {
            cap: FIVE_HOUR_CAP_PERCENT,
            reserve: WEEKLY_RESERVE_PERCENT,
          })}
        </span>
      </div>

      <div className={styles.cards}>
        {summaries.map((summary) => {
          const iconSrc = getAuthFileIcon(summary.type, resolvedTheme);
          const servingFiveHour = summary.serving?.fiveHour ?? null;
          const nextReset = summary.nextWeeklyReset;
          return (
            <article key={summary.type} className={styles.card}>
              <header className={styles.cardHead}>
                <span className={styles.cardName}>
                  {iconSrc && <img src={iconSrc} alt="" className={styles.cardIcon} />}
                  {getTypeLabel(t, summary.type)}
                </span>
                <span className={styles.cardCount}>
                  {t('quota_routing.credentials', { count: summary.rows.length })}
                </span>
              </header>

              <div className={styles.metricRow}>
                <span className={styles.metricLabel}>{t('quota_routing.weekly_remaining')}</span>
                {summary.loadedCount > 0 ? (
                  <span className={styles.metric}>
                    <span className={styles.metricValue}>{summary.weeklyRemaining}%</span>
                    <span className={styles.metricOf}>
                      {t('quota_routing.of_capacity', { capacity: summary.weeklyCapacity })}
                    </span>
                  </span>
                ) : (
                  <span className={styles.metricOf}>{t('quota_routing.not_loaded')}</span>
                )}
              </div>

              <div className={styles.segments}>
                {summary.rows.map((row) => {
                  const remaining = row.loaded ? 100 - (row.weekly?.usedPercent ?? 0) : null;
                  const name = accountLabel(row, showEmails);
                  return (
                    <span
                      key={row.entry.file.name}
                      className={`${styles.segment} ${row.status === 'serving' ? styles.segmentServing : ''}`}
                      title={
                        remaining === null
                          ? name
                          : t('quota_routing.segment_title', {
                              name,
                              remaining: Math.round(remaining),
                            })
                      }
                    >
                      {remaining !== null && (
                        <span
                          className={`${styles.segmentFill} ${remainingClass(remaining)}`}
                          style={{ width: `${remaining}%` }}
                        />
                      )}
                    </span>
                  );
                })}
              </div>

              <div className={styles.cardNote}>
                {nextReset
                  ? t('quota_routing.next_weekly_reset', { when: resetText(nextReset.atMs) })
                  : t('quota_routing.no_weekly_reset')}
              </div>

              <footer className={styles.cardFoot}>
                <span className={styles.metricLabel}>{t('quota_routing.five_hour_serving')}</span>
                <span className={styles.footValue}>
                  {servingFiveHour
                    ? t('quota_routing.five_hour_left', {
                        remaining: Math.round(100 - servingFiveHour.usedPercent),
                      })
                    : summary.type === 'codex'
                      ? t('quota_routing.five_hour_none')
                      : t('quota_routing.five_hour_idle')}
                </span>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
