/**
 * DATEV-Buchungsstapel (Format EXTF).
 *
 * Das Format, in dem DATEV-Programme Buchungen von aussen annehmen: eine
 * CSV-Datei mit **zwei** Kopfzeilen - Metadaten in Zeile 1, Spaltennamen in
 * Zeile 2, Buchungen ab Zeile 3.
 *
 * ## Formatregeln, die eingehalten werden muessen
 *
 *   - Trennzeichen Semikolon, Textfelder in doppelten Anfuehrungszeichen.
 *   - **Betraege mit Dezimalkomma**, zwei Stellen, immer positiv. Die Richtung
 *     steckt im Soll-Haben-Kennzeichen.
 *   - Zahlenfelder (Konto, Gegenkonto) **ohne** Anfuehrungszeichen.
 *   - Zeilenende CRLF.
 *   - Zeichensatz: ab Version 700 UTF-8 mit Byte-Reihenfolge-Marke. Aeltere
 *     Versionen erwarten Windows-1252; deshalb ist die Version hier fest auf
 *     700 gesetzt und nicht einstellbar - ein Stapel, der als 510
 *     gekennzeichnet ist und UTF-8 enthaelt, kommt mit zerlegten Umlauten an.
 *
 * ## Was der Betrieb beim Steuerberater erfragen muss
 *
 * Beraternummer, Mandantennummer und der Beginn des Wirtschaftsjahres stehen im
 * Kopf der Datei. Ohne sie nimmt DATEV den Stapel nicht an, und **raten kann man
 * sie nicht**: eine falsche Mandantennummer bucht in die Buchhaltung eines
 * anderen Betriebs. Deshalb sind sie Pflichtfelder der Einstellung und keine
 * Vorschlaege.
 *
 * ## Festschreibung
 *
 * Feld 21 des Kopfes. `0` bedeutet: der Stapel kann in DATEV noch bearbeitet
 * werden. Das ist hier die Voreinstellung und die richtige - ein festgeschriebener
 * Stapel laesst sich nicht mehr korrigieren, und die erste Zuordnung eines
 * Betriebs sitzt selten auf Anhieb. Die Unveraenderbarkeit der **Kassendaten**
 * haengt nicht daran; die liegt in der Kasse und in der TSE.
 */

import { formatAmount } from "../money.ts";
import { AccountingError, type AccountMapping } from "./accounts.ts";
import type { BookingEntry } from "./bookings.ts";

/**
 * Formatversion. Nicht einstellbar - siehe Zeichensatz oben.
 *
 * 700 ist die Version, die UTF-8 zulaesst und von aktuellen DATEV-Programmen
 * gelesen wird.
 */
export const DATEV_FORMAT_VERSION = 700;

/** Kategorie und Name des Formats laut Schnittstellenbeschreibung. */
const FORMAT_CATEGORY = 21;
const FORMAT_NAME = "Buchungsstapel";
const FORMAT_VERSION_FIELD = 13;

/** Byte-Reihenfolge-Marke. Ohne sie liest DATEV UTF-8 als Windows-1252. */
export const DATEV_BOM = "﻿";

export interface DatevHeader {
  /**
   * Beraternummer beim Steuerberater, 1001 bis 9999999.
   *
   * Nicht zu erraten - beim Steuerberater erfragen.
   */
  readonly consultantNumber: number;
  /** Mandantennummer beim Steuerberater, 1 bis 99999. */
  readonly clientNumber: number;
  /** Beginn des Wirtschaftsjahres als `YYYY-MM-DD`. Meist der 1. Januar. */
  readonly fiscalYearStart: string;
  /** Zeitraum des Stapels, `YYYY-MM-DD`. */
  readonly from: string;
  readonly to: string;
  /** Bezeichnung des Stapels, hoechstens 30 Zeichen. */
  readonly label: string;
  /** Wer den Stapel erzeugt hat - erscheint in DATEV als Herkunft. */
  readonly createdBy: string;
  /** Zeitpunkt der Erzeugung, ISO-8601. */
  readonly createdAt: string;
  /** Diktatkuerzel, genau zwei Buchstaben. Optional. */
  readonly initials?: string;
  /** Festschreiben? Voreinstellung `false` - siehe Kopf dieser Datei. */
  readonly locked?: boolean;
}

/** Spaltennamen der Zeile 2, in der Reihenfolge der Schnittstelle. */
export const DATEV_COLUMNS: readonly string[] = [
  "Umsatz (ohne Soll/Haben-Kz)",
  "Soll/Haben-Kennzeichen",
  "WKZ Umsatz",
  "Kurs",
  "Basis-Umsatz",
  "WKZ Basis-Umsatz",
  "Konto",
  "Gegenkonto (ohne BU-Schlüssel)",
  "BU-Schlüssel",
  "Belegdatum",
  "Belegfeld 1",
  "Belegfeld 2",
  "Skonto",
  "Buchungstext",
];

function field(value: string): string {
  // Anfuehrungszeichen verdoppeln - sonst endet das Feld mitten im Text und
  // DATEV weist die ganze Datei zurueck.
  return `"${value.replace(/"/g, '""')}"`;
}

/** Betrag mit Dezimalkomma, zwei Stellen, ohne Vorzeichen und ohne Tausenderpunkt. */
function amount(cents: number): string {
  if (cents < 0) throw new AccountingError(`Ein DATEV-Betrag darf nicht negativ sein, war ${cents}.`);
  return formatAmount(cents);
}

/** `YYYY-MM-DD` zu `DDMM`, wie das Belegdatum im Buchungsstapel steht. */
function documentDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new AccountingError(`"${date}" ist kein Datum in der Form JJJJ-MM-TT.`);
  return `${match[3]}${match[2]}`;
}

function compactDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) throw new AccountingError(`"${date}" ist kein Datum in der Form JJJJ-MM-TT.`);
  return `${match[1]}${match[2]}${match[3]}`;
}

/** Zeitstempel als `JJJJMMTTHHMMSSFFF`, wie der Kopf ihn verlangt. */
function stamp(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) throw new AccountingError(`"${iso}" ist kein lesbarer Zeitstempel.`);
  return `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${match[6]}000`;
}

export interface HeaderCheck {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

/**
 * Kopfangaben pruefen, bevor die Datei entsteht.
 *
 * Alle Maengel auf einmal: wer sechs Felder ausfuellt, will nicht sechsmal
 * exportieren, um sechs Meldungen zu sehen.
 */
export function checkDatevHeader(header: DatevHeader): HeaderCheck {
  const problems: string[] = [];

  if (!Number.isInteger(header.consultantNumber) || header.consultantNumber < 1001 || header.consultantNumber > 9_999_999) {
    problems.push("Die Beraternummer liegt zwischen 1001 und 9999999. Sie steht auf jedem Schreiben des Steuerberaters.");
  }
  if (!Number.isInteger(header.clientNumber) || header.clientNumber < 1 || header.clientNumber > 99_999) {
    problems.push("Die Mandantennummer liegt zwischen 1 und 99999. Eine falsche Nummer bucht in die Buchhaltung eines anderen Betriebs.");
  }
  for (const [value, label] of [
    [header.fiscalYearStart, "Der Beginn des Wirtschaftsjahres"],
    [header.from, "Der Beginn des Zeitraums"],
    [header.to, "Das Ende des Zeitraums"],
  ] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) problems.push(`${label} muss in der Form JJJJ-MM-TT angegeben werden.`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(header.from) && /^\d{4}-\d{2}-\d{2}$/.test(header.to) && header.from > header.to) {
    problems.push("Der Zeitraum endet vor seinem Beginn.");
  }
  if (header.label.trim() === "") problems.push("Die Bezeichnung des Stapels fehlt.");
  if (header.label.length > 30) problems.push("Die Bezeichnung des Stapels darf hoechstens 30 Zeichen lang sein.");
  if (header.initials != null && header.initials !== "" && !/^[A-Za-z]{2}$/.test(header.initials)) {
    problems.push("Das Diktatkuerzel besteht aus genau zwei Buchstaben.");
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Kopfzeile bilden.
 *
 * 31 Felder in fester Reihenfolge. Die nicht belegten bleiben leer - sie sind
 * reserviert oder betreffen Faelle, die eine Kasse nicht hat (Fremdwaehrung,
 * Derivate, Branchenloesungen).
 */
function headerLine(header: DatevHeader, mapping: AccountMapping): string {
  const fields: (string | number)[] = [
    field("EXTF"), //  1 Kennzeichen: von einem Fremdprogramm erzeugt
    DATEV_FORMAT_VERSION, //  2
    FORMAT_CATEGORY, //  3
    field(FORMAT_NAME), //  4
    FORMAT_VERSION_FIELD, //  5
    stamp(header.createdAt), //  6 erzeugt am
    "", //  7 importiert am - fuellt DATEV
    field("RE"), //  8 Herkunft: Rechnungswesen-Fremdprogramm
    field(header.createdBy.slice(0, 25)), //  9 exportiert von
    "", // 10 importiert von
    header.consultantNumber, // 11
    header.clientNumber, // 12
    compactDate(header.fiscalYearStart), // 13
    mapping.accountLength, // 14 Sachkontenlaenge
    compactDate(header.from), // 15
    compactDate(header.to), // 16
    field(header.label.slice(0, 30)), // 17
    field(header.initials ?? ""), // 18 Diktatkuerzel
    1, // 19 Buchungstyp: Finanzbuchfuehrung
    0, // 20 Rechnungslegungszweck: keiner
    header.locked === true ? 1 : 0, // 21 Festschreibung
    field("EUR"), // 22 Waehrungskennzeichen
    "", // 23 reserviert
    "", // 24 Derivatskennzeichen
    "", // 25 reserviert
    "", // 26 reserviert
    // 27 Sachkontenrahmen: die Nummer des Kontenrahmens, nicht sein Name.
    // Bei eigenen Konten bleibt das Feld leer - DATEV nimmt dann die
    // Einstellung des Mandanten.
    field(mapping.chart === "SKR03" ? "03" : mapping.chart === "SKR04" ? "04" : ""),
    "", // 28 Id der Branchenloesung
    "", // 29 reserviert
    "", // 30 reserviert
    field("Kassensystem"), // 31 Anwendungsinformation
  ];
  return fields.join(";");
}

function bookingLine(entry: BookingEntry): string {
  const fields: (string | number)[] = [
    field(amount(entry.amount)), //  1 Umsatz ohne Vorzeichen
    field(entry.side), //  2 S oder H, bezogen auf Konto
    field("EUR"), //  3 Waehrung des Umsatzes
    "", //  4 Kurs (nur bei Fremdwaehrung)
    "", //  5 Basis-Umsatz
    "", //  6 Waehrung des Basis-Umsatzes
    entry.account, //  7 Konto - ohne Anfuehrungszeichen
    entry.contraAccount, //  8 Gegenkonto - ohne Anfuehrungszeichen
    // 9 BU-Schluessel. Leer bei Automatikkonten; ein gesetzter Schluessel auf
    // einem Automatikkonto ist ein Fehler, den DATEV meldet.
    field(entry.taxCode),
    documentDate(entry.date), // 10 Belegdatum TTMM
    field(entry.documentField), // 11 Belegfeld 1: Belegnummer
    "", // 12 Belegfeld 2
    "", // 13 Skonto
    field(entry.text), // 14 Buchungstext
  ];
  return fields.join(";");
}

/**
 * Buchungsstapel als Text.
 *
 * Prueft den Kopf, bevor irgendetwas geschrieben wird: eine Datei mit falscher
 * Mandantennummer ist schlimmer als keine, weil sie in DATEV ankommt und dort
 * Schaden anrichtet.
 */
export function buildDatevFile(
  entries: readonly BookingEntry[],
  header: DatevHeader,
  mapping: AccountMapping,
): string {
  const checked = checkDatevHeader(header);
  if (!checked.ok) throw new AccountingError(checked.problems.join(" "));

  const lines = [headerLine(header, mapping), DATEV_COLUMNS.map(field).join(";")];
  for (const entry of entries) lines.push(bookingLine(entry));
  return DATEV_BOM + lines.join("\r\n") + "\r\n";
}

/** Dateiname, wie DATEV ihn erwartet: `EXTF_<Bezeichnung>.csv`. */
export function datevFileName(header: DatevHeader): string {
  const slug = header.label
    .toLowerCase()
    .replace(/[äöüß]/g, (char) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[char] ?? char)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return `EXTF_${slug || "buchungsstapel"}_${compactDate(header.from)}-${compactDate(header.to)}.csv`;
}
