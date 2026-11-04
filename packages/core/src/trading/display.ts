/** Trading delivery times use the market's timezone; the offset stays visible. */
export function formatTradingInstant(value: string, locale: string, timeZone?: string): string {
  return new Date(value).toLocaleString(locale, { timeZone, timeZoneName: "short" });
}
