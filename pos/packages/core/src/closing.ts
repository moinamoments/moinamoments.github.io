/**
 * Kassenabschluss (Z-Bericht).
 *
 * Der Kassenabschluss ist mehr als eine Tagesauswertung: er ist die
 * Klammer, auf die sich die DSFinV-K bezieht. Jeder Beleg gehoert zu genau
 * einem Abschluss, die Abschluesse sind je Kasse lueckenlos durchnummeriert,
 * und ein abgeschlossener Zeitraum wird nicht wieder geoeffnet.
 *
 * Das Zaehlprotokoll (gezaehltes Bargeld) ist nicht gesetzlich
 * vorgeschrieben, aber die Kassensturzfaehigkeit ist es: der tatsaechliche
 * Bestand muss jederzeit mit dem gerechneten abgleichbar sein. Deshalb
 * rechnet der Abschluss die Differenz aus und verschweigt sie nicht -
 * auch dann nicht, wenn Geld fehlt.
 */

import { type Cents, formatAmount, sumCents } from "./money.ts";
import type {
  CashCountEntry,
  Closing,
  Device,
  Id,
  Order,
  PaymentMethod,
  Store,
  Tenant,
  Timestamp,
} from "./model.ts";
import { isTseSecured, PAYMENT_LABELS } from "./order.ts";
import {
  CASH_MOVEMENT_LABELS,
  type CashMovement,
  cashMovementsWithoutOpening,
  openingCashFrom,
  summarizeCashbook,
  type CashbookSummary,
} from "./cashbook.ts";
import { type TaxGroupTotal, type TaxRegistry, createTaxRegistry, summarizeTax } from "./tax.ts";

export class ClosingError extends Error {}

/** Stueckelung der Euro-Scheine und -Muenzen, absteigend. */
export const DENOMINATIONS: readonly Cents[] = [
  50_000, 20_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100, 50, 20, 10, 5, 2, 1,
];

export interface PaymentTotal {
  readonly method: PaymentMethod;
  readonly label: string;
  readonly amount: Cents;
  readonly count: number;
}

export interface ClosingReport {
  readonly closing: Closing;
  readonly tenantName: string;
  readonly deviceName: string;
  readonly orderCount: number;
  /** Belege ohne TSE-Signatur. Muessen im Abschluss sichtbar sein. */
  readonly unsecuredOrderCount: number;
  readonly voidCount: number;
  readonly grossTotal: Cents;
  /** Warenumsatz ohne Pfand - die Zahl, die in die Buchhaltung gehoert. */
  readonly salesTotal: Cents;
  /** Berechnetes Pfand. */
  readonly depositCharged: Cents;
  /** Zurueckgezahltes Pfand, negativ. */
  readonly depositRefunded: Cents;
  /** Pfandsaldo: was netto an Pfand in der Kasse geblieben ist. */
  readonly depositBalance: Cents;
  readonly taxGroups: readonly TaxGroupTotal[];
  readonly taxTotal: Cents;
  readonly payments: readonly PaymentTotal[];
  /**
   * Bargeldbestand, den die Kasse erwartet:
   * Anfangsbestand + Barumsatz + Einlagen - Entnahmen - Transit.
   */
  readonly expectedCash: Cents;
  /** Bargeldbewegungen ohne Umsatz, verdichtet. */
  readonly cashbook: CashbookSummary;
  /** Die einzelnen Bewegungen, fuer den Ausdruck. */
  readonly cashMovements: readonly CashMovement[];
  /** Gezaehltes Bargeld; `null`, wenn nicht gezaehlt wurde. */
  readonly countedCash: Cents | null;
  /** Gezaehlt minus erwartet. Negativ bedeutet: es fehlt Geld. */
  readonly cashDifference: Cents | null;
  readonly firstReceiptNumber: string | null;
  readonly lastReceiptNumber: string | null;
}

/** Summe eines Zaehlprotokolls. */
export function countCash(entries: readonly CashCountEntry[]): Cents {
  let total = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.count) || entry.count < 0) {
      throw new ClosingError(`Stueckzahl muss eine nicht negative ganze Zahl sein, war ${entry.count}`);
    }
    if (!DENOMINATIONS.includes(entry.denomination)) {
      throw new ClosingError(`${entry.denomination} ist kein Euro-Nennwert`);
    }
    total += entry.denomination * entry.count;
  }
  return total;
}

export interface BuildClosingInput {
  readonly tenant: Tenant;
  readonly store: Store;
  readonly device: Device;
  readonly userId: Id;
  readonly closingId: Id;
  /** Fortlaufende Abschlussnummer der Kasse. */
  readonly number: number;
  readonly from: Timestamp;
  readonly to: Timestamp;
  readonly createdAt: Timestamp;
  readonly orders: readonly Order[];
  readonly openingCash?: Cents;
  readonly cashCount?: readonly CashCountEntry[];
  readonly taxRegistry?: TaxRegistry;
  /**
   * Bargeldbewegungen des Zeitraums: Tageseroeffnung, Einlagen, Entnahmen,
   * Geldtransit. Ohne sie stimmt der Soll-Kassenbestand nicht - eine Entnahme
   * am Mittag wuerde am Abend als Fehlbetrag erscheinen.
   */
  readonly cashMovements?: readonly CashMovement[];
}

/**
 * Abschluss aus den Belegen des Zeitraums bilden.
 *
 * Es werden nur bezahlte Belege gezaehlt. Offene Vorgaenge gehoeren nicht in
 * den Abschluss - sie sind noch kein Geschaeftsvorfall. Ein Beleg, der schon
 * zu einem Abschluss gehoert, wird abgewiesen: ihn doppelt zu zaehlen wuerde
 * den Umsatz verdoppeln.
 */
export function buildClosing(input: BuildClosingInput): ClosingReport {
  const registry = input.taxRegistry ?? createTaxRegistry();
  const orders = input.orders;

  for (const order of orders) {
    if (order.tenantId !== input.tenant.id) {
      throw new ClosingError(`Beleg ${order.receiptNumber} gehoert zu einem anderen Mandanten`);
    }
    if (order.deviceId !== input.device.id) {
      throw new ClosingError(`Beleg ${order.receiptNumber} gehoert zu einer anderen Kasse`);
    }
    if (order.state !== "PAID") {
      throw new ClosingError(`Beleg ${order.receiptNumber} ist nicht bezahlt und gehoert nicht in den Abschluss`);
    }
    if (order.closingId != null) {
      throw new ClosingError(`Beleg ${order.receiptNumber} ist bereits in Abschluss ${order.closingId} enthalten`);
    }
  }
  if (!Number.isInteger(input.number) || input.number < 1) {
    throw new ClosingError(`Abschlussnummer muss eine positive ganze Zahl sein, war ${input.number}`);
  }

  const sorted = [...orders].sort((a, b) => a.receiptNumber.localeCompare(b.receiptNumber, "de"));

  const taxGroups = summarizeTax(
    sorted.flatMap((order) => order.lines.map((line) => ({ taxKey: line.taxKey, gross: line.gross }))),
    registry,
  );

  const byMethod = new Map<PaymentMethod, { amount: Cents; count: number }>();
  for (const order of sorted) {
    for (const payment of order.payments) {
      const bucket = byMethod.get(payment.method) ?? { amount: 0, count: 0 };
      byMethod.set(payment.method, { amount: bucket.amount + payment.amount, count: bucket.count + 1 });
    }
  }
  const payments: PaymentTotal[] = [...byMethod.entries()]
    .map(([method, bucket]) => ({ method, label: PAYMENT_LABELS[method], amount: bucket.amount, count: bucket.count }))
    .sort((a, b) => a.method.localeCompare(b.method));

  const allLines = sorted.flatMap((order) => order.lines);
  const depositCharged = sumCents(allLines.filter((l) => l.businessCaseType === "Pfand").map((l) => l.gross));
  const depositRefunded = sumCents(
    allLines.filter((l) => l.businessCaseType === "PfandRueckzahlung").map((l) => l.gross),
  );

  const cashMovements = input.cashMovements ?? [];
  const cashbook = summarizeCashbook(cashMovements);

  // Der Anfangsbestand kommt aus der Eroeffnungsbuchung, wenn es eine gibt -
  // sie ist gezaehlt und damit belastbarer als ein uebergebener Wert. Ohne
  // Eroeffnung gilt der uebergebene Wert (z. B. der Endbestand von gestern).
  const openingCash = cashMovements.some((movement) => movement.type === "OPENING")
    ? openingCashFrom(cashMovements)
    : input.openingCash ?? 0;

  const cashSales = byMethod.get("CASH")?.amount ?? 0;
  const expectedCash = openingCash + cashSales + cashbook.netMovements;
  const cashCount = input.cashCount ?? [];
  const countedCash = cashCount.length > 0 ? countCash(cashCount) : null;

  const closing: Closing = {
    id: input.closingId,
    tenantId: input.tenant.id,
    storeId: input.store.id,
    deviceId: input.device.id,
    number: input.number,
    from: input.from,
    to: input.to,
    createdAt: input.createdAt,
    userId: input.userId,
    orderIds: sorted.map((order) => order.id),
    cashCount,
    openingCash,
  };

  return {
    closing,
    tenantName: input.tenant.name,
    deviceName: input.device.name,
    orderCount: sorted.length,
    unsecuredOrderCount: sorted.filter((order) => !isTseSecured(order)).length,
    voidCount: sorted.filter((order) => order.voidsOrderId != null).length,
    grossTotal: sumCents(sorted.map((order) => order.total)),
    salesTotal: sumCents(sorted.map((order) => order.total)) - (depositCharged + depositRefunded),
    depositCharged,
    depositRefunded,
    depositBalance: depositCharged + depositRefunded,
    taxGroups,
    taxTotal: sumCents(taxGroups.map((group) => group.tax)),
    payments,
    expectedCash,
    cashbook,
    cashMovements: cashMovementsWithoutOpening(cashMovements),
    countedCash,
    cashDifference: countedCash == null ? null : countedCash - expectedCash,
    firstReceiptNumber: sorted[0]?.receiptNumber ?? null,
    lastReceiptNumber: sorted[sorted.length - 1]?.receiptNumber ?? null,
  };
}

/** Abschluss als Text zum Drucken oder Anzeigen. */
export function renderClosingText(report: ClosingReport, width = 42): string {
  const out: string[] = [];
  const rule = "-".repeat(width);
  const row = (left: string, right: string): string => {
    const space = Math.max(1, width - left.length - right.length);
    return left + " ".repeat(space) + right;
  };

  out.push(`Kassenabschluss Nr. ${report.closing.number}`);
  out.push(report.tenantName);
  out.push(`${report.deviceName} (${report.closing.deviceId})`);
  out.push(rule);
  out.push(row("Von", report.closing.from));
  out.push(row("Bis", report.closing.to));
  out.push(row("Belege", String(report.orderCount)));
  if (report.firstReceiptNumber) {
    out.push(row("Erster Beleg", report.firstReceiptNumber));
    out.push(row("Letzter Beleg", report.lastReceiptNumber ?? ""));
  }
  if (report.voidCount > 0) out.push(row("davon Storni", String(report.voidCount)));
  if (report.unsecuredOrderCount > 0) {
    // Diese Zeile ist der Grund, warum der Abschluss gedruckt wird: sie
    // gehoert in die Ausfalldokumentation.
    out.push(row("OHNE TSE-SIGNATUR", String(report.unsecuredOrderCount)));
  }
  out.push(rule);
  out.push(row("Umsatz brutto", formatAmount(report.grossTotal)));
  if (report.depositBalance !== 0 || report.depositCharged !== 0) {
    // Pfand ist durchlaufendes Geld: es steht in der Belegsumme, ist aber
    // kein Warenumsatz. Beide Zahlen gehoeren nebeneinander, sonst liest die
    // Buchhaltung einen zu hohen Umsatz.
    out.push(row("  davon Pfand berechnet", formatAmount(report.depositCharged)));
    out.push(row("  davon Pfand zurueck", formatAmount(report.depositRefunded)));
    out.push(row("Warenumsatz ohne Pfand", formatAmount(report.salesTotal)));
  }
  for (const group of report.taxGroups) {
    out.push(row(`  ${group.label} netto`, formatAmount(group.net)));
    out.push(row(`  ${group.label} Steuer`, formatAmount(group.tax)));
  }
  out.push(row("Steuer gesamt", formatAmount(report.taxTotal)));
  out.push(rule);
  for (const payment of report.payments) {
    out.push(row(`${payment.label} (${payment.count})`, formatAmount(payment.amount)));
  }
  out.push(rule);
  out.push(row("Anfangsbestand bar", formatAmount(report.closing.openingCash)));
  if (report.cashbook.deposits !== 0) out.push(row(CASH_MOVEMENT_LABELS.DEPOSIT, formatAmount(report.cashbook.deposits)));
  if (report.cashbook.withdrawals !== 0) out.push(row(CASH_MOVEMENT_LABELS.WITHDRAWAL, formatAmount(report.cashbook.withdrawals)));
  if (report.cashbook.transits !== 0) out.push(row(CASH_MOVEMENT_LABELS.TRANSIT, formatAmount(report.cashbook.transits)));
  if (report.cashbook.tipOuts !== 0) out.push(row(CASH_MOVEMENT_LABELS.TIP_OUT, formatAmount(report.cashbook.tipOuts)));
  out.push(row("Soll-Kassenbestand", formatAmount(report.expectedCash)));
  if (report.countedCash != null) {
    out.push(row("Gezaehlt", formatAmount(report.countedCash)));
    const difference = report.cashDifference ?? 0;
    out.push(row(difference === 0 ? "Differenz" : difference > 0 ? "Ueberschuss" : "FEHLBETRAG", formatAmount(difference)));
  } else {
    out.push("Nicht gezaehlt");
  }
  return out.join("\n");
}
