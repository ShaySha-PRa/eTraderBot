const SCALE = 1_000_000n;

/** Six decimal fixed point. No money or quantity comparisons use binary floating point. */
export function tradingDecimal(value: string): bigint {
  if (!/^-?(?:0|[1-9]\d{0,29})(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("Invalid trading decimal");
  }
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const result = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(6, "0"));
  return negative ? -result : result;
}

export function tradingDecimalString(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const fraction = (absolute % SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${absolute / SCALE}${fraction ? `.${fraction}` : ""}`;
}

export const tradingScale = SCALE;
export const tradingMin = (...values: bigint[]) => values.reduce((a, b) => (a < b ? a : b));
export const tradingMax = (...values: bigint[]) => values.reduce((a, b) => (a > b ? a : b));
export const tradingAbs = (value: bigint) => (value < 0n ? -value : value);
export const tradingFloorStep = (value: bigint, step: bigint) => (value / step) * step;
export const tradingCeil = (numerator: bigint, denominator: bigint) =>
  (numerator + denominator - 1n) / denominator;

export function tradingGrossNotional(lines: { energyMwh: string; limitPrice: string }[]): string {
  // Reserve conservatively per line, including negative prices.
  return tradingDecimalString(
    lines.reduce(
      (sum, line) =>
        sum +
        tradingCeil(
          tradingDecimal(line.energyMwh) * tradingAbs(tradingDecimal(line.limitPrice)),
          SCALE,
        ),
      0n,
    ),
  );
}
