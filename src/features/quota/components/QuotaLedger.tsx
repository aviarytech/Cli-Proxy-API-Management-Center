/**
 * Ledger view: a pooled summary per provider, then one aligned row per
 * credential with every quota window side by side.
 *
 * The card grid answers "what does this credential look like"; the ledger
 * answers "where is the capacity across all of them" — so each window gets the
 * same column treatment regardless of provider, and the pool strip on top adds
 * them up.
 */

import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { QUOTA_TAB_ORDER } from '../constants';
import {
  buildLedgerCredential,
  buildLedgerPool,
  type LedgerPool,
  type LedgerPoolLimit,
  type LedgerWindow,
} from '../ledgerModel';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { QUOTA_PROGRESS_HIGH_THRESHOLD, QUOTA_PROGRESS_MEDIUM_THRESHOLD } from './QuotaMeter';
import styles from './QuotaLedger.module.scss';

export interface QuotaLedgerProps {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  displayNameFor: (entry: QuotaFileEntry) => string;
  resolvedTheme: ResolvedTheme;
  canUseActions: boolean;
  resettingName: string | null;
  onRefresh: (entry: QuotaFileEntry) => void;
  onReset: (entry: QuotaFileEntry) => void;
  /** Injectable for tests/screenshots; defaults to the real clock. */
  now?: number;
}

type Level = 'high' | 'medium' | 'low' | 'unknown';

const levelOf = (percent: number | null): Level =>
  percent === null
    ? 'unknown'
    : percent >= QUOTA_PROGRESS_HIGH_THRESHOLD
      ? 'high'
      : percent >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
        ? 'medium'
        : 'low';

const formatPercent = (value: number | null) => (value === null ? '--' : `${Math.round(value)}%`);

export function QuotaLedger(props: QuotaLedgerProps) {
  const {
    entries,
    quotaFor,
    displayNameFor,
    resolvedTheme,
    canUseActions,
    resettingName,
    onRefresh,
    onReset,
    now: nowProp,
  } = props;
  const { t, i18n } = useTranslation();
  const tick = useNow(nowProp === undefined);
  const now = nowProp ?? tick;
  const locale = i18n.resolvedLanguage;

  const groups = useMemo(
    () =>
      QUOTA_TAB_ORDER.map((provider) => {
        const rows = entries
          .filter((entry) => entry.type === provider)
          .map((entry) => {
            const quota = quotaFor(entry);
            return {
              entry,
              name: getQuotaCacheKey(entry.file),
              quota,
              data: buildLedgerCredential(provider, quota, t),
            };
          });
        return { provider, rows };
      }).filter((group) => group.rows.length > 0),
    [entries, quotaFor, t]
  );

  const pools = useMemo(
    () =>
      groups.map((group) =>
        buildLedgerPool(group.provider, group.rows, now, t('quota_management.ledger_limit'))
      ),
    [groups, now, t]
  );

  const resetText = (atMs: number | null) =>
    atMs === null || atMs <= now
      ? t('quota_management.ledger_no_reset')
      : `${formatRelativeInstant(atMs, now, locale)} · ${formatInstantShort(atMs)}`;

  const renderIcon = (provider: QuotaProviderType) => {
    const iconSrc = getAuthFileIcon(provider, resolvedTheme);
    const label = getTypeLabel(t, provider);
    return (
      <span
        className={styles.icon}
        style={
          isThemeSurfaceIconProvider(provider)
            ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
            : undefined
        }
        aria-hidden="true"
      >
        {iconSrc ? <img src={iconSrc} alt="" /> : label.slice(0, 1).toUpperCase()}
      </span>
    );
  };

  return (
    <div className={styles.ledger}>
      <div className={styles.pools}>
        {pools.map((pool) => (
          <PoolCell
            key={pool.provider}
            pool={pool}
            icon={renderIcon(pool.provider)}
            resetText={resetText}
          />
        ))}
      </div>

      {groups.map((group) => (
        <section key={group.provider} className={styles.group}>
          <h2 className={styles.groupTitle}>
            {getTypeLabel(t, group.provider)}
            <span className={styles.groupCount}>{group.rows.length}</span>
          </h2>
          <ul className={styles.rows}>
            {group.rows.map(({ entry, name, quota, data }) => {
              const adapter = QUOTA_ADAPTERS[entry.type];
              const status = quota?.status ?? 'idle';
              const loading = status === 'loading';
              const resetting = resettingName === name;
              const canRefresh = canUseActions && !entry.file.disabled;
              const showReset =
                status === 'success' &&
                Boolean(adapter.resetQuota) &&
                quota !== undefined &&
                Boolean(adapter.canResetQuota?.(quota));
              const displayName = displayNameFor(entry);

              return (
                <li key={name} className={styles.row}>
                  <div className={styles.identity}>
                    <span className={styles.name} title={displayName}>
                      {displayName}
                    </span>
                    <span className={styles.plan}>
                      {data?.plan ?? (status === 'success' ? '' : getTypeLabel(t, entry.type))}
                    </span>
                  </div>

                  <div className={styles.windows} aria-busy={loading || undefined}>
                    {status === 'idle' ? (
                      <button
                        type="button"
                        className={styles.idle}
                        onClick={() => onRefresh(entry)}
                        disabled={!canRefresh}
                      >
                        {t(`${adapter.i18nPrefix}.idle`)}
                      </button>
                    ) : loading && !data ? (
                      [0, 1, 2].map((index) => (
                        <span key={index} className={styles.skeleton} aria-hidden="true" />
                      ))
                    ) : status === 'error' ? (
                      <span className={styles.error} role="alert">
                        {t(`${adapter.i18nPrefix}.load_failed`, {
                          message: resolveQuotaErrorMessage(
                            t,
                            quota?.errorStatus,
                            quota?.error || t('common.unknown_error')
                          ),
                        })}
                      </span>
                    ) : data && data.windows.length > 0 ? (
                      data.windows.map((window) => (
                        <WindowCell key={window.key} window={window} resetText={resetText} />
                      ))
                    ) : (
                      <span className={styles.muted}>{t('quota_management.ledger_no_windows')}</span>
                    )}
                  </div>

                  <div className={styles.actions}>
                    {showReset && (
                      <button
                        type="button"
                        className={styles.action}
                        onClick={() => onReset(entry)}
                        disabled={!canRefresh || loading || resetting}
                      >
                        <IconRefreshCw
                          size={13}
                          className={resetting ? styles.spinning : undefined}
                          aria-hidden="true"
                        />
                        {t('codex_quota.reset_button')}
                      </button>
                    )}
                    {status !== 'idle' && (
                      <button
                        type="button"
                        className={styles.action}
                        onClick={() => onRefresh(entry)}
                        disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting)}
                        title={t('auth_files.quota_refresh_hint')}
                      >
                        <IconRefreshCw
                          size={13}
                          className={loading ? styles.spinning : undefined}
                          aria-hidden="true"
                        />
                        {t('auth_files.quota_refresh_single')}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Bar({ percent }: { percent: number | null }) {
  const width = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <span className={styles.track}>
      <span
        className={styles.fill}
        data-level={levelOf(percent)}
        style={{ width: `${width}%` } as CSSProperties}
      />
    </span>
  );
}

function WindowCell({
  window,
  resetText,
}: {
  window: LedgerWindow;
  resetText: (atMs: number | null) => string;
}) {
  return (
    <div className={styles.cell}>
      <div className={styles.cellHead}>
        <span className={styles.cellLabel} title={window.label}>
          {window.label}
        </span>
        <span className={styles.cellPercent}>{formatPercent(window.remaining)}</span>
      </div>
      <Bar percent={window.remaining} />
      <span className={styles.cellReset}>{resetText(window.resetAtMs)}</span>
    </div>
  );
}

function PoolCell({
  pool,
  icon,
  resetText,
}: {
  pool: LedgerPool;
  icon: ReactNode;
  resetText: (atMs: number | null) => string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const { primary, secondary } = pool;
  const visibleSecondary: LedgerPoolLimit[] = expanded ? secondary : secondary.slice(0, 1);

  return (
    <article className={styles.pool}>
      <header className={styles.poolHead}>
        {icon}
        <span className={styles.poolName}>{getTypeLabel(t, pool.provider)}</span>
        <span className={styles.poolCount}>
          {t('quota_management.ledger_credentials', { count: pool.credentialCount })}
        </span>
      </header>
      <span className={styles.poolLabel}>{primary.label}</span>
      <div className={styles.poolFigure}>
        <span className={styles.poolValue}>{formatPercent(primary.remaining)}</span>
        <span className={styles.poolCapacity}>
          {t('quota_management.ledger_of_capacity', { capacity: primary.capacity })}
        </span>
      </div>
      <div className={styles.segments} aria-hidden="true">
        {primary.segments.map((segment) => (
          <span
            key={segment.name}
            className={styles.segment}
            data-level={levelOf(segment.remaining)}
          />
        ))}
      </div>
      <span className={styles.poolReset}>{resetText(primary.nextResetAtMs)}</span>

      {secondary.length > 0 && (
        <div className={styles.poolMore}>
          {visibleSecondary.map((limit) => (
            <div key={limit.key} className={styles.poolMoreRow}>
              <span className={styles.poolMoreLabel}>{limit.label}</span>
              <span className={styles.poolMoreValue}>{formatPercent(limit.remaining)}</span>
            </div>
          ))}
          {secondary.length > 1 && (
            <button
              type="button"
              className={styles.poolToggle}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? t('quota_management.ledger_hide') : t('quota_management.ledger_show')}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
