import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE, sumCents } from "./money.ts";
import { fixedClock, sequentialIds } from "./clock.ts";
import { addProduct, cartTotals, emptyCart, setLineDiscount, setOrderDiscount } from "./cart.ts";
import { createDepositCatalog } from "./deposit.ts";
import type { Device, Order, Product, Store, Tenant, User } from "./model.ts";
import { MockTse } from "./tse/mock.ts";
import {
  OrderError,
  buildPartialVoidCart,
  buildRefundCart,
  buildVoidCart,
  beginTransaction,
  finishTransaction,
  type TransactionContext,
} from "./order.ts";

const TENANT = "t1";
const tenant: Tenant = {
  id: TENANT, name: "Kiosk", legalName: "Kiosk", street: "Weg 1", postalCode: "24103", city: "Kiel",
  countryCode: "DE", taxNumber: "20/1", vatId: null, email: null, phone: null, smallBusiness: false,
  receiptFooter: null, currency: "EUR", timeZone: "Europe/Berlin", createdAt: "x",
};
const store: Store = { id: "s1", tenantId: TENANT, name: "Stand", active: true };
const device: Device = {
  id: "d1", tenantId: TENANT, storeId: "s1", name: "Kasse 1", serialNumber: "KASSE-1",
  tseClientId: "c1", receiptPrefix: "K1", active: true,
};
const user: User = { id: "u1", tenantId: TENANT, name: "Bediener", role: "OWNER", active: true };

function base(over: Partial<Product> = {}): Product {
  return {
    id: "x", tenantId: TENANT, categoryId: "c1", name: "x", price: 0, taxKey: 1, unit: "PIECE",
    sortOrder: 0, active: true, updatedAt: "x", ...over,
  };
}
const flasche = base({ id: "d-flasche", name: "Flaschenpfand", price: 25, isDeposit: true });
const limo = base({ id: "p-limo", name: "Limonade", price: 250, depositProductIds: ["d-flasche"] });
const crepe = base({ id: "p-crepe", name: "Crepe", price: 450, taxKey: 2, taxKeyDineIn: 1 });
const deposits = createDepositCatalog([flasche, limo, crepe]);

function context(): TransactionContext {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  return { tenant, store, device, user, clock, newId: sequentialIds("o"), tse: new MockTse({ clock }) };
}

/** Verkauft drei Limonaden und zwei Crepes, wahlweise mit Rabatt. */
async function sale(options: { lineDiscount?: number; orderDiscount?: number } = {}): Promise<{ order: Order; ctx: TransactionContext }> {
  const ctx = context();
  const open = await beginTransaction(ctx);
  let cart = addProduct(emptyCart(TENANT), limo, { id: "l1", quantity: 3 * ONE });
  cart = addProduct(cart, crepe, { id: "l2", quantity: 2 * ONE });
  if (options.lineDiscount) cart = setLineDiscount(cart, "l1", options.lineDiscount);
  if (options.orderDiscount) cart = setOrderDiscount(cart, options.orderDiscount);
  const total = cartTotals(cart, { deposits }).total;
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: total, tendered: total }], {
    sequence: 1, deposits,
  });
  return { order, ctx };
}

test("Vollstorno hebt den Beleg auf den Cent genau auf", async () => {
  const { order } = await sale({ lineDiscount: 137, orderDiscount: 113 });
  const totals = cartTotals(buildVoidCart(order), { deposits });
  assert.equal(totals.total, -order.total);

  // Auch je Steuersatz muss sich alles aufheben.
  const original = new Map<number, number>();
  for (const line of order.lines) original.set(line.taxKey, (original.get(line.taxKey) ?? 0) + line.gross);
  for (const group of totals.taxGroups) {
    assert.equal(group.gross, -(original.get(group.key) ?? 0), `Steuersatz ${group.key}`);
  }
});

test("eine von drei Flaschen zurueck: Ware und Pfand anteilig", async () => {
  const { order } = await sale();
  // Verkauft: 3 Limo zu 2,50 = 7,50 plus 3 x 0,25 Pfand = 0,75; 2 Crepe = 9,00.
  assert.equal(order.total, 750 + 75 + 900);

  const cart = buildPartialVoidCart(order, [{ lineId: "l1", quantity: ONE }]);
  const totals = cartTotals(cart, { deposits });
  // 2,50 Ware plus 0,25 Pfand zurueck.
  assert.equal(totals.total, -275);
  assert.deepEqual(
    totals.lines.map((line) => [line.name, line.gross]),
    [
      ["Limonade", -250],
      ["Flaschenpfand", -25],
    ],
  );
});

test("Teilstorno greift nicht auf Positionen zu, die nicht gewaehlt wurden", async () => {
  const { order } = await sale();
  const totals = cartTotals(buildPartialVoidCart(order, [{ lineId: "l2", quantity: ONE }]), { deposits });
  assert.equal(totals.total, -450, "ein Crepe, kein Pfand");
  assert.deepEqual(totals.lines.map((l) => l.name), ["Crepe"]);
});

test("Teilstorno der vollen Menge ist der Vollstorno dieser Position", async () => {
  const { order } = await sale({ lineDiscount: 137 });
  const limoLine = order.lines.find((line) => line.productId === "p-limo")!;
  const totals = cartTotals(buildPartialVoidCart(order, [{ lineId: limoLine.id, quantity: 3 * ONE }]), { deposits });
  const depositLine = order.lines.find((line) => line.businessCaseType === "Pfand")!;
  assert.equal(totals.total, -(limoLine.gross + depositLine.gross), "exakt der gezahlte Anteil");
});

test("rabattierte Position wird nur mit dem gezahlten Anteil erstattet", async () => {
  // 3 Limo zu 2,50 = 7,50, davon 1,50 Rabatt -> 6,00 gezahlt, also 2,00 je Stueck.
  const { order } = await sale({ lineDiscount: 150 });
  const limoLine = order.lines.find((line) => line.productId === "p-limo")!;
  assert.equal(limoLine.gross, 600);

  const totals = cartTotals(buildPartialVoidCart(order, [{ lineId: limoLine.id, quantity: ONE }]), { deposits });
  const ware = totals.lines.find((line) => line.name === "Limonade")!;
  assert.equal(ware.gross, -200, "nicht 2,50 - der Rabatt gilt auch beim Storno");
});

test("Belegrabatt wirkt beim Teilstorno anteilig mit", async () => {
  const { order } = await sale({ orderDiscount: 300 });
  const limoLine = order.lines.find((line) => line.productId === "p-limo")!;
  const perUnit = Math.round(limoLine.gross / 3);
  const totals = cartTotals(buildPartialVoidCart(order, [{ lineId: limoLine.id, quantity: ONE }]), { deposits });
  const ware = totals.lines.find((line) => line.name === "Limonade")!;
  assert.equal(ware.gross, -perUnit);
  assert.ok(Math.abs(ware.gross) < 250, "weniger als der Listenpreis");
});

test("Summe mehrerer Teilstorni uebersteigt den Beleg nicht", async () => {
  const { order } = await sale();
  const limoLine = order.lines.find((line) => line.productId === "p-limo")!;
  // Drei einzelne Rueckgaben ergeben zusammen den Vollstorno der Position.
  const parts = [ONE, ONE, ONE].map((quantity) =>
    cartTotals(buildPartialVoidCart(order, [{ lineId: limoLine.id, quantity }]), { deposits }).total,
  );
  const depositLine = order.lines.find((line) => line.businessCaseType === "Pfand")!;
  assert.equal(sumCents(parts), -(limoLine.gross + depositLine.gross));
});

test("mehr zurueckgeben als verkauft wurde ist nicht moeglich", async () => {
  const { order } = await sale();
  const limoLine = order.lines.find((line) => line.productId === "p-limo")!;
  assert.throws(() => buildPartialVoidCart(order, [{ lineId: limoLine.id, quantity: 4 * ONE }]), OrderError);
  // Auch nicht in zwei Schritten innerhalb derselben Auswahl.
  assert.throws(
    () => buildPartialVoidCart(order, [{ lineId: limoLine.id, quantity: 2 * ONE }, { lineId: limoLine.id, quantity: 2 * ONE }]),
    OrderError,
  );
  assert.throws(() => buildPartialVoidCart(order, [{ lineId: limoLine.id, quantity: 0 }]), OrderError);
  assert.throws(() => buildPartialVoidCart(order, [{ lineId: "gibtsnicht", quantity: ONE }]), OrderError);
  assert.throws(() => buildPartialVoidCart(order, []), OrderError);
});

test("nur bezahlte Belege koennen storniert werden", async () => {
  const { order } = await sale();
  assert.throws(() => buildPartialVoidCart({ ...order, state: "OPEN" }, [{ lineId: "l1", quantity: ONE }]), OrderError);
  assert.throws(() => buildVoidCart({ ...order, state: "VOIDED" }), OrderError);
});

test("Teilstorno laeuft als eigener Beleg durch die TSE", async () => {
  const { order, ctx } = await sale();
  const limoLine = order.lines.find((line) => line.productId === "p-limo")!;
  const cart = buildPartialVoidCart(order, [{ lineId: limoLine.id, quantity: ONE }]);
  const total = cartTotals(cart, { deposits }).total;

  const open = await beginTransaction(ctx);
  const { order: storno } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: total }], {
    sequence: 2, deposits, note: `Teilstorno zu ${order.receiptNumber}`,
  });

  assert.equal(storno.receiptNumber, "K1-000002");
  assert.equal(storno.total, -275);
  assert.notEqual(storno.tse?.transactionNumber, order.tse?.transactionNumber);
  // Der ausgezahlte Betrag steht als negative Barzahlung in den Prozessdaten.
  assert.ok(storno.tse?.processData.includes("-2.75:Bar"));
});

test("freie Auszahlung braucht Betrag, Grund und Steuersatz", async () => {
  const { order } = await sale();
  const cart = buildRefundCart(order, 500, 1, { id: "r1", reason: "Kulanz, Ware beschaedigt" });
  const totals = cartTotals(cart);
  assert.equal(totals.total, -500);
  assert.equal(totals.taxGroups[0]?.key, 1);
  assert.equal(totals.taxGroups[0]?.tax, -80);
  assert.ok(totals.lines[0]?.name.includes("Kulanz"));
  assert.ok(totals.lines[0]?.note?.includes(order.receiptNumber));

  assert.throws(() => buildRefundCart(order, 0, 1, { id: "r1", reason: "x" }), OrderError);
  assert.throws(() => buildRefundCart(order, -100, 1, { id: "r1", reason: "x" }), OrderError);
  assert.throws(() => buildRefundCart(order, 500, 1, { id: "r1", reason: "   " }), OrderError);
});

test("freie Auszahlung mit ermaessigtem Satz weist diesen aus", async () => {
  const { order } = await sale();
  const totals = cartTotals(buildRefundCart(order, 428, 2, { id: "r1", reason: "Speise verdorben" }));
  assert.equal(totals.taxGroups[0]?.key, 2);
  assert.equal(totals.taxGroups[0]?.tax, -28);
});
