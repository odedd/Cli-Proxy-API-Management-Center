import { expect, test } from 'bun:test';
import * as presentation from '@/features/quota/routing/codexResetPresentation';

test('shared credit eligibility overrides an older full-card balance', () => {
  expect(presentation.resolveQuotaResetEligibility?.(true, false)).toBe(false);
  expect(presentation.resolveQuotaResetEligibility?.(false, true)).toBe(true);
});

test('providers without separate credit metadata retain their existing eligibility', () => {
  expect(presentation.resolveQuotaResetEligibility?.(true)).toBe(true);
  expect(presentation.resolveQuotaResetEligibility?.(false)).toBe(false);
});
