/**
 * Lexware-Buchungsstapel als CSV.
 *
 * Lexware buchhalter liest Buchungen ueber einen **Importassistenten**, in dem
 * der Anwender die Spalten der Datei einmal den Feldern des Programms zuordnet
 * und die Zuordnung als Vorlage speichert. Es gibt kein festes Format wie bei
 * DATEV, an das eine Datei sich halten muesste.
 *
 * Das hat eine Folge, die hier ausdruecklich steht, damit niemand etwas anderes
 * erwartet: **diese Datei wird beim ersten Import einmal zugeordnet.** Danach
 * laeuft es ohne Nachfrage. Die Spaltennamen sind deshalb deutsch,
 * selbsterklaerend und stabil - sie zu aendern hiesse, die Vorlage jedes Kunden
 * zu zerstoeren.
 *
 * ## Unterschiede zur DATEV-Datei
 *
 * Derselbe Buchungsstapel, nur anders geschrieben:
 *
 *   - **Soll- und Habenkonto stehen in eigenen Spalten** statt als Konto,
 *     Gegenkonto und Kennzeichen. Das ist die Form, in der ein Mensch einen
 *     Buchungssatz liest, und Lexware erwartet sie so.
 *   - **Volles Datum** (TT.MM.JJJJ) statt nur Tag und Monat. Ein Stapel ueber
 *     einen Jahreswechsel ist damit eindeutig - bei DATEV ergibt sich das Jahr
 *     aus dem Kopf.
 *   - **Kein Kopf mit Berater- und Mandantennummer.** Die kennt Lexware aus der
 *     geoeffneten Firma; sie in die Datei zu schreiben waere ueberfluessig und
 *     eine Fehlerquelle.
 *   - Der **Steuersatz** steht als Prozentzahl dabei. Lexware kann ihn zur
 *     Pruefung gegen das Konto verwenden; bei Automatikkonten ignoriert es ihn.
 */

import { formatAmount } from "../money.ts";
import { STANDARD_TAX_RATES } from "../tax.ts";
import { AccountingError } from "./accounts.ts";
import type { BookingEntry } from "./bookings.ts";

/** Trennzeichen. Semikolon, wie es eine deutsche Tabellenkalkulation erwartet. */
export const LEXWARE_SEPARATOR = ";";

/** Byte-Reihenfolge-Marke, damit Umlaute in Excel und Lexware ankommen. */
export const LEXWARE_BOM = "﻿";

/**
 * Spalten der Datei.
 *
 * Reihenfolge und Benennung sind Teil der Zusage an den Anwender: seine
 * Importvorlage in Lexware haengt daran.
 */
export const LEXWARE_COLUMNS: readonly string[] = [
  "Belegdatum",
  "Belegnummer",
  "Buchungstext",
  "Betrag",
  "Sollkonto",
  "Habenkonto",
  "Steuersatz",
  "Art",
];

/** Klartext der Buchungsart - hilft beim Zuordnen und beim Nachlesen. */
const KIND_LABELS: Record<BookingEntry["kind"], string> = {
  REVENUE: "Erloes",
  DEPOSIT: "Pfand",
  TIP: "Trinkgeld",
  PAYMENT: "Zahlung",
  CASH_MOVEMENT: "Kassenbewegung",
  CASH_DIFFERENCE: "Kassendifferenz",
};

function field(value: string): string {
  if (value.includes(LEXWARE_SEPARATOR) || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

/** `YYYY-MM-DD` zu `TT.MM.JJJJ`. */
function germanDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new AccountingError(`"${date}" ist kein Datum in der Form JJJJ-MM-TT.`);
  return `${match[3]}.${match[2]}.${match[1]}`;
}

/**
 * Soll- und Habenkonto aus einem Satz.
 *
 * Der Satz traegt Konto, Gegenkonto und die Seite, auf der das Konto steht.
 * Steht das Konto im Soll, ist das Gegenkonto im Haben - und umgekehrt. Diese
 * Umrechnung ist der ganze Unterschied der beiden Formate.
 */
function sides(entry: BookingEntry): { debit: string; credit: string } {
  return entry.side === "S"
    ? { debit: entry.account, credit: entry.contraAccount }
    : { debit: entry.contraAccount, credit: entry.account };
}

/** Steuersatz als Prozentzahl; leer, wo keiner gilt (Geldkonten, Transit). */
function taxPercent(entry: BookingEntry): string {
  if (entry.taxKey == null) return "";
  const rate = STANDARD_TAX_RATES.find((entry2) => entry2.key === entry.taxKey);
  if (!rate) return "";
  // Bei 0 % bleibt das Feld leer statt "0": Lexware unterscheidet nicht
  // zwischen steuerfrei, nicht steuerbar und nicht ermittelbar, und eine 0
  // wuerde eine Aussage vortaeuschen, die nicht in der Zahl steckt.
  return rate.rate === 0 ? "" : String(rate.rate / 100);
}

/** Buchungsstapel im Lexware-Format. */
export function buildLexwareFile(entries: readonly BookingEntry[]): string {
  const lines = [LEXWARE_COLUMNS.map(field).join(LEXWARE_SEPARATOR)];

  for (const entry of entries) {
    if (entry.amount < 0) {
      throw new AccountingError(`Ein Betrag darf nicht negativ sein, war ${entry.amount} (Beleg ${entry.documentField}).`);
    }
    const { debit, credit } = sides(entry);
    lines.push(
      [
        germanDate(entry.date),
        field(entry.documentField),
        field(entry.text),
        // Dezimalkomma, weil die Datei in einer deutschen Umgebung geoeffnet
        // wird - derselbe Grund wie beim Artikelexport.
        formatAmount(entry.amount),
        debit,
        credit,
        taxPercent(entry),
        field(KIND_LABELS[entry.kind]),
      ].join(LEXWARE_SEPARATOR),
    );
  }
  return LEXWARE_BOM + lines.join("\r\n") + "\r\n";
}

export function lexwareFileName(from: string, to: string): string {
  const compact = (date: string): string => date.replaceAll("-", "");
  return `lexware-buchungen-${compact(from)}-${compact(to)}.csv`;
}

/**
 * Hinweis fuer den ersten Import.
 *
 * Steht in der Oberflaeche neben dem Knopf. Ohne ihn sucht der Anwender in
 * Lexware nach einem Format, das es nicht gibt.
 */
export const LEXWARE_IMPORT_HINT: readonly string[] = [
  "In Lexware buchhalter: Datei › Import/Export › Import von Buchungssaetzen.",
  "Beim ersten Mal die Spalten der Datei den Feldern zuordnen und die Zuordnung als Vorlage speichern.",
  "Trennzeichen ist das Semikolon, der Zeichensatz UTF-8, Betraege mit Dezimalkomma.",
  "Die Spaltennamen bleiben unveraendert - eine gespeicherte Vorlage passt auch fuer kuenftige Exporte.",
];
