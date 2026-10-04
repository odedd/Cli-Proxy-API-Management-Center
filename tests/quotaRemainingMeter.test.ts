import { expect, test } from 'bun:test';

const load = () => import('@/features/quota/routing/remainingMeter').catch(() => null);

test.each([
  { remaining: 100, fill: 'fillHigh' },
  { remaining: 65, fill: 'fillHigh' },
  { remaining: 30, fill: 'fillHigh' },
  { remaining: 29.8, fill: 'fillMedium' },
  { remaining: 5.2, fill: 'fillMedium' },
  { remaining: 5, fill: 'fillLow' },
  { remaining: 0, fill: 'fillLow' },
])(
  'individual remaining meter uses aggregate status colors for %j',
  async ({ remaining, fill }) => {
    const module = await load();
    expect(module?.remainingMeterFill?.(remaining, 95)).toBe(fill);
  }
);

test('the warning boundary follows the existing used-quota threshold', async () => {
  const module = await load();
  expect(module?.remainingMeterFill?.(10, 90)).toBe('fillLow');
  expect(module?.remainingMeterFill?.(10.1, 90)).toBe('fillMedium');
});
