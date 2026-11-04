import type { TradingIntent, TradingReceipt, TradingSimulationScenario } from "@rakazo/contracts";
import { TradingReceiptSchema } from "@rakazo/contracts";
import { tradingAssert } from "./algorithms.js";
import {
  tradingDecimal as d,
  tradingDecimalString as s,
  tradingAbs,
  tradingCeil,
  tradingScale,
} from "./decimal.js";

export const tradingExecutionTerminal = (status: TradingReceipt["status"]) =>
  status === "filled" || status === "cancelled" || status === "rejected";

/** Cumulative accounting at approved limit prices. Round once per line, never per fill. */
export function tradingExecutionBalance(intent: TradingIntent, receipt: TradingReceipt) {
  const energies = intent.lines.map(() => 0n);
  const ids = new Set<string>();
  tradingAssert(
    receipt.intentHash === intent.intentHash,
    "INVALID_RECEIPT",
    "Receipt intent mismatch",
  );
  for (const fill of receipt.fills) {
    const line = intent.lines[fill.lineIndex];
    tradingAssert(line && !ids.has(fill.fillId), "INVALID_RECEIPT", "Invalid or duplicate fill");
    ids.add(fill.fillId);
    tradingAssert(
      d(fill.energyMwh) > 0n && d(fill.price) === d(line.limitPrice),
      "INVALID_RECEIPT",
      "Invalid synthetic fill",
    );
    energies[fill.lineIndex] = energies[fill.lineIndex]! + d(fill.energyMwh);
  }
  let total = 0n,
    settled = 0n;
  for (const [index, line] of intent.lines.entries()) {
    const energy = energies[index]!;
    tradingAssert(energy <= d(line.energyMwh), "INVALID_RECEIPT", "Overfilled order");
    if (receipt.status === "filled")
      tradingAssert(energy === d(line.energyMwh), "INVALID_RECEIPT", "Incomplete full fill");
    const price = tradingAbs(d(line.limitPrice));
    total += tradingCeil(d(line.energyMwh) * price, tradingScale);
    settled += tradingCeil(energy * price, tradingScale);
  }
  tradingAssert(
    receipt.status !== "rejected" || receipt.fills.length === 0,
    "INVALID_RECEIPT",
    "Rejected order has fills",
  );
  return { settled, reserved: tradingExecutionTerminal(receipt.status) ? 0n : total - settled };
}

/** A deterministic synthetic venue. Reconciliation advances only when explicitly requested.
 * No company endpoint or market outcome is inferred from these scenarios. */
export function simulateTradingExecution(input: {
  intent: TradingIntent;
  executionId: string;
  clientRequestId: string;
  scenario: TradingSimulationScenario;
  energyStep: string;
  now: Date;
  previous?: TradingReceipt;
  operation?: "reconcile" | "cancel";
  cancellationPending?: boolean;
}): TradingReceipt {
  const { intent, previous, scenario, now, operation } = input;
  if (previous && tradingExecutionTerminal(previous.status)) return previous;
  if (
    previous &&
    ((scenario === "unavailable" && operation === "reconcile") ||
      (scenario === "pending" && operation === "reconcile"))
  )
    return previous;
  if (previous && input.cancellationPending && operation === "cancel") return previous;
  const fills = [...(previous?.fills ?? [])];
  const append = (partial: boolean) => {
    for (const [lineIndex, line] of intent.lines.entries()) {
      const filled = fills
        .filter((fill) => fill.lineIndex === lineIndex)
        .reduce((sum, fill) => sum + d(fill.energyMwh), 0n);
      const target = partial
        ? (d(line.energyMwh) / d(input.energyStep) / 2n) * d(input.energyStep)
        : d(line.energyMwh);
      if (target > filled)
        fills.push({
          fillId: `${input.executionId}-${lineIndex}-${previous ? previous.sequence + 1 : 1}`,
          lineIndex,
          energyMwh: s(target - filled),
          price: line.limitPrice,
          occurredAt: now.toISOString(),
        });
    }
  };
  let status: TradingReceipt["status"];
  if (operation === "cancel") {
    status = scenario === "cancel_timeout" || scenario === "unavailable" ? "unknown" : "cancelled";
  } else if (input.cancellationPending) {
    status = "cancelled";
  } else if (previous) {
    append(scenario === "timeout" && previous.status === "unknown");
    status =
      scenario === "timeout" && previous.status === "unknown"
        ? fills.length
          ? "partially_filled"
          : "accepted"
        : "filled";
  } else if (scenario === "immediate_fill") {
    append(false);
    status = "filled";
  } else if (scenario === "partial_fill" || scenario === "cancel_timeout") {
    append(true);
    status = fills.length ? "partially_filled" : "accepted";
  } else {
    status = scenario === "rejected" ? "rejected" : scenario === "pending" ? "accepted" : "unknown";
  }
  const receipt = TradingReceiptSchema.parse({
    executionId: input.executionId,
    clientRequestId: input.clientRequestId,
    intentHash: intent.intentHash,
    scope: intent.scope,
    status,
    sequence: previous ? previous.sequence + 1 : 1,
    source: {
      sourceId: "internal-execution-simulation-v2",
      kind: "synthetic",
      asOf: now.toISOString(),
      observedAt: now.toISOString(),
      validUntil: new Date(now.getTime() + 86_400_000).toISOString(),
      revision: "2",
    },
    fills,
  });
  tradingExecutionBalance(intent, receipt);
  return receipt;
}
