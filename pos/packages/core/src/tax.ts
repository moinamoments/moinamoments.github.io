/**
 * Umsatzsteuer.
 *
 * Deutsche Kassenpreise sind Bruttopreise: der Kunde sieht 4,50 EUR und der
 * Steueranteil wird herausgerechnet, nicht aufgeschlagen. Das ist die
 * umgekehrte Richtung der meisten internationalen POS-Bibliotheken und die
 * Quelle der haeufigsten Rundungsfehler.
 *
 * Gerundet wird *je Steuersatz auf der Belegsumme*, nicht je Position.
 * Sonst weicht die ausgewiesene Steuer um Cent von der Summe ab, die das
 * Finanzamt aus Netto mal Satz nachrechnet.
 *
 * Die Schluesselnummern sind die der DSFinV-K (Anlage C, "USt_Schluessel").
 * Sie sind kein Freitext: der Export muss exakt diese Nummern verwenden.
 */

import { type BasisPoints, type Cents, cents, formatDecimal, roundHalfUp, sumCents } from "./money.ts";

/** Schluesselnummer eines Steuersatzes nach DSFinV-K. */
export type TaxKey = number;

export interface TaxRate {
  /** DSFinV-K USt_Schluessel. 1..8 sind bundesweit belegt, ab 11 frei. */
  readonly key: TaxKey;
  /** Satz in Hundertstel Prozent, z. B. 1900 fuer 19,00 %. */
  readonly rate: BasisPoints;
  /** Bezeichnung fuer Bon und Berichte. */
  readonly label: string;
}

/**
 * Bundesweit festgelegte Schluessel der DSFinV-K.
 *
 * Achtung: Die Zuordnung ist normativ vorgegeben. Eigene Saetze - etwa die
 * befristeten 16 % / 5 % aus 2020 oder auslaendische Saetze bei einer
 * spaeteren Expansion - gehoeren in den Bereich ab 11 und werden pro Mandant
 * konfiguriert, nicht hier eingetragen.
 */
export const TAX_RATES = {
  /** Regelsteuersatz, § 12 Abs. 1 UStG. */
  NORMAL: { key: 1, rate: 1900, label: "19 %" },
  /** Ermaessigter Satz, § 12 Abs. 2 UStG - u. a. Speisen ausser Haus. */
  REDUCED: { key: 2, rate: 700, label: "7 %" },
  /** Durchschnittssatz § 24 Abs. 1 Nr. 3 UStG (Land- und Forstwirtschaft). */
  AVERAGE_10_7: { key: 3, rate: 1070, label: "10,7 %" },
  /** Durchschnittssatz § 24 Abs. 1 Nr. 1 UStG. */
  AVERAGE_5_5: { key: 4, rate: 550, label: "5,5 %" },
  /** Nicht steuerbar (z. B. Pfandrueckgabe, Durchlaufposten). */
  NOT_TAXABLE: { key: 5, rate: 0, label: "nicht steuerbar" },
  /** Umsatzsteuerfrei (z. B. Kleinunternehmer nach § 19 UStG). */
  EXEMPT: { key: 6, rate: 0, label: "umsatzsteuerfrei" },
  /** Umsatzsteuer nicht ermittelbar - Ausnahmefall, sollte leer bleiben. */
  UNKNOWN: { key: 7, rate: 0, label: "nicht ermittelbar" },
} as const satisfies Record<string, TaxRate>;

export type StandardTaxName = keyof typeof TAX_RATES;

/** Alle bundesweiten Saetze als Liste, aufsteigend nach Schluessel. */
export const STANDARD_TAX_RATES: readonly TaxRate[] = Object.values(TAX_RATES);

/**
 * Bewirtungsform. Entscheidet bei Speisen ueber 19 % oder 7 %:
 * Verzehr an Ort und Stelle ist eine sonstige Leistung (19 %), Mitnahme
 * eine Lieferung (7 %). Fuer einen Verkaufsanhaenger ist das der Normalfall
 * und muss pro Beleg umschaltbar sein - nicht pro Artikel fest verdrahtet.
 */
export type ServiceMode = "TAKEAWAY" | "DINE_IN";

export class TaxError extends Error {}

export interface TaxRegistry {
  /** Satz zu einem Schluessel. Wirft, wenn der Schluessel unbekannt ist. */
  get(key: TaxKey): TaxRate;
  /** Alle bekannten Saetze. */
  all(): readonly TaxRate[];
}

/**
 * Steuersatz-Verzeichnis eines Mandanten: die bundesweiten Saetze plus
 * eigene Saetze ab Schluessel 11.
 */
export function createTaxRegistry(custom: readonly TaxRate[] = []): TaxRegistry {
  const map = new Map<TaxKey, TaxRate>();
  for (const rate of STANDARD_TAX_RATES) map.set(rate.key, rate);
  for (const rate of custom) {
    if (rate.key < 11) {
      throw new TaxError(
        `Eigene Steuersaetze muessen den Schluessel 11 oder hoeher haben, ${rate.key} ist bundesweit belegt`,
      );
    }
    map.set(rate.key, rate);
  }
  return {
    get(key) {
      const rate = map.get(key);
      if (!rate) throw new TaxError(`Unbekannter Steuerschluessel ${key}`);
      return rate;
    },
    all() {
      return [...map.values()].sort((a, b) => a.key - b.key);
    },
  };
}

/** Aus einem Bruttobetrag den enthaltenen Steueranteil herausrechnen. */
export function taxFromGross(gross: Cents, rate: BasisPoints): Cents {
  cents(gross);
  if (rate === 0) return 0;
  // brutto * satz / (10000 + satz) - in einem Schritt, damit nur einmal
  // gerundet wird.
  return roundHalfUp((gross * rate) / (10_000 + rate));
}

/** Nettobetrag eines Bruttobetrags. Immer brutto minus Steuer, nie separat gerundet. */
export function netFromGross(gross: Cents, rate: BasisPoints): Cents {
  return cents(gross) - taxFromGross(gross, rate);
}

/** Bruttobetrag aus einem Netto, fuer Importe aus Systemen mit Nettopreisen. */
export function grossFromNet(net: Cents, rate: BasisPoints): Cents {
  cents(net);
  return net + roundHalfUp((net * rate) / 10_000);
}

/** Summenzeile eines Steuersatzes, wie sie auf dem Bon erscheint. */
export interface TaxGroupTotal {
  readonly key: TaxKey;
  readonly rate: BasisPoints;
  readonly label: string;
  readonly gross: Cents;
  readonly net: Cents;
  readonly tax: Cents;
}

/**
 * Bruttobetraege je Steuerschluessel zu Summenzeilen verdichten.
 *
 * Die Steuer wird auf der aggregierten Bruttosumme berechnet. Gruppen mit
 * Bruttosumme 0 entfallen - ausser der Beleg besteht ausschliesslich aus
 * ihnen (0-EUR-Beleg), dann bleibt die Zeile stehen, weil ein Beleg ohne
 * jede Steuerzeile nicht pruefbar waere.
 */
export function summarizeTax(
  entries: readonly { readonly taxKey: TaxKey; readonly gross: Cents }[],
  registry: TaxRegistry = createTaxRegistry(),
): TaxGroupTotal[] {
  const byKey = new Map<TaxKey, Cents[]>();
  for (const entry of entries) {
    const bucket = byKey.get(entry.taxKey);
    if (bucket) bucket.push(cents(entry.gross));
    else byKey.set(entry.taxKey, [cents(entry.gross)]);
  }

  const groups: TaxGroupTotal[] = [];
  for (const [key, amounts] of byKey) {
    const rate = registry.get(key);
    const gross = sumCents(amounts);
    const tax = taxFromGross(gross, rate.rate);
    groups.push({ key, rate: rate.rate, label: rate.label, gross, net: gross - tax, tax });
  }
  groups.sort((a, b) => a.key - b.key);

  const nonZero = groups.filter((g) => g.gross !== 0);
  return nonZero.length > 0 ? nonZero : groups;
}

/**
 * Steuerschluessel einer Position bestimmen.
 *
 * Hat der Artikel einen abweichenden Satz fuer Verzehr vor Ort hinterlegt,
 * gewinnt der bei `DINE_IN`. Sonst gilt der Standardsatz des Artikels.
 * Kleinunternehmer nach § 19 UStG weisen keine Steuer aus - dann wird jede
 * Position auf "umsatzsteuerfrei" gezogen, unabhaengig vom Artikel.
 */
export function resolveTaxKey(
  article: { readonly taxKey: TaxKey; readonly taxKeyDineIn?: TaxKey | null },
  mode: ServiceMode,
  smallBusiness = false,
): TaxKey {
  if (smallBusiness) return TAX_RATES.EXEMPT.key;
  if (mode === "DINE_IN" && article.taxKeyDineIn != null) return article.taxKeyDineIn;
  return article.taxKey;
}

/**
 * Steuersaetze im Format der TSE-Prozessdaten `Kassenbeleg-V1`.
 *
 * Die Reihenfolge ist durch die technische Richtlinie festgelegt und darf
 * nicht veraendert werden:
 * 1. Regelsteuersatz (19 %)
 * 2. ermaessigter Satz (7 %)
 * 3. Durchschnittssatz 10,7 %
 * 4. Durchschnittssatz 5,5 %
 * 5. Null / nicht steuerbar / steuerfrei (zusammengefasst)
 */
export const KASSENBELEG_TAX_ORDER: readonly TaxKey[] = [1, 2, 3, 4, 5];

/** Die fuenf Bruttofelder der Prozessdaten, mit Punkt als Trennzeichen. */
export function kassenbelegTaxFields(groups: readonly TaxGroupTotal[]): string[] {
  const buckets = new Map<TaxKey, Cents>();
  for (const key of KASSENBELEG_TAX_ORDER) buckets.set(key, 0);
  for (const group of groups) {
    // Alles ohne Steuer (Schluessel 5, 6, 7) faellt in das fuenfte Feld.
    const slot = KASSENBELEG_TAX_ORDER.includes(group.key) ? group.key : 5;
    buckets.set(slot, (buckets.get(slot) ?? 0) + group.gross);
  }
  return KASSENBELEG_TAX_ORDER.map((key) => formatDecimal(buckets.get(key) ?? 0));
}
