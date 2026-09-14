/**
 * Lieferantenrechnung als CSV.
 *
 * ## Wofuer
 *
 * ZUGFeRD und XRechnung sind der gute Fall. Der haeufige Fall bei einem kleinen
 * Betrieb ist ein Grosshaendler, der eine Tabelle ausgibt - oder ein Bediener,
 * der die Lieferscheinpositionen selbst in eine Tabelle tippt, weil das
 * schneller geht als dreissig Artikel einzeln zu buchen.
 *
 * ## Warum das Format nachgiebig ist
 *
 * Diese Datei kommt aus einem fremden System oder aus einer Tabelle, die ein
 * Mensch gepflegt hat. Wer darauf ein enges Format erzwingt, erzeugt vor allem
 * abgewiesene Dateien. Deshalb:
 *
 *   - **Das Trennzeichen wird erkannt** - Semikolon, Komma oder Tabulator.
 *   - **Die Spalten werden ueber ihre Ueberschrift gefunden**, in beliebiger
 *     Reihenfolge, und unter mehreren gebraeuchlichen Namen. `Menge`, `Anzahl`
 *     und `Quantity` meinen dasselbe.
 *   - **Unbekannte Spalten stoeren nicht.** Eine Lieferantendatei traegt
 *     Lagerplatz, Bestellnummer und Zeilenfarbe mit; das ist nicht falsch,
 *     es wird nur nicht gebraucht.
 *
 * Zwei Dinge sind Pflicht: eine **Bezeichnung** und eine **Menge**. Ohne
 * Bezeichnung ist die Zeile nicht zuzuordnen, ohne Menge nichts zu buchen.
 *
 * ## Was hier nicht entschieden wird
 *
 * Ob eine Zeile zu einem Artikel im Bestand passt, entscheidet `matching.ts` -
 * und bestaetigen muss es ein Mensch. Diese Datei liest eine Tabelle, sonst
 * nichts.
 */

import { parseCatalogCsv } from "../backup.ts";
import { ONE, type Cents, type Quantity, roundHalfUp } from "../money.ts";
import { InvoiceError, MAX_INVOICE_LINES, type SupplierInvoice, type SupplierInvoiceLine, parseInvoiceDate } from "./invoice.ts";

/** Trennzeichen, die vorkommen. */
const SEPARATORS = [";", ",", "\t"] as const;

/**
 * Das Trennzeichen an der Kopfzeile erkennen.
 *
 * Genommen wird das, mit dem die erste Zeile in die meisten Felder zerfaellt.
 * Ein Komma im Preis ("1,49") fuehrt so nicht in die Irre, solange die
 * Kopfzeile mit Semikolon getrennt ist - und genau dort steht kein Preis.
 */
export function detectSeparator(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ";";
  let bestCount = 0;
  for (const separator of SEPARATORS) {
    const count = firstLine.split(separator).length;
    if (count > bestCount) {
      bestCount = count;
      best = separator;
    }
  }
  return best;
}

/**
 * Spaltennamen, die verstanden werden.
 *
 * Verglichen wird kleingeschrieben und ohne Leer- und Sonderzeichen, damit
 * `Artikel-Nr.`, `artikelnr` und `Artikel Nr` denselben Treffer ergeben.
 */
const COLUMN_ALIASES = {
  gtin: ["gtin", "ean", "barcode", "strichcode"],
  sellerItemId: ["artikelnummer", "artikelnr", "artnr", "lieferantenartikelnummer", "bestellnummer", "sku", "itemid"],
  name: ["bezeichnung", "artikelbezeichnung", "name", "artikel", "beschreibung", "description", "itemname"],
  quantity: ["menge", "anzahl", "stueck", "stück", "quantity", "liefermenge"],
  unit: ["einheit", "mengeneinheit", "unit", "me"],
  netUnitPrice: ["einzelpreis", "preis", "nettopreis", "ekpreis", "einkaufspreis", "unitprice", "preisnetto"],
  netAmount: ["gesamtpreis", "betrag", "summe", "nettobetrag", "positionswert", "linetotal", "gesamt"],
  taxPercent: ["steuersatz", "mwst", "ust", "steuer", "taxrate", "vat"],
} as const;

type ColumnKey = keyof typeof COLUMN_ALIASES;

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s._\-/()]/g, "")
    .replace(/%|€|eur/g, "")
    .trim();
}

/** Welche Spalte steht an welcher Stelle? */
export function mapColumns(header: readonly string[]): Partial<Record<ColumnKey, number>> {
  const mapping: Partial<Record<ColumnKey, number>> = {};
  header.forEach((cell, index) => {
    const normalized = normalizeHeader(cell);
    if (normalized.length === 0) return;
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES) as [ColumnKey, readonly string[]][]) {
      // Die erste passende Spalte gewinnt: steht "Preis" zweimal in der Datei,
      // ist die linke gemeint - so liest es auch ein Mensch.
      if (mapping[key] === undefined && aliases.includes(normalized)) mapping[key] = index;
    }
  });
  return mapping;
}

/**
 * Eine Zahl aus einer Tabellenzelle.
 *
 * Hier ist das **Komma** der Normalfall - anders als im XML. Ein Punkt kann
 * beides sein: Dezimalpunkt (`1.49`) oder Tausendertrenner (`1.234`). Die
 * Regel: kommen beide vor, ist das letzte das Dezimalzeichen. Steht nur ein
 * Punkt und danach genau drei Ziffern, ist es ein Tausendertrenner.
 *
 * Das ist geraten - aber es ist dasselbe Raten, das jede Tabellenkalkulation
 * macht, und die Vorschau zeigt dem Bediener das Ergebnis, bevor etwas gebucht
 * wird.
 */
export function parseCsvNumber(value: string | undefined): number | null {
  if (value == null) return null;
  let text = value.trim().replace(/\s/g, "").replace(/€|EUR|%/gi, "");
  if (text.length === 0) return null;

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    // Beide da: das hintere trennt die Nachkommastellen.
    if (lastComma > lastDot) text = text.replaceAll(".", "").replace(",", ".");
    else text = text.replaceAll(",", "");
  } else if (lastComma >= 0) {
    text = text.replace(",", ".");
  } else if (lastDot >= 0 && /^[+-]?\d{1,3}(\.\d{3})+$/.test(text)) {
    // "1.234" oder "1.234.567": nur Tausendertrenner, kein Dezimalpunkt.
    // "1.49" faellt nicht darunter und bleibt ein Dezimalpunkt.
    text = text.replaceAll(".", "");
  }

  if (!/^[+-]?\d*(\.\d+)?$/.test(text) || text.replace(/[+-]/, "").length === 0) return null;
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : null;
}

function toCents(value: string | undefined): Cents | null {
  const number = parseCsvNumber(value);
  return number == null ? null : roundHalfUp(number * 100);
}

function toQuantity(value: string | undefined): Quantity | null {
  const number = parseCsvNumber(value);
  return number == null ? null : roundHalfUp(number * ONE);
}

export interface CsvInvoiceOptions {
  /** Rechnungsnummer, wenn sie nicht in der Datei steht. */
  readonly invoiceNumber?: string | null;
  /** Rechnungsdatum `YYYY-MM-DD`. */
  readonly issuedOn?: string | null;
  readonly supplierName?: string | null;
}

/**
 * Eine CSV-Datei als Lieferantenrechnung lesen.
 *
 * Kopfdaten stehen in einer Tabelle selten; sie kommen deshalb von aussen -
 * der Bediener tippt Rechnungsnummer und Datum einmal ein, statt sie dreissig
 * Zeilen lang zu wiederholen.
 */
export function parseInvoiceCsv(text: string, options: CsvInvoiceOptions = {}): SupplierInvoice {
  const rows = parseCatalogCsv(text, detectSeparator(text));
  if (rows.length === 0) throw new InvoiceError("Die Datei ist leer.");

  const header = rows[0]!;
  const columns = mapColumns(header);

  if (columns.name === undefined) {
    throw new InvoiceError(
      `In der Kopfzeile fehlt eine Spalte mit der Artikelbezeichnung. Erkannt werden unter anderem: ${COLUMN_ALIASES.name.join(", ")}.`,
    );
  }
  if (columns.quantity === undefined) {
    throw new InvoiceError(
      `In der Kopfzeile fehlt eine Spalte mit der Menge. Erkannt werden unter anderem: ${COLUMN_ALIASES.quantity.join(", ")}.`,
    );
  }

  const body = rows.slice(1);
  if (body.length > MAX_INVOICE_LINES) {
    throw new InvoiceError(`Die Datei hat ${body.length} Zeilen; verarbeitet werden bis zu ${MAX_INVOICE_LINES}.`);
  }

  const lines: SupplierInvoiceLine[] = [];
  body.forEach((row, index) => {
    const cell = (key: ColumnKey): string | undefined => {
      const position = columns[key];
      return position === undefined ? undefined : row[position]?.trim();
    };

    const name = cell("name");
    // Eine Zeile ohne Bezeichnung ist meistens eine Summenzeile am Ende der
    // Tabelle. Sie zu ueberspringen ist richtiger, als die Datei abzuweisen.
    if (!name) return;

    const netUnitPrice = toCents(cell("netUnitPrice"));
    const quantity = toQuantity(cell("quantity")) ?? 0;
    const netAmount = toCents(cell("netAmount"));

    lines.push({
      lineId: String(index + 1),
      gtin: cell("gtin") || null,
      sellerItemId: cell("sellerItemId") || null,
      name,
      quantity,
      unitCode: cell("unit") || null,
      netUnitPrice,
      // Fehlt der Positionsbetrag, laesst er sich ausrechnen - und umgekehrt.
      // Das erspart dem Bediener eine Spalte, die er sonst tippen muesste.
      netAmount: netAmount ?? (netUnitPrice != null ? roundHalfUp((netUnitPrice * quantity) / ONE) : null),
      taxPercent: parseCsvNumber(cell("taxPercent")),
    });
  });

  return {
    format: "CSV",
    invoiceNumber: options.invoiceNumber ?? null,
    issuedOn: parseInvoiceDate(options.issuedOn ?? null),
    supplierName: options.supplierName ?? null,
    supplierVatId: null,
    currency: "EUR",
    lines,
    // Eine CSV-Datei nennt keine geprueften Summen. Die Summe der Positionen
    // hier als Rechnungssumme auszugeben waere eine Scheinpruefung: sie ginge
    // immer auf, weil sie aus denselben Zahlen kaeme.
    netTotal: null,
    taxTotal: null,
    grossTotal: null,
  };
}

/** Eine Beispieldatei, die der Bediener als Vorlage herunterladen kann. */
export function csvTemplate(): string {
  return [
    "Artikelnummer;GTIN;Bezeichnung;Menge;Einheit;Einzelpreis;Steuersatz",
    "A-4711;4001234567890;Cola 0,33 l Dose;24;Stueck;0,63;19",
    "K-100;;Kaffeebohnen;2,5;kg;14,90;7",
  ].join("\r\n");
}
