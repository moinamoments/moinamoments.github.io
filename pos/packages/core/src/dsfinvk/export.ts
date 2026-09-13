/**
 * DSFinV-K-Export.
 *
 * Die "Digitale Schnittstelle der Finanzverwaltung fuer Kassensysteme" ist das
 * Format, in dem eine Kasse ihre Daten bei einer Kassennachschau oder
 * Betriebspruefung herausgeben muss (§ 4 KassenSichV). Sie besteht aus einer
 * Reihe CSV-Dateien plus einer `index.xml`, die den Aufbau beschreibt.
 *
 * Bezugsgroesse ist immer der **Kassenabschluss**, nicht der Tag: ein Export
 * enthaelt einen oder mehrere vollstaendige Abschluesse, niemals einen
 * angeschnittenen.
 *
 * UMFANG DIESER UMSETZUNG - bitte vor einer Pruefung lesen:
 *
 * Umgesetzt sind die Dateien des Einzelaufzeichnungsmoduls und des
 * Kassenabschlussmoduls, die ein Kassensystem mit Barverkauf und Kartenzahlung
 * fuellen muss:
 *
 *   cashpointclosing.csv  Kassenabschluss (Kopf)
 *   businesscases.csv     Geschaeftsvorfaelle je Abschluss und Steuersatz
 *   payment.csv           Zahlarten je Abschluss
 *   transactions.csv      Bonkopf
 *   transactions_tse.csv  TSE-Daten je Bon
 *   datapayment.csv       Zahlarten je Bon
 *   lines.csv             Bonpositionen
 *   lines_vat.csv         Umsatzsteuer je Bonposition
 *   index.xml             Beschreibung der Dateien und Felder
 *
 * NICHT umgesetzt sind unter anderem: Stammdatenmodul (`cashregister.csv`,
 * `location.csv`, `slaves.csv`, `pa.csv`, `vat.csv`, `tse.csv`), das
 * Warenwirtschaftsmodul, Waehrungen ausser Euro und die `gdpdu-01-09-2004.dtd`.
 * Der Export ist damit *noch nicht* abgabefaehig. Was fehlt, steht in
 * docs/ROADMAP.md; vor dem Produktivstart gehoert das Ergebnis durch den
 * Pruefer des Steuerberaters oder ein Validierungswerkzeug.
 *
 * Formatregeln, die die Schnittstelle vorgibt und die hier eingehalten werden:
 *   - Trennzeichen Komma, Textbegrenzer doppelte Anfuehrungszeichen
 *   - Dezimaltrennzeichen Punkt, kein Tausendertrennzeichen
 *   - Zeichensatz UTF-8, Zeilenende CRLF
 *   - Datum und Zeit als ISO 8601 mit Offset
 */

import type { ClosingReport } from "../closing.ts";
import { formatDecimal, formatQuantityDecimal } from "../money.ts";
import type { Device, Order, Store, Tenant } from "../model.ts";
import { isTseSecured } from "../order.ts";
import { createTaxRegistry, netFromGross, taxFromGross, type TaxRegistry } from "../tax.ts";

export class DsfinvkError extends Error {}

/** Version der Schnittstelle, gegen die dieser Export gebaut ist. */
export const DSFINVK_VERSION = "2.3";

export interface ExportFile {
  readonly name: string;
  readonly content: string;
}

export interface ExportInput {
  readonly tenant: Tenant;
  readonly store: Store;
  readonly device: Device;
  /** Abschluesse mit ihren Belegen. Jeder Abschluss muss vollstaendig sein. */
  readonly closings: readonly { readonly report: ClosingReport; readonly orders: readonly Order[] }[];
  readonly taxRegistry?: TaxRegistry;
}

// --- CSV ------------------------------------------------------------------

/**
 * Ein CSV-Feld maskieren.
 *
 * Anfuehrungszeichen werden verdoppelt. Das ist keine Kosmetik: ein
 * Artikelname mit Anfuehrungszeichen - "Crepe \"Hausgemacht\"" - wuerde die
 * Datei sonst ab dieser Zeile unlesbar machen, und die Pruefung wuerde den
 * ganzen Export zurueckweisen.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value == null) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}

export function csvRow(values: readonly (string | number | null | undefined)[]): string {
  return values.map(csvField).join(",");
}

/** CSV-Datei aus Kopfzeile und Datenzeilen; Zeilenende CRLF wie vorgegeben. */
export function csvFile(header: readonly string[], rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return [csvRow(header), ...rows.map(csvRow)].join("\r\n") + "\r\n";
}

// --- Dateien --------------------------------------------------------------

const CASHPOINTCLOSING_HEADER = [
  "Z_KASSE_ID", "Z_ERSTELLUNG", "Z_NR", "Z_BUCHUNGSTAG", "TAXONOMIE_VERSION",
  "Z_START_ID", "Z_ENDE_ID", "NAME", "STRASSE", "PLZ", "ORT", "LAND", "STNR", "USTID",
  "Z_SE_ZAHLUNGEN", "Z_SE_BARZAHLUNGEN",
] as const;

const BUSINESSCASES_HEADER = [
  "Z_KASSE_ID", "Z_ERSTELLUNG", "Z_NR", "GV_TYP", "GV_NAME", "AGENTUR_ID", "UST_SCHLUESSEL",
  "Z_UMS_BRUTTO", "Z_UMS_NETTO", "Z_UST",
] as const;

const PAYMENT_HEADER = [
  "Z_KASSE_ID", "Z_ERSTELLUNG", "Z_NR", "ZAHLART_TYP", "ZAHLART_NAME", "Z_ZAHLART_BETRAG",
] as const;

const TRANSACTIONS_HEADER = [
  "Z_KASSE_ID", "Z_ERSTELLUNG", "Z_NR", "BON_ID", "BON_NR", "BON_TYP", "BON_NAME",
  "TERMINAL_ID", "BON_STORNO", "BON_START", "BON_ENDE", "BEDIENER_ID", "BEDIENER_NAME",
  "UMS_BRUTTO",
] as const;

const TRANSACTIONS_TSE_HEADER = [
  "Z_KASSE_ID", "Z_ERSTELLUNG", "Z_NR", "BON_ID", "TSE_ID", "TSE_TANR", "TSE_TA_START",
  "TSE_TA_ENDE", "TSE_TA_VORGANGSART", "TSE_TA_SIGZ", "TSE_TA_SIG", "TSE_TA_FEHLER",
  "TSE_TA_VORGANGSDATEN",
] as const;

const DATAPAYMENT_HEADER = [
  "Z_KASSE_ID", "Z_ERSTELLUNG", "Z_NR", "BON_ID", "ZAHLART_TYP", "ZAHLART_NAME", "BETRAG",
] as const;

const LINES_HEADER = [
  "Z_KASSE_ID", "Z_ERSTELLUNG", "Z_NR", "BON_ID", "POS_ZEILE", "GUTSCHEIN_NR", "ARTIKELTEXT",
  "POS_TERMINAL_ID", "GV_TYP", "GV_NAME", "INHAUS", "P_STORNO", "AGENTUR_ID", "ART_NR",
  "GTIN", "WARENGR_ID", "WARENGR", "MENGE", "FAKTOR", "EINHEIT", "STK_BR",
] as const;

const LINES_VAT_HEADER = [
  "Z_KASSE_ID", "Z_ERSTELLUNG", "Z_NR", "BON_ID", "POS_ZEILE", "UST_SCHLUESSEL",
  "POS_BRUTTO", "POS_NETTO", "POS_UST",
] as const;

/**
 * Zahlart im Schema der DSFinV-K.
 *
 * Erlaubt sind unter anderem `Bar`, `Unbar`, `ECKarte`, `Kreditkarte`,
 * `Guthabenkarte`, `Gutschein`. Eigene Bezeichnungen kommen in
 * `ZAHLART_NAME`, nicht in `ZAHLART_TYP`.
 */
function paymentType(method: string): string {
  switch (method) {
    case "CASH":
      return "Bar";
    case "CARD_DEBIT":
      return "ECKarte";
    case "CARD_CREDIT":
      return "Kreditkarte";
    case "VOUCHER":
      return "Gutschein";
    default:
      return "Unbar";
  }
}

/**
 * Belegart. `Beleg` ist der Umsatzbeleg - auch ein Storno ist ein Beleg und
 * wird ueber `BON_STORNO` gekennzeichnet, nicht ueber eine eigene Belegart.
 * Kassenbewegungen ohne Umsatz (Geldtransit, Privatentnahme) tragen
 * `AVTransfer` bzw. `AVSonstige`; die kennt die Kasse noch nicht.
 */
const RECEIPT_TYPE = "Beleg";

export function buildExport(input: ExportInput): ExportFile[] {
  const registry = input.taxRegistry ?? createTaxRegistry();
  const { tenant, store, device } = input;

  if (input.closings.length === 0) throw new DsfinvkError("Ein Export ohne Kassenabschluss ist nicht zulaessig");

  const cashpointclosing: (string | number | null)[][] = [];
  const businesscases: (string | number | null)[][] = [];
  const payment: (string | number | null)[][] = [];
  const transactions: (string | number | null)[][] = [];
  const transactionsTse: (string | number | null)[][] = [];
  const datapayment: (string | number | null)[][] = [];
  const lines: (string | number | null)[][] = [];
  const linesVat: (string | number | null)[][] = [];

  for (const entry of input.closings) {
    const report = entry.report;
    const closing = report.closing;
    const kasseId = device.serialNumber;
    const erstellung = closing.createdAt;
    const zNr = closing.number;

    const orders = [...entry.orders].sort((a, b) => a.receiptNumber.localeCompare(b.receiptNumber, "de"));
    for (const order of orders) {
      if (!closing.orderIds.includes(order.id)) {
        throw new DsfinvkError(`Beleg ${order.receiptNumber} gehoert nicht zu Abschluss ${zNr}`);
      }
    }
    if (closing.orderIds.length !== orders.length) {
      throw new DsfinvkError(
        `Abschluss ${zNr} verweist auf ${closing.orderIds.length} Belege, uebergeben wurden ${orders.length} - ein angeschnittener Abschluss darf nicht exportiert werden`,
      );
    }

    cashpointclosing.push([
      kasseId,
      erstellung,
      zNr,
      closing.to.slice(0, 10),
      DSFINVK_VERSION,
      report.firstReceiptNumber,
      report.lastReceiptNumber,
      tenant.legalName || tenant.name,
      store.street ?? tenant.street,
      store.postalCode ?? tenant.postalCode,
      store.city ?? tenant.city,
      tenant.countryCode === "DE" ? "DEU" : tenant.countryCode,
      tenant.taxNumber ?? "",
      tenant.vatId ?? "",
      formatDecimal(report.grossTotal),
      formatDecimal(report.payments.find((p) => p.method === "CASH")?.amount ?? 0),
    ]);

    // Geschaeftsvorfaelle: je Geschaeftsvorfallart und Steuersatz eine Zeile.
    const byCase = new Map<string, Map<number, number>>();
    for (const order of orders) {
      for (const line of order.lines) {
        const perTax = byCase.get(line.businessCaseType) ?? new Map<number, number>();
        perTax.set(line.taxKey, (perTax.get(line.taxKey) ?? 0) + line.gross);
        byCase.set(line.businessCaseType, perTax);
      }
    }
    for (const [type, perTax] of byCase) {
      for (const [taxKey, gross] of perTax) {
        const rate = registry.get(taxKey).rate;
        businesscases.push([
          kasseId, erstellung, zNr, type, "", "", taxKey,
          formatDecimal(gross),
          formatDecimal(netFromGross(gross, rate)),
          formatDecimal(taxFromGross(gross, rate)),
        ]);
      }
    }

    for (const total of report.payments) {
      payment.push([kasseId, erstellung, zNr, paymentType(total.method), total.label, formatDecimal(total.amount)]);
    }

    for (const order of orders) {
      transactions.push([
        kasseId, erstellung, zNr,
        order.id,
        order.receiptNumber,
        RECEIPT_TYPE,
        order.voidsOrderId != null ? `Storno zu ${order.voidsOrderId}` : "",
        device.id,
        order.voidsOrderId != null ? 1 : 0,
        order.startedAt,
        order.paidAt ?? order.startedAt,
        order.userId,
        "",
        formatDecimal(order.total),
      ]);

      const tse = order.tse;
      transactionsTse.push([
        kasseId, erstellung, zNr, order.id,
        tse?.serialNumber ?? "",
        tse && isTseSecured(order) ? tse.transactionNumber : "",
        tse && isTseSecured(order) ? tse.startTime : "",
        tse && isTseSecured(order) ? tse.logTime : "",
        tse?.processType ?? "",
        tse && isTseSecured(order) ? tse.signatureCounter : "",
        tse && isTseSecured(order) ? tse.signature : "",
        // Der Ausfallgrund gehoert in die Datei, nicht nur auf den Bon.
        tse?.failureReason ?? "",
        tse?.processData ?? "",
      ]);

      for (const p of order.payments) {
        datapayment.push([kasseId, erstellung, zNr, order.id, paymentType(p.method), p.label, formatDecimal(p.amount)]);
      }

      for (const line of order.lines) {
        const rate = registry.get(line.taxKey).rate;
        lines.push([
          kasseId, erstellung, zNr, order.id, line.position, "",
          line.name,
          device.id,
          line.businessCaseType,
          "",
          order.serviceMode === "DINE_IN" ? 1 : 0,
          line.gross < 0 ? 1 : 0,
          "",
          line.productId ?? "",
          "",
          "",
          "",
          formatQuantityDecimal(line.quantity),
          "1.000",
          "Stk",
          formatDecimal(line.unitPrice),
        ]);
        linesVat.push([
          kasseId, erstellung, zNr, order.id, line.position, line.taxKey,
          formatDecimal(line.gross),
          formatDecimal(netFromGross(line.gross, rate)),
          formatDecimal(taxFromGross(line.gross, rate)),
        ]);
      }
    }
  }

  const files: ExportFile[] = [
    { name: "cashpointclosing.csv", content: csvFile(CASHPOINTCLOSING_HEADER, cashpointclosing) },
    { name: "businesscases.csv", content: csvFile(BUSINESSCASES_HEADER, businesscases) },
    { name: "payment.csv", content: csvFile(PAYMENT_HEADER, payment) },
    { name: "transactions.csv", content: csvFile(TRANSACTIONS_HEADER, transactions) },
    { name: "transactions_tse.csv", content: csvFile(TRANSACTIONS_TSE_HEADER, transactionsTse) },
    { name: "datapayment.csv", content: csvFile(DATAPAYMENT_HEADER, datapayment) },
    { name: "lines.csv", content: csvFile(LINES_HEADER, lines) },
    { name: "lines_vat.csv", content: csvFile(LINES_VAT_HEADER, linesVat) },
  ];
  files.push({ name: "index.xml", content: buildIndexXml(files) });
  return files;
}

const FILE_HEADERS: Record<string, readonly string[]> = {
  "cashpointclosing.csv": CASHPOINTCLOSING_HEADER,
  "businesscases.csv": BUSINESSCASES_HEADER,
  "payment.csv": PAYMENT_HEADER,
  "transactions.csv": TRANSACTIONS_HEADER,
  "transactions_tse.csv": TRANSACTIONS_TSE_HEADER,
  "datapayment.csv": DATAPAYMENT_HEADER,
  "lines.csv": LINES_HEADER,
  "lines_vat.csv": LINES_VAT_HEADER,
};

/** XML-Text maskieren. */
function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * `index.xml` erzeugen.
 *
 * Beschreibt fuer die Pruefsoftware, welche Dateien der Export enthaelt und
 * welche Spalten in welcher Reihenfolge darin stehen. Ohne diese Datei ist ein
 * Export nicht einlesbar.
 */
export function buildIndexXml(files: readonly ExportFile[]): string {
  const tables = files
    .filter((file) => file.name.endsWith(".csv"))
    .map((file) => {
      const header = FILE_HEADERS[file.name];
      if (!header) throw new DsfinvkError(`Keine Spaltenbeschreibung fuer ${file.name}`);
      const columns = header
        .map((column) => `          <VariableLength>\n            <Name>${xml(column)}</Name>\n          </VariableLength>`)
        .join("\n");
      return [
        "    <Table>",
        `      <URL>${xml(file.name)}</URL>`,
        `      <Name>${xml(file.name.replace(/\.csv$/, ""))}</Name>`,
        "      <Description />",
        "      <Validity>",
        "        <Range>",
        "          <From />",
        "          <To />",
        "        </Range>",
        "      </Validity>",
        "      <DecimalSymbol>.</DecimalSymbol>",
        "      <DigitGroupingSymbol>,</DigitGroupingSymbol>",
        "      <VariableLength>",
        "        <ColumnDelimiter>,</ColumnDelimiter>",
        "        <RecordDelimiter>&#13;&#10;</RecordDelimiter>",
        '        <TextEncapsulator>"</TextEncapsulator>',
        columns,
        "      </VariableLength>",
        "    </Table>",
      ].join("\n");
    })
    .join("\n");

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<DataSet xmlns="http://www.bzst.bund.de/dsfinvk">',
    "  <Version>1.0</Version>",
    `  <DataSupplier>`,
    `    <Name>DSFinV-K ${DSFINVK_VERSION}</Name>`,
    `  </DataSupplier>`,
    "  <Media>",
    "    <Name>DSFinV-K Export</Name>",
    tables,
    "  </Media>",
    "</DataSet>",
    "",
  ].join("\n");
}

/** Alle Dateien als einfache Namens-Inhalt-Zuordnung, fuers Schreiben auf Platte. */
export function exportToMap(files: readonly ExportFile[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const file of files) map[file.name] = file.content;
  return map;
}
