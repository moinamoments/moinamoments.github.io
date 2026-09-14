/**
 * Kontenzuordnung fuer die Buchhaltung.
 *
 * ## Warum die Konten nicht fest verdrahtet sind
 *
 * Es gibt keinen "richtigen" Kontenrahmen. SKR03 und SKR04 unterscheiden sich in
 * jeder Nummer, Branchenkontenrahmen kommen dazu, und jeder Betrieb hat mit
 * seinem Steuerberater eine eigene Zuordnung abgestimmt. Ein Kassensystem, das
 * Konten fest einbaut, produziert einen Buchungsstapel, den der Steuerberater
 * hinterher von Hand umbuchen muss - dann ist der Export schaedlich statt
 * nuetzlich.
 *
 * Deshalb: die Zuordnung gehoert zum Mandanten und ist einstellbar. Die
 * `SKR03_PROPOSAL` und `SKR04_PROPOSAL` sind **Vorschlaege** mit den ueblichen
 * Konten der beiden Standardkontenrahmen - damit niemand vor zwoelf leeren
 * Feldern sitzt. Sie sind nicht abgestimmt, und das Feld `confirmed` haelt
 * genau das fest.
 *
 * ## Der Verrechnungsweg, und warum es ihn braucht
 *
 * Ein Beleg hat zwei Aufteilungen, die nicht zueinander passen: Erloese je
 * **Steuersatz** und Zahlungen je **Zahlart**. Ein Beleg mit 7 % und 19 %, bezahlt
 * halb bar und halb mit Karte, laesst sich nicht direkt gegeneinander buchen -
 * jede Zuordnung waere eine Erfindung.
 *
 * Deshalb laeuft jeder Beleg ueber ein **Verrechnungskonto** (durchlaufende
 * Posten):
 *
 *   Erloese 19 %   an  Verrechnung
 *   Erloese  7 %   an  Verrechnung
 *   Kasse          an  Verrechnung   (andere Richtung)
 *   Karte          an  Verrechnung
 *
 * Das Verrechnungskonto geht je Beleg auf null auf. Der Vorteil ist nicht
 * Bequemlichkeit, sondern Genauigkeit: es wird nichts geschaetzt und nichts
 * umgelegt, und jede Zeile traegt ihre Belegnummer.
 *
 * ## Umsatzsteuer: Automatikkonten oder BU-Schluessel
 *
 * In DATEV tragen **Automatikkonten** ihren Steuersatz selbst (8400 ist "Erloese
 * 19 % USt"); dann bleibt der BU-Schluessel leer und darf auch nicht gesetzt
 * werden. Wer stattdessen neutrale Erloeskonten verwendet, braucht je Steuersatz
 * einen BU-Schluessel - und den bestimmt der Steuerberater, nicht die Kasse.
 * `taxCode` ist deshalb einstellbar und standardmaessig leer.
 */

import type { CashMovementType } from "../cashbook.ts";
import type { PaymentMethod } from "../model.ts";
import { STANDARD_TAX_RATES, TAX_RATES, type TaxKey } from "../tax.ts";

export class AccountingError extends Error {}

/** Bekannte Kontenrahmen. `CUSTOM` heisst: der Betrieb hat eigene Nummern. */
export type ChartOfAccounts = "SKR03" | "SKR04" | "CUSTOM";

export const CHART_LABELS: Record<ChartOfAccounts, string> = {
  SKR03: "SKR03 (Standardkontenrahmen 03)",
  SKR04: "SKR04 (Standardkontenrahmen 04)",
  CUSTOM: "eigene Konten",
};

export interface AccountMapping {
  readonly chart: ChartOfAccounts;
  /**
   * Laenge der Sachkonten, 4 bis 8.
   *
   * Steht im Kopf der DATEV-Datei und muss zur Einstellung des Steuerberaters
   * passen. Stimmt sie nicht, liest DATEV die Konten falsch - aus 8400 wird
   * 84000.
   */
  readonly accountLength: number;
  /** Erloeskonto je Steuerschluessel der DSFinV-K. */
  readonly revenue: Readonly<Record<string, string>>;
  /** Konto fuer Pfandeinnahmen und -rueckzahlungen. */
  readonly deposit: string;
  /** Geldkonto je Zahlart. */
  readonly payment: Readonly<Record<string, string>>;
  /** Verrechnungskonto, ueber das jeder Beleg ausgeglichen wird. */
  readonly clearing: string;
  /** Konto fuer eine Kassendifferenz. */
  readonly cashDifference: string;
  /** Konto je Art der Bargeldbewegung. */
  readonly cashMovement: Readonly<Record<string, string>>;
  /** Konto fuer Rabatte, wenn sie getrennt gebucht werden sollen; leer = im Erloes. */
  readonly discount?: string | null;
  /** BU-Schluessel je Steuerschluessel. Leer bei Automatikkonten. */
  readonly taxCode?: Readonly<Record<string, string>>;
  /**
   * Hat der Steuerberater die Zuordnung bestaetigt?
   *
   * Kein technisches Feld: es entscheidet darueber, ob die Oberflaeche den
   * Export als abgestimmt oder als Vorschlag kennzeichnet. Ein Buchungsstapel
   * aus unbestaetigten Konten ist Arbeit fuer jemand anderen.
   */
  readonly confirmed: boolean;
}

/**
 * Vorschlag fuer SKR03.
 *
 * **Nicht abgestimmt.** Die Nummern sind die ueblichen des Kontenrahmens; ob sie
 * fuer diesen Betrieb richtig sind, weiss nur sein Steuerberater.
 */
export const SKR03_PROPOSAL: AccountMapping = {
  chart: "SKR03",
  accountLength: 4,
  revenue: {
    [TAX_RATES.NORMAL.key]: "8400", // Erloese 19 % USt
    [TAX_RATES.REDUCED.key]: "8300", // Erloese 7 % USt
    [TAX_RATES.AVERAGE_10_7.key]: "8300", // 10,7 % Durchschnittssatz
    [TAX_RATES.AVERAGE_5_5.key]: "8300", // 5,5 % Durchschnittssatz
    [TAX_RATES.NOT_TAXABLE.key]: "8200", // Erloese, nicht steuerbar
    [TAX_RATES.EXEMPT.key]: "8200", // Erloese, steuerfrei
    [TAX_RATES.UNKNOWN.key]: "8200",
  },
  // Pfand ist beim Verkauf umsatzsteuerpflichtig wie die Ware, mit der es
  // ausgegeben wird - deshalb dasselbe Erloeskonto wie 19 %. Wer es getrennt
  // sehen will, legt ein eigenes Konto an.
  deposit: "8400",
  payment: {
    CASH: "1000", // Kasse
    // Karte und Mobilzahlung liegen bis zur Auszahlung des Anbieters im
    // Geldtransit: das Geld ist weg vom Kunden und noch nicht auf dem Konto.
    CARD_DEBIT: "1360",
    CARD_CREDIT: "1360",
    MOBILE: "1360",
    INVOICE: "1400", // Forderungen aus Lieferungen und Leistungen
    VOUCHER: "1590", // durchlaufende Posten
    OTHER: "1590",
  },
  clearing: "1590", // durchlaufende Posten
  cashDifference: "4970", // Nebenkosten des Geldverkehrs
  cashMovement: {
    DEPOSIT: "1890", // Privateinlagen
    WITHDRAWAL: "1800", // Privatentnahmen allgemein
    TRANSIT: "1360", // Geldtransit
    TIP_OUT: "1590", // Trinkgeld an Arbeitnehmer: durchlaufender Posten
    OPENING: "1360",
  },
  discount: null,
  taxCode: {},
  confirmed: false,
};

/**
 * Vorschlag fuer SKR04.
 *
 * **Nicht abgestimmt** - dieselbe Einschraenkung wie bei SKR03.
 */
export const SKR04_PROPOSAL: AccountMapping = {
  chart: "SKR04",
  accountLength: 4,
  revenue: {
    [TAX_RATES.NORMAL.key]: "4400",
    [TAX_RATES.REDUCED.key]: "4300",
    [TAX_RATES.AVERAGE_10_7.key]: "4300",
    [TAX_RATES.AVERAGE_5_5.key]: "4300",
    [TAX_RATES.NOT_TAXABLE.key]: "4200",
    [TAX_RATES.EXEMPT.key]: "4200",
    [TAX_RATES.UNKNOWN.key]: "4200",
  },
  deposit: "4400",
  payment: {
    CASH: "1600", // Kasse
    CARD_DEBIT: "1460", // Geldtransit
    CARD_CREDIT: "1460",
    MOBILE: "1460",
    INVOICE: "1200", // Forderungen aus Lieferungen und Leistungen
    VOUCHER: "1370", // durchlaufende Posten
    OTHER: "1370",
  },
  clearing: "1370",
  cashDifference: "6855", // Nebenkosten des Geldverkehrs
  cashMovement: {
    DEPOSIT: "2180", // Privateinlagen
    WITHDRAWAL: "2100", // Privatentnahmen allgemein
    TRANSIT: "1460",
    TIP_OUT: "1370",
    OPENING: "1460",
  },
  discount: null,
  taxCode: {},
  confirmed: false,
};

export function proposalFor(chart: ChartOfAccounts): AccountMapping {
  return chart === "SKR04" ? SKR04_PROPOSAL : SKR03_PROPOSAL;
}

/** Konto fuer einen Steuerschluessel, oder `null`, wenn keines eingestellt ist. */
export function revenueAccount(mapping: AccountMapping, taxKey: TaxKey): string | null {
  return mapping.revenue[String(taxKey)] ?? null;
}

export function paymentAccount(mapping: AccountMapping, method: PaymentMethod): string | null {
  return mapping.payment[method] ?? null;
}

export function cashMovementAccount(mapping: AccountMapping, type: CashMovementType): string | null {
  return mapping.cashMovement[type] ?? null;
}

/** BU-Schluessel fuer einen Steuerschluessel; leer bedeutet Automatikkonto. */
export function taxCodeFor(mapping: AccountMapping, taxKey: TaxKey): string {
  return mapping.taxCode?.[String(taxKey)] ?? "";
}

/** Eine Kontonummer, wie sie in eine Buchhaltung darf. */
export function checkAccountNumber(input: string, label: string, length: number): { ok: true; value: string } | { ok: false; reason: string } {
  const value = input.trim();
  if (value === "") return { ok: false, reason: `${label} fehlt.` };
  if (!/^\d+$/.test(value)) return { ok: false, reason: `${label} darf nur Ziffern enthalten, war "${value}".` };
  // Personenkonten (Debitoren, Kreditoren) sind eine Stelle laenger als die
  // Sachkonten. Beides ist zulaessig, mehr nicht.
  if (value.length !== length && value.length !== length + 1) {
    return {
      ok: false,
      reason: `${label} hat ${value.length} Stellen; bei Sachkontenlaenge ${length} sind ${length} (Sachkonto) oder ${length + 1} (Personenkonto) zulaessig.`,
    };
  }
  return { ok: true, value };
}

export interface MappingCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** Hinweise, die den Export nicht verhindern, aber gelesen werden sollten. */
  readonly notes: readonly string[];
}

/**
 * Kontenzuordnung pruefen, bevor exportiert wird.
 *
 * Sammelt alle Maengel statt beim ersten abzubrechen: wer zwoelf Konten
 * eintraegt, will alle Probleme auf einmal sehen. Geprueft werden nur die
 * Konten, die fuer die tatsaechlich vorkommenden Vorgaenge gebraucht werden -
 * ein Betrieb ohne Kartenzahlung braucht kein Kartenkonto.
 */
export function checkAccountMapping(
  mapping: AccountMapping,
  used: {
    readonly taxKeys?: readonly TaxKey[];
    readonly methods?: readonly PaymentMethod[];
    readonly movements?: readonly CashMovementType[];
    readonly hasDeposit?: boolean;
    readonly hasCashDifference?: boolean;
  } = {},
): MappingCheck {
  const problems: string[] = [];
  const notes: string[] = [];
  const length = mapping.accountLength;

  if (!Number.isInteger(length) || length < 4 || length > 8) {
    problems.push(`Die Sachkontenlaenge muss zwischen 4 und 8 liegen, war ${length}.`);
  }

  const require = (value: string | null | undefined, label: string): void => {
    if (value == null || value.trim() === "") {
      problems.push(`${label} ist nicht eingestellt.`);
      return;
    }
    const checked = checkAccountNumber(value, label, length);
    if (!checked.ok) problems.push(checked.reason);
  };

  for (const taxKey of used.taxKeys ?? []) {
    const rate = STANDARD_TAX_RATES.find((entry) => entry.key === taxKey);
    require(revenueAccount(mapping, taxKey), `Das Erloeskonto fuer ${rate?.label ?? `Steuerschluessel ${taxKey}`}`);
  }
  for (const method of used.methods ?? []) {
    require(paymentAccount(mapping, method), `Das Geldkonto fuer die Zahlart ${method}`);
  }
  for (const type of used.movements ?? []) {
    if (type === "OPENING") continue; // Die Eroeffnung wird nicht gebucht.
    require(cashMovementAccount(mapping, type), `Das Konto fuer ${type}`);
  }
  if (used.hasDeposit) require(mapping.deposit, "Das Konto fuer Pfand");
  if (used.hasCashDifference) require(mapping.cashDifference, "Das Konto fuer die Kassendifferenz");
  require(mapping.clearing, "Das Verrechnungskonto");

  if (!mapping.confirmed) {
    notes.push(
      "Die Kontenzuordnung ist nicht mit dem Steuerberater abgestimmt. Die Vorschlaege sind die ueblichen Konten des Kontenrahmens - ob sie fuer diesen Betrieb stimmen, entscheidet er.",
    );
  }
  const codes = Object.values(mapping.taxCode ?? {}).filter((code) => code.trim() !== "");
  if (codes.length === 0) {
    notes.push(
      "Es sind keine BU-Schluessel eingestellt. Das ist richtig, wenn die Erloeskonten Automatikkonten sind (sie tragen ihren Steuersatz selbst). Bei neutralen Konten fehlt die Umsatzsteuer im Stapel.",
    );
  }
  return { ok: problems.length === 0, problems, notes };
}
