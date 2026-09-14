import { strict as assert } from "node:assert";
import test from "node:test";

import { ONE } from "../money.ts";
import {
  InvoiceError,
  MAX_INVOICE_LINES,
  bookableLines,
  checkInvoice,
  parseInvoiceDate,
  parseInvoiceXml,
  parseXmlDecimal,
  parseXmlDecimalToCents,
  parseXmlQuantity,
  quantityInBaseUnit,
  unitFromCode,
} from "./invoice.ts";

/* ------------------------------------------------------------------ *
 * Zahlen, Mengen, Daten
 * ------------------------------------------------------------------ */

test("Dezimalzahlen in Cent, kaufmaennisch gerundet", () => {
  assert.equal(parseXmlDecimalToCents("12.34"), 1234);
  assert.equal(parseXmlDecimalToCents("0.1234"), 12);
  assert.equal(parseXmlDecimalToCents("0.005"), 1);
  assert.equal(parseXmlDecimalToCents("-3.50"), -350);
  assert.equal(parseXmlDecimalToCents("1000"), 100000);
});

test("ein Komma als Dezimaltrenner wird angenommen, obwohl die Norm den Punkt verlangt", () => {
  assert.equal(parseXmlDecimalToCents("12,34"), 1234);
});

test("was keine Zahl ist, ergibt null statt NaN", () => {
  assert.equal(parseXmlDecimal("zwoelf"), null);
  assert.equal(parseXmlDecimal(""), null);
  assert.equal(parseXmlDecimal(null), null);
  assert.equal(parseXmlDecimal("12.34.56"), null);
  assert.equal(parseXmlDecimal("1e5"), null);
});

test("Mengen kommen in Tausendsteln an", () => {
  assert.equal(parseXmlQuantity("10"), 10 * ONE);
  assert.equal(parseXmlQuantity("2.5"), 2500);
  assert.equal(parseXmlQuantity("0.001"), 1);
});

test("Rechnungsdatum in beiden Schreibweisen", () => {
  assert.equal(parseInvoiceDate("20260914"), "2026-09-14");
  assert.equal(parseInvoiceDate("2026-09-14"), "2026-09-14");
  assert.equal(parseInvoiceDate("2026-09-14T10:00:00"), "2026-09-14");
});

test("ein unlesbares Datum wird nicht geraten", () => {
  assert.equal(parseInvoiceDate("14.09.2026"), null);
  assert.equal(parseInvoiceDate("20261301"), null);
  assert.equal(parseInvoiceDate("irgendwann"), null);
});

test("Gramm sind nicht Kilogramm - der Faktor entscheidet ueber den Bestand", () => {
  assert.deepEqual(unitFromCode("KGM"), { unit: "KILOGRAM", factor: 1 });
  assert.deepEqual(unitFromCode("grm"), { unit: "KILOGRAM", factor: 0.001 });
  // 500 Gramm sind ein halbes Kilo, nicht 500 Kilo.
  assert.equal(quantityInBaseUnit(500 * ONE, "GRM"), ONE / 2);
  assert.equal(quantityInBaseUnit(500 * ONE, "KGM"), 500 * ONE);
});

test("ein unbekannter Einheitencode wird nicht geraten", () => {
  // CS = Kiste. Wie viele Flaschen drin sind, steht nur auf der Rechnung.
  assert.equal(unitFromCode("CS"), null);
  assert.equal(unitFromCode(null), null);
  assert.equal(quantityInBaseUnit(3 * ONE, "CS"), 3 * ONE);
});

/* ------------------------------------------------------------------ *
 * CII / ZUGFeRD
 * ------------------------------------------------------------------ */

const CII = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">
  <rsm:ExchangedDocument>
    <ram:ID>RE-2026-0815</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20260914</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:GlobalID schemeID="0160">4001234567890</ram:GlobalID>
        <ram:SellerAssignedID>A-4711</ram:SellerAssignedID>
        <ram:Name>Cola 0,33 l Dose</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:GrossPriceProductTradePrice><ram:ChargeAmount>0.7500</ram:ChargeAmount></ram:GrossPriceProductTradePrice>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>0.6300</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="H87">24</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:RateApplicablePercent>19.00</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>15.12</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>2</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>Kaffeebohnen</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>14.90</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="KGM">2.5</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:RateApplicablePercent>7.00</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>37.25</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>Getraenke Mueller GmbH</ram:Name>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">123/456/78901</ram:ID></ram:SpecifiedTaxRegistration>
        <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">DE123456789</ram:ID></ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:TaxBasisTotalAmount>52.37</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">5.48</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>57.85</ram:GrandTotalAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

test("ZUGFeRD/CII: Kopfdaten", () => {
  const invoice = parseInvoiceXml(CII);
  assert.equal(invoice.format, "CII");
  assert.equal(invoice.invoiceNumber, "RE-2026-0815");
  assert.equal(invoice.issuedOn, "2026-09-14");
  assert.equal(invoice.supplierName, "Getraenke Mueller GmbH");
  assert.equal(invoice.currency, "EUR");
  assert.equal(invoice.netTotal, 5237);
  assert.equal(invoice.taxTotal, 548);
  assert.equal(invoice.grossTotal, 5785);
});

test("ZUGFeRD/CII: die USt-IdNr. wird am schemeID erkannt, nicht an der Reihenfolge", () => {
  // Die Steuernummer (FC) steht in dieser Datei zuerst.
  assert.equal(parseInvoiceXml(CII).supplierVatId, "DE123456789");
});

test("ZUGFeRD/CII: Positionen", () => {
  const [erste, zweite] = parseInvoiceXml(CII).lines;
  assert.equal(erste?.lineId, "1");
  assert.equal(erste?.gtin, "4001234567890");
  assert.equal(erste?.sellerItemId, "A-4711");
  assert.equal(erste?.name, "Cola 0,33 l Dose");
  assert.equal(erste?.quantity, 24 * ONE);
  assert.equal(erste?.unitCode, "H87");
  assert.equal(erste?.netAmount, 1512);
  assert.equal(erste?.taxPercent, 19);

  assert.equal(zweite?.gtin, null);
  assert.equal(zweite?.quantity, 2500);
  assert.equal(zweite?.unitCode, "KGM");
  assert.equal(zweite?.taxPercent, 7);
});

test("ZUGFeRD/CII: der Nettopreis gilt, nicht der Bruttopreis vor Rabatt", () => {
  // 0,63 ist der berechnete Preis, 0,75 der Listenpreis. Wer den Listenpreis
  // bucht, hat einen zu hohen Bestandswert und einen zu kleinen Rohertrag.
  assert.equal(parseInvoiceXml(CII).lines[0]?.netUnitPrice, 63);
});

test("ZUGFeRD/CII: eine GlobalID mit fremdem Schema ist keine GTIN", () => {
  const fremd = CII.replace('schemeID="0160"', 'schemeID="0088"');
  assert.equal(parseInvoiceXml(fremd).lines[0]?.gtin, null);
});

test("ZUGFeRD/CII: eine GlobalID ohne Schema wird trotzdem genommen", () => {
  const ohne = CII.replace(' schemeID="0160"', "");
  assert.equal(parseInvoiceXml(ohne).lines[0]?.gtin, "4001234567890");
});

test("eine Position ohne Bezeichnung bekommt einen Platzhalter statt leer zu bleiben", () => {
  const ohne = CII.replace("<ram:Name>Cola 0,33 l Dose</ram:Name>", "");
  assert.equal(parseInvoiceXml(ohne).lines[0]?.name, "Ohne Bezeichnung");
});

/* ------------------------------------------------------------------ *
 * UBL / XRechnung
 * ------------------------------------------------------------------ */

const UBL = `<?xml version="1.0" encoding="UTF-8"?>
<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
             xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
             xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>2026-4711</cbc:ID>
  <cbc:IssueDate>2026-09-14</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>Metro Grossmarkt</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme><cbc:CompanyID>DE987654321</cbc:CompanyID></cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="EUR">3.80</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="EUR">20.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">23.80</cbc:TaxInclusiveAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="H87">10</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">20.00</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Name>Pappbecher 0,2 l</cbc:Name>
      <cac:StandardItemIdentification><cbc:ID schemeID="0160">4009876543210</cbc:ID></cac:StandardItemIdentification>
      <cac:SellersItemIdentification><cbc:ID>BEC-200</cbc:ID></cac:SellersItemIdentification>
      <cac:ClassifiedTaxCategory><cbc:Percent>19</cbc:Percent></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="EUR">12.00</cbc:PriceAmount>
      <cbc:BaseQuantity unitCode="H87">6</cbc:BaseQuantity>
    </cac:Price>
  </cac:InvoiceLine>
</ubl:Invoice>`;

test("XRechnung/UBL: Kopfdaten und Position", () => {
  const invoice = parseInvoiceXml(UBL);
  assert.equal(invoice.format, "UBL");
  assert.equal(invoice.invoiceNumber, "2026-4711");
  assert.equal(invoice.issuedOn, "2026-09-14");
  assert.equal(invoice.supplierName, "Metro Grossmarkt");
  assert.equal(invoice.supplierVatId, "DE987654321");
  assert.equal(invoice.netTotal, 2000);
  assert.equal(invoice.taxTotal, 380);
  assert.equal(invoice.grossTotal, 2380);

  const line = invoice.lines[0];
  assert.equal(line?.gtin, "4009876543210");
  assert.equal(line?.sellerItemId, "BEC-200");
  assert.equal(line?.name, "Pappbecher 0,2 l");
  assert.equal(line?.quantity, 10 * ONE);
  assert.equal(line?.taxPercent, 19);
});

test("XRechnung/UBL: BaseQuantity - 12 EUR fuer sechs Stueck sind 2 EUR je Stueck", () => {
  // Ohne diese Rechnung waere der Einkaufspreis sechsmal zu hoch.
  assert.equal(parseInvoiceXml(UBL).lines[0]?.netUnitPrice, 200);
});

test("XRechnung/UBL: ohne BaseQuantity gilt der Preis je Stueck", () => {
  const ohne = UBL.replace('<cbc:BaseQuantity unitCode="H87">6</cbc:BaseQuantity>', "");
  assert.equal(parseInvoiceXml(ohne).lines[0]?.netUnitPrice, 1200);
});

test("XRechnung/UBL: der Firmenname springt ein, wenn kein Handelsname dasteht", () => {
  const ohne = UBL.replace(
    "<cac:PartyName><cbc:Name>Metro Grossmarkt</cbc:Name></cac:PartyName>",
    "<cac:PartyLegalEntity><cbc:RegistrationName>Metro Deutschland GmbH</cbc:RegistrationName></cac:PartyLegalEntity>",
  );
  assert.equal(parseInvoiceXml(ohne).supplierName, "Metro Deutschland GmbH");
});

test("eine Gutschrift wird gelesen wie eine Rechnung", () => {
  const gutschrift = UBL.replace(/ubl:Invoice/g, "ubl:CreditNote")
    .replace(/cac:InvoiceLine/g, "cac:CreditNoteLine")
    .replace(/cbc:InvoicedQuantity/g, "cbc:CreditedQuantity");
  const invoice = parseInvoiceXml(gutschrift);
  assert.equal(invoice.lines.length, 1);
  assert.equal(invoice.lines[0]?.quantity, 10 * ONE);
});

/* ------------------------------------------------------------------ *
 * Abweisen und Warnen
 * ------------------------------------------------------------------ */

test("ein fremdes Wurzelelement wird mit klarer Ansage abgewiesen", () => {
  assert.throws(
    () => parseInvoiceXml("<Lieferschein><Position/></Lieferschein>"),
    (error: unknown) => error instanceof InvoiceError && /Unbekanntes Rechnungsformat/.test((error as Error).message),
  );
});

test("kaputtes XML kommt als Rechnungsfehler zurueck, nicht als XML-Fehler", () => {
  assert.throws(() => parseInvoiceXml("<rsm:CrossIndustryInvoice>"), InvoiceError);
});

test("zu viele Positionen werden abgewiesen", () => {
  const position = `<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="H87">1</cbc:InvoicedQuantity><cac:Item><cbc:Name>X</cbc:Name></cac:Item></cac:InvoiceLine>`;
  const viele = `<ubl:Invoice><cbc:ID>1</cbc:ID>${position.repeat(MAX_INVOICE_LINES + 1)}</ubl:Invoice>`;
  assert.throws(() => parseInvoiceXml(viele), (error: unknown) => error instanceof InvoiceError && /Positionen/.test((error as Error).message));
});

test("eine saubere Rechnung erzeugt keine Hinweise", () => {
  assert.deepEqual(checkInvoice(parseInvoiceXml(UBL)), []);
});

test("Hinweis, wenn die Positionen nicht die Rechnungssumme ergeben", () => {
  const abweichend = UBL.replace("<cbc:LineExtensionAmount currencyID=\"EUR\">20.00</cbc:LineExtensionAmount>", "<cbc:LineExtensionAmount currencyID=\"EUR\">18.00</cbc:LineExtensionAmount>");
  const warnungen = checkInvoice(parseInvoiceXml(abweichend));
  assert.equal(warnungen.length, 1);
  assert.equal(warnungen[0]?.kind, "TOTAL_MISMATCH");
  assert.match(warnungen[0]!.message, /18\.00 EUR netto/);
});

test("ein Cent Abweichung ist Rundung und kein Hinweis", () => {
  const einCent = UBL.replace('<cbc:TaxExclusiveAmount currencyID="EUR">20.00</cbc:TaxExclusiveAmount>', '<cbc:TaxExclusiveAmount currencyID="EUR">20.01</cbc:TaxExclusiveAmount>');
  assert.deepEqual(checkInvoice(parseInvoiceXml(einCent)), []);
});

test("Hinweis bei fremder Waehrung - umgerechnet wird nichts", () => {
  const chf = UBL.replace("<cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>", "<cbc:DocumentCurrencyCode>CHF</cbc:DocumentCurrencyCode>");
  const warnungen = checkInvoice(parseInvoiceXml(chf));
  assert.ok(warnungen.some((warning) => warning.kind === "CURRENCY"));
});

test("Hinweise bei fehlender Nummer, fehlendem Datum und leerer Rechnung", () => {
  const leer = parseInvoiceXml("<ubl:Invoice><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode></ubl:Invoice>");
  const arten = checkInvoice(leer).map((warning) => warning.kind);
  assert.deepEqual(arten.sort(), ["NO_DATE", "NO_LINES", "NO_NUMBER"]);
});

test("Positionen ohne Menge werden gemeldet und nicht gebucht", () => {
  const ohneMenge = UBL.replace('<cbc:InvoicedQuantity unitCode="H87">10</cbc:InvoicedQuantity>', '<cbc:InvoicedQuantity unitCode="H87">0</cbc:InvoicedQuantity>');
  const invoice = parseInvoiceXml(ohneMenge);
  assert.ok(checkInvoice(invoice).some((warning) => warning.kind === "ZERO_QUANTITY"));
  assert.equal(bookableLines(invoice).length, 0);
});
