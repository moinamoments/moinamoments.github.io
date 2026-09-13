/**
 * Kassenbuch: Tageseroeffnung und Bargeldbewegungen ohne Umsatz.
 *
 * Nicht jede Bewegung in der Geldschublade ist ein Verkauf. Am Anfang des Tages
 * liegt Wechselgeld darin, zwischendurch holt der Inhaber Geld heraus, am Abend
 * wandert der Umsatz in den Tresor. Alle diese Bewegungen gehoeren aufgezeichnet
 * - sie erklaeren die Differenz zwischen Umsatz und Kassenbestand, und ohne sie
 * ist die Kasse nicht kassensturzfaehig.
 *
 * Die Arten entsprechen den Geschaeftsvorfallarten der DSFinV-K, damit sie im
 * Export nicht erst uebersetzt werden muessen:
 *
 *   - `OPENING`      Anfangsbestand des Tages (Wechselgeld)
 *   - `DEPOSIT`      Einlage, z. B. nachgelegtes Wechselgeld  -> Privateinlage
 *   - `WITHDRAWAL`   Entnahme durch den Inhaber               -> Privatentnahme
 *   - `TRANSIT`      Geldtransit: in den Tresor, zur Bank     -> Geldtransit
 *   - `TIP_OUT`      Auszahlung von Trinkgeld an das Personal -> TrinkgeldAN
 *
 * Bewusst **kein** `CORRECTION`: eine Differenz wird nicht wegbebucht, sondern
 * im Kassenabschluss als Differenz ausgewiesen. Wer sie glattbuchen kann, macht
 * das Zaehlen sinnlos.
 */

import { type Cents, cents, formatAmount } from "./money.ts";
import type { BusinessCaseType, CashCountEntry, Id, Timestamp } from "./model.ts";
import { countCash } from "./closing.ts";

export class CashbookError extends Error {}

export type CashMovementType = "OPENING" | "DEPOSIT" | "WITHDRAWAL" | "TRANSIT" | "TIP_OUT";

export const CASH_MOVEMENT_LABELS: Record<CashMovementType, string> = {
  OPENING: "Anfangsbestand",
  DEPOSIT: "Einlage",
  WITHDRAWAL: "Entnahme",
  TRANSIT: "Geldtransit",
  TIP_OUT: "Trinkgeld ausgezahlt",
};

/** Zuordnung zur Geschaeftsvorfallart der DSFinV-K. */
export const CASH_MOVEMENT_BUSINESS_CASE: Record<CashMovementType, BusinessCaseType> = {
  // Der Anfangsbestand ist in der DSFinV-K ein Geldtransit in die Kasse.
  OPENING: "Geldtransit",
  DEPOSIT: "Privateinlage",
  WITHDRAWAL: "Privatentnahme",
  TRANSIT: "Geldtransit",
  TIP_OUT: "TrinkgeldAN",
};

/** Bewegungen, die den Bestand erhoehen. Die uebrigen mindern ihn. */
const INCREASES: readonly CashMovementType[] = ["OPENING", "DEPOSIT"];

export interface CashMovement {
  readonly id: Id;
  readonly tenantId: Id;
  readonly storeId: Id;
  readonly deviceId: Id;
  readonly type: CashMovementType;
  /**
   * Betrag mit Vorzeichen: positiv erhoeht den Kassenbestand, negativ mindert
   * ihn. Das Vorzeichen steckt im Betrag und nicht nur in der Art, damit eine
   * Summe ueber die Bewegungen ohne Fallunterscheidung stimmt.
   */
  readonly amount: Cents;
  readonly reason: string;
  /** Zaehlprotokoll, wenn die Bewegung gezaehlt wurde (Tageseroeffnung). */
  readonly cashCount?: readonly CashCountEntry[];
  readonly userId: Id;
  readonly createdAt: Timestamp;
}

export interface CashMovementRequest {
  readonly id: Id;
  readonly tenantId: Id;
  readonly storeId: Id;
  readonly deviceId: Id;
  readonly type: CashMovementType;
  /** Betrag ohne Vorzeichen - die Richtung ergibt sich aus der Art. */
  readonly amount: Cents;
  readonly reason: string;
  readonly cashCount?: readonly CashCountEntry[];
  readonly userId: Id;
  readonly createdAt: Timestamp;
}

/**
 * Bargeldbewegung bilden.
 *
 * Der Grund ist Pflicht. Eine Entnahme ohne Grund ist bei einer Kassennachschau
 * nicht erklaerbar, und "war schon immer so" zaehlt dort nicht.
 */
export function buildCashMovement(request: CashMovementRequest): CashMovement {
  cents(request.amount);
  if (request.amount < 0) {
    throw new CashbookError("Der Betrag wird ohne Vorzeichen angegeben - die Richtung ergibt sich aus der Art");
  }
  if (request.amount === 0) throw new CashbookError("Eine Bewegung ueber 0,00 EUR ist keine Bewegung");

  const reason = request.reason.trim();
  if (reason === "") {
    throw new CashbookError(`${CASH_MOVEMENT_LABELS[request.type]} braucht einen Grund`);
  }

  if (request.cashCount && request.cashCount.length > 0) {
    const counted = countCash(request.cashCount);
    if (counted !== request.amount) {
      throw new CashbookError(
        `Das Zaehlprotokoll ergibt ${formatAmount(counted)}, angegeben wurde ${formatAmount(request.amount)}`,
      );
    }
  }

  const signed = INCREASES.includes(request.type) ? request.amount : -request.amount;
  return {
    id: request.id,
    tenantId: request.tenantId,
    storeId: request.storeId,
    deviceId: request.deviceId,
    type: request.type,
    amount: signed,
    reason,
    ...(request.cashCount ? { cashCount: request.cashCount } : {}),
    userId: request.userId,
    createdAt: request.createdAt,
  };
}

/**
 * Tag eroeffnen: Anfangsbestand zaehlen und festhalten.
 *
 * Ohne Anfangsbestand ist die Differenz am Abend nicht aussagekraeftig - das
 * Wechselgeld waere dann ein Ueberschuss. Deshalb ist die Tageseroeffnung kein
 * Beiwerk, sondern der Bezugspunkt des ganzen Tages.
 */
export function openDay(request: {
  readonly id: Id;
  readonly tenantId: Id;
  readonly storeId: Id;
  readonly deviceId: Id;
  readonly userId: Id;
  readonly createdAt: Timestamp;
  readonly cashCount: readonly CashCountEntry[];
  readonly reason?: string;
}): CashMovement {
  const amount = countCash(request.cashCount);
  if (amount === 0) {
    // Ein Tag ohne Wechselgeld ist moeglich, aber dann gibt es auch nichts zu
    // buchen: der Anfangsbestand ist 0 und der Abschluss rechnet damit.
    throw new CashbookError("Der gezaehlte Anfangsbestand ist 0,00 EUR - dann ist keine Eroeffnungsbuchung noetig");
  }
  return buildCashMovement({
    id: request.id,
    tenantId: request.tenantId,
    storeId: request.storeId,
    deviceId: request.deviceId,
    type: "OPENING",
    amount,
    reason: request.reason?.trim() || "Anfangsbestand gezaehlt",
    cashCount: request.cashCount,
    userId: request.userId,
    createdAt: request.createdAt,
  });
}

/** Summe der Bewegungen mit Vorzeichen. */
export function cashMovementTotal(movements: readonly CashMovement[]): Cents {
  return movements.reduce((sum, movement) => sum + movement.amount, 0);
}

/** Anfangsbestand des Zeitraums: die Eroeffnungsbuchungen. */
export function openingCashFrom(movements: readonly CashMovement[]): Cents {
  return movements
    .filter((movement) => movement.type === "OPENING")
    .reduce((sum, movement) => sum + movement.amount, 0);
}

/** Bewegungen ohne die Eroeffnung - Einlagen, Entnahmen, Transit. */
export function cashMovementsWithoutOpening(movements: readonly CashMovement[]): CashMovement[] {
  return movements.filter((movement) => movement.type !== "OPENING");
}

export interface CashbookSummary {
  readonly opening: Cents;
  readonly deposits: Cents;
  readonly withdrawals: Cents;
  readonly transits: Cents;
  readonly tipOuts: Cents;
  /** Alles ohne die Eroeffnung, mit Vorzeichen. */
  readonly netMovements: Cents;
}

export function summarizeCashbook(movements: readonly CashMovement[]): CashbookSummary {
  const sumOf = (type: CashMovementType): Cents =>
    movements.filter((movement) => movement.type === type).reduce((sum, movement) => sum + movement.amount, 0);

  const opening = sumOf("OPENING");
  return {
    opening,
    deposits: sumOf("DEPOSIT"),
    withdrawals: sumOf("WITHDRAWAL"),
    transits: sumOf("TRANSIT"),
    tipOuts: sumOf("TIP_OUT"),
    netMovements: cashMovementTotal(movements) - opening,
  };
}

/** Eine Zeile fuers Kassenbuch, wie sie angezeigt und gedruckt wird. */
export function formatCashMovement(movement: CashMovement): string {
  return `${CASH_MOVEMENT_LABELS[movement.type]}: ${formatAmount(movement.amount)} - ${movement.reason}`;
}
