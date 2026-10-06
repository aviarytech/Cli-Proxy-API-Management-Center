/**
 * Quota ledger: every window on every credential as one flat, comparable row,
 * plus the per-provider pool those rows add up to.
 *
 * The card grid renders each provider in its own idiom; the ledger trades that
 * detail for alignment, so the same window can be read down a column across
 * credentials. The provider shapes are read structurally here, the same way
 * `buildTimelineLane` and `collectQuotaRowInstants` read them — each answers a
 * different question about the same states, so they stay separate.
 *
 * Pure and React-free: labels come through the injected `t`, and nothing here
 * reads the clock.
 */

import type { TFunction } from 'i18next';
import type { QuotaProviderType } from './providers/types';

export interface LedgerWindow {
  /** Stable within a provider, so the same limit lines up across credentials. */
  key: string;
  label: string;
  /** Remaining percent, 0..100; null when the payload carried no usable figure. */
  remaining: number | null;
  resetAtMs: number | null;
  periodHours: number | null;
}

export interface LedgerCredentialData {
  plan: string | null;
  windows: LedgerWindow[];
}

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const remainingFromUsed = (used: unknown): number | null => {
  const value = finiteOrNull(used);
  return value === null ? null : clampPercent(100 - value);
};

interface LabelledWindowLike {
  id?: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

const labelOf = (t: TFunction, window: LabelledWindowLike, fallback: string): string =>
  window.labelKey
    ? String(t(window.labelKey, window.labelParams ?? {}))
    : window.label || fallback;

const codexPlanLabel = (t: TFunction, planType: string): string => {
  const normalized = planType.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return String(t(`codex_quota.plan_${normalized}`, { defaultValue: planType }));
};

const antigravityPlanLabel = (
  t: TFunction,
  subscription: { plan?: string | null; tierName?: string | null } | null | undefined
): string | null => {
  if (!subscription) return null;
  const plan = subscription.plan?.trim();
  if (plan && plan !== 'unknown') {
    return String(
      t(`antigravity_subscription.plan_${plan.replace(/-/g, '_')}`, {
        defaultValue: subscription.tierName || plan,
      })
    );
  }
  return subscription.tierName || null;
};

/** Normalize one loaded credential into ledger rows. Anything not loaded yields null. */
export function buildLedgerCredential(
  provider: QuotaProviderType,
  quota: unknown,
  t: TFunction
): LedgerCredentialData | null {
  const state = quota as { status?: string } | undefined;
  if (!state || state.status !== 'success') return null;

  if (provider === 'claude' || provider === 'codex') {
    const source = quota as { windows?: LabelledWindowLike[]; planType?: string | null };
    const planType = source.planType?.trim() || null;
    const plan =
      planType === null
        ? null
        : provider === 'claude'
          ? String(t(`claude_quota.${planType}`, { defaultValue: planType }))
          : codexPlanLabel(t, planType);
    return {
      plan,
      windows: (source.windows ?? []).map((window, index) => ({
        key: window.id || `window-${index}`,
        label: labelOf(t, window, window.id || ''),
        remaining: remainingFromUsed(window.usedPercent),
        resetAtMs: finiteOrNull(window.resetAtMs),
        periodHours: finiteOrNull(window.periodHours),
      })),
    };
  }

  if (provider === 'devin') {
    const source = quota as {
      plan?: string | null;
      windows?: {
        id: string;
        label?: string;
        remainingPercent: number | null;
        resetAtMs: number | null;
        periodHours: number;
      }[];
    };
    return {
      plan: source.plan || null,
      windows: (source.windows ?? []).map((window) => ({
        key: window.id,
        label: window.label || String(t(`devin_quota.${window.id}`)),
        remaining: finiteOrNull(window.remainingPercent),
        resetAtMs: finiteOrNull(window.resetAtMs),
        periodHours: finiteOrNull(window.periodHours),
      })),
    };
  }

  if (provider === 'xai') {
    const billing = (
      quota as {
        billing?: {
          periodType?: string;
          usagePercent?: number | null;
          resetAtMs?: number | null;
          periodHours?: number | null;
          planLabel?: string;
          planType?: string;
        } | null;
      }
    ).billing;
    if (!billing) return { plan: null, windows: [] };
    const plan = billing.planLabel || (billing.planType ? String(t('xai_quota.plan_paid')) : null);
    // Only the weekly limit is rate-limited capacity; a monthly figure is a
    // billing cycle and would read as something it is not beside the others.
    if (billing.periodType !== 'weekly') return { plan, windows: [] };
    return {
      plan,
      windows: [
        {
          key: 'weekly',
          label: String(t('xai_quota.weekly_limit')),
          remaining: remainingFromUsed(billing.usagePercent),
          resetAtMs: finiteOrNull(billing.resetAtMs),
          periodHours: finiteOrNull(billing.periodHours) ?? 24 * 7,
        },
      ],
    };
  }

  if (provider === 'antigravity') {
    const source = quota as {
      subscription?: { plan?: string | null; tierName?: string | null } | null;
      groups?: {
        id?: string;
        buckets?: {
          id?: string;
          label?: string;
          remainingFraction?: number | null;
          resetAtMs?: number | null;
          periodHours?: number | null;
        }[];
      }[];
    };
    return {
      plan: antigravityPlanLabel(t, source.subscription),
      windows: (source.groups ?? []).flatMap((group, groupIndex) =>
        (group.buckets ?? []).map((bucket, bucketIndex) => {
          const fraction = finiteOrNull(bucket.remainingFraction);
          return {
            key: `${group.id ?? groupIndex}:${bucket.id ?? bucketIndex}`,
            label: bucket.label || bucket.id || '',
            remaining: fraction === null ? null : clampPercent(Math.round(fraction * 100)),
            resetAtMs: finiteOrNull(bucket.resetAtMs),
            periodHours: finiteOrNull(bucket.periodHours),
          };
        })
      ),
    };
  }

  if (provider === 'kimi') {
    const rows =
      (
        quota as {
          rows?: (LabelledWindowLike & { used: number; limit: number })[];
        }
      ).rows ?? [];
    return {
      plan: null,
      windows: rows.map((row, index) => ({
        key: row.id || `row-${index}`,
        label: labelOf(t, row, row.id || ''),
        remaining:
          row.limit > 0 ? clampPercent(Math.round(((row.limit - row.used) / row.limit) * 100)) : null,
        resetAtMs: finiteOrNull(row.resetAtMs),
        periodHours: finiteOrNull(row.periodHours),
      })),
    };
  }

  if (provider === 'meta') {
    const data = (
      quota as {
        data?: {
          planName?: string;
          windows?: {
            id: string;
            usedPercent: number | null;
            resetAt?: number;
            durationMinutes?: number;
          }[];
        };
      }
    ).data;
    return {
      plan: data?.planName || null,
      windows: (data?.windows ?? []).map((window) => {
        const resetAt = finiteOrNull(window.resetAt);
        const minutes = finiteOrNull(window.durationMinutes);
        return {
          key: window.id,
          label: String(t(`meta_quota.${window.id}`)),
          remaining: remainingFromUsed(window.usedPercent),
          resetAtMs: resetAt === null ? null : resetAt * 1000,
          periodHours: window.id === 'weekly' ? 24 * 7 : minutes === null ? null : minutes / 60,
        };
      }),
    };
  }

  return null;
}

/* ------------------------------------------------------------------ pool */

/** One credential's share of a pooled limit; null remaining = not loaded or not reported. */
export interface LedgerPoolSegment {
  name: string;
  remaining: number | null;
}

export interface LedgerPoolLimit {
  key: string;
  label: string;
  /** Sum of remaining percent across reporting credentials; null when none report. */
  remaining: number | null;
  /** 100 per credential of this provider, so unloaded credentials count against the pool. */
  capacity: number;
  /** Soonest future reset among credentials reporting this limit. */
  nextResetAtMs: number | null;
  segments: LedgerPoolSegment[];
}

export interface LedgerPool {
  provider: QuotaProviderType;
  credentialCount: number;
  /** Most constrained limit, or a placeholder when nothing has loaded yet. */
  primary: LedgerPoolLimit;
  secondary: LedgerPoolLimit[];
}

export interface LedgerPoolInput {
  name: string;
  data: LedgerCredentialData | null;
}

/** Long windows are what a pool summary is for; a 5-hour window refills before anyone plans around it. */
const LONG_WINDOW_HOURS = 24;

const poolRatio = (limit: LedgerPoolLimit) =>
  limit.remaining === null || limit.capacity === 0 ? Infinity : limit.remaining / limit.capacity;

/**
 * Pool one provider's credentials into per-limit totals.
 *
 * The headline is the most constrained long window — the one that runs out
 * first across the fleet — rather than a fixed key, because which limit binds
 * differs by plan and changes over the week.
 */
export function buildLedgerPool(
  provider: QuotaProviderType,
  credentials: readonly LedgerPoolInput[],
  nowMs: number,
  fallbackLabel: string
): LedgerPool {
  const capacity = credentials.length * 100;
  const limits = new Map<string, LedgerPoolLimit & { periodHours: number | null }>();

  credentials.forEach((credential) => {
    credential.data?.windows.forEach((window) => {
      let limit = limits.get(window.key);
      if (!limit) {
        limit = {
          key: window.key,
          label: window.label,
          remaining: null,
          capacity,
          nextResetAtMs: null,
          periodHours: window.periodHours,
          segments: credentials.map((entry) => ({ name: entry.name, remaining: null })),
        };
        limits.set(window.key, limit);
      }
      if (window.remaining !== null) {
        limit.remaining = (limit.remaining ?? 0) + window.remaining;
        const segment = limit.segments.find((entry) => entry.name === credential.name);
        if (segment) segment.remaining = window.remaining;
      }
      if (
        window.resetAtMs !== null &&
        window.resetAtMs > nowMs &&
        (limit.nextResetAtMs === null || window.resetAtMs < limit.nextResetAtMs)
      ) {
        limit.nextResetAtMs = window.resetAtMs;
      }
    });
  });

  const all = [...limits.values()];
  const long = all.filter((limit) => (limit.periodHours ?? 0) >= LONG_WINDOW_HOURS);
  const candidates = long.length > 0 ? long : all;
  const primary = candidates.reduce<(typeof all)[number] | null>(
    (best, limit) => (best === null || poolRatio(limit) < poolRatio(best) ? limit : best),
    null
  );

  const strip = ({ periodHours: _periodHours, ...limit }: (typeof all)[number]) => limit;

  return {
    provider,
    credentialCount: credentials.length,
    primary: primary
      ? strip(primary)
      : {
          key: '',
          label: fallbackLabel,
          remaining: null,
          capacity,
          nextResetAtMs: null,
          segments: credentials.map((entry) => ({ name: entry.name, remaining: null })),
        },
    secondary: all.filter((limit) => limit !== primary).map(strip),
  };
}

/* ------------------------------------------------------------------ privacy */

const EMAIL_PATTERN = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const MASK = '•••';

const maskDomain = (domain: string): string => {
  // A credential filename carries its extension straight after the domain.
  const ext = domain.match(/\.json$/i)?.[0] ?? '';
  const bare = ext ? domain.slice(0, -ext.length) : domain;
  const labels = bare.split('.');
  if (labels.length < 2) return `${bare.slice(0, 1)}${MASK}${ext}`;
  const tld = labels[labels.length - 1];
  return `${labels[0].slice(0, 1)}${MASK}.${tld}${ext}`;
};

/**
 * Hide the identifying parts of any email inside a credential name, keeping
 * enough shape (provider prefix, first letters, TLD) to tell rows apart.
 *
 * `claude-tom@example.dev.json` → `claude-t•••@e•••.dev.json`
 */
export function maskCredentialName(name: string): string {
  return name.replace(EMAIL_PATTERN, (_match, local: string, domain: string) => {
    // Filenames prefix the email with the provider (`claude-`, `codex-`); that
    // part identifies nobody and keeps masked rows scannable.
    const prefix = local.match(/^[a-z]+-/)?.[0] ?? '';
    const user = local.slice(prefix.length);
    return `${prefix}${user.slice(0, 1)}${MASK}@${maskDomain(domain)}`;
  });
}
