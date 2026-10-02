/**
 * Ranked rows for one routed provider: rank, account, routing pill, then the two
 * windows routing decides on (5-hour, weekly) as used-percent meters with the
 * 95% thresholds marked.
 */

import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { buildResetDisplay, resolveQuotaErrorMessage } from '@/utils/quota';
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
import styles from './RoutingRows.module.scss';

export type RoutingRowsItem = {
  row: RoutingRow;
  quotaStatus: 'idle' | 'loading' | 'success' | 'error';
  error?: string;
  errorStatus?: number;
};

export type RoutingRowsProps = {
  type: RoutedProvider;
  items: RoutingRowsItem[];
  resolvedTheme: ResolvedTheme;
  now: number;
  showEmails: boolean;
};

const usedClass = (used: number, threshold: number): string =>
  used >= threshold ? styles.fillLow : used >= 70 ? styles.fillMedium : styles.fillHigh;

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
    const used = window ? Math.round(window.usedPercent) : null;
    return (
      <div key={key} className={styles.meter}>
        <div className={styles.meterHead}>
          <span className={styles.meterLabel}>{label}</span>
          <span className={styles.meterValue}>
            {used === null ? '—' : t('quota_routing.used_percent', { used })}
          </span>
        </div>
        <div
          className={styles.track}
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={used ?? 0}
        >
          {used !== null && (
            <span
              className={`${styles.fill} ${usedClass(used, threshold)}`}
              style={{ width: `${used}%` }}
            />
          )}
          {window && (
            <span
              className={styles.tick}
              style={{ left: `${threshold}%` }}
              title={t('quota_routing.threshold_hint', { threshold })}
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
                    <span className={styles.accountName} title={getQuotaDisplayName(file)}>
                      {email ?? getQuotaDisplayName(file)}
                    </span>
                    <span className={styles.accountMeta}>
                      {row.status !== 'unknown' && (
                        <span className={`${styles.pill} ${styles[`pill_${row.status}`]}`}>
                          {t(`quota_routing.status_${row.status}`)}
                        </span>
                      )}
                      <span className={styles.priority} title={t('quota_routing.priority_hint')}>
                        p{row.priority}
                      </span>
                    </span>
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
