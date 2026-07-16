import type { ActivityImport, ActivityType } from "@wealthfolio/addon-sdk";
import type { PlaidHolding, PlaidInvestmentTransaction, PlaidSecurity } from "../plaid/types";

/**
 * Investment mapping. Plaid conventions (verified against live sandbox):
 * - quantity: positive for buys, negative for sells
 * - amount: signed cash impact — positive = cash out (buys), negative = cash in
 * - securities[] carries the symbol; cash rows reference a `CUR:XXX` security
 */

export interface MappedInvestments {
  rows: ActivityImport[];
  /** Transactions dropped because their security has no usable ticker. */
  skipped: PlaidInvestmentTransaction[];
}

function isCashSecurity(sec: PlaidSecurity | undefined): boolean {
  if (!sec) return false;
  return Boolean(
    sec.is_cash_equivalent || sec.type === "cash" || sec.ticker_symbol?.startsWith("CUR:"),
  );
}

function symbolFor(sec: PlaidSecurity | undefined): string | null {
  if (!sec || isCashSecurity(sec)) return null;
  const ticker = sec.ticker_symbol?.trim();
  return ticker ? ticker : null;
}

function baseRow(
  t: PlaidInvestmentTransaction,
  wfAccountId: string,
  fallbackCurrency: string,
  lineNumber: number,
): ActivityImport {
  return {
    accountId: wfAccountId,
    currency: t.iso_currency_code ?? fallbackCurrency,
    activityType: "UNKNOWN",
    date: t.date,
    symbol: "",
    comment: `${t.name} [plaid:${t.investment_transaction_id}]`,
    lineNumber,
    isValid: false,
    isDraft: false,
  };
}

/** Returns the mapped row, or null to skip (cancelled / zero rows / no ticker). */
export function mapInvestmentTransaction(
  t: PlaidInvestmentTransaction,
  securities: Map<string, PlaidSecurity>,
  wfAccountId: string,
  fallbackCurrency: string,
  lineNumber: number,
): ActivityImport | "skipped" | null {
  const sec = t.security_id ? securities.get(t.security_id) : undefined;
  const symbol = symbolFor(sec);
  const row = baseRow(t, wfAccountId, fallbackCurrency, lineNumber);
  const absAmount = Math.abs(t.amount);
  const fees = t.fees && t.fees !== 0 ? Math.abs(t.fees).toFixed(2) : undefined;

  switch (t.type) {
    case "buy":
    case "sell": {
      if (!symbol) return "skipped";
      const quantity = Math.abs(t.quantity);
      if (quantity === 0) return null;
      const price =
        t.price != null && t.price > 0
          ? t.price
          : Math.max(0, absAmount - (t.fees ?? 0)) / quantity;
      return {
        ...row,
        activityType: t.type === "buy" ? "BUY" : "SELL",
        symbol,
        quantity: String(quantity),
        unitPrice: price.toFixed(6),
        fee: fees,
      };
    }
    case "cash": {
      const subtype = t.subtype ?? "";
      let activityType: ActivityType;
      if (/dividend/.test(subtype)) {
        activityType = "DIVIDEND";
      } else if (/deposit|contribution/.test(subtype)) {
        activityType = "DEPOSIT";
      } else if (/withdrawal/.test(subtype)) {
        activityType = "WITHDRAWAL";
      } else {
        // Plaid cash amounts: positive = cash out
        activityType = t.amount > 0 ? "WITHDRAWAL" : "DEPOSIT";
      }
      if (absAmount === 0) return null;
      return {
        ...row,
        activityType,
        // Dividends attach to the asset when the security has a ticker.
        symbol: activityType === "DIVIDEND" && symbol ? symbol : "",
        amount: absAmount.toFixed(2),
        fee: fees,
      };
    }
    case "fee": {
      if (absAmount === 0) return null;
      return { ...row, activityType: "FEE", amount: absAmount.toFixed(2) };
    }
    case "transfer": {
      if (symbol && t.quantity !== 0) {
        return {
          ...row,
          activityType: t.quantity > 0 ? "TRANSFER_IN" : "TRANSFER_OUT",
          symbol,
          quantity: String(Math.abs(t.quantity)),
          unitPrice: t.price != null && t.price > 0 ? t.price.toFixed(6) : undefined,
        };
      }
      if (absAmount === 0) return null;
      return {
        ...row,
        activityType: t.amount > 0 ? "TRANSFER_OUT" : "TRANSFER_IN",
        amount: absAmount.toFixed(2),
      };
    }
    case "cancel":
      return null;
    default:
      return null;
  }
}

export function mapInvestmentTransactions(
  transactions: PlaidInvestmentTransaction[],
  securities: Map<string, PlaidSecurity>,
  wfAccountId: string,
  fallbackCurrency: string,
): MappedInvestments {
  const rows: ActivityImport[] = [];
  const skipped: PlaidInvestmentTransaction[] = [];
  const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const t of sorted) {
    const mapped = mapInvestmentTransaction(
      t,
      securities,
      wfAccountId,
      fallbackCurrency,
      rows.length + 1,
    );
    if (mapped === "skipped") skipped.push(t);
    else if (mapped) rows.push(mapped);
  }
  return { rows, skipped };
}

/**
 * First-sync baseline: Plaid's transaction history (~24 months) may not cover
 * positions opened earlier. For each held security, whatever quantity the
 * imported transactions don't account for comes in as a TRANSFER_IN dated the
 * day before the history window, priced at the holding's average cost. The
 * cash component gets the same treatment as a DEPOSIT/WITHDRAWAL anchor.
 */
export function buildInvestmentBaseline(
  holdings: PlaidHolding[],
  securities: Map<string, PlaidSecurity>,
  mappedRows: ActivityImport[],
  plaidAccountId: string,
  wfAccountId: string,
  fallbackCurrency: string,
  earliestTxnDate: string | null,
): ActivityImport[] {
  const anchorDate = earliestTxnDate
    ? new Date(new Date(`${earliestTxnDate}T00:00:00Z`).getTime() - 86400_000)
        .toISOString()
        .slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  // Net imported quantity per symbol (buys + transfers in − sells − transfers out).
  const netQty = new Map<string, number>();
  for (const row of mappedRows) {
    if (!row.symbol) continue;
    const qty = Number(row.quantity ?? 0);
    if (!qty) continue;
    const sign =
      row.activityType === "BUY" || row.activityType === "TRANSFER_IN"
        ? 1
        : row.activityType === "SELL" || row.activityType === "TRANSFER_OUT"
          ? -1
          : 0;
    if (!sign) continue;
    netQty.set(row.symbol, (netQty.get(row.symbol) ?? 0) + sign * qty);
  }

  const baseline: ActivityImport[] = [];
  let cashValue = 0;

  for (const holding of holdings) {
    if (holding.account_id !== plaidAccountId) continue;
    const sec = securities.get(holding.security_id);
    if (isCashSecurity(sec)) {
      cashValue += holding.institution_value ?? holding.quantity;
      continue;
    }
    const symbol = symbolFor(sec);
    if (!symbol) continue;
    const remainder = holding.quantity - (netQty.get(symbol) ?? 0);
    if (remainder <= 1e-6) continue;
    const avgCost =
      holding.cost_basis != null && holding.quantity > 0
        ? holding.cost_basis / holding.quantity
        : (holding.institution_price ?? 0);
    baseline.push({
      accountId: wfAccountId,
      currency: holding.iso_currency_code ?? fallbackCurrency,
      activityType: "TRANSFER_IN",
      date: anchorDate,
      symbol,
      quantity: remainder.toFixed(8),
      unitPrice: avgCost > 0 ? avgCost.toFixed(6) : undefined,
      comment: `Position baseline [plaid:baseline:${plaidAccountId}:${symbol}]`,
      lineNumber: 0,
      isValid: false,
      isDraft: false,
    });
  }

  // Cash anchor: current cash minus the net cash effect of imported rows.
  const netCash = mappedRows.reduce((acc, row) => {
    const amount = Number(row.amount ?? 0);
    if (!amount) {
      // BUY/SELL rows carry quantity+price instead of amount.
      const qty = Number(row.quantity ?? 0);
      const price = Number(row.unitPrice ?? 0);
      const fee = Number(row.fee ?? 0);
      if (row.activityType === "BUY") return acc - (qty * price + fee);
      if (row.activityType === "SELL") return acc + (qty * price - fee);
      return acc;
    }
    switch (row.activityType) {
      case "DEPOSIT":
      case "DIVIDEND":
      case "INTEREST":
      case "TRANSFER_IN":
        return acc + amount;
      case "WITHDRAWAL":
      case "FEE":
      case "TAX":
      case "TRANSFER_OUT":
        return acc - amount;
      default:
        return acc;
    }
  }, 0);
  const cashResidue = Math.round((cashValue - netCash) * 100) / 100;
  if (cashResidue !== 0 && Number.isFinite(cashResidue)) {
    baseline.push({
      accountId: wfAccountId,
      currency: fallbackCurrency,
      activityType: cashResidue > 0 ? "DEPOSIT" : "WITHDRAWAL",
      date: anchorDate,
      symbol: "",
      amount: Math.abs(cashResidue).toFixed(2),
      comment: `Cash baseline [plaid:baseline:${plaidAccountId}:cash]`,
      lineNumber: 0,
      isValid: false,
      isDraft: false,
    });
  }

  return baseline;
}
