/**
 * Buchungssaetze aus Belegen und Kassenbewegungen.
 *
 * Absichtlich **formatneutral**: hier entsteht die Buchhaltung, nicht eine
 * Datei. DATEV und Lexware serialisieren dieselben Saetze unterschiedlich, und
 * ein drittes Format kommt irgendwann dazu. Wer die Buchungslogik in den
 * Dateiaufbau mischt, hat sie zweimal - und einmal davon falsch.
 *
 * ## Die Regeln, in der Reihenfolge ihrer Wichtigkeit
 *
 * 1. **Jeder Satz traegt seine Belegnummer.** Ein Buchungsstapel, in dem eine
 *    Zeile nicht mehr auf einen Beleg zurueckfuehrbar ist, hilft bei einer
 *    Pruefung nicht.
 * 2. **Es wird nichts umgelegt.** Erloese laufen je Steuersatz, Zahlungen je
 *    Zahlart, beide gegen ein Verrechnungskonto (siehe accounts.ts). Jede
 *    direkte Zuordnung zwischen Steuersatz und Zahlart waere eine Erfindung.
 * 3. **Betraege sind immer positiv**, die Richtung steckt im Soll-Haben-
 *    Kennzeichen. So erwarten es beide Formate, und so dreht ein Storno die
 *    Buchung, statt einen negativen Betrag zu schreiben.
 * 4. **Das Verrechnungskonto geht auf null auf.** `checkBookingBalance` prueft
 *    das. Bleibt ein Rest, steht ein Umsatz da, dem kein Geld gegenuebersteht -
 *    besser, es faellt hier auf als beim Steuerberater.
 *
 * ## Was nicht gebucht wird
 *
 * Die **Tageseroeffnung** ist keine Buchung. Der gezaehlte Anfangsbestand ist
 * der Bestand, den das Kassenkonto schon hat; ihn zu buchen wuerde ihn
 * verdoppeln. Er dient dem Abgleich, nicht der Buchhaltung.
 */

import type { CashMovement, CashMovementType } from "../cashbook.ts";
import { CASH_MOVEMENT_LABELS } from "../cashbook.ts";
import type { ClosingReport } from "../closing.ts";
import type { Cents } from "../money.ts";
import type { Order, PaymentMethod, Timestamp } from "../model.ts";
import { PAYMENT_LABELS } from "../order.ts";
import { STANDARD_TAX_RATES, type TaxKey } from "../tax.ts";
import {
  AccountingError,
  type AccountMapping,
  cashMovementAccount,
  paymentAccount,
  revenueAccount,
  taxCodeFor,
} from "./accounts.ts";

/** Woraus ein Satz entstanden ist - fuer Auswertung und Fehlermeldungen. */
export type BookingKind = "REVENUE" | "DEPOSIT" | "TIP" | "PAYMENT" | "CASH_MOVEMENT" | "CASH_DIFFERENCE";

export interface BookingEntry {
  /** Belegdatum als `YYYY-MM-DD`. */
  readonly date: string;
  /** Betrag in Cent, immer positiv. */
  readonly amount: Cents;
  /** Bezieht sich auf `account`: `S` = Soll, `H` = Haben. */
  readonly side: "S" | "H";
  readonly account: string;
  readonly contraAccount: string;
  /** Buchungstext, hoechstens 60 Zeichen (Grenze beider Formate). */
  readonly text: string;
  /** Belegnummer, hoechstens 36 Zeichen. */
  readonly documentField: string;
  readonly taxKey: TaxKey | null;
  /** BU-Schluessel; leer bei Automatikkonten. */
  readonly taxCode: string;
  readonly kind: BookingKind;
}

/** Hoechstlaengen der Formate. Laengere Werte werden gekuerzt, nicht abgewiesen. */
const MAX_TEXT = 60;
const MAX_DOCUMENT = 36;

function shorten(value: string, max: number): string {
  const cleaned = value.replace(/[\r\n\t]+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

/** Datumsteil eines Zeitstempels mit Offset - ohne Umrechnung in UTC. */
function dateOf(timestamp: Timestamp): string {
  // Bewusst der Datumsteil der Ortszeit: ein Verkauf am 26.09. um 23:30 in
  // Berlin ist in UTC der 26.09. um 21:30, aber ein Verkauf am 01.01. um 00:30
  // waere in UTC noch der 31.12. - und dann liegt der Umsatz im falschen Jahr.
  const date = timestamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new AccountingError(`"${timestamp}" ist kein lesbarer Zeitstempel.`);
  }
  return date;
}

/**
 * Richtung bestimmen.
 *
 * `natural` ist die Seite, auf der der Betrag steht, wenn er positiv ist. Bei
 * einem negativen Betrag - Storno, Pfandrueckgabe - dreht sie sich, und der
 * Betrag wird positiv geschrieben.
 */
function directed(amount: Cents, natural: "S" | "H"): { amount: Cents; side: "S" | "H" } {
  if (amount >= 0) return { amount, side: natural };
  return { amount: -amount, side: natural === "S" ? "H" : "S" };
}

function taxLabel(taxKey: TaxKey): string {
  return STANDARD_TAX_RATES.find((rate) => rate.key === taxKey)?.label ?? `Schluessel ${taxKey}`;
}

export interface BookingInput {
  readonly report: ClosingReport;
  readonly orders: readonly Order[];
  readonly mapping: AccountMapping;
  /**
   * Belegweise buchen oder je Abschluss verdichten?
   *
   * `RECEIPT` ist genauer und die Voreinstellung: jede Zeile traegt ihre
   * Belegnummer. `CLOSING` fasst je Abschluss, Steuersatz und Zahlart zusammen -
   * fuer einen Markttag mit dreihundert Belegen sind das vier Zeilen statt
   * neunhundert. Was der Steuerberater lieber hat, entscheidet er.
   */
  readonly granularity?: "RECEIPT" | "CLOSING";
}

/**
 * Buchungssaetze eines Kassenabschlusses.
 *
 * Reihenfolge: Erloese und Pfand, dann Zahlungen, dann Kassenbewegungen, zuletzt
 * eine Kassendifferenz. Das ist die Folge, in der ein Mensch den Stapel liest.
 */
export function buildBookings(input: BookingInput): readonly BookingEntry[] {
  const { report, mapping } = input;
  const granularity = input.granularity ?? "RECEIPT";
  const entries: BookingEntry[] = [];

  const account = (value: string | null, what: string): string => {
    if (value == null || value.trim() === "") {
      throw new AccountingError(`${what} ist nicht eingestellt - der Buchungsstapel waere unvollstaendig.`);
    }
    return value.trim();
  };

  const clearing = account(mapping.clearing, "Das Verrechnungskonto");

  if (granularity === "RECEIPT") {
    for (const order of [...input.orders].sort((a, b) => a.receiptNumber.localeCompare(b.receiptNumber, "de"))) {
      entries.push(...bookOrder(order, mapping, clearing, account));
    }
  } else {
    entries.push(...bookClosingSummary(input, clearing, account));
  }

  // --- Bargeldbewegungen -------------------------------------------------
  // Die Eroeffnung fehlt in `report.cashMovements` schon (cashMovementsWithout-
  // Opening); die Pruefung hier ist die Zusicherung, dass das so bleibt.
  const cashAccount = account(paymentAccount(mapping, "CASH"), "Das Kassenkonto");
  for (const movement of report.cashMovements) {
    if (movement.type === "OPENING") continue;
    entries.push(bookCashMovement(movement, mapping, cashAccount, account));
  }

  // --- Kassendifferenz ---------------------------------------------------
  if (report.cashDifference != null && report.cashDifference !== 0) {
    const differenceAccount = account(mapping.cashDifference, "Das Konto fuer die Kassendifferenz");
    // Ein Fehlbetrag (negativ) ist Aufwand: Differenzkonto im Soll, Kasse im
    // Haben. Ein Ueberschuss dreht das.
    const { amount, side } = directed(-report.cashDifference, "S");
    entries.push({
      date: dateOf(report.closing.to),
      amount,
      side,
      account: differenceAccount,
      contraAccount: cashAccount,
      text: shorten(
        `Kassendifferenz Abschluss ${report.closing.number} (${report.cashDifference < 0 ? "Fehlbetrag" : "Ueberschuss"})`,
        MAX_TEXT,
      ),
      documentField: shorten(`Z-${report.closing.number}`, MAX_DOCUMENT),
      taxKey: null,
      taxCode: "",
      kind: "CASH_DIFFERENCE",
    });
  }

  return entries;
}

/** Erloese, Pfand und Zahlungen eines einzelnen Belegs. */
function bookOrder(
  order: Order,
  mapping: AccountMapping,
  clearing: string,
  account: (value: string | null, what: string) => string,
): BookingEntry[] {
  const entries: BookingEntry[] = [];
  const date = dateOf(order.paidAt ?? order.startedAt);
  const documentField = shorten(order.receiptNumber, MAX_DOCUMENT);
  const isVoid = order.voidsOrderId != null;

  // Positionen nach Art und Steuersatz buendeln. Warenumsatz, Pfand und
  // Trinkgeld gehen auf verschiedene Konten und duerfen nicht vermischt werden.
  const groups = new Map<string, { kind: BookingKind; taxKey: TaxKey; gross: Cents }>();
  for (const line of order.lines) {
    const kind: BookingKind =
      line.businessCaseType === "Pfand" || line.businessCaseType === "PfandRueckzahlung"
        ? "DEPOSIT"
        : line.businessCaseType === "TrinkgeldAN" || line.businessCaseType === "TrinkgeldAG"
          ? "TIP"
          : "REVENUE";
    const key = `${kind}:${line.taxKey}`;
    const bucket = groups.get(key);
    if (bucket) groups.set(key, { ...bucket, gross: bucket.gross + line.gross });
    else groups.set(key, { kind, taxKey: line.taxKey, gross: line.gross });
  }

  for (const [, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.gross === 0) continue;
    const target =
      group.kind === "DEPOSIT"
        ? account(mapping.deposit, "Das Konto fuer Pfand")
        : group.kind === "TIP"
          ? account(mapping.cashMovement["TIP_OUT"] ?? null, "Das Konto fuer Trinkgeld")
          : account(revenueAccount(mapping, group.taxKey), `Das Erloeskonto fuer ${taxLabel(group.taxKey)}`);

    // Erloes im Haben, Verrechnung im Soll - bei einem Storno umgekehrt.
    const { amount, side } = directed(group.gross, "H");
    entries.push({
      date,
      amount,
      side,
      account: target,
      contraAccount: clearing,
      text: shorten(
        `${isVoid ? "Storno " : ""}${group.kind === "DEPOSIT" ? "Pfand" : group.kind === "TIP" ? "Trinkgeld" : "Erloes"} ${taxLabel(group.taxKey)} Beleg ${order.receiptNumber}`,
        MAX_TEXT,
      ),
      documentField,
      taxKey: group.taxKey,
      // Pfand und Trinkgeld tragen den Satz ihrer Position; der BU-Schluessel
      // kommt aus derselben Zuordnung.
      taxCode: taxCodeFor(mapping, group.taxKey),
      kind: group.kind,
    });
  }

  for (const payment of order.payments) {
    if (payment.amount === 0) continue;
    const money = account(paymentAccount(mapping, payment.method), `Das Geldkonto fuer ${PAYMENT_LABELS[payment.method]}`);
    // Geld im Soll, Verrechnung im Haben - bei einer Auszahlung umgekehrt.
    const { amount, side } = directed(payment.amount, "S");
    entries.push({
      date,
      amount,
      side,
      account: money,
      contraAccount: clearing,
      text: shorten(`${payment.label} Beleg ${order.receiptNumber}`, MAX_TEXT),
      documentField,
      taxKey: null,
      // Ein Geldkonto traegt keine Umsatzsteuer. Der Satz steht an der
      // Erloesbuchung; hier waere er doppelt.
      taxCode: "",
      kind: "PAYMENT",
    });
  }

  return entries;
}

/**
 * Verdichtete Buchung je Abschluss.
 *
 * Dieselbe Struktur wie belegweise, nur summiert. Die Belegnummer wird durch die
 * Abschlussnummer ersetzt; der Bezug auf den einzelnen Beleg geht damit
 * verloren - deshalb ist das nicht die Voreinstellung. Die Spanne der
 * Belegnummern steht im Buchungstext, damit der Zusammenhang nicht ganz fehlt.
 */
function bookClosingSummary(
  input: BookingInput,
  clearing: string,
  account: (value: string | null, what: string) => string,
): BookingEntry[] {
  const { report, mapping } = input;
  const entries: BookingEntry[] = [];
  const date = dateOf(report.closing.to);
  const documentField = shorten(`Z-${report.closing.number}`, MAX_DOCUMENT);
  const span =
    report.firstReceiptNumber && report.lastReceiptNumber
      ? ` (${report.firstReceiptNumber} bis ${report.lastReceiptNumber})`
      : "";

  // Erloese und Pfand getrennt: `taxGroups` enthaelt beides zusammen, deshalb
  // wird hier neu aus den Positionen summiert.
  const groups = new Map<string, { kind: BookingKind; taxKey: TaxKey; gross: Cents }>();
  for (const order of input.orders) {
    for (const line of order.lines) {
      const kind: BookingKind =
        line.businessCaseType === "Pfand" || line.businessCaseType === "PfandRueckzahlung"
          ? "DEPOSIT"
          : line.businessCaseType === "TrinkgeldAN" || line.businessCaseType === "TrinkgeldAG"
            ? "TIP"
            : "REVENUE";
      const key = `${kind}:${line.taxKey}`;
      const bucket = groups.get(key);
      if (bucket) groups.set(key, { ...bucket, gross: bucket.gross + line.gross });
      else groups.set(key, { kind, taxKey: line.taxKey, gross: line.gross });
    }
  }

  for (const [, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.gross === 0) continue;
    const target =
      group.kind === "DEPOSIT"
        ? account(mapping.deposit, "Das Konto fuer Pfand")
        : group.kind === "TIP"
          ? account(mapping.cashMovement["TIP_OUT"] ?? null, "Das Konto fuer Trinkgeld")
          : account(revenueAccount(mapping, group.taxKey), `Das Erloeskonto fuer ${taxLabel(group.taxKey)}`);
    const { amount, side } = directed(group.gross, "H");
    entries.push({
      date,
      amount,
      side,
      account: target,
      contraAccount: clearing,
      text: shorten(
        `${group.kind === "DEPOSIT" ? "Pfand" : group.kind === "TIP" ? "Trinkgeld" : "Erloes"} ${taxLabel(group.taxKey)} Abschluss ${report.closing.number}${span}`,
        MAX_TEXT,
      ),
      documentField,
      taxKey: group.taxKey,
      taxCode: taxCodeFor(mapping, group.taxKey),
      kind: group.kind,
    });
  }

  for (const total of report.payments) {
    if (total.amount === 0) continue;
    const money = account(paymentAccount(mapping, total.method), `Das Geldkonto fuer ${total.label}`);
    const { amount, side } = directed(total.amount, "S");
    entries.push({
      date,
      amount,
      side,
      account: money,
      contraAccount: clearing,
      text: shorten(`${total.label} Abschluss ${report.closing.number} (${total.count} Belege)`, MAX_TEXT),
      documentField,
      taxKey: null,
      taxCode: "",
      kind: "PAYMENT",
    });
  }

  return entries;
}

/** Eine Bargeldbewegung ohne Beleg. */
function bookCashMovement(
  movement: CashMovement,
  mapping: AccountMapping,
  cashAccount: string,
  account: (value: string | null, what: string) => string,
): BookingEntry {
  const target = account(
    cashMovementAccount(mapping, movement.type),
    `Das Konto fuer ${CASH_MOVEMENT_LABELS[movement.type]}`,
  );
  // `movement.amount` traegt sein Vorzeichen: positiv erhoeht den
  // Kassenbestand. Eine Einlage ist also Kasse im Soll, das Gegenkonto im
  // Haben - hier wird aus Sicht des Gegenkontos gebucht, deshalb gedreht.
  const { amount, side } = directed(-movement.amount, "S");
  return {
    date: dateOf(movement.createdAt),
    amount,
    side,
    account: target,
    contraAccount: cashAccount,
    text: shorten(`${CASH_MOVEMENT_LABELS[movement.type]}: ${movement.reason}`, MAX_TEXT),
    // Eine Bargeldbewegung hat keine Belegnummer der Kasse. Die Id waere hier
    // unbrauchbar (36 Zeichen Zufall); die Art plus das Datum ist das, was ein
    // Mensch wiederfindet.
    documentField: shorten(`${movement.type}-${dateOf(movement.createdAt).replaceAll("-", "")}`, MAX_DOCUMENT),
    taxKey: null,
    taxCode: "",
    kind: "CASH_MOVEMENT",
  };
}

// --- Pruefung -------------------------------------------------------------

export interface BalanceCheck {
  readonly ok: boolean;
  /** Summe aller Buchungsbetraege - die Groesse des Stapels. */
  readonly total: Cents;
  /**
   * Saldo des Verrechnungskontos. Muss null sein.
   *
   * Positiv heisst: es steht mehr Umsatz da als Geld dafuer eingegangen ist.
   */
  readonly openClearing: Cents;
  /** Saldo je Konto, Soll positiv. Fuer die Anzeige vor dem Export. */
  readonly byAccount: Readonly<Record<string, Cents>>;
  readonly problems: readonly string[];
}

/**
 * Geht der Stapel auf?
 *
 * Eine Buchung ist hier ein **vollstaendiger Satz**: Konto und Gegenkonto stehen
 * in derselben Zeile. Damit ist "Soll gleich Haben" von selbst erfuellt und
 * prueft nichts - jede Zeile bucht denselben Betrag einmal ins Soll und einmal
 * ins Haben. Diese Pruefung war in einer frueheren Fassung dieses Moduls drin
 * und hat prompt einen Fehlalarm erzeugt.
 *
 * Was tatsaechlich etwas faengt, ist das **Verrechnungskonto**: dort treffen
 * Erloese und Zahlungen jedes Belegs aufeinander, und es muss auf null aufgehen.
 * Bleibt ein Rest, fehlt eine Zahlung zu einem Beleg oder umgekehrt - und dann
 * steht ein Umsatz da, dem kein Geld gegenuebersteht.
 */
export function checkBookingBalance(entries: readonly BookingEntry[], clearingAccount: string): BalanceCheck {
  let total = 0;
  const byAccount: Record<string, Cents> = {};
  const problems: string[] = [];

  // Soll positiv, Haben negativ - so liest sich ein Saldo.
  const add = (account: string, amount: Cents): void => {
    byAccount[account] = (byAccount[account] ?? 0) + amount;
  };

  for (const entry of entries) {
    if (entry.amount < 0) {
      problems.push(`Ein Betrag ist negativ (${entry.documentField}) - das Vorzeichen gehoert in die Seite.`);
      continue;
    }
    if (entry.account === entry.contraAccount) {
      problems.push(`Konto und Gegenkonto sind gleich (${entry.account}, Beleg ${entry.documentField}).`);
      continue;
    }
    total += entry.amount;
    const signed = entry.side === "S" ? entry.amount : -entry.amount;
    add(entry.account, signed);
    add(entry.contraAccount, -signed);
  }

  const openClearing = byAccount[clearingAccount] ?? 0;
  if (openClearing !== 0) {
    problems.push(`Das Verrechnungskonto ${clearingAccount} geht nicht auf null auf, offen sind ${openClearing} Cent.`);
  }
  return { ok: problems.length === 0, total, openClearing, byAccount, problems };
}

/** Welche Konten und Schluessel der Stapel braucht - fuer die Pruefung der Zuordnung. */
export function usedInBookings(
  report: ClosingReport,
  orders: readonly Order[],
): {
  readonly taxKeys: readonly TaxKey[];
  readonly methods: readonly PaymentMethod[];
  readonly movements: readonly CashMovementType[];
  readonly hasDeposit: boolean;
  readonly hasCashDifference: boolean;
} {
  const taxKeys = new Set<TaxKey>();
  const methods = new Set<PaymentMethod>();
  let hasDeposit = false;

  for (const order of orders) {
    for (const line of order.lines) {
      if (line.businessCaseType === "Pfand" || line.businessCaseType === "PfandRueckzahlung") hasDeposit = true;
      else taxKeys.add(line.taxKey);
    }
    for (const payment of order.payments) methods.add(payment.method);
  }
  // Die Kasse wird immer gebraucht: Kassenbewegungen und Differenz laufen
  // darueber, auch wenn kein Beleg bar bezahlt wurde.
  methods.add("CASH");

  return {
    taxKeys: [...taxKeys].sort((a, b) => a - b),
    methods: [...methods].sort(),
    movements: [...new Set(report.cashMovements.map((movement) => movement.type))],
    hasDeposit,
    hasCashDifference: report.cashDifference != null && report.cashDifference !== 0,
  };
}
