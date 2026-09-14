/**
 * Artikelstamm ausgeben, wieder einlesen und sichern.
 *
 * Zwei verschiedene Dinge, die oft verwechselt werden:
 *
 *   1. **Export als CSV** - zum *Bearbeiten*. Der Betrieb zieht seine Artikel
 *      in eine Tabelle, aendert dreissig Preise auf dem Rechner und liest sie
 *      wieder ein. Menschenlesbar, verlustbehaftet: Bilder, Ids und Bestaende
 *      stehen nicht darin.
 *   2. **Sicherung als JSON** - zum *Wiederherstellen*. Vollstaendig, mit Ids,
 *      Bildlizenzen und Pfandzuordnungen, mit Pruefsumme. Nicht zum Bearbeiten
 *      gedacht.
 *
 * ## Was eine Sicherung nicht ist
 *
 * **Eine Sicherung des Artikelstamms erfuellt die Aufbewahrungspflicht nach
 * § 147 AO nicht.** Aufzubewahren sind die Belege, die Kassenabschluesse und
 * die TSE-Daten - zehn Jahre, unveraenderbar und maschinell auswertbar. Dafuer
 * ist der DSFinV-K-Export da (dsfinvk/export.ts), nicht diese Datei. Wer nur
 * den Artikelstamm sichert und glaubt, damit die Pflicht erfuellt zu haben,
 * steht bei einer Kassennachschau ohne Aufzeichnungen da.
 *
 * Umgekehrt ersetzt der DSFinV-K-Export diese Sicherung nicht: er enthaelt die
 * Umsaetze, nicht den Stamm. Ein verlorenes Geraet ohne Stammsicherung
 * bedeutet, dreihundert Artikel neu anzulegen.
 *
 * ## Warum das Einlesen niemals still ueberschreibt
 *
 * Eine CSV-Datei aus einer Tabellenkalkulation ist eine unzuverlaessige Quelle:
 * eine Spalte verrutscht, das Dezimalkomma wird zum Punkt, eine Zeile fehlt,
 * weil der Filter noch aktiv war. Deshalb liefert `planCatalogImport` eine
 * **Vorschau** - was wird angelegt, was geaendert, was ist unklar - und aendert
 * selbst nichts. Erst der Aufrufer entscheidet.
 *
 * Und: **fehlende Zeilen loeschen nichts.** Wer aus einer Datei mit dreissig
 * Artikeln eine mit drei macht, wollte drei aendern und nicht siebenundzwanzig
 * ausblenden. Ausblenden bleibt eine Handlung im Artikelbildschirm.
 */

import { type Cents, type Quantity, ONE, formatAmount, formatQuantityDecimal, parseAmount } from "./money.ts";
import type { Category, Id, Product, ProductImage, Store, Tenant, Timestamp } from "./model.ts";
import { STANDARD_TAX_RATES, type TaxKey } from "./tax.ts";
import { MAX_NAME_LENGTH } from "./limits.ts";
import { sha256, toHex, utf8 } from "./security/hash.ts";
import { checkBarcode, checkDisplayName } from "./validation.ts";

export class BackupError extends Error {}

// --- CSV: Zeichenkette hin und zurueck ------------------------------------

/**
 * Trennzeichen.
 *
 * Semikolon, nicht Komma: deutsche Tabellenkalkulationen erwarten es, und
 * Betraege werden mit Dezimalkomma geschrieben. Ein Komma als Trennzeichen und
 * ein Komma im Preis in derselben Datei ist der Fehler, der beim Kunden auf dem
 * Rechner passiert und nicht hier.
 */
export const CSV_SEPARATOR = ";";

/**
 * Byte-Reihenfolge-Marke.
 *
 * Ohne sie oeffnet Excel eine UTF-8-Datei als Windows-1252, und aus "Getränke"
 * wird "GetrÃ¤nke". Mit ihr erkennt Excel die Kodierung. Beim Einlesen wird sie
 * wieder entfernt, damit sie nicht im ersten Spaltennamen landet.
 */
export const CSV_BOM = "﻿";

/** Ein Feld so schreiben, dass es sich unveraendert wieder einlesen laesst. */
export function catalogCsvField(value: string): string {
  // Anfuehrungszeichen sind noetig, sobald Trennzeichen, Anfuehrungszeichen
  // oder ein Umbruch im Wert stehen. Darin werden Anfuehrungszeichen
  // verdoppelt - so schreibt es RFC 4180, und so liest es jede Tabelle.
  if (value.includes(CSV_SEPARATOR) || value.includes('"') || value.includes("\n") || value.includes("\r")) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function catalogCsvLine(fields: readonly string[]): string {
  return fields.map(catalogCsvField).join(CSV_SEPARATOR);
}

/**
 * CSV in Zeilen und Felder zerlegen.
 *
 * Eigener Parser, weil ein `split(";")` an der ersten Bemerkung mit Semikolon
 * scheitert - und Bemerkungen mit Semikolon schreibt jeder. Umbrueche innerhalb
 * von Anfuehrungszeichen gehoeren zum Feld; ein `split("\n")` waere dort schon
 * falsch.
 *
 * Das Trennzeichen ist einstellbar, weil nicht jede CSV-Datei aus dieser App
 * stammt: eine Lieferantendatei kommt mit Komma oder Tabulator (siehe
 * `purchase/csv.ts`). Die Regeln fuer Anfuehrungszeichen sind dieselben.
 */
export function parseCatalogCsv(text: string, separator: string = CSV_SEPARATOR): string[][] {
  const body = text.startsWith(CSV_BOM) ? text.slice(CSV_BOM.length) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < body.length; index++) {
    const char = body[index] as string;

    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
    } else if (char === separator) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      // Zeilenende in beiden Schreibweisen; \r\n zaehlt einmal.
      if (char === "\r" && body[index + 1] === "\n") index++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Leere Zeilen am Ende sind Artefakte des Speicherns, keine Daten.
  return rows.filter((entry) => entry.some((value) => value.trim() !== ""));
}

// --- Artikelstamm als CSV -------------------------------------------------

/**
 * Spalten der Artikeldatei.
 *
 * Die Reihenfolge ist Teil des Formats: sie steht in der Kopfzeile, und beim
 * Einlesen wird **nach Namen** zugeordnet, nicht nach Position. Damit
 * uebersteht die Datei das Umsortieren von Spalten in der Tabelle - was
 * passiert, sobald jemand darin arbeitet.
 */
export const PRODUCT_COLUMNS = [
  "Artikelnummer",
  "Name",
  "Warengruppe",
  "Preis",
  "Steuersatz",
  "Steuersatz vor Ort",
  "Einheit",
  "Pfand",
  "Ist Pfandartikel",
  "Bestand fuehren",
  "Mindestbestand",
  "Bestand",
  "Aktiv",
] as const;

/** Trennzeichen mehrerer Pfandartikel in einer Zelle. */
const DEPOSIT_SEPARATOR = " + ";

const UNIT_LABELS: Record<Product["unit"], string> = {
  PIECE: "Stueck",
  KILOGRAM: "Kilogramm",
  LITRE: "Liter",
  HOUR: "Stunde",
};

function unitFromLabel(label: string): Product["unit"] | null {
  const value = label.trim().toLowerCase();
  for (const [unit, text] of Object.entries(UNIT_LABELS)) {
    if (text.toLowerCase() === value) return unit as Product["unit"];
  }
  // Auch die englischen Schluessel annehmen: wer die Datei aus einem anderen
  // System zusammenstellt, schreibt eher PIECE als "Stueck".
  if (value in UNIT_LABELS) return value.toUpperCase() as Product["unit"];
  const upper = label.trim().toUpperCase();
  return upper in UNIT_LABELS ? (upper as Product["unit"]) : null;
}

/** Vollstaendiger Pfad einer Warengruppe, z. B. `Getraenke > Kaffee`. */
export function categoryPathLabel(categories: readonly Category[], categoryId: Id): string {
  const names: string[] = [];
  const byId = new Map(categories.map((category) => [category.id, category]));
  let current = byId.get(categoryId);
  // Die Tiefe ist begrenzt (limits.ts); der Zaehler schuetzt zusaetzlich gegen
  // einen Zyklus in fehlerhaften Daten - eine Endlosschleife beim Export waere
  // schlimmer als ein abgeschnittener Pfad.
  let guard = 0;
  while (current && guard++ < 16) {
    names.unshift(current.name);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names.join(" > ");
}

/**
 * Steuersatz in der Tabelle.
 *
 * Saetze mit Prozentzahl werden als Zahl geschrieben (`19`, `7`), die drei
 * Faelle ohne Steuer als Wort. Das ist kein Geschmack, sondern Notwendigkeit:
 * "nicht steuerbar", "steuerfrei" und "nicht ermittelbar" haben alle drei den
 * Satz 0 %, und als `0` waeren sie beim Einlesen nicht mehr auseinanderzuhalten
 * - die Kasse wuerde einen davon raten.
 *
 * Der DSFinV-K-Schluessel selbst (1, 2, 5, 6, 7) wird bewusst **nicht**
 * angenommen: `7` waere sonst zugleich "7 Prozent" und "nicht ermittelbar", und
 * ein falsch gelesener Steuersatz faellt erst in der Umsatzsteuererklaerung auf.
 */
const ZERO_RATE_LABELS: Readonly<Record<string, TaxKey>> = {
  "nicht steuerbar": 5,
  steuerfrei: 6,
  "nicht ermittelbar": 7,
};

function taxLabel(key: TaxKey): string {
  const rate = STANDARD_TAX_RATES.find((entry) => entry.key === key);
  if (!rate) return String(key);
  if (rate.rate > 0) return String(rate.rate / 100);
  const word = Object.entries(ZERO_RATE_LABELS).find(([, value]) => value === key);
  return word ? word[0] : String(rate.rate / 100);
}

function taxFromLabel(text: string): TaxKey | null {
  const value = text.trim().toLowerCase();
  if (value === "") return null;

  const word = ZERO_RATE_LABELS[value];
  if (word !== undefined) return word;

  const numeric = value.replace("%", "").replace(",", ".").trim();
  const number = Number(numeric);
  if (numeric === "" || !Number.isFinite(number)) return null;
  // Nur Saetze mit Prozentzahl, und nur die, die es wirklich gibt. Ein
  // erfundener Satz wird abgewiesen statt still auf den naechstbesten
  // abgebildet.
  const byPercent = STANDARD_TAX_RATES.find((entry) => entry.rate > 0 && entry.rate === Math.round(number * 100));
  return byPercent ? byPercent.key : null;
}

/** Die Werte, die in der Steuerspalte stehen duerfen - fuer die Fehlermeldung. */
export function taxColumnValues(): readonly string[] {
  return [
    ...STANDARD_TAX_RATES.filter((rate) => rate.rate > 0).map((rate) => String(rate.rate / 100)),
    ...Object.keys(ZERO_RATE_LABELS),
  ];
}

/**
 * Artikelstamm als CSV.
 *
 * Enthaelt bewusst **nicht**: Bilder (eine Adresse samt Lizenz in einer Zelle
 * ueberlebt keine Tabellenbearbeitung), die technischen Ids (wer sie von Hand
 * aendert, zerlegt seine Belege) und nichts, was sich nur ueber Bewegungen
 * aendern darf. Der Bestand steht als Spalte dabei, aber nur zum **Lesen** -
 * beim Einlesen wird er ignoriert, weil er nur ueber Bestandsbewegungen
 * fortgeschrieben wird.
 */
export function buildProductCsv(products: readonly Product[], categories: readonly Category[]): string {
  const names = new Map(products.map((product) => [product.id, product.name]));
  const lines = [catalogCsvLine(PRODUCT_COLUMNS)];

  for (const product of products) {
    lines.push(
      catalogCsvLine([
        product.sku ?? "",
        product.name,
        product.isDeposit ? "" : categoryPathLabel(categories, product.categoryId),
        product.price == null ? "" : formatAmount(product.price),
        taxLabel(product.taxKey),
        product.taxKeyDineIn == null ? "" : taxLabel(product.taxKeyDineIn),
        UNIT_LABELS[product.unit],
        (product.depositProductIds ?? []).map((id) => names.get(id) ?? id).join(DEPOSIT_SEPARATOR),
        product.isDeposit ? "ja" : "nein",
        product.trackStock ? "ja" : "nein",
        product.lowStockThreshold == null ? "" : formatQuantityDecimal(product.lowStockThreshold),
        formatQuantityDecimal(product.stock ?? 0),
        product.active ? "ja" : "nein",
      ]),
    );
  }
  // Mit BOM und CRLF: so oeffnet Excel die Datei ohne Ruecksprache.
  return CSV_BOM + lines.join("\r\n") + "\r\n";
}

function boolFromLabel(text: string, fallback: boolean): boolean {
  const value = text.trim().toLowerCase();
  if (value === "") return fallback;
  return ["ja", "yes", "true", "1", "x", "wahr"].includes(value);
}

function quantityFromLabel(text: string): Quantity | null {
  const value = text.trim().replace(",", ".");
  if (value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * ONE);
}

// --- Einlesen mit Vorschau ------------------------------------------------

/** Was mit einer Zeile geschehen soll. */
export type ImportAction = "CREATE" | "UPDATE" | "UNCHANGED" | "REJECTED";

export interface ImportRow {
  /** Zeilennummer in der Datei, damit der Bediener sie findet. Kopfzeile ist 1. */
  readonly line: number;
  readonly action: ImportAction;
  /** Der Artikel, wie er gespeichert wuerde - `null` bei `REJECTED`. */
  readonly product: Product | null;
  /** Der bestehende Artikel, wenn die Zeile einen trifft. */
  readonly existingId: Id | null;
  /** Woran die Zeile zugeordnet wurde. */
  readonly matchedBy: "sku" | "name" | null;
  /** Bei `REJECTED` der Grund; bei den anderen Hinweise, die man lesen sollte. */
  readonly problems: readonly string[];
  /** Felder, die sich aendern - fuer die Vorschau. */
  readonly changes: readonly string[];
  /** Warengruppe, die dafuer angelegt werden muesste. */
  readonly newCategoryPath: string | null;
}

export interface ImportPlan {
  readonly rows: readonly ImportRow[];
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly rejected: number;
  /** Warengruppen, die neu entstehen wuerden - in der Reihenfolge des Anlegens. */
  readonly newCategoryPaths: readonly string[];
  /**
   * Artikel im Stamm, die in der Datei fehlen.
   *
   * Sie werden **nicht** angetastet. Die Liste steht hier, damit der Bediener
   * sieht, dass seine Datei unvollstaendig ist - der haeufigste Grund dafuer ist
   * ein Filter, der beim Speichern noch aktiv war.
   */
  readonly missingFromFile: readonly { readonly id: Id; readonly name: string }[];
}

export interface ImportContext {
  readonly tenantId: Id;
  readonly categories: readonly Category[];
  readonly products: readonly Product[];
  readonly newId: () => string;
  readonly now: Timestamp;
}

/**
 * Einlesen planen, ohne etwas zu aendern.
 *
 * Die Zuordnung laeuft in dieser Folge:
 *
 *   1. **Artikelnummer**, wenn eine da ist. Sie ist der einzige Schluessel, den
 *      der Betrieb selbst kontrolliert.
 *   2. **Name innerhalb der Warengruppe**. Zwei Artikel gleichen Namens in
 *      derselben Gruppe sind unzulaessig, also ist das eindeutig.
 *
 * Trifft eine Zeile keinen bestehenden Artikel, entsteht ein neuer. Trifft sie
 * mehrere, wird sie abgewiesen - lieber eine Zeile zum Klaeren als der falsche
 * Preis am falschen Artikel.
 */
export function planCatalogImport(text: string, context: ImportContext): ImportPlan {
  const rows = parseCatalogCsv(text);
  if (rows.length === 0) throw new BackupError("Die Datei ist leer.");

  const header = (rows[0] ?? []).map((value) => value.trim());
  const column = new Map(header.map((name, index) => [name.toLowerCase(), index]));
  for (const required of ["Name"] as const) {
    if (!column.has(required.toLowerCase())) {
      throw new BackupError(
        `In der Kopfzeile fehlt die Spalte "${required}". Erwartet werden: ${PRODUCT_COLUMNS.join(", ")}.`,
      );
    }
  }

  const cell = (row: readonly string[], name: string): string => {
    const index = column.get(name.toLowerCase());
    return index === undefined ? "" : (row[index] ?? "").trim();
  };

  const bySku = new Map<string, Product[]>();
  for (const product of context.products) {
    if (!product.sku) continue;
    const list = bySku.get(product.sku);
    if (list) list.push(product);
    else bySku.set(product.sku, [product]);
  }

  const categoryIdByPath = new Map<string, Id>();
  for (const category of context.categories) {
    categoryIdByPath.set(categoryPathLabel(context.categories, category.id).toLowerCase(), category.id);
  }

  const depositByName = new Map<string, Product>();
  for (const product of context.products) {
    if (product.isDeposit) depositByName.set(product.name.trim().toLowerCase(), product);
  }

  const result: ImportRow[] = [];
  const newCategoryPaths: string[] = [];
  const touched = new Set<Id>();

  for (let index = 1; index < rows.length; index++) {
    const row = rows[index] as string[];
    const line = index + 1;
    const problems: string[] = [];

    const checkedName = checkDisplayName(cell(row, "Name"), "Der Artikelname");
    if (!checkedName.ok) {
      result.push({
        line, action: "REJECTED", product: null, existingId: null, matchedBy: null,
        problems: [checkedName.reason], changes: [], newCategoryPath: null,
      });
      continue;
    }
    const name = checkedName.value;
    const isDeposit = boolFromLabel(cell(row, "Ist Pfandartikel"), false);

    // Artikelnummer
    let sku: string | null = null;
    const skuText = cell(row, "Artikelnummer");
    if (skuText !== "") {
      const checked = checkBarcode(skuText);
      if (!checked.ok) {
        // Kein Abbruch: eine Artikelnummer, die keine GTIN ist, kann eine
        // betriebseigene Nummer sein. Sie wird uebernommen, aber gemeldet -
        // dann weiss der Bediener, dass ein Scanner sie nicht findet.
        problems.push(`${checked.reason} Die Nummer wird uebernommen, ein Scanner wird sie aber nicht pruefen.`);
        sku = skuText.slice(0, MAX_NAME_LENGTH);
      } else {
        sku = checked.value;
      }
    }

    // Preis
    const priceText = cell(row, "Preis");
    let price: Cents | null = null;
    if (priceText === "") {
      if (isDeposit) {
        result.push({
          line, action: "REJECTED", product: null, existingId: null, matchedBy: null,
          problems: ["Ein Pfandartikel braucht einen festen Betrag - ein offener Preis ist nicht moeglich."],
          changes: [], newCategoryPath: null,
        });
        continue;
      }
      price = null;
    } else {
      const parsed = parseAmount(priceText);
      if (parsed == null || parsed < 0) {
        result.push({
          line, action: "REJECTED", product: null, existingId: null, matchedBy: null,
          problems: [`"${priceText}" ist kein Preis. Beispiel: 4,50`], changes: [], newCategoryPath: null,
        });
        continue;
      }
      if (isDeposit && parsed === 0) {
        result.push({
          line, action: "REJECTED", product: null, existingId: null, matchedBy: null,
          problems: ["Ein Pfand von 0,00 EUR ist kein Pfand."], changes: [], newCategoryPath: null,
        });
        continue;
      }
      price = parsed;
    }

    // Steuersatz
    const taxKey = taxFromLabel(cell(row, "Steuersatz"));
    if (taxKey == null) {
      result.push({
        line, action: "REJECTED", product: null, existingId: null, matchedBy: null,
        problems: [
          `"${cell(row, "Steuersatz")}" ist kein bekannter Steuersatz. Erwartet wird einer von: ${taxColumnValues().join(", ")}.`,
        ],
        changes: [], newCategoryPath: null,
      });
      continue;
    }
    const taxKeyDineIn = taxFromLabel(cell(row, "Steuersatz vor Ort"));
    if (cell(row, "Steuersatz vor Ort") !== "" && taxKeyDineIn == null) {
      problems.push(`"${cell(row, "Steuersatz vor Ort")}" ist kein bekannter Steuersatz - der Wert wird ignoriert.`);
    }

    // Einheit
    const unitText = cell(row, "Einheit");
    const unit = unitText === "" ? "PIECE" : unitFromLabel(unitText);
    if (unit == null) {
      result.push({
        line, action: "REJECTED", product: null, existingId: null, matchedBy: null,
        problems: [`"${unitText}" ist keine bekannte Einheit. Erwartet: ${Object.values(UNIT_LABELS).join(", ")}.`],
        changes: [], newCategoryPath: null,
      });
      continue;
    }

    // Warengruppe. Pfandartikel liegen ausserhalb des Verkaufsbaums; sie
    // behalten ihre Gruppe oder bekommen die erste vorhandene.
    const pathText = cell(row, "Warengruppe");
    let categoryId: Id | null = null;
    let newCategoryPath: string | null = null;
    if (pathText !== "") {
      const found = categoryIdByPath.get(pathText.toLowerCase());
      if (found) {
        categoryId = found;
      } else {
        newCategoryPath = pathText;
        if (!newCategoryPaths.includes(pathText)) newCategoryPaths.push(pathText);
      }
    }

    // Pfandzuordnung ueber die Namen der Pfandartikel.
    const depositText = cell(row, "Pfand");
    const depositProductIds: Id[] = [];
    if (depositText !== "" && !isDeposit) {
      for (const part of depositText.split(DEPOSIT_SEPARATOR)) {
        const trimmed = part.trim();
        if (trimmed === "") continue;
        const deposit = depositByName.get(trimmed.toLowerCase());
        if (deposit) depositProductIds.push(deposit.id);
        else problems.push(`Der Pfandartikel "${trimmed}" ist nicht angelegt - die Zuordnung fehlt danach.`);
      }
    }

    // Zuordnung zum bestehenden Artikel
    let existing: Product | null = null;
    let matchedBy: "sku" | "name" | null = null;
    if (sku) {
      const candidates = bySku.get(sku) ?? [];
      if (candidates.length > 1) {
        result.push({
          line, action: "REJECTED", product: null, existingId: null, matchedBy: null,
          problems: [`Die Artikelnummer ${sku} ist im Stamm mehrfach vergeben - bitte dort zuerst klaeren.`],
          changes: [], newCategoryPath,
        });
        continue;
      }
      existing = candidates[0] ?? null;
      if (existing) matchedBy = "sku";
    }
    if (!existing) {
      const byName = context.products.filter(
        (product) =>
          product.name.trim().toLowerCase() === name.toLowerCase() &&
          (categoryId == null || product.categoryId === categoryId) &&
          (product.isDeposit === true) === isDeposit,
      );
      if (byName.length > 1) {
        result.push({
          line, action: "REJECTED", product: null, existingId: null, matchedBy: null,
          problems: [
            `"${name}" kommt im Stamm mehrfach vor. Bitte eine Artikelnummer eintragen, damit die Zeile eindeutig ist.`,
          ],
          changes: [], newCategoryPath,
        });
        continue;
      }
      existing = byName[0] ?? null;
      if (existing) matchedBy = "name";
    }

    if (existing && touched.has(existing.id)) {
      result.push({
        line, action: "REJECTED", product: null, existingId: existing.id, matchedBy,
        problems: [`Dieser Artikel wird in der Datei mehrfach geaendert - zuletzt in Zeile ${line}.`],
        changes: [], newCategoryPath,
      });
      continue;
    }

    const resolvedCategoryId =
      categoryId ?? existing?.categoryId ?? context.categories[0]?.id ?? null;
    if (resolvedCategoryId == null && newCategoryPath == null) {
      result.push({
        line, action: "REJECTED", product: null, existingId: null, matchedBy: null,
        problems: ["Es gibt keine Warengruppe, in die der Artikel gehoert - bitte eine in der Spalte angeben."],
        changes: [], newCategoryPath,
      });
      continue;
    }

    const trackStock = isDeposit ? false : boolFromLabel(cell(row, "Bestand fuehren"), existing?.trackStock === true);
    const product: Product = {
      // Die Id bleibt: sie steht auf jedem alten Beleg. Nur neue Artikel
      // bekommen eine neue.
      id: existing?.id ?? context.newId(),
      tenantId: context.tenantId,
      // Bei einer neuen Warengruppe setzt der Aufrufer die Id ein, sobald er
      // sie angelegt hat - hier steht vorlaeufig die bisherige.
      categoryId: resolvedCategoryId ?? "",
      name,
      description: existing?.description ?? null,
      price,
      taxKey,
      taxKeyDineIn: taxKeyDineIn ?? null,
      sku,
      unit,
      depositProductIds: isDeposit ? null : depositProductIds,
      isDeposit,
      color: existing?.color ?? null,
      // Das Bild steht nicht in der CSV - ein bestehendes bleibt erhalten.
      image: existing?.image ?? null,
      trackStock,
      // Der Bestand wird nicht aus der Datei uebernommen: er aendert sich nur
      // ueber Bestandsbewegungen. Eine CSV-Spalte, die ihn setzt, wuerde jede
      // Bewegung ueberschreiben - und das Journal waere wertlos.
      stock: existing?.stock ?? 0,
      lowStockThreshold: quantityFromLabel(cell(row, "Mindestbestand")),
      sortOrder: existing?.sortOrder ?? 0,
      active: boolFromLabel(cell(row, "Aktiv"), existing?.active ?? true),
      updatedAt: context.now,
    };

    const changes = existing ? describeChanges(existing, product, context.categories) : [];
    if (existing) touched.add(existing.id);

    result.push({
      line,
      action: existing ? (changes.length === 0 ? "UNCHANGED" : "UPDATE") : "CREATE",
      product,
      existingId: existing?.id ?? null,
      matchedBy,
      problems,
      changes,
      newCategoryPath,
    });
  }

  const missingFromFile = context.products
    .filter((product) => !touched.has(product.id) && product.active)
    .map((product) => ({ id: product.id, name: product.name }));

  return {
    rows: result,
    created: result.filter((row) => row.action === "CREATE").length,
    updated: result.filter((row) => row.action === "UPDATE").length,
    unchanged: result.filter((row) => row.action === "UNCHANGED").length,
    rejected: result.filter((row) => row.action === "REJECTED").length,
    newCategoryPaths,
    missingFromFile,
  };
}

/** Was sich an einem Artikel aendert - im Klartext fuer die Vorschau. */
function describeChanges(before: Product, after: Product, categories: readonly Category[]): string[] {
  const changes: string[] = [];
  const amount = (value: Cents | null): string => (value == null ? "offener Preis" : formatAmount(value));

  if (before.name !== after.name) changes.push(`Name: ${before.name} -> ${after.name}`);
  if (before.price !== after.price) changes.push(`Preis: ${amount(before.price)} -> ${amount(after.price)}`);
  if (before.taxKey !== after.taxKey) changes.push(`Steuersatz: ${taxLabel(before.taxKey)} -> ${taxLabel(after.taxKey)}`);
  if ((before.taxKeyDineIn ?? null) !== (after.taxKeyDineIn ?? null)) {
    changes.push(
      `Steuersatz vor Ort: ${before.taxKeyDineIn == null ? "wie ausser Haus" : taxLabel(before.taxKeyDineIn)} -> ${after.taxKeyDineIn == null ? "wie ausser Haus" : taxLabel(after.taxKeyDineIn)}`,
    );
  }
  if (before.unit !== after.unit) changes.push(`Einheit: ${UNIT_LABELS[before.unit]} -> ${UNIT_LABELS[after.unit]}`);
  if ((before.sku ?? "") !== (after.sku ?? "")) changes.push(`Artikelnummer: ${before.sku ?? "-"} -> ${after.sku ?? "-"}`);
  if (before.categoryId !== after.categoryId) {
    changes.push(
      `Warengruppe: ${categoryPathLabel(categories, before.categoryId)} -> ${categoryPathLabel(categories, after.categoryId)}`,
    );
  }
  const beforeDeposits = [...(before.depositProductIds ?? [])].sort().join(",");
  const afterDeposits = [...(after.depositProductIds ?? [])].sort().join(",");
  if (beforeDeposits !== afterDeposits) changes.push("Pfandzuordnung geaendert");
  if ((before.trackStock === true) !== (after.trackStock === true)) {
    changes.push(`Bestandsfuehrung: ${before.trackStock ? "ja" : "nein"} -> ${after.trackStock ? "ja" : "nein"}`);
  }
  if ((before.lowStockThreshold ?? null) !== (after.lowStockThreshold ?? null)) changes.push("Mindestbestand geaendert");
  if (before.active !== after.active) changes.push(`Aktiv: ${before.active ? "ja" : "nein"} -> ${after.active ? "ja" : "nein"}`);
  return changes;
}

// --- Sicherung als JSON --------------------------------------------------

/** Format der Sicherungsdatei. Steigt, wenn sich die Struktur aendert. */
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupPayload {
  readonly formatVersion: number;
  readonly createdAt: Timestamp;
  /** Bezeichnung des Betriebs - nur damit ein Mensch die Datei zuordnen kann. */
  readonly tenantName: string;
  readonly tenant: Tenant;
  readonly stores: readonly Store[];
  readonly categories: readonly Category[];
  readonly products: readonly Product[];
}

export interface BackupFile {
  readonly payload: BackupPayload;
  /**
   * SHA-256 ueber die Nutzdaten.
   *
   * Kein Schutz gegen Faelschung - wer die Datei aendert, kann die Pruefsumme
   * neu bilden. Sie faengt den Fall ab, der wirklich passiert: eine halb
   * kopierte Datei, ein abgebrochener Download, ein Editor, der die Kodierung
   * geaendert hat. Das ohne Pruefsumme einzuspielen heisst, einen kaputten
   * Stamm einzuspielen.
   */
  readonly checksum: string;
}

/** Sicherung bilden. */
export function buildBackup(input: {
  readonly tenant: Tenant;
  readonly stores: readonly Store[];
  readonly categories: readonly Category[];
  readonly products: readonly Product[];
  readonly createdAt: Timestamp;
}): BackupFile {
  const payload: BackupPayload = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: input.createdAt,
    tenantName: input.tenant.name,
    tenant: input.tenant,
    stores: [...input.stores],
    categories: [...input.categories],
    products: [...input.products],
  };
  return { payload, checksum: checksumOf(payload) };
}

function checksumOf(payload: BackupPayload): string {
  return toHex(sha256(utf8(JSON.stringify(payload))));
}

/** Sicherung als Text, wie sie in die Datei geschrieben wird. */
export function serializeBackup(file: BackupFile): string {
  // Mit Einrueckung: eine Sicherung wird gelegentlich von einem Menschen
  // angesehen, und 200 KB in einer Zeile sieht niemand an.
  return JSON.stringify(file, null, 2);
}

/**
 * Sicherung lesen und pruefen.
 *
 * Prueft Format, Pruefsumme und die Zaehlbarkeit der Inhalte, **bevor**
 * irgendetwas gespeichert wird. Eine halb eingespielte Sicherung ist schlimmer
 * als keine: danach weiss niemand mehr, welcher Stand gilt.
 */
export function readBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError("Die Datei ist keine Sicherung - sie laesst sich nicht lesen.");
  }
  if (!parsed || typeof parsed !== "object") throw new BackupError("Die Datei ist keine Sicherung.");

  const file = parsed as { payload?: unknown; checksum?: unknown };
  if (!file.payload || typeof file.payload !== "object" || typeof file.checksum !== "string") {
    throw new BackupError("Die Datei ist keine Sicherung - Nutzdaten oder Pruefsumme fehlen.");
  }

  const payload = file.payload as BackupPayload;
  if (payload.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      `Diese Sicherung hat Format ${String(payload.formatVersion)}, die App erwartet ${BACKUP_FORMAT_VERSION}. ` +
        "Eine neuere Sicherung kann nicht in eine aeltere App eingespielt werden.",
    );
  }
  if (!payload.tenant || !Array.isArray(payload.products) || !Array.isArray(payload.categories)) {
    throw new BackupError("Die Sicherung ist unvollstaendig - Betrieb, Warengruppen oder Artikel fehlen.");
  }

  const expected = checksumOf(payload);
  if (expected !== file.checksum) {
    throw new BackupError(
      "Die Pruefsumme stimmt nicht. Die Datei ist unvollstaendig oder wurde nachtraeglich geaendert - sie wird nicht eingespielt.",
    );
  }
  return { payload, checksum: file.checksum };
}

/** Kurzbeschreibung einer Sicherung fuer die Bestaetigung vor dem Einspielen. */
export function describeBackup(file: BackupFile): string {
  const { payload } = file;
  const deposits = payload.products.filter((product) => product.isDeposit).length;
  return [
    `Betrieb: ${payload.tenantName}`,
    `Erstellt: ${payload.createdAt.replace("T", " ").slice(0, 16)}`,
    `${payload.categories.length} Warengruppen`,
    `${payload.products.length - deposits} Artikel, ${deposits} Pfandartikel`,
  ].join("\n");
}

/** Name der Datei, unter dem gespeichert wird. */
export function backupFileName(tenantName: string, createdAt: Timestamp, extension: "json" | "csv"): string {
  const slug = tenantName
    .toLowerCase()
    .replace(/[äöüß]/g, (char) => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[char] ?? char)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const day = createdAt.slice(0, 10);
  const time = createdAt.slice(11, 16).replace(":", "");
  return `${slug || "kasse"}-artikel-${day}-${time}.${extension}`;
}

/**
 * Bildlizenzen einer Sicherung, zum Nachlesen.
 *
 * Bilder werden als Adresse gesichert, nicht als Datei: die Datei wuerde die
 * Sicherung um Groessenordnungen aufblaehen, und die Lizenz verlangt die Nennung
 * der Quelle - die bleibt so erhalten. Verschwindet ein Bild im Netz, fehlt es
 * nach dem Einspielen; das ist sichtbar und behebbar.
 */
export function backupImageLicenses(file: BackupFile): readonly { readonly name: string; readonly image: ProductImage }[] {
  return file.payload.products
    .filter((product): product is Product & { image: ProductImage } => product.image != null)
    .map((product) => ({ name: product.name, image: product.image }));
}
