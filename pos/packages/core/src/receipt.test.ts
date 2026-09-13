import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE } from "./money.ts";
import { fixedClock, sequentialIds } from "./clock.ts";
import { addProduct, emptyCart, setOrderDiscount, setServiceMode } from "./cart.ts";
import type { Device, Order, Product, Store, Tenant, User } from "./model.ts";
import { MockTse } from "./tse/mock.ts";
import { beginTransaction, finishTransaction, type TransactionContext } from "./order.ts";
import {
  ReceiptError,
  buildReceiptQrPayload,
  buildReceiptView,
  formatGermanDateTime,
  renderReceiptText,
  summarizeReceipt,
} from "./receipt.ts";

const tenant: Tenant = {
  id: "t1",
  name: "MOINA",
  legalName: "Mehmet Gelgel",
  street: "Musterweg 1",
  postalCode: "24103",
  city: "Kiel",
  countryCode: "DE",
  taxNumber: "20/123/45678",
  vatId: null,
  email: null,
  phone: null,
  smallBusiness: false,
  receiptFooter: "Vielen Dank fuer den Besuch!",
  currency: "EUR",
  timeZone: "Europe/Berlin",
  createdAt: "2026-01-01T00:00:00+01:00",
};
const store: Store = { id: "s1", tenantId: "t1", name: "Anhaenger", active: true };
const device: Device = {
  id: "d1",
  tenantId: "t1",
  storeId: "s1",
  name: "Kasse 1",
  serialNumber: "KASSE-0001",
  tseClientId: "client-1",
  receiptPrefix: "K1",
  active: true,
};
const user: User = { id: "u1", tenantId: "t1", name: "Mehmet", role: "OWNER", active: true };
const crepe: Product = {
  id: "p1",
  tenantId: "t1",
  categoryId: "c1",
  name: "Crepe Zimt & Zucker",
  price: 450,
  taxKey: 2,
  taxKeyDineIn: 1,
  unit: "PIECE",
  sortOrder: 1,
  active: true,
  updatedAt: "2026-09-01T00:00:00+02:00",
};

async function sampleOrder(
  over: {
    tenant?: Tenant;
    tseAvailable?: boolean;
    dineIn?: boolean;
    discount?: number;
    quantity?: number;
  } = {},
): Promise<{ order: Order; ctx: TransactionContext }> {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  const tse = new MockTse({ clock, available: over.tseAvailable ?? true });
  const ctx: TransactionContext = {
    tenant: over.tenant ?? tenant,
    store,
    device,
    user,
    clock,
    newId: sequentialIds("o"),
    tse,
  };
  const open = await beginTransaction(ctx);
  clock.advance(37);
  let cart = addProduct(emptyCart(ctx.tenant.id), crepe, { id: "l1", quantity: (over.quantity ?? 2) * ONE });
  cart = addProduct(cart, { ...crepe, id: "p2", name: "Cola 0,33", price: 250, taxKey: 1, taxKeyDineIn: null }, { id: "l2" });
  if (over.dineIn) cart = setServiceMode(cart, "DINE_IN");
  if (over.discount) cart = setOrderDiscount(cart, over.discount);

  const total = (over.quantity ?? 2) * 450 + 250 - (over.discount ?? 0);
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: total, tendered: 2000 }], {
    sequence: 42,
  });
  return { order, ctx };
}

test("formatGermanDateTime schreibt Datum und Uhrzeit deutsch", () => {
  assert.equal(formatGermanDateTime("2026-09-26T11:04:12+02:00"), "26.09.2026 11:04:12");
  assert.throws(() => formatGermanDateTime("kaputt"), ReceiptError);
});

test("Beleg enthaelt alle Pflichtangaben nach Paragraf 6 KassenSichV", async () => {
  const { order, ctx } = await sampleOrder();
  const view = buildReceiptView(order, ctx);

  // 1. Name und vollstaendige Adresse
  assert.deepEqual(view.header, ["MOINA", "Mehmet Gelgel", "Musterweg 1", "24103 Kiel", "Steuernummer 20/123/45678"]);
  // 2. Datum der Ausstellung, Beginn und Ende des Vorgangs
  assert.equal(view.startedAt, "26.09.2026 09:00:00");
  assert.equal(view.finishedAt, "26.09.2026 09:00:37");
  assert.equal(view.issuedAt, "26.09.2026 09:00:37");
  // 3. Menge und Art der Leistung
  assert.deepEqual(view.lines.map((l) => [l.quantity, l.name, l.total]), [
    ["2", "Crepe Zimt & Zucker", "9,00"],
    ["1", "Cola 0,33", "2,50"],
  ]);
  // 4. Transaktionsnummer
  assert.ok(view.tseLines.some((l) => l.startsWith("Transaktion: 1")));
  // 5. Entgelt und Steuer je Steuersatz
  assert.deepEqual(view.taxGroups.map((g) => [g.label, g.net, g.tax, g.gross]), [
    ["19 %", 210, 40, 250],
    ["7 %", 841, 59, 900],
  ]);
  // 6. Seriennummer der TSE und der Kasse
  assert.ok(view.tseLines.some((l) => l.includes("TSE-Seriennummer:")));
  assert.ok(view.tseLines.some((l) => l.includes("KASSE-0001")));
  assert.equal(view.receiptNumber, "K1-000042");
});

test("Rueckgeld und Zahlart stehen auf dem Beleg", async () => {
  const { order, ctx } = await sampleOrder();
  const view = buildReceiptView(order, ctx);
  assert.deepEqual(view.payments, [{ label: "Bar", amount: "11,50" }]);
  assert.equal(view.change, 850);
  assert.equal(view.total, "11,50");
});

test("Bewirtungsform steht auf dem Beleg und aendert die Steuerzeile", async () => {
  const away = await sampleOrder();
  assert.equal(buildReceiptView(away.order, away.ctx).serviceMode, "Ausser Haus");

  const inHouse = await sampleOrder({ dineIn: true });
  const view = buildReceiptView(inHouse.order, inHouse.ctx);
  assert.equal(view.serviceMode, "Verzehr vor Ort");
  assert.deepEqual(view.taxGroups.map((g) => g.label), ["19 %"]);
});

test("Rabatte erscheinen als Hinweiszeile unter der Position", async () => {
  const { order, ctx } = await sampleOrder({ discount: 100 });
  const view = buildReceiptView(order, ctx);
  const notes = view.lines.flatMap((l) => l.notes);
  assert.ok(notes.some((n) => n.startsWith("Belegrabatt -")));
  assert.equal(view.total, "10,50");
});

test("Kleinunternehmer: Pflichthinweis statt Steuerausweis", async () => {
  const { order, ctx } = await sampleOrder({ tenant: { ...tenant, smallBusiness: true } });
  const view = buildReceiptView(order, ctx);
  assert.ok(view.footer.some((l) => l.includes("§ 19 UStG")));
  assert.deepEqual(view.taxGroups.map((g) => [g.label, g.tax]), [["umsatzsteuerfrei", 0]]);
});

test("Umsatzsteuer-Identifikationsnummer verdraengt die Steuernummer", async () => {
  const { order, ctx } = await sampleOrder({ tenant: { ...tenant, vatId: "DE123456789" } });
  const header = buildReceiptView(order, ctx).header;
  assert.ok(header.includes("USt-IdNr. DE123456789"));
  assert.equal(header.some((l) => l.startsWith("Steuernummer")), false);
});

test("QR-Code enthaelt die zwoelf Felder der Belegpruefung in fester Reihenfolge", async () => {
  const { order, ctx } = await sampleOrder();
  const payload = buildReceiptQrPayload(ctx.device, order.tse!);
  assert.ok(payload);
  const fields = payload!.split(";");
  assert.equal(fields.length, 12);
  assert.equal(fields[0], "V0");
  assert.equal(fields[1], "KASSE-0001");
  assert.equal(fields[2], "Kassenbeleg-V1");
  assert.equal(fields[3], "Kassenbeleg-V1^2.50_9.00_0.00_0.00_0.00^11.50:Bar");
  assert.equal(fields[4], "1", "Transaktionsnummer");
  assert.equal(fields[5], "2", "Signaturzaehler");
  assert.equal(fields[6], "2026-09-26T09:00:00+00:00", "Beginn");
  assert.equal(fields[7], "2026-09-26T09:00:37+00:00", "Log-Zeit");
  assert.equal(fields[8], "ecdsa-plain-SHA256");
  assert.equal(fields[9], "utcTime");
  assert.ok(fields[10]!.length > 0, "Signatur");
  assert.ok(fields[11]!.length > 0, "oeffentlicher Schluessel");
});

test("ohne TSE-Signatur gibt es keinen QR-Code", async () => {
  const { order, ctx } = await sampleOrder({ tseAvailable: false });
  assert.equal(buildReceiptQrPayload(ctx.device, order.tse!), null);
  assert.equal(buildReceiptView(order, ctx).qrPayload, null);
});

test("Semikolon in einem Feld wird als Fehler erkannt, nicht stillschweigend gedruckt", async () => {
  const { order, ctx } = await sampleOrder();
  const broken = { ...order.tse!, processData: "Kassenbeleg-V1^1;00^x" };
  assert.throws(() => buildReceiptQrPayload(ctx.device, broken), ReceiptError);
});

test("TSE-Ausfall steht als Hinweis auf dem Beleg", async () => {
  const { order, ctx } = await sampleOrder({ tseAvailable: false });
  const view = buildReceiptView(order, ctx);
  assert.equal(view.tseLines[0], "Sicherheitseinrichtung ausgefallen");
  assert.ok(view.tseLines[1]?.startsWith("Grund:"));
  const text = renderReceiptText(view);
  assert.ok(text.includes("Sicherheitseinrichtung ausgefallen"));
});

test("Beleg eines fremden Mandanten wird abgewiesen", async () => {
  const { order, ctx } = await sampleOrder();
  assert.throws(() => buildReceiptView(order, { ...ctx, tenant: { ...tenant, id: "t2" } }), ReceiptError);
});

test("Textbon bleibt in der Druckbreite und richtet Betraege rechts aus", async () => {
  const { order, ctx } = await sampleOrder();
  for (const width of [32, 42]) {
    const text = renderReceiptText(buildReceiptView(order, ctx), width);
    for (const line of text.split("\n")) {
      assert.ok(line.length <= width, `Zeile zu lang fuer ${width} Zeichen: "${line}" (${line.length})`);
    }
    assert.ok(text.includes("SUMME"));
  }
});

test("Textbon zeigt den Einzelpreis nur bei Menge ungleich eins", async () => {
  const { order, ctx } = await sampleOrder({ quantity: 3 });
  const text = renderReceiptText(buildReceiptView(order, ctx));
  assert.ok(text.includes("Einzelpreis 4,50"));
  assert.equal((text.match(/Einzelpreis/g) ?? []).length, 1, "die Cola mit Menge 1 braucht keine Zeile");
});

test("Nachdruck ist als solcher gekennzeichnet", async () => {
  const { order, ctx } = await sampleOrder();
  const view = buildReceiptView(order, { ...ctx, reprint: true });
  assert.ok(view.footer.includes("NACHDRUCK - kein Erstbeleg"));
});

test("Nachdruck ergibt denselben Beleg, nicht die aktuelle Uhrzeit", async () => {
  const { order, ctx } = await sampleOrder();
  const first = renderReceiptText(buildReceiptView(order, ctx));
  const later = renderReceiptText(buildReceiptView(order, ctx));
  assert.equal(first, later);
});

test("summarizeReceipt fasst fuer die Bildschirmanzeige zusammen", async () => {
  const { order, ctx } = await sampleOrder();
  assert.equal(summarizeReceipt(buildReceiptView(order, ctx)), "K1-000042 · 11,50 € · 26.09.2026 09:00:37");
});
