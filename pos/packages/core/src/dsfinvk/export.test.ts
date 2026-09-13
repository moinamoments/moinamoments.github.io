import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE } from "../money.ts";
import { fixedClock, sequentialIds } from "../clock.ts";
import { addProduct, cartTotals, emptyCart } from "../cart.ts";
import { createDepositCatalog } from "../deposit.ts";
import type { Device, Order, Product, Store, Tenant } from "../model.ts";
import { MockTse } from "../tse/mock.ts";
import { beginTransaction, finishTransaction, type TransactionContext } from "../order.ts";
import { buildClosing } from "../closing.ts";
import { DSFINVK_VERSION, DsfinvkError, buildExport, csvField, csvFile, exportToMap } from "./export.ts";

const tenant: Tenant = {
  id: "t1", name: "MOINA", legalName: "Mehmet Gelgel", street: "Musterweg 1", postalCode: "24103",
  city: "Kiel", countryCode: "DE", taxNumber: "20/123/45678", vatId: null, email: null, phone: null,
  smallBusiness: false, receiptFooter: null, currency: "EUR", timeZone: "Europe/Berlin", createdAt: "x",
};
const store: Store = { id: "s1", tenantId: "t1", name: "Anhaenger", active: true };
const device: Device = {
  id: "d1", tenantId: "t1", storeId: "s1", name: "Kasse 1", serialNumber: "KASSE-0001",
  tseClientId: "client-1", receiptPrefix: "K1", active: true,
};

function base(over: Partial<Product>): Product {
  return { id: "x", tenantId: "t1", categoryId: "c1", name: "x", price: 0, taxKey: 1, unit: "PIECE", sortOrder: 1, active: true, updatedAt: "x", ...over };
}
const becher = base({ id: "d-becher", name: "Mehrwegbecher", price: 100, deposit: { kind: "REUSABLE", refundable: true } });
const kaffee = base({ id: "p-kaffee", name: "Cafe Crema", price: 250, depositProductIds: ["d-becher"] });
const crepe = base({ id: "p-crepe", name: 'Crepe "Hausgemacht"', price: 450, taxKey: 2, taxKeyDineIn: 1 });
const deposits = createDepositCatalog([becher, kaffee, crepe]);

async function scenario(): Promise<{ orders: Order[]; report: ReturnType<typeof buildClosing> }> {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  const ctx: TransactionContext = {
    tenant, store, device,
    user: { id: "u1", tenantId: "t1", name: "Mehmet", role: "OWNER", active: true },
    clock, newId: sequentialIds("o"), tse: new MockTse({ clock }),
  };
  const orders: Order[] = [];
  let sequence = 1;
  for (const build of [
    (c: ReturnType<typeof emptyCart>) => addProduct(c, kaffee, { id: "l1", quantity: 2 * ONE }),
    (c: ReturnType<typeof emptyCart>) => addProduct(c, crepe, { id: "l1" }),
  ]) {
    const open = await beginTransaction(ctx);
    clock.advance(40);
    const cart = build(emptyCart("t1"));
    const total = cartTotals(cart, { deposits }).total;
    const { order } = await finishTransaction(ctx, open, cart, [{ method: sequence === 1 ? "CASH" : "CARD_DEBIT", amount: total, tendered: sequence === 1 ? total : undefined }], { sequence: sequence++, deposits });
    orders.push(order);
  }
  const report = buildClosing({
    tenant, store, device, userId: "u1", closingId: "z1", number: 3,
    from: "2026-09-26T09:00:00+00:00", to: "2026-09-26T22:00:00+00:00",
    createdAt: "2026-09-26T22:00:05+00:00", orders, openingCash: 5000,
  });
  return { orders, report };
}

function parse(content: string): string[][] {
  return content
    .split("\r\n")
    .filter((line) => line !== "")
    .map((line) => (line.match(/"((?:[^"]|"")*)"/g) ?? []).map((cell) => cell.slice(1, -1).replace(/""/g, '"')));
}

test("csvField maskiert Anfuehrungszeichen durch Verdoppelung", () => {
  assert.equal(csvField('Crepe "Hausgemacht"'), '"Crepe ""Hausgemacht"""');
  assert.equal(csvField(null), '""');
  assert.equal(csvField(0), '"0"');
});

test("csvFile verwendet CRLF als Zeilenende", () => {
  const content = csvFile(["A", "B"], [["1", "2"]]);
  assert.equal(content, '"A","B"\r\n"1","2"\r\n');
});

test("Export enthaelt alle umgesetzten Dateien plus index.xml", async () => {
  const { orders, report } = await scenario();
  const files = buildExport({ tenant, store, device, closings: [{ report, orders }] });
  assert.deepEqual(files.map((f) => f.name), [
    "cashpointclosing.csv", "businesscases.csv", "payment.csv", "transactions.csv",
    "transactions_tse.csv", "datapayment.csv", "lines.csv", "lines_vat.csv", "index.xml",
  ]);
});

test("cashpointclosing traegt Abschluss, Adresse und Belegspanne", async () => {
  const { orders, report } = await scenario();
  const map = exportToMap(buildExport({ tenant, store, device, closings: [{ report, orders }] }));
  const rows = parse(map["cashpointclosing.csv"]!);
  assert.deepEqual(rows[0]?.slice(0, 5), ["Z_KASSE_ID", "Z_ERSTELLUNG", "Z_NR", "Z_BUCHUNGSTAG", "TAXONOMIE_VERSION"]);
  const row = rows[1]!;
  assert.equal(row[0], "KASSE-0001");
  assert.equal(row[2], "3", "Abschlussnummer");
  assert.equal(row[3], "2026-09-26", "Buchungstag");
  assert.equal(row[4], DSFINVK_VERSION);
  assert.equal(row[5], "K1-000001");
  assert.equal(row[6], "K1-000002");
  assert.equal(row[7], "Mehmet Gelgel");
  assert.equal(row[11], "DEU");
  assert.equal(row[12], "20/123/45678");
  assert.equal(row[14], "11.50", "Summe: 5,00 Kaffee + 2,00 Pfand + 4,50 Crepe");
  assert.equal(row[15], "7.00", "davon bar");
});

test("businesscases trennt Umsatz und Pfand je Steuersatz", async () => {
  const { orders, report } = await scenario();
  const map = exportToMap(buildExport({ tenant, store, device, closings: [{ report, orders }] }));
  const rows = parse(map["businesscases.csv"]!).slice(1);
  const relevant = rows.map((r) => [r[3], r[6], r[7], r[8], r[9]]);
  assert.deepEqual(relevant, [
    ["Umsatz", "1", "5.00", "4.20", "0.80"],
    ["Umsatz", "2", "4.50", "4.21", "0.29"],
    ["Pfand", "1", "2.00", "1.68", "0.32"],
  ]);
});

test("payment listet die Zahlarten im Schema der Schnittstelle", async () => {
  const { orders, report } = await scenario();
  const map = exportToMap(buildExport({ tenant, store, device, closings: [{ report, orders }] }));
  const rows = parse(map["payment.csv"]!).slice(1);
  assert.deepEqual(rows.map((r) => [r[3], r[4], r[5]]), [
    ["ECKarte", "girocard", "4.50"],
    ["Bar", "Bar", "7.00"],
  ]);
});

test("transactions traegt Bonkopf mit Start- und Endzeit", async () => {
  const { orders, report } = await scenario();
  const map = exportToMap(buildExport({ tenant, store, device, closings: [{ report, orders }] }));
  const rows = parse(map["transactions.csv"]!).slice(1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.[4], "K1-000001");
  assert.equal(rows[0]?.[5], "Beleg");
  assert.equal(rows[0]?.[8], "0", "kein Storno");
  assert.equal(rows[0]?.[9], "2026-09-26T09:00:00+00:00");
  assert.equal(rows[0]?.[10], "2026-09-26T09:00:40+00:00");
  assert.equal(rows[0]?.[13], "7.00");
});

test("transactions_tse traegt Signatur, Zaehler und Prozessdaten", async () => {
  const { orders, report } = await scenario();
  const map = exportToMap(buildExport({ tenant, store, device, closings: [{ report, orders }] }));
  const rows = parse(map["transactions_tse.csv"]!).slice(1);
  const row = rows[0]!;
  assert.match(row[4]!, /TEST-TSE/, "TSE-Seriennummer");
  assert.equal(row[5], "1", "Transaktionsnummer");
  assert.equal(row[8], "Kassenbeleg-V1");
  assert.equal(row[9], "2", "Signaturzaehler");
  assert.ok(row[10]!.length > 0, "Signatur");
  assert.equal(row[11], "", "kein Fehler");
  assert.equal(row[12], "Kassenbeleg-V1^7.00_0.00_0.00_0.00_0.00^7.00:Bar");
});

test("TSE-Ausfall steht mit Grund in transactions_tse, Signaturfelder bleiben leer", async () => {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  const ctx: TransactionContext = {
    tenant, store, device,
    user: { id: "u1", tenantId: "t1", name: "M", role: "OWNER", active: true },
    clock, newId: sequentialIds("o"), tse: new MockTse({ clock, available: false }),
  };
  const open = await beginTransaction(ctx);
  const { order } = await finishTransaction(ctx, open, addProduct(emptyCart("t1"), crepe, { id: "l1" }), [{ method: "CASH", amount: 450 }], { sequence: 1 });
  const report = buildClosing({ tenant, store, device, userId: "u1", closingId: "z1", number: 1, from: "a", to: "2026-09-26T22:00:00+00:00", createdAt: "c", orders: [order] });

  const map = exportToMap(buildExport({ tenant, store, device, closings: [{ report, orders: [order] }] }));
  const row = parse(map["transactions_tse.csv"]!)[1]!;
  assert.equal(row[5], "", "keine Transaktionsnummer");
  assert.equal(row[10], "", "keine Signatur");
  assert.match(row[11]!, /nicht erreichbar/, "der Grund gehoert in die Datei");
});

test("lines traegt Positionen mit Menge, Einzelpreis und Inhaus-Kennzeichen", async () => {
  const { orders, report } = await scenario();
  const map = exportToMap(buildExport({ tenant, store, device, closings: [{ report, orders }] }));
  const rows = parse(map["lines.csv"]!).slice(1);
  assert.equal(rows.length, 3, "Kaffee, Becherpfand, Crepe");
  assert.deepEqual(rows.map((r) => [r[4], r[6], r[8], r[10], r[17], r[20]]), [
    ["1", "Cafe Crema", "Umsatz", "0", "2.000", "2.50"],
    ["2", "Mehrwegbecher", "Pfand", "0", "2.000", "1.00"],
    ["1", 'Crepe "Hausgemacht"', "Umsatz", "0", "1.000", "4.50"],
  ]);
});

test("lines_vat weist Brutto, Netto und Steuer je Position aus", async () => {
  const { orders, report } = await scenario();
  const map = exportToMap(buildExport({ tenant, store, device, closings: [{ report, orders }] }));
  const rows = parse(map["lines_vat.csv"]!).slice(1);
  assert.deepEqual(rows.map((r) => [r[5], r[6], r[7], r[8]]), [
    ["1", "5.00", "4.20", "0.80"],
    ["1", "2.00", "1.68", "0.32"],
    ["2", "4.50", "4.21", "0.29"],
  ]);
});

test("Artikelname mit Anfuehrungszeichen zerstoert die Datei nicht", async () => {
  const { orders, report } = await scenario();
  const map = exportToMap(buildExport({ tenant, store, device, closings: [{ report, orders }] }));
  assert.ok(map["lines.csv"]!.includes('"Crepe ""Hausgemacht"""'));
  // Jede Zeile hat gleich viele Felder - das waere bei falscher Maskierung nicht so.
  const rows = parse(map["lines.csv"]!);
  const widths = new Set(rows.map((r) => r.length));
  assert.equal(widths.size, 1, `unterschiedliche Feldzahlen: ${[...widths].join(", ")}`);
});

test("index.xml beschreibt jede CSV-Datei mit ihren Spalten", async () => {
  const { orders, report } = await scenario();
  const files = buildExport({ tenant, store, device, closings: [{ report, orders }] });
  const index = files.find((f) => f.name === "index.xml")!.content;
  for (const file of files.filter((f) => f.name.endsWith(".csv"))) {
    assert.ok(index.includes(`<URL>${file.name}</URL>`), `${file.name} fehlt in index.xml`);
  }
  assert.ok(index.includes("<Name>Z_KASSE_ID</Name>"));
  assert.ok(index.includes("<DecimalSymbol>.</DecimalSymbol>"));
  assert.ok(index.includes("<RecordDelimiter>&#13;&#10;</RecordDelimiter>"));
  assert.ok(index.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
});

test("angeschnittener Abschluss wird abgewiesen", async () => {
  const { orders, report } = await scenario();
  assert.throws(
    () => buildExport({ tenant, store, device, closings: [{ report, orders: [orders[0]!] }] }),
    DsfinvkError,
  );
  const foreign = { ...orders[1]!, id: "fremd" };
  assert.throws(
    () => buildExport({ tenant, store, device, closings: [{ report, orders: [orders[0]!, foreign] }] }),
    DsfinvkError,
  );
});

test("Export ohne Abschluss ist nicht zulaessig", () => {
  assert.throws(() => buildExport({ tenant, store, device, closings: [] }), DsfinvkError);
});

test("mehrere Abschluesse landen in denselben Dateien", async () => {
  const first = await scenario();
  const second = await scenario();
  const files = buildExport({
    tenant, store, device,
    closings: [
      { report: first.report, orders: first.orders },
      { report: { ...second.report, closing: { ...second.report.closing, number: 4 } }, orders: second.orders },
    ],
  });
  const rows = parse(exportToMap(files)["cashpointclosing.csv"]!).slice(1);
  assert.deepEqual(rows.map((r) => r[2]), ["3", "4"]);
  assert.equal(parse(exportToMap(files)["transactions.csv"]!).slice(1).length, 4);
});
