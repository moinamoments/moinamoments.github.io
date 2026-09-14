/**
 * Haerteprobe fuer die Rechnungsleser.
 *
 * Die anderen Tests pruefen, dass richtige Dateien richtig gelesen werden.
 * Dieser prueft das Gegenteil: dass **falsche Dateien nichts kaputt machen**.
 *
 * Das ist hier keine Fleissarbeit. Der Wareneingang ist die einzige Stelle, an
 * der die Kasse eine Datei oeffnet, die jemand anders geschrieben hat - ein
 * Lieferant, ein fremdes System, oder jemand mit boesen Absichten. Was so ein
 * Leser tun darf, ist: den Inhalt lesen oder einen benannten Fehler werfen.
 * Was er nicht darf:
 *
 *   - mit `TypeError`, `RangeError` oder "undefined is not a function"
 *     abstuerzen - das ist in React Native ein weisser Bildschirm,
 *   - in eine Endlosschleife laufen,
 *   - `NaN`, `Infinity` oder `undefined` in eine Menge oder einen Betrag
 *     schreiben, die spaeter als Bestand in der Datenbank landen.
 *
 * Geprueft wird mit abgeschnittenen, verdrehten und zufaelligen Eingaben -
 * tausendfach, aus festen Zufallszahlen, damit ein Fehlschlag wiederholbar ist.
 */

import { strict as assert } from "node:assert";
import { deflateSync } from "node:zlib";
import test from "node:test";

import { parseInvoiceCsv } from "./csv.ts";
import { InflateError, inflate, inflateRaw } from "./inflate.ts";
import { InvoiceError, type SupplierInvoice, bookableLines, checkInvoice, parseInvoiceXml } from "./invoice.ts";
import { GoodsReceiptError, planGoodsReceipt } from "./matching.ts";
import { PdfError, base64ToBytes, extractInvoiceXml } from "./pdf.ts";
import { XmlError, parseXml } from "./xml.ts";
import type { Product } from "../model.ts";
import { ONE } from "../money.ts";

/**
 * Zufallszahlen mit festem Startwert.
 *
 * `Math.random()` waere hier ein Eigentor: ein Fehlschlag liesse sich nicht
 * wiederholen, und ein Test, der nur manchmal rot ist, wird abgeschaltet
 * statt gelesen.
 */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32 - kurz, gut genug, und ueberall gleich.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** Erlaubt sind die benannten Fehler dieses Pakets - sonst nichts. */
function expectOnlyKnownErrors(action: () => unknown, what: string): void {
  try {
    action();
  } catch (error) {
    const known =
      error instanceof XmlError ||
      error instanceof InvoiceError ||
      error instanceof PdfError ||
      error instanceof InflateError ||
      error instanceof GoodsReceiptError;
    assert.ok(known, `${what}: unerwarteter Fehler ${(error as Error).constructor.name}: ${(error as Error).message}`);
    assert.ok((error as Error).message.length > 0, `${what}: Fehler ohne Text`);
  }
}

const GUT = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">
  <rsm:ExchangedDocument><ram:ID>RE-1</ram:ID>
    <ram:IssueDateTime><udt:DateTimeString format="102">20260914</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:SpecifiedTradeProduct><ram:GlobalID schemeID="0160">4001234567890</ram:GlobalID><ram:Name>Cola</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="H87">24</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
    </ram:IncludedSupplyChainTradeLineItem>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

test("XML: jedes Abschneiden der Datei fuehrt zu einem benannten Fehler", () => {
  for (let length = 0; length <= GUT.length; length++) {
    expectOnlyKnownErrors(() => parseXml(GUT.slice(0, length)), `abgeschnitten bei ${length}`);
  }
});

test("XML: einzelne verdrehte Zeichen bringen den Leser nicht um", () => {
  const random = seeded(20260914);
  const zeichen = ['<', '>', '"', "'", "/", "&", "=", "?", "!", "-", "[", "]", " ", "\0", "￿"];
  for (let runde = 0; runde < 2000; runde++) {
    const stelle = Math.floor(random() * GUT.length);
    const ersatz = zeichen[Math.floor(random() * zeichen.length)]!;
    const kaputt = GUT.slice(0, stelle) + ersatz + GUT.slice(stelle + 1);
    expectOnlyKnownErrors(() => parseXml(kaputt), `Stelle ${stelle} -> "${ersatz}"`);
  }
});

test("XML: zufaellige Zeichenketten sind entweder XML oder ein benannter Fehler", () => {
  const random = seeded(4711);
  for (let runde = 0; runde < 500; runde++) {
    const laenge = Math.floor(random() * 200);
    let text = "";
    for (let index = 0; index < laenge; index++) {
      text += String.fromCharCode(Math.floor(random() * 128));
    }
    expectOnlyKnownErrors(() => parseXml(text), JSON.stringify(text.slice(0, 40)));
  }
});

test("Rechnung: abgeschnittene und verdrehte Dateien ergeben nie kaputte Zahlen", () => {
  const random = seeded(99);
  for (let runde = 0; runde < 1000; runde++) {
    const stelle = Math.floor(random() * GUT.length);
    const kaputt = runde % 2 === 0 ? GUT.slice(0, stelle) : GUT.slice(0, stelle) + GUT.slice(stelle + 1);

    let invoice: SupplierInvoice | null = null;
    try {
      invoice = parseInvoiceXml(kaputt);
    } catch (error) {
      assert.ok(error instanceof InvoiceError, `unerwartet: ${(error as Error).constructor.name}`);
      continue;
    }

    // Kommt eine Rechnung heraus, muss jede Zahl darin brauchbar sein - sie
    // wird spaeter zu einem Bestand in der Datenbank.
    for (const line of invoice.lines) {
      assert.ok(Number.isInteger(line.quantity), `Menge kein ganzer Wert: ${line.quantity}`);
      assert.ok(Number.isFinite(line.quantity), `Menge nicht endlich: ${line.quantity}`);
      if (line.netUnitPrice != null) assert.ok(Number.isInteger(line.netUnitPrice), `Preis krumm: ${line.netUnitPrice}`);
      if (line.netAmount != null) assert.ok(Number.isInteger(line.netAmount), `Betrag krumm: ${line.netAmount}`);
      if (line.taxPercent != null) assert.ok(Number.isFinite(line.taxPercent), `Steuersatz: ${line.taxPercent}`);
      assert.equal(typeof line.name, "string");
      assert.ok(line.name.length > 0, "Bezeichnung nie leer - sonst steht nichts auf dem Bildschirm");
    }
    // Und die Pruefung selbst darf auch nicht stolpern.
    expectOnlyKnownErrors(() => checkInvoice(invoice!), "checkInvoice");
    expectOnlyKnownErrors(() => bookableLines(invoice!), "bookableLines");
  }
});

test("CSV: beliebige Tabellen fuehren zu einer Rechnung oder zu einem benannten Fehler", () => {
  const random = seeded(2026);
  const felder = ["Menge", "Bezeichnung", "EAN", "Preis", "Steuersatz", "", "x;y", '"', "1,5", "-3", "1e99", "NaN", "\t"];
  for (let runde = 0; runde < 1000; runde++) {
    const spalten = 1 + Math.floor(random() * 6);
    const zeilen = Math.floor(random() * 5);
    const bauen = (): string =>
      Array.from({ length: spalten }, () => felder[Math.floor(random() * felder.length)]!).join(random() < 0.5 ? ";" : ",");
    const datei = [bauen(), ...Array.from({ length: zeilen }, bauen)].join("\n");

    let invoice: SupplierInvoice | null = null;
    try {
      invoice = parseInvoiceCsv(datei);
    } catch (error) {
      assert.ok(error instanceof InvoiceError, `unerwartet: ${(error as Error).constructor.name}`);
      continue;
    }
    for (const line of invoice.lines) {
      assert.ok(Number.isInteger(line.quantity) && Number.isFinite(line.quantity), `Menge: ${line.quantity}`);
      if (line.netAmount != null) assert.ok(Number.isInteger(line.netAmount), `Betrag: ${line.netAmount}`);
      if (line.netUnitPrice != null) assert.ok(Number.isInteger(line.netUnitPrice), `Preis: ${line.netUnitPrice}`);
    }
  }
});

test("Auspacken: jeder verdrehte Datenstrom endet, statt zu kreisen", () => {
  const random = seeded(31337);
  const gut = new Uint8Array(deflateSync(new TextEncoder().encode("Cola 0,33 l Dose; ".repeat(50))));
  for (let runde = 0; runde < 1500; runde++) {
    const kaputt = gut.slice();
    // Ein bis drei Bytes verdrehen - so sieht eine beschaedigte Uebertragung aus.
    const wie = 1 + Math.floor(random() * 3);
    for (let index = 0; index < wie; index++) {
      kaputt[Math.floor(random() * kaputt.length)] = Math.floor(random() * 256);
    }
    expectOnlyKnownErrors(() => inflate(kaputt), `Runde ${runde}`);
  }
});

test("Auspacken: abgeschnittene Datenstroeme jeder Laenge", () => {
  const gut = new Uint8Array(deflateSync(new TextEncoder().encode("x".repeat(5000))));
  for (let length = 0; length <= gut.length; length++) {
    expectOnlyKnownErrors(() => inflate(gut.subarray(0, length)), `Laenge ${length}`);
  }
});

test("Auspacken: reiner Zufall ist nie ein gueltiger Datenstrom, aber auch nie ein Absturz", () => {
  const random = seeded(777);
  for (let runde = 0; runde < 1000; runde++) {
    const laenge = Math.floor(random() * 200);
    const bytes = new Uint8Array(laenge);
    for (let index = 0; index < laenge; index++) bytes[index] = Math.floor(random() * 256);
    expectOnlyKnownErrors(() => inflateRaw(bytes, 1_000_000), `Runde ${runde}`);
  }
});

test("PDF: beschaedigte Dateien werden abgewiesen, nicht verdaut", () => {
  const random = seeded(5150);
  const anhang = new Uint8Array(deflateSync(new TextEncoder().encode(GUT)));
  const kopf = new TextEncoder().encode(`%PDF-1.7\n1 0 obj\n<< /Type /EmbeddedFile /Filter /FlateDecode /Length ${anhang.length} >>\nstream\n`);
  const fuss = new TextEncoder().encode("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
  const pdf = new Uint8Array(kopf.length + anhang.length + fuss.length);
  pdf.set(kopf, 0);
  pdf.set(anhang, kopf.length);
  pdf.set(fuss, kopf.length + anhang.length);

  for (let runde = 0; runde < 1000; runde++) {
    const kaputt = pdf.slice();
    kaputt[Math.floor(random() * kaputt.length)] = Math.floor(random() * 256);
    expectOnlyKnownErrors(() => extractInvoiceXml(kaputt), `Runde ${runde}`);
  }
});

test("PDF: jedes Abschneiden der Datei", () => {
  const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Length 5 >>\nstream\nHallo\nendstream\nendobj\n%%EOF\n");
  for (let length = 0; length <= pdf.length; length++) {
    expectOnlyKnownErrors(() => extractInvoiceXml(pdf.subarray(0, length)), `Laenge ${length}`);
  }
});

test("Base64: beliebiger Text fuehrt zu Bytes oder zu einem benannten Fehler", () => {
  const random = seeded(64);
  for (let runde = 0; runde < 500; runde++) {
    const laenge = Math.floor(random() * 100);
    let text = "";
    for (let index = 0; index < laenge; index++) text += String.fromCharCode(32 + Math.floor(random() * 95));
    expectOnlyKnownErrors(() => base64ToBytes(text), JSON.stringify(text.slice(0, 30)));
  }
});

test("Zuordnen: ein leerer Artikelstamm ordnet nichts zu und stuerzt nicht ab", () => {
  const invoice = parseInvoiceXml(GUT);
  const plan = planGoodsReceipt(invoice, []);
  assert.equal(plan.readyCount, 0);
  assert.equal(plan.lines[0]?.match, "NONE");
});

test("Zuordnen: Artikel mit seltsamen Namen bringen den Namensvergleich nicht um", () => {
  const seltsam = ["", " ", "   ", "!!!", "ßßß", "🍺", "a".repeat(500), "1", "0,33", "\n\t"];
  const produkte: Product[] = seltsam.map((name, index) => ({
    id: `p${index}`,
    tenantId: "t1",
    categoryId: "c1",
    name,
    price: 100,
    taxKey: 1,
    unit: "PIECE",
    trackStock: true,
    stock: 0,
    sortOrder: index,
    active: true,
    updatedAt: "2026-09-14T08:00:00.000Z",
  }));

  for (const name of seltsam) {
    const invoice: SupplierInvoice = {
      format: "CSV",
      invoiceNumber: null,
      issuedOn: null,
      supplierName: null,
      supplierVatId: null,
      currency: "EUR",
      netTotal: null,
      taxTotal: null,
      grossTotal: null,
      lines: [
        {
          lineId: "1",
          gtin: null,
          sellerItemId: null,
          name: name || "Ohne Bezeichnung",
          quantity: ONE,
          unitCode: null,
          netUnitPrice: null,
          netAmount: null,
          taxPercent: null,
        },
      ],
    };
    expectOnlyKnownErrors(() => planGoodsReceipt(invoice, produkte), `Name ${JSON.stringify(name)}`);
  }
});
