import { useLingui } from "@lingui/react/macro";

export function useTradingBotTemplates() {
  const { t } = useLingui();
  return {
    mid_long_term: {
      name: t`Mid / long term bot`,
      description: t`Contracts, coverage and delivery exposure`,
    },
    spot: { name: t`Spot bot`, description: t`Day-ahead, intraday and real-time decisions` },
    risk: { name: t`Risk bot`, description: t`Exposure, limits and approval evidence` },
    review: { name: t`Review bot`, description: t`Decisions, receipts and lessons learned` },
  };
}
