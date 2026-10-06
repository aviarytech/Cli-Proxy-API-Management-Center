import { describe, expect, test } from 'bun:test';
import type { TFunction } from 'i18next';
import {
  buildLedgerCredential,
  buildLedgerPool,
  maskCredentialName,
} from '@/features/quota/ledgerModel';

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

const NOW = Date.UTC(2026, 8, 11, 12);
const DAY = 24 * 60 * 60 * 1000;

const claude = (fableUsed: number, weeklyUsed: number, resetInDays: number) => ({
  status: 'success',
  planType: 'plan_max',
  windows: [
    {
      id: 'seven_day_fable',
      label: '7-day Fable 5',
      usedPercent: fableUsed,
      resetAtMs: NOW + resetInDays * DAY,
      periodHours: 168,
    },
    { id: 'five_hour', label: '5-hour limit', usedPercent: 0, resetAtMs: null, periodHours: 5 },
    {
      id: 'seven_day',
      label: '7-day limit',
      usedPercent: weeklyUsed,
      resetAtMs: NOW + resetInDays * DAY,
      periodHours: 168,
    },
  ],
});

describe('buildLedgerCredential', () => {
  test('converts percent used into percent remaining and keeps window order', () => {
    const data = buildLedgerCredential('claude', claude(42, 21, 1), t);
    expect(data?.plan).toBe('plan_max');
    expect(data?.windows.map((window) => [window.key, window.remaining])).toEqual([
      ['seven_day_fable', 58],
      ['five_hour', 100],
      ['seven_day', 79],
    ]);
  });

  test('yields nothing for a credential that has not loaded', () => {
    expect(buildLedgerCredential('claude', { status: 'idle', windows: [] }, t)).toBeNull();
    expect(buildLedgerCredential('claude', undefined, t)).toBeNull();
  });

  test('reads Antigravity remaining fractions without inverting them', () => {
    const data = buildLedgerCredential(
      'antigravity',
      {
        status: 'success',
        groups: [{ id: 'g', buckets: [{ id: 'b', label: 'Gemini', remainingFraction: 0.25 }] }],
      },
      t
    );
    expect(data?.windows[0]).toMatchObject({ key: 'g:b', remaining: 25 });
  });

  test('drops a monthly xAI billing cycle rather than presenting it as a quota window', () => {
    const data = buildLedgerCredential(
      'xai',
      { status: 'success', billing: { periodType: 'monthly', usagePercent: 10 } },
      t
    );
    expect(data?.windows).toEqual([]);
  });
});

describe('buildLedgerPool', () => {
  const credentials = [
    { name: 'a', data: buildLedgerCredential('claude', claude(42, 21, 1), t) },
    { name: 'b', data: buildLedgerCredential('claude', claude(0, 0, 4), t) },
    { name: 'c', data: null },
  ];

  test('sums remaining against 100% per credential, unloaded ones included', () => {
    const pool = buildLedgerPool('claude', credentials, NOW, 'Quota');
    expect(pool.primary.key).toBe('seven_day_fable');
    expect(pool.primary.remaining).toBe(158);
    expect(pool.primary.capacity).toBe(300);
    expect(pool.primary.segments.map((segment) => segment.remaining)).toEqual([58, 100, null]);
  });

  test('headlines the most constrained long window and reports its soonest reset', () => {
    const pool = buildLedgerPool('claude', credentials, NOW, 'Quota');
    expect(pool.primary.nextResetAtMs).toBe(NOW + DAY);
    expect(pool.secondary.map((limit) => limit.key)).toEqual(['five_hour', 'seven_day']);
  });

  test('falls back to a placeholder when nothing has loaded', () => {
    const pool = buildLedgerPool('codex', [{ name: 'x', data: null }], NOW, 'Quota');
    expect(pool.primary).toMatchObject({ label: 'Quota', remaining: null, capacity: 100 });
    expect(pool.secondary).toEqual([]);
  });
});

describe('maskCredentialName', () => {
  test('keeps the provider prefix, first letters and TLD', () => {
    expect(maskCredentialName('claude-tom@1example.dev.json')).toBe('claude-t•••@1•••.dev.json');
    expect(maskCredentialName('codex-jane.doe@gmail.com.json')).toBe('codex-j•••@g•••.com.json');
  });

  test('leaves names without an email untouched', () => {
    expect(maskCredentialName('kimi-account-1.json')).toBe('kimi-account-1.json');
  });
});
