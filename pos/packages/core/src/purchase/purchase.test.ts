import { strict as assert } from "node:assert";
import test from "node:test";

import type { Product } from "../model.ts";
import { ONE } from "../money.ts";
import { csvTemplate, detectSeparator, parseCsvNumber, parseInvoiceCsv } from "./csv.ts";
import { InvoiceError, type SupplierInvoice } from "./invoice.ts";
import {
  GoodsReceiptError,
  assignProduct,
  bookGoodsReceipt,
  nameSimilarity,
  normalizeName,
  planGoodsReceipt,
  receiptNote,
  unitPriceOf,
  unmatchedLines,
} from "./matching.ts";

/* ------------------------------------------------------------------ *
 * CSV
 * ------------------------------------------------------------------ */

test("das Trennzeichen wird an der Kopfzeile erkannt", () => {
  assert.equal(detectSeparator("a;b;c\n1;2;3"), ";");
  assert.equal(detectSeparator("a,b,c\n1,2,3"), ",");
  assert.equal(detectSeparator("a\tb\tc\n1\t2\t3"), "\t");
});

test("Zahlen aus Tabellenzellen - Komma ist der Normalfall", () => {
  assert.equal(parseCsvNumber("1,49"), 1.49);
  assert.equal(parseCsvNumber("1.49"), 1.49);
  assert.equal(parseCsvNumber("1.234,56"), 1234.56);
  assert.equal(parseCsvNumber("1,234.56"), 1234.56);
  assert.equal(parseCsvNumber("1.234"), 1234);
  assert.equal(parseCsvNumber("1.234.567"), 1234567);
  assert.equal(parseCsvNumber(" 12,50 € "), 12.5);
  assert.equal(parseCsvNumber("19 %"), 19);
  assert.equal(parseCsvNumber("-3,00"), -3);
});

test("was keine Zahl ist, ergibt null", () => {
  assert.equal(parseCsvNumber("k.A."), null);
  assert.equal(parseCsvNumber(""), null);
  assert.equal(parseCsvNumber(undefined), null);
  assert.equal(parseCsvNumber("-"), null);
});

test("eine Lieferantentabelle wird gelesen", () => {
  const invoice = parseInvoiceCsv(csvTemplate(), {
    invoiceNumber: "RE-99",
    issuedOn: "2026-09-14",
    supplierName: "Metro",
  });
  assert.equal(invoice.format, "CSV");
  assert.equal(invoice.invoiceNumber, "RE-99");
  assert.equal(invoice.issuedOn, "2026-09-14");
  assert.equal(invoice.lines.length, 2);

  const [cola, kaffee] = invoice.lines;
  assert.equal(cola?.gtin, "4001234567890");
  assert.equal(cola?.sellerItemId, "A-4711");
  assert.equal(cola?.quantity, 24 * ONE);
  assert.equal(cola?.netUnitPrice, 63);
  // Ohne Betragsspalte wird der Positionsbetrag gerechnet: 24 x 0,63.
  assert.equal(cola?.netAmount, 1512);
  assert.equal(cola?.taxPercent, 19);
  assert.equal(kaffee?.quantity, 2500);
});

test("Spalten werden ueber ihre Ueberschrift gefunden, in beliebiger Reihenfolge", () => {
  const datei = ["Menge,Artikel-Nr.,Bezeichnung,Lagerplatz", "3,X-1,Zucker 1 kg,Regal 4"].join("\n");
  const invoice = parseInvoiceCsv(datei);
  assert.equal(invoice.lines[0]?.name, "Zucker 1 kg");
  assert.equal(invoice.lines[0]?.sellerItemId, "X-1");
  assert.equal(invoice.lines[0]?.quantity, 3 * ONE);
});

test("Summenzeilen ohne Bezeichnung werden uebersprungen statt abgewiesen", () => {
  const datei = ["Bezeichnung;Menge;Betrag", "Cola;24;15,12", ";;15,12"].join("\n");
  assert.equal(parseInvoiceCsv(datei).lines.length, 1);
});

test("eine Datei ohne Mengenspalte sagt, welche Ueberschriften erkannt werden", () => {
  assert.throws(
    () => parseInvoiceCsv("Bezeichnung;Preis\nCola;0,63"),
    (error: unknown) => error instanceof InvoiceError && /Menge/.test((error as Error).message) && /anzahl/.test((error as Error).message),
  );
});

test("eine CSV nennt keine geprueften Summen - und behauptet auch keine", () => {
  // Die Summe der Positionen als Rechnungssumme auszugeben waere eine
  // Scheinpruefung: sie ginge immer auf.
  const invoice = parseInvoiceCsv(csvTemplate());
  assert.equal(invoice.netTotal, null);
  assert.equal(invoice.grossTotal, null);
});

/* ------------------------------------------------------------------ *
 * Zuordnen
 * ------------------------------------------------------------------ */

function product(overrides: Partial<Product> & { id: string; name: string }): Product {
  return {
    tenantId: "t1",
    categoryId: "c1",
    price: 250,
    taxKey: 1,
    unit: "PIECE",
    trackStock: true,
    stock: 10 * ONE,
    sortOrder: 0,
    active: true,
    updatedAt: "2026-09-14T08:00:00.000Z",
    ...overrides,
  } as Product;
}

function invoiceWith(lines: Partial<SupplierInvoice["lines"][number]>[]): SupplierInvoice {
  return {
    format: "CSV",
    invoiceNumber: "RE-1",
    issuedOn: "2026-09-14",
    supplierName: "Metro",
    supplierVatId: null,
    currency: "EUR",
    netTotal: null,
    taxTotal: null,
    grossTotal: null,
    lines: lines.map((line, index) => ({
      lineId: String(index + 1),
      gtin: null,
      sellerItemId: null,
      name: "Artikel",
      quantity: ONE,
      unitCode: "H87",
      netUnitPrice: null,
      netAmount: null,
      taxPercent: null,
      ...line,
    })),
  };
}

test("Namen werden fuer den Vergleich vereinheitlicht", () => {
  assert.equal(normalizeName("Cola 0,33l Dose"), "cola 0 33l dose");
  assert.equal(normalizeName("GETRÄNKE"), "getraenke");
  assert.equal(normalizeName("Weißbier"), "weissbier");
});

test("Aehnlichkeit wird ueber Woerter gemessen, nicht ueber Zeichen", () => {
  // Andere Reihenfolge, fast dieselben Woerter.
  assert.ok(nameSimilarity("Coca Cola Dose 0,33", "Cola 0,33 Dose") > 0.5);
  assert.equal(nameSimilarity("Cola", "Cola"), 1);
  assert.ok(nameSimilarity("Cola", "Kaffeebohnen") < 0.2);
});

test("GTIN schlaegt alles: eindeutig und sicher", () => {
  const artikel = product({ id: "p1", name: "Voellig anderer Name", sku: "4001234567890" });
  const plan = planGoodsReceipt(invoiceWith([{ gtin: "4001234567890", name: "Cola 0,33", quantity: 24 * ONE }]), [artikel]);
  assert.equal(plan.lines[0]?.match, "GTIN");
  assert.equal(plan.lines[0]?.product?.id, "p1");
  assert.equal(plan.lines[0]?.selected, true);
  assert.equal(plan.readyCount, 1);
});

test("Artikelnummer des Lieferanten trifft die eigene Artikelnummer", () => {
  const plan = planGoodsReceipt(invoiceWith([{ sellerItemId: "a-4711", name: "X" }]), [product({ id: "p1", name: "Cola", sku: "A-4711" })]);
  assert.equal(plan.lines[0]?.match, "SKU");
});

test("gleicher Name trifft auch ohne Nummer", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "COLA 0,33 L" }]), [product({ id: "p1", name: "Cola 0,33 l" })]);
  assert.equal(plan.lines[0]?.match, "NAME_EXACT");
  assert.equal(plan.lines[0]?.selected, true);
});

test("ein aehnlicher Name ist ein Vorschlag, kein Treffer - und wird nicht vorbelegt", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Coca Cola Dose 0,33" }]), [product({ id: "p1", name: "Cola 0,33 Dose" })]);
  assert.equal(plan.lines[0]?.match, "NAME_SIMILAR");
  assert.equal(plan.lines[0]?.product?.id, "p1");
  // Der entscheidende Punkt: der Bediener muss hinsehen.
  assert.equal(plan.lines[0]?.selected, false);
  assert.equal(plan.openCount, 1);
});

test("zwei gleich gute Treffer ergeben keinen Treffer", () => {
  const plan = planGoodsReceipt(invoiceWith([{ sellerItemId: "A-1", name: "X" }]), [
    product({ id: "p1", name: "Cola gross", sku: "A-1" }),
    product({ id: "p2", name: "Cola klein", sku: "A-1" }),
  ]);
  assert.equal(plan.lines[0]?.match, "AMBIGUOUS");
  assert.equal(plan.lines[0]?.product, null);
  assert.equal(plan.lines[0]?.candidates.length, 2);
  assert.equal(plan.lines[0]?.selected, false);
});

test("was zu nichts passt, wird als offen gemeldet", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Serviettenspender Edelstahl" }]), [product({ id: "p1", name: "Cola" })]);
  assert.equal(plan.lines[0]?.match, "NONE");
  assert.deepEqual(unmatchedLines(plan).length, 1);
});

test("ein Artikel ohne Bestandsfuehrung wird nicht vorbelegt und sagt warum", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Crepe" }]), [product({ id: "p1", name: "Crepe", trackStock: false })]);
  assert.equal(plan.lines[0]?.match, "NAME_EXACT");
  assert.equal(plan.lines[0]?.selected, false);
  assert.ok(plan.lines[0]?.notes.some((note) => note.kind === "NO_STOCK"));
});

test("Pfandartikel fuehren keinen Bestand - das wird gesagt, nicht gebucht", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Becher" }]), [product({ id: "p1", name: "Becher", isDeposit: true })]);
  assert.equal(plan.lines[0]?.selected, false);
  assert.ok(plan.lines[0]?.notes.some((note) => note.kind === "DEPOSIT"));
});

test("Gramm werden in Kilogramm umgerechnet, bevor gebucht wird", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Kaffee", quantity: 500 * ONE, unitCode: "GRM" }]), [
    product({ id: "p1", name: "Kaffee", unit: "KILOGRAM" }),
  ]);
  assert.equal(plan.lines[0]?.quantity, ONE / 2);
  assert.equal(plan.lines[0]?.notes.length, 0);
});

test("ein Gebinde wird nicht geraten, sondern gemeldet", () => {
  // "CS" ist eine Kiste. Wie viele Flaschen drin sind, steht nirgends.
  const plan = planGoodsReceipt(invoiceWith([{ name: "Cola", quantity: 2 * ONE, unitCode: "CS" }]), [product({ id: "p1", name: "Cola" })]);
  assert.equal(plan.lines[0]?.quantity, 2 * ONE);
  assert.ok(plan.lines[0]?.notes.some((note) => note.kind === "UNIT" && /Gebinde/.test(note.message)));
});

test("eine abweichende Einheit wird gemeldet und nicht umgerechnet", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Kaffee", quantity: 3 * ONE, unitCode: "KGM" }]), [
    product({ id: "p1", name: "Kaffee", unit: "PIECE" }),
  ]);
  assert.ok(plan.lines[0]?.notes.some((note) => note.kind === "UNIT"));
  assert.equal(plan.lines[0]?.quantity, 3 * ONE);
});

test("ein Einkaufspreis ueber dem Verkaufspreis faellt auf", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Cola", netUnitPrice: 900 }]), [product({ id: "p1", name: "Cola", price: 250 })]);
  const note = plan.lines[0]?.notes.find((entry) => entry.kind === "PRICE_JUMP");
  assert.ok(note, "Hinweis erwartet");
  assert.match(note!.message, /9\.00 EUR netto/);
});

test("eine negative Menge ist eine Ruecklieferung und wird als solche gebucht", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Cola", quantity: -2 * ONE }]), [product({ id: "p1", name: "Cola" })]);
  assert.ok(plan.lines[0]?.notes.some((note) => note.kind === "NEGATIVE"));
  const { movements } = bookGoodsReceipt({ ...plan, lines: [{ ...plan.lines[0]!, selected: true }] }, options());
  assert.equal(movements[0]?.quantity, -2 * ONE);
  assert.equal(movements[0]?.resultingStock, 8 * ONE);
});

test("der Einzelpreis wird aus Betrag und Menge gerechnet, wenn er fehlt", () => {
  const line = invoiceWith([{ quantity: 24 * ONE, netAmount: 1512 }]).lines[0]!;
  assert.equal(unitPriceOf(line), 63);
});

test("von Hand zuordnen macht die Zeile buchbar", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Unbekanntes" }]), [product({ id: "p1", name: "Cola" })]);
  assert.equal(plan.lines[0]?.selected, false);

  const zugeordnet = assignProduct(plan.lines[0]!, product({ id: "p1", name: "Cola" }));
  assert.equal(zugeordnet.product?.id, "p1");
  assert.equal(zugeordnet.selected, true);
  assert.equal(zugeordnet.candidates.length, 0);
});

test("eine Zuordnung laesst sich auch wieder aufheben", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Cola" }]), [product({ id: "p1", name: "Cola" })]);
  const geloest = assignProduct(plan.lines[0]!, null);
  assert.equal(geloest.product, null);
  assert.equal(geloest.selected, false);
});

/* ------------------------------------------------------------------ *
 * Buchen
 * ------------------------------------------------------------------ */

function options() {
  let counter = 0;
  return {
    newId: () => `m${++counter}`,
    storeId: "s1",
    userId: "u1",
    createdAt: "2026-09-14T10:00:00.000Z",
  };
}

test("aus bestaetigten Positionen werden Bestandsbewegungen", () => {
  const plan = planGoodsReceipt(invoiceWith([{ gtin: "111", name: "Cola", quantity: 24 * ONE }]), [
    product({ id: "p1", name: "Cola", sku: "111", stock: 10 * ONE }),
  ]);
  const { movements, stockByProduct } = bookGoodsReceipt(plan, options());

  assert.equal(movements.length, 1);
  assert.equal(movements[0]?.reason, "PURCHASE");
  assert.equal(movements[0]?.quantity, 24 * ONE);
  assert.equal(movements[0]?.resultingStock, 34 * ONE);
  assert.equal(movements[0]?.storeId, "s1");
  assert.equal(movements[0]?.userId, "u1");
  assert.equal(stockByProduct.get("p1"), 34 * ONE);
});

test("nicht angehakte Positionen werden nicht gebucht", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Coca Cola Dose 0,33" }]), [product({ id: "p1", name: "Cola 0,33 Dose" })]);
  assert.equal(bookGoodsReceipt(plan, options()).movements.length, 0);
});

test("derselbe Artikel mehrfach auf einer Rechnung wird fortlaufend weitergerechnet", () => {
  // Der Fehler, den ein naives Buchen macht: die zweite Bewegung geht wieder
  // vom Ausgangsbestand aus, und die Haelfte der Lieferung ist weg.
  const plan = planGoodsReceipt(
    invoiceWith([
      { gtin: "111", name: "Cola", quantity: 24 * ONE },
      { gtin: "111", name: "Cola", quantity: 12 * ONE },
    ]),
    [product({ id: "p1", name: "Cola", sku: "111", stock: 10 * ONE })],
  );
  const { movements, stockByProduct } = bookGoodsReceipt(plan, options());
  assert.equal(movements.length, 2);
  assert.equal(movements[0]?.resultingStock, 34 * ONE);
  assert.equal(movements[1]?.resultingStock, 46 * ONE);
  assert.equal(stockByProduct.get("p1"), 46 * ONE);
});

test("der Vermerk fuehrt vom Journal zur Rechnung im Ordner", () => {
  const invoice = invoiceWith([{ lineId: "7" }]);
  assert.equal(receiptNote(invoice, invoice.lines[0]!), "Metro, Rg. RE-1, 2026-09-14, Pos. 7");
});

test("der Vermerk landet an der Bewegung", () => {
  const plan = planGoodsReceipt(invoiceWith([{ gtin: "111", name: "Cola" }]), [product({ id: "p1", name: "Cola", sku: "111" })]);
  const { movements } = bookGoodsReceipt(plan, options());
  assert.match(movements[0]!.note ?? "", /Rg\. RE-1/);
});

test("eine bestaetigte Zeile ohne Bestandsfuehrung wird abgewiesen statt still verworfen", () => {
  const plan = planGoodsReceipt(invoiceWith([{ name: "Crepe" }]), [product({ id: "p1", name: "Crepe", trackStock: false })]);
  const erzwungen = { ...plan, lines: [{ ...plan.lines[0]!, selected: true }] };
  assert.throws(() => bookGoodsReceipt(erzwungen, options()), GoodsReceiptError);
});

test("ein ganzer Wareneingang von der CSV-Datei bis zur Bewegung", () => {
  const artikel = [
    product({ id: "p1", name: "Cola 0,33 l Dose", sku: "4001234567890", stock: 0 }),
    product({ id: "p2", name: "Kaffeebohnen", unit: "KILOGRAM", stock: ONE, price: 2500 }),
  ];
  const invoice = parseInvoiceCsv(csvTemplate(), { invoiceNumber: "RE-2026-0815", issuedOn: "2026-09-14", supplierName: "Metro" });
  const plan = planGoodsReceipt(invoice, artikel);

  assert.equal(plan.readyCount, 2, "beide Zeilen sollten sicher zugeordnet sein");
  assert.equal(plan.openCount, 0);

  const { movements } = bookGoodsReceipt(plan, options());
  assert.equal(movements.length, 2);
  assert.equal(movements[0]?.resultingStock, 24 * ONE);
  // 2,5 kg auf 1 kg Bestand.
  assert.equal(movements[1]?.resultingStock, 3500);
});
