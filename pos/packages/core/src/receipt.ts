/**
 * Beleg (Bon).
 *
 * § 6 KassenSichV schreibt vor, was auf einem Kassenbeleg stehen muss:
 *
 *   1. vollstaendiger Name und vollstaendige Adresse des leistenden
 *      Unternehmers
 *   2. Datum der Belegausstellung sowie Zeitpunkt des Vorgangbeginns und
 *      Zeitpunkt der Vorgangbeendigung
 *   3. Menge und Art der gelieferten Gegenstaende oder Umfang und Art der
 *      sonstigen Leistung
 *   4. Transaktionsnummer
 *   5. Entgelt und darauf entfallender Steuerbetrag, nach Steuersaetzen
 *      aufgeschluesselt, oder Hinweis auf eine Steuerbefreiung
 *   6. Seriennummer des elektronischen Aufzeichnungssystems oder der TSE
 *
 * Zusaetzlich verlangt die Belegausgabepflicht (§ 146a Abs. 2 AO), dass der
 * Beleg dem Kunden *angeboten* wird - mitnehmen muss er ihn nicht. Ein
 * Anzeigen auf dem Bildschirm oder ein QR-Code genuegt, wenn der Kunde ihn
 * dort abrufen kann.
 *
 * Alle Zeitangaben und Betraege kommen aus dem Beleg, nicht aus der Uhr des
 * Druckers: ein Nachdruck muss denselben Bon ergeben wie das Original.
 */

import { type Cents, formatAmount, formatDecimal, formatEuro, formatQuantity } from "./money.ts";
import type { Device, Order, Store, Tenant, TseTransactionRecord } from "./model.ts";
import { type TaxGroupTotal, type TaxRegistry, createTaxRegistry, summarizeTax } from "./tax.ts";

export class ReceiptError extends Error {}

export interface ReceiptContext {
  readonly tenant: Tenant;
  readonly store: Store;
  readonly device: Device;
  readonly taxRegistry?: TaxRegistry;
  /** `true` markiert einen Nachdruck - Pflicht, damit er nicht als Erstbeleg gilt. */
  readonly reprint?: boolean;
}

export interface ReceiptLineView {
  readonly quantity: string;
  readonly name: string;
  readonly unitPrice: string;
  readonly total: string;
  readonly notes: readonly string[];
  /** Pfandposition: wird auf dem Bon eingerueckt unter ihrer Warenposition. */
  readonly isDeposit: boolean;
}

export interface ReceiptView {
  readonly header: readonly string[];
  readonly receiptNumber: string;
  readonly issuedAt: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly serviceMode: string;
  readonly lines: readonly ReceiptLineView[];
  readonly total: string;
  readonly taxGroups: readonly TaxGroupTotal[];
  readonly payments: readonly { readonly label: string; readonly amount: string }[];
  readonly change: Cents;
  /** Pfandsaldo des Belegs; `null`, wenn der Beleg kein Pfand enthaelt. */
  readonly depositBalance: Cents | null;
  /** Pflichtangaben der TSE oder der Hinweis auf ihren Ausfall. */
  readonly tseLines: readonly string[];
  readonly qrPayload: string | null;
  readonly footer: readonly string[];
}

/** Datum und Uhrzeit eines ISO-Zeitstempels in deutscher Schreibweise. */
export function formatGermanDateTime(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) throw new ReceiptError(`Zeitstempel nicht lesbar: ${iso}`);
  const [, year, month, day, hour, minute, second] = match;
  return `${day}.${month}.${year} ${hour}:${minute}:${second}`;
}

/** Nur die Uhrzeit, fuer Beginn und Ende desselben Tages. */
export function formatGermanTime(iso: string): string {
  return formatGermanDateTime(iso).slice(11);
}

/**
 * QR-Code-Inhalt fuer die Belegpruefung ("digitaler Kassenbeleg", Version V0).
 *
 * Aufbau - Reihenfolge und Trennzeichen sind festgelegt und duerfen nicht
 * veraendert werden:
 *
 *   V0;<Kassen-Seriennummer>;<processType>;<processData>;<transactionNumber>;
 *   <signatureCounter>;<startTime>;<logTime>;<sigAlg>;<logTimeFormat>;
 *   <signature>;<publicKey>
 *
 * Der QR-Code ist freiwillig: Pflicht ist, dass die Angaben *lesbar* auf dem
 * Beleg stehen. Wer den QR-Code druckt, darf dafuer die einzelnen
 * TSE-Angaben weglassen - das macht den Bon kuerzer und die Pruefung durch
 * das Finanzamt schneller. Deshalb wird er hier immer erzeugt.
 *
 * Zu pruefen vor dem Produktivstart: Die Zeitangaben muessen im Format der
 * eingesetzten TSE stehen (`unixTime` als Sekundenzahl, `utcTime` als
 * ISO-Zeit). Die Felder werden daher unveraendert aus der TSE-Antwort
 * uebernommen und hier nicht umgerechnet.
 */
export function buildReceiptQrPayload(device: Device, tse: TseTransactionRecord): string | null {
  // Ohne Signatur gibt es nichts zu pruefen: ein QR-Code mit leeren Feldern
  // wuerde einen abgesicherten Beleg vortaeuschen.
  if (!tse.signature || tse.failureReason) return null;

  const fields = [
    "V0",
    device.serialNumber,
    tse.processType,
    tse.processData,
    String(tse.transactionNumber),
    String(tse.signatureCounter),
    tse.startTime,
    tse.logTime,
    tse.signatureAlgorithm,
    tse.logTimeFormat,
    tse.signature,
    tse.publicKey,
  ];

  for (const field of fields) {
    if (field.includes(";")) {
      throw new ReceiptError(`Feld des QR-Codes enthaelt ein Semikolon und wuerde den Code zerstoeren: ${field}`);
    }
  }
  return fields.join(";");
}

/** Beleg in eine Darstellung uebersetzen, aus der Druck und Anzeige entstehen. */
export function buildReceiptView(order: Order, context: ReceiptContext): ReceiptView {
  const { tenant, store, device } = context;
  if (order.tenantId !== tenant.id) throw new ReceiptError("Beleg gehoert zu einem anderen Mandanten");

  const header = [
    tenant.name,
    ...(tenant.legalName && tenant.legalName !== tenant.name ? [tenant.legalName] : []),
    store.street ?? tenant.street,
    `${store.postalCode ?? tenant.postalCode} ${store.city ?? tenant.city}`,
    ...(tenant.vatId ? [`USt-IdNr. ${tenant.vatId}`] : tenant.taxNumber ? [`Steuernummer ${tenant.taxNumber}`] : []),
  ];

  const taxGroups = summarizeTax(
    order.lines.map((line) => ({ taxKey: line.taxKey, gross: line.gross })),
    context.taxRegistry ?? createTaxRegistry(),
  );

  const depositLines = order.lines.filter(
    (line) => line.businessCaseType === "Pfand" || line.businessCaseType === "PfandRueckzahlung",
  );

  const lines: ReceiptLineView[] = order.lines.map((line) => ({
    quantity: formatQuantity(line.quantity),
    name: line.name,
    unitPrice: formatAmount(line.unitPrice),
    total: formatAmount(line.gross),
    isDeposit: line.businessCaseType === "Pfand" || line.businessCaseType === "PfandRueckzahlung",
    notes: [
      ...line.modifiers.map((m) => `+ ${m.name}${m.priceDelta === 0 ? "" : ` ${formatAmount(m.priceDelta)}`}`),
      ...(line.discount > 0 ? [`Rabatt -${formatAmount(line.discount)}`] : []),
      ...(line.allocatedDiscount > 0 ? [`Belegrabatt -${formatAmount(line.allocatedDiscount)}`] : []),
      ...(line.note ? [line.note] : []),
    ],
  }));

  const footer: string[] = [];
  if (tenant.smallBusiness) {
    // Pflichthinweis: ohne ihn ist der Beleg eines Kleinunternehmers
    // unvollstaendig und der Kunde koennte Vorsteuer vermuten.
    footer.push("Kein Steuerausweis: Kleinunternehmer nach § 19 UStG.");
  }
  if (context.reprint) footer.push("NACHDRUCK - kein Erstbeleg");
  if (tenant.receiptFooter) footer.push(tenant.receiptFooter);

  return {
    header,
    receiptNumber: order.receiptNumber,
    issuedAt: formatGermanDateTime(order.paidAt ?? order.startedAt),
    startedAt: formatGermanDateTime(order.startedAt),
    finishedAt: formatGermanDateTime(order.paidAt ?? order.startedAt),
    serviceMode: order.serviceMode === "DINE_IN" ? "Verzehr vor Ort" : "Ausser Haus",
    lines,
    total: formatAmount(order.total),
    taxGroups,
    payments: order.payments.map((p) => ({ label: p.label, amount: formatAmount(p.amount) })),
    change: order.payments.reduce((sum, p) => sum + p.change, 0),
    depositBalance: depositLines.length === 0 ? null : depositLines.reduce((sum, line) => sum + line.gross, 0),
    tseLines: buildTseLines(order, device),
    qrPayload: order.tse ? buildReceiptQrPayload(device, order.tse) : null,
    footer,
  };
}

function buildTseLines(order: Order, device: Device): string[] {
  const tse = order.tse;
  if (!tse || tse.failureReason) {
    // Der Ausfall gehoert auf den Bon. Ihn zu verschweigen waere der
    // schwerere Fehler - der Kunde und die Pruefung muessen erkennen
    // koennen, dass dieser Beleg nicht abgesichert ist.
    return [
      "Sicherheitseinrichtung ausgefallen",
      `Grund: ${tse?.failureReason ?? "keine TSE angebunden"}`,
      `Kasse: ${device.serialNumber}`,
    ];
  }
  return [
    `Transaktion: ${tse.transactionNumber}`,
    `Signaturzaehler: ${tse.signatureCounter}`,
    `Beginn: ${tse.startTime}`,
    `Log-Zeit: ${tse.logTime}`,
    `TSE-Seriennummer: ${tse.serialNumber}`,
    `Kasse: ${device.serialNumber}`,
  ];
}

/**
 * Bon als Text fuer einen Thermodrucker rendern.
 *
 * `width` ist die Zeichenbreite des Druckers: 32 bei 58-mm-Papier,
 * 42 bei 80 mm. Betraege stehen rechts, damit die Spalte auch bei
 * unterschiedlich langen Artikelnamen ausgerichtet bleibt.
 *
 * Keine Zeile darf die Druckbreite ueberschreiten: der Drucker bricht sonst
 * hart um und die TSE-Angaben werden unlesbar - auf einem Pflichtbeleg ein
 * echtes Problem. Zu lange Werte werden deshalb kontrolliert umgebrochen,
 * und die Steueraufstellung wechselt auf schmalem Papier von Spalten auf
 * zwei Zeilen je Satz.
 */
export function renderReceiptText(view: ReceiptView, width = 42): string {
  const out: string[] = [];
  const rule = "-".repeat(width);
  const center = (text: string): string => {
    const pad = Math.max(0, Math.floor((width - text.length) / 2));
    return " ".repeat(pad) + text;
  };
  const row = (left: string, right: string): string => {
    const space = Math.max(1, width - left.length - right.length);
    return left.length + right.length + 1 > width
      ? `${left.slice(0, width - right.length - 1)} ${right}`
      : left + " ".repeat(space) + right;
  };

  // Zu langen Text auf mehrere Zeilen verteilen, Folgezeilen eingerueckt.
  const wrap = (text: string, indent = "  "): string[] => {
    if (text.length <= width) return [text];
    const parts: string[] = [];
    let rest = text;
    let prefix = "";
    while (rest.length > width - prefix.length) {
      const room = width - prefix.length;
      const cut = rest.lastIndexOf(" ", room);
      const at = cut > room / 2 ? cut : room;
      parts.push(prefix + rest.slice(0, at).trimEnd());
      rest = rest.slice(at).trimStart();
      prefix = indent;
    }
    if (rest !== "") parts.push(prefix + rest);
    return parts;
  };

  /**
   * `Label: Wert` umbrechen, ohne den Wert zu zerschneiden. Ein auf zwei
   * Zeilen verteilter Zeitstempel oder eine zerhackte Seriennummer sind auf
   * einem Pflichtbeleg nicht mehr ablesbar - und genau diese Angaben sind
   * die, die bei einer Kassennachschau geprueft werden.
   */
  const wrapLabelValue = (line: string): string[] => {
    if (line.length <= width) return [line];
    const separator = line.indexOf(": ");
    if (separator < 0) return wrap(line);
    const label = line.slice(0, separator + 1);
    const value = line.slice(separator + 2);
    return [label, ...wrap(`  ${value}`, "  ")];
  };

  for (const line of view.header) out.push(...wrap(center(line)));
  out.push("");
  out.push(row(`Beleg ${view.receiptNumber}`, view.serviceMode));
  out.push(view.issuedAt);
  out.push(rule);

  for (const line of view.lines) {
    // Pfand steht eingerueckt unter seiner Warenposition: der Kunde soll auf
    // einen Blick sehen, welcher Teil des Betrags Pfand ist und damit
    // zurueckkommt.
    const prefix = line.isDeposit ? "  " : "";
    out.push(row(`${prefix}${line.quantity} x ${line.name}`, line.total));
    if (!line.isDeposit && line.quantity !== "1") {
      out.push(...wrap(`    Einzelpreis ${line.unitPrice}`, "      "));
    }
    for (const note of line.notes) out.push(...wrap(`    ${note}`, "      "));
  }

  out.push(rule);
  out.push(row("SUMME", `${view.total} EUR`));
  if (view.depositBalance != null) {
    out.push(row("darin Pfand", formatAmount(view.depositBalance)));
  }

  if (view.taxGroups.length > 0) {
    out.push("");
    if (width >= 40) {
      out.push(row("Satz", "Netto    Steuer    Brutto"));
      for (const group of view.taxGroups) {
        out.push(
          row(
            group.label,
            [
              formatAmount(group.net).padStart(8),
              formatAmount(group.tax).padStart(8),
              formatAmount(group.gross).padStart(8),
            ].join("  "),
          ),
        );
      }
    } else {
      // 58-mm-Papier: drei Spalten passen nicht, also zwei Zeilen je Satz.
      for (const group of view.taxGroups) {
        out.push(row(`Brutto ${group.label}`, formatAmount(group.gross)));
        out.push(row(`  Netto / USt`, `${formatAmount(group.net)} / ${formatAmount(group.tax)}`));
      }
    }
  }

  out.push("");
  for (const payment of view.payments) out.push(row(payment.label, payment.amount));
  if (view.change !== 0) out.push(row("Rueckgeld", formatAmount(view.change)));

  out.push(rule);
  out.push(row("Beginn", view.startedAt));
  out.push(row("Ende", view.finishedAt));
  for (const line of view.tseLines) out.push(...wrapLabelValue(line));

  if (view.footer.length > 0) {
    out.push(rule);
    for (const line of view.footer) out.push(...wrap(line, ""));
  }
  return out.join("\n");
}

/** Kurzfassung fuer die Bildschirmanzeige nach dem Bezahlen. */
export function summarizeReceipt(view: ReceiptView): string {
  return `${view.receiptNumber} · ${view.total} € · ${view.issuedAt}`;
}

/** Betrag einer Zahlart im Format der DSFinV-K, fuer Berichte. */
export function receiptTotalDecimal(order: Order): string {
  return formatDecimal(order.total);
}

/** Belegsumme mit Euro-Zeichen, fuer die Bildschirmanzeige. */
export function receiptTotalEuro(order: Order): string {
  return formatEuro(order.total);
}
