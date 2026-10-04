/** Keep individual remaining meters on the aggregate bars' status scale. */
export const remainingMeterFill = (
  remaining: number,
  usedThreshold: number
): 'fillHigh' | 'fillMedium' | 'fillLow' =>
  remaining >= 30 ? 'fillHigh' : remaining > 100 - usedThreshold ? 'fillMedium' : 'fillLow';
