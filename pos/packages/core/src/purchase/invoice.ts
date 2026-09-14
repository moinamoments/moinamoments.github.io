/**
 * Die Lieferantenrechnung lesen.
 *
 * Zwei Formate kommen heute bei einem kleinen Betrieb an:
 *
 *   - **CII** (UN/CEFACT Cross Industry Invoice). Das ist der Inhalt von
 *     **ZUGFeRD** und **Factur-X** - dort steckt dieses XML in einer PDF-Datei
 *     (siehe `pdf.ts`) - und eines der beiden zulaessigen XRechnungs-Formate.
 *   - **UBL** (Universal Business Language). Das andere XRechnungs-Format;
 *     oeffentliche Auftraggeber und viele Grosshaendler liefern es.
 *
 * Beide beschreiben dieselbe Rechnung mit anderen Namen. Hier werden sie auf
 * **eine** Form gebracht, damit der Rest der App nur eine kennt.
 *
 * ## Was gelesen wird und was nicht
 *
 * Gelesen wird, was fuer einen Wareneingang gebraucht wird: Lieferant,
 * Rechnungsnummer, Datum, und je Position Menge, Bezeichnung, Nummer (GTIN
 * oder Lieferantenartikelnummer), Einkaufspreis und Steuersatz.
 *
 * Nicht gelesen wird alles, was die Rechnung sonst noch regelt: Zahlungsziele,
 * Skonto, Lieferadressen, Mahnstufen. Eine Kasse bucht daraus Ware in den
 * Bestand - sie ist keine Buchhaltung und soll auch nicht so aussehen.
 *
 * ## Warum Betraege hier netto sind
 *
 * Auf einer Lieferantenrechnung stehen Nettopreise; die Vorsteuer holt sich
 * der Betrieb zurueck. Der Einkaufspreis, der spaeter einen Bestandswert
 * ergibt, ist deshalb der **Nettopreis**. Der Verkaufspreis in der Kasse ist
 * dagegen brutto - das ist kein Widerspruch, sondern die uebliche Sicht von
 * beiden Seiten des Geschaefts.
 */

import type { Product } from "../model.ts";
import { ONE, type Cents, type Quantity, roundHalfUp } from "../money.ts";
import { XmlError, childrenNamed, parseXml, path, textAt, type XmlNode } from "./xml.ts";

export class InvoiceError extends Error {}

/** Woher die Rechnung kam - steht spaeter im Bestandsjournal. */
export type InvoiceFormat = "CII" | "UBL" | "CSV";

export interface SupplierInvoiceLine {
  /** Positionsnummer der Rechnung, wie sie dort steht. */
  readonly lineId: string | null;
  /** GTIN/EAN, falls angegeben - der zuverlaessigste Weg zum Artikel. */
  readonly gtin: string | null;
  /** Artikelnummer des Lieferanten. */
  readonly sellerItemId: string | null;
  readonly name: string;
  /** Menge in Tausendsteln, wie `Quantity` im ganzen System. */
  readonly quantity: Quantity;
  /** Mengeneinheit nach UN/ECE Rec. 20, z. B. `H87` (Stueck), `KGM`, `LTR`. */
  readonly unitCode: string | null;
  /** Nettopreis je Einheit in Cent. */
  readonly netUnitPrice: Cents | null;
  /** Nettobetrag der Position in Cent. */
  readonly netAmount: Cents | null;
  /** Steuersatz in Prozent, z. B. 19 oder 7. `null` = nicht angegeben. */
  readonly taxPercent: number | null;
}

export interface SupplierInvoice {
  readonly format: InvoiceFormat;
  readonly invoiceNumber: string | null;
  /** Rechnungsdatum als `YYYY-MM-DD`. */
  readonly issuedOn: string | null;
  readonly supplierName: string | null;
  /** Umsatzsteuer-Identifikationsnummer des Lieferanten. */
  readonly supplierVatId: string | null;
  readonly currency: string;
  readonly lines: readonly SupplierInvoiceLine[];
  /** Summen der Rechnung, soweit angegeben. */
  readonly netTotal: Cents | null;
  readonly taxTotal: Cents | null;
  readonly grossTotal: Cents | null;
}

/**
 * Positionen je Rechnung.
 *
 * Eine Grosshandelsrechnung eines Kiosks hat selten mehr als 100 Positionen.
 * 1000 laesst Luft fuer den Monatssammelbeleg und haelt die Vorschau auf dem
 * Telefon bedienbar.
 */
export const MAX_INVOICE_LINES = 1000;

/* ------------------------------------------------------------------ *
 * Zahlen und Daten
 * ------------------------------------------------------------------ */

/**
 * Eine Dezimalzahl aus dem XML in Cent.
 *
 * In XML steht der Punkt als Dezimaltrenner (so schreibt es die Spezifikation
 * vor). Ein Komma wird trotzdem angenommen: es gibt Erzeuger, die sich nicht
 * daran halten, und eine Rechnung wegen eines Kommas abzuweisen hilft dem
 * Betrieb nicht.
 *
 * Gerundet wird kaufmaennisch auf ganze Cent. Preise mit vier Nachkommastellen
 * sind im Grosshandel ueblich (0,1234 EUR je Stueck); der Rundungsfehler
 * bleibt unter einem Cent je Einheit und wird beim Positionsbetrag nicht
 * weitergerechnet, sondern der Betrag wird eigenstaendig gelesen.
 */
export function parseXmlDecimalToCents(value: string | null): Cents | null {
  const number = parseXmlDecimal(value);
  if (number == null) return null;
  return roundHalfUp(number * 100);
}

/** Eine Dezimalzahl aus dem XML als Zahl. */
export function parseXmlDecimal(value: string | null): number | null {
  if (value == null) return null;
  const trimmed = value.trim().replace(",", ".");
  if (trimmed.length === 0) return null;
  if (!/^[+-]?\d+(\.\d+)?$/.test(trimmed)) return null;
  const number = Number.parseFloat(trimmed);
  return Number.isFinite(number) ? number : null;
}

/** Eine Menge aus dem XML in Tausendstel. */
export function parseXmlQuantity(value: string | null): Quantity | null {
  const number = parseXmlDecimal(value);
  if (number == null) return null;
  return roundHalfUp(number * ONE);
}

/**
 * Ein Datum aus dem XML als `YYYY-MM-DD`.
 *
 * CII schreibt `20260914` mit `format="102"`, UBL schreibt `2026-09-14`.
 * Beides kommt vor, also versteht diese Funktion beides - und gibt `null`
 * zurueck, statt zu raten, wenn es etwas anderes ist. Ein falsches
 * Rechnungsdatum waere schlimmer als gar keines: es landet im Bestandsjournal
 * und laesst sich spaeter nicht mehr von einem richtigen unterscheiden.
 */
export function parseInvoiceDate(value: string | null): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (compact) return validDate(compact[1]!, compact[2]!, compact[3]!);
  const dashed = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (dashed) return validDate(dashed[1]!, dashed[2]!, dashed[3]!);
  return null;
}

function validDate(year: string, month: string, day: string): string | null {
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${month}-${day}`;
}

/* ------------------------------------------------------------------ *
 * Einstieg
 * ------------------------------------------------------------------ */

/**
 * Eine Rechnungsdatei lesen - CII oder UBL, selbst erkannt.
 *
 * Erkannt wird am Wurzelelement, nicht am Dateinamen: wie eine Datei heisst,
 * entscheidet der, der sie verschickt, und das ist keine verlaessliche Angabe.
 */
export function parseInvoiceXml(source: string): SupplierInvoice {
  let root: XmlNode;
  try {
    root = parseXml(source);
  } catch (error) {
    if (error instanceof XmlError) throw new InvoiceError(`Die Rechnungsdatei laesst sich nicht lesen: ${error.message}`);
    throw error;
  }

  if (root.name === "CrossIndustryInvoice") return parseCii(root);
  if (root.name === "Invoice" || root.name === "CreditNote") return parseUbl(root);
  throw new InvoiceError(
    `Unbekanntes Rechnungsformat: das Wurzelelement heisst "${root.name}". Erwartet wird ZUGFeRD/Factur-X oder eine XRechnung (CrossIndustryInvoice oder Invoice).`,
  );
}

function limitLines(lines: SupplierInvoiceLine[]): SupplierInvoiceLine[] {
  if (lines.length > MAX_INVOICE_LINES) {
    throw new InvoiceError(
      `Die Rechnung hat ${lines.length} Positionen; verarbeitet werden bis zu ${MAX_INVOICE_LINES}. Eine so grosse Rechnung gehoert in eine Warenwirtschaft, nicht in die Kasse.`,
    );
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * CII - ZUGFeRD, Factur-X, XRechnung (CII-Auspraegung)
 * ------------------------------------------------------------------ */

function parseCii(root: XmlNode): SupplierInvoice {
  const document = path(root, "ExchangedDocument");
  const transaction = path(root, "SupplyChainTradeTransaction");

  const agreement = transaction ? path(transaction, "ApplicableHeaderTradeAgreement") : null;
  const seller = agreement ? path(agreement, "SellerTradeParty") : null;
  const settlement = transaction ? path(transaction, "ApplicableHeaderTradeSettlement") : null;
  const summation = settlement ? path(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation") : null;

  const lines: SupplierInvoiceLine[] = [];
  for (const item of transaction ? childrenNamed(transaction, "IncludedSupplyChainTradeLineItem") : []) {
    lines.push(parseCiiLine(item));
  }

  return {
    format: "CII",
    invoiceNumber: document ? textAt(document, "ID") : null,
    issuedOn: parseInvoiceDate(document ? textAt(document, "IssueDateTime", "DateTimeString") : null),
    supplierName: seller ? textAt(seller, "Name") : null,
    supplierVatId: seller ? ciiVatId(seller) : null,
    currency: (settlement ? textAt(settlement, "InvoiceCurrencyCode") : null) ?? "EUR",
    lines: limitLines(lines),
    netTotal: parseXmlDecimalToCents(summation ? textAt(summation, "TaxBasisTotalAmount") : null),
    taxTotal: parseXmlDecimalToCents(summation ? textAt(summation, "TaxTotalAmount") : null),
    grossTotal: parseXmlDecimalToCents(summation ? textAt(summation, "GrandTotalAmount") : null),
  };
}

/**
 * Die Umsatzsteuer-Identifikationsnummer des Lieferanten.
 *
 * In CII stehen unter `SpecifiedTaxRegistration` mehrere Nummern nebeneinander;
 * welche gemeint ist, sagt das Attribut `schemeID`: `VA` ist die USt-IdNr.,
 * `FC` die Steuernummer. Wer einfach die erste nimmt, schreibt gelegentlich
 * die Steuernummer in das Feld fuer die USt-IdNr.
 */
function ciiVatId(seller: XmlNode): string | null {
  for (const registration of childrenNamed(seller, "SpecifiedTaxRegistration")) {
    const id = path(registration, "ID");
    if (id && id.attributes.schemeID === "VA" && id.text.length > 0) return id.text;
  }
  return null;
}

function parseCiiLine(item: XmlNode): SupplierInvoiceLine {
  const product = path(item, "SpecifiedTradeProduct");
  const agreement = path(item, "SpecifiedLineTradeAgreement");
  const delivery = path(item, "SpecifiedLineTradeDelivery");
  const settlement = path(item, "SpecifiedLineTradeSettlement");

  // Der vereinbarte Preis steht im Netto-Preis; daneben kann ein Bruttopreis
  // vor Rabatt stehen. Gebraucht wird der, der wirklich berechnet wird.
  const netPrice = agreement ? path(agreement, "NetPriceProductTradePrice") : null;
  const grossPrice = agreement ? path(agreement, "GrossPriceProductTradePrice") : null;
  const priceNode = netPrice ?? grossPrice;

  const tax = settlement ? path(settlement, "ApplicableTradeTax") : null;
  const summation = settlement ? path(settlement, "SpecifiedTradeSettlementLineMonetarySummation") : null;

  const quantityNode = delivery ? path(delivery, "BilledQuantity") : null;

  return {
    lineId: textAt(item, "AssociatedDocumentLineDocument", "LineID"),
    gtin: product ? ciiGtin(product) : null,
    sellerItemId: product ? textAt(product, "SellerAssignedID") : null,
    name: (product ? textAt(product, "Name") : null) ?? "Ohne Bezeichnung",
    quantity: parseXmlQuantity(quantityNode?.text ?? null) ?? 0,
    unitCode: quantityNode?.attributes.unitCode ?? null,
    netUnitPrice: parseXmlDecimalToCents(priceNode ? textAt(priceNode, "ChargeAmount") : null),
    netAmount: parseXmlDecimalToCents(summation ? textAt(summation, "LineTotalAmount") : null),
    taxPercent: parseXmlDecimal(tax ? textAt(tax, "RateApplicablePercent") : null),
  };
}

/**
 * Die GTIN einer CII-Position.
 *
 * `GlobalID` traegt ein `schemeID`: `0160` ist GS1 (die GTIN), andere Werte
 * sind andere Verzeichnisse. Fehlt das Attribut, wird der Wert genommen -
 * viele Erzeuger lassen es weg, und eine Nummer ohne Schema ist immer noch
 * besser als keine.
 */
function ciiGtin(product: XmlNode): string | null {
  const global = path(product, "GlobalID");
  if (!global || global.text.length === 0) return null;
  const scheme = global.attributes.schemeID;
  if (scheme && scheme !== "0160") return null;
  return global.text;
}

/* ------------------------------------------------------------------ *
 * UBL - XRechnung (UBL-Auspraegung)
 * ------------------------------------------------------------------ */

function parseUbl(root: XmlNode): SupplierInvoice {
  const supplier = path(root, "AccountingSupplierParty", "Party");
  const total = path(root, "LegalMonetaryTotal");

  // In einer Gutschrift heissen die Positionen anders; gelesen werden beide,
  // damit eine Rueckgabe an den Lieferanten nicht als leere Rechnung ankommt.
  const items = [...childrenNamed(root, "InvoiceLine"), ...childrenNamed(root, "CreditNoteLine")];

  return {
    format: "UBL",
    invoiceNumber: textAt(root, "ID"),
    issuedOn: parseInvoiceDate(textAt(root, "IssueDate")),
    supplierName: supplier ? (textAt(supplier, "PartyName", "Name") ?? textAt(supplier, "PartyLegalEntity", "RegistrationName")) : null,
    supplierVatId: supplier ? ublVatId(supplier) : null,
    currency: textAt(root, "DocumentCurrencyCode") ?? "EUR",
    lines: limitLines(items.map(parseUblLine)),
    netTotal: parseXmlDecimalToCents(total ? textAt(total, "TaxExclusiveAmount") : null),
    taxTotal: parseXmlDecimalToCents(ublTaxTotal(root)),
    grossTotal: parseXmlDecimalToCents(total ? textAt(total, "TaxInclusiveAmount") : null),
  };
}

function ublVatId(supplier: XmlNode): string | null {
  for (const scheme of childrenNamed(supplier, "PartyTaxScheme")) {
    const id = textAt(scheme, "CompanyID");
    if (id) return id;
  }
  return null;
}

function ublTaxTotal(root: XmlNode): string | null {
  const taxTotal = path(root, "TaxTotal");
  return taxTotal ? textAt(taxTotal, "TaxAmount") : null;
}

function parseUblLine(item: XmlNode): SupplierInvoiceLine {
  const article = path(item, "Item");
  const price = path(item, "Price");

  // `InvoicedQuantity` in der Rechnung, `CreditedQuantity` in der Gutschrift.
  const quantityNode = path(item, "InvoicedQuantity") ?? path(item, "CreditedQuantity");

  const category = article ? path(article, "ClassifiedTaxCategory") : null;

  return {
    lineId: textAt(item, "ID"),
    gtin: article ? ublGtin(article) : null,
    sellerItemId: article ? textAt(article, "SellersItemIdentification", "ID") : null,
    name: (article ? textAt(article, "Name") : null) ?? "Ohne Bezeichnung",
    quantity: parseXmlQuantity(quantityNode?.text ?? null) ?? 0,
    unitCode: quantityNode?.attributes.unitCode ?? null,
    netUnitPrice: ublUnitPrice(price),
    netAmount: parseXmlDecimalToCents(textAt(item, "LineExtensionAmount")),
    taxPercent: parseXmlDecimal(category ? textAt(category, "Percent") : null),
  };
}

function ublGtin(article: XmlNode): string | null {
  const standard = path(article, "StandardItemIdentification", "ID");
  if (!standard || standard.text.length === 0) return null;
  const scheme = standard.attributes.schemeID;
  if (scheme && scheme !== "0160" && scheme.toUpperCase() !== "GTIN") return null;
  return standard.text;
}

/**
 * Der Einzelpreis in UBL - mit `BaseQuantity`.
 *
 * UBL erlaubt Staffelpreise: `PriceAmount` 12,00 bei `BaseQuantity` 6 heisst
 * 12 EUR **fuer sechs Stueck**, also 2 EUR je Stueck. Wer die Basismenge
 * uebersieht, bucht den sechsfachen Einkaufspreis - und merkt es erst, wenn
 * der Bestandswert nicht stimmt.
 */
function ublUnitPrice(price: XmlNode | null): Cents | null {
  if (!price) return null;
  const amount = parseXmlDecimal(textAt(price, "PriceAmount"));
  if (amount == null) return null;
  const base = parseXmlDecimal(textAt(price, "BaseQuantity"));
  if (base == null || base === 0) return roundHalfUp(amount * 100);
  return roundHalfUp((amount / base) * 100);
}

/* ------------------------------------------------------------------ *
 * Pruefung
 * ------------------------------------------------------------------ */

export interface InvoiceWarning {
  readonly kind: "CURRENCY" | "NO_LINES" | "NO_NUMBER" | "NO_DATE" | "TOTAL_MISMATCH" | "ZERO_QUANTITY";
  readonly message: string;
}

/**
 * Was an der Rechnung auffaellt.
 *
 * Bewusst **Hinweise und keine Fehler**: eine Rechnung, die in einem Punkt
 * unvollstaendig ist, kann in allen anderen brauchbar sein. Der Bediener soll
 * sehen, was fehlt, und dann entscheiden - nicht vor einer abgewiesenen Datei
 * stehen, ohne zu wissen warum.
 *
 * Die Summenprobe ist der wichtigste Hinweis: stimmt die Summe der Positionen
 * nicht mit der Rechnungssumme ueberein, ist entweder etwas nicht gelesen
 * worden oder die Rechnung enthaelt Zu- und Abschlaege auf der Kopfebene, die
 * hier nicht ausgewertet werden. Beides muss ein Mensch ansehen.
 */
export function checkInvoice(invoice: SupplierInvoice): InvoiceWarning[] {
  const warnings: InvoiceWarning[] = [];

  if (invoice.currency !== "EUR") {
    warnings.push({
      kind: "CURRENCY",
      message: `Die Rechnung ist in ${invoice.currency} ausgestellt. Die Kasse rechnet in Euro; die Betraege werden nicht umgerechnet.`,
    });
  }
  if (invoice.lines.length === 0) {
    warnings.push({ kind: "NO_LINES", message: "Die Rechnung enthaelt keine Positionen." });
  }
  if (!invoice.invoiceNumber) {
    warnings.push({ kind: "NO_NUMBER", message: "Die Rechnung hat keine Nummer. Sie sollte im Bestandsjournal vermerkt werden." });
  }
  if (!invoice.issuedOn) {
    warnings.push({ kind: "NO_DATE", message: "Die Rechnung hat kein lesbares Datum." });
  }
  if (invoice.lines.some((line) => line.quantity === 0)) {
    warnings.push({ kind: "ZERO_QUANTITY", message: "Mindestens eine Position hat keine Menge. Solche Positionen werden nicht gebucht." });
  }

  const sum = invoice.lines.reduce((total, line) => total + (line.netAmount ?? 0), 0);
  if (invoice.netTotal != null && invoice.lines.length > 0 && Math.abs(sum - invoice.netTotal) > 1) {
    warnings.push({
      kind: "TOTAL_MISMATCH",
      message: `Die Positionen ergeben ${(sum / 100).toFixed(2)} EUR netto, die Rechnung nennt ${(invoice.netTotal / 100).toFixed(2)} EUR. Moeglich sind Zu- oder Abschlaege auf der Rechnung, die hier nicht ausgewertet werden.`,
    });
  }

  return warnings;
}

/** Die Positionen, aus denen sich ueberhaupt eine Buchung ergeben kann. */
export function bookableLines(invoice: SupplierInvoice): SupplierInvoiceLine[] {
  return invoice.lines.filter((line) => line.quantity !== 0);
}

/**
 * Mengeneinheiten nach UN/ECE Rec. 20, soweit sie hier vorkommen.
 *
 * Der `factor` ist der Punkt. Ein Lieferant, der in **Gramm** liefert, nennt
 * eine Zahl, die tausendmal groesser ist als dieselbe Menge in Kilogramm. Wer
 * `GRM` einfach auf `KILOGRAM` abbildet, bucht aus 500 Gramm einen Zugang von
 * 500 Kilogramm - ein Bestand, der nie wieder stimmt und im Bestandswert
 * richtig teuer aussieht. Deshalb traegt jede Einheit den Faktor in die
 * Basiseinheit der Kasse mit.
 */
export interface UnitMapping {
  readonly unit: Product["unit"];
  /** Faktor in die Basiseinheit: Gramm -> Kilogramm ist 0,001. */
  readonly factor: number;
}

export const UNIT_CODES: Readonly<Record<string, UnitMapping>> = {
  H87: { unit: "PIECE", factor: 1 },
  C62: { unit: "PIECE", factor: 1 },
  EA: { unit: "PIECE", factor: 1 },
  PCE: { unit: "PIECE", factor: 1 },
  KGM: { unit: "KILOGRAM", factor: 1 },
  GRM: { unit: "KILOGRAM", factor: 0.001 },
  LTR: { unit: "LITRE", factor: 1 },
  MLT: { unit: "LITRE", factor: 0.001 },
  HUR: { unit: "HOUR", factor: 1 },
};

/**
 * Die Einheit des Lieferanten nachschlagen.
 *
 * `null` heisst "unbekannter Code" - dann wird **nicht geraten**. Eine
 * Kiste (`CS`) oder ein Gebinde (`PK`) enthaelt eine Stueckzahl, die nur auf
 * der Rechnung steht; die muss ein Mensch eingeben.
 */
export function unitFromCode(code: string | null): UnitMapping | null {
  if (!code) return null;
  return UNIT_CODES[code.trim().toUpperCase()] ?? null;
}

/** Eine Menge des Lieferanten in die Basiseinheit der Kasse umrechnen. */
export function quantityInBaseUnit(quantity: Quantity, code: string | null): Quantity {
  const mapping = unitFromCode(code);
  if (!mapping || mapping.factor === 1) return quantity;
  return roundHalfUp(quantity * mapping.factor);
}
