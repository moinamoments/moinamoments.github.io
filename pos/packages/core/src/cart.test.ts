import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE, sumCents } from "./money.ts";
import type { Product } from "./model.ts";
import {
  CartError,
  addFreeLine,
  addProduct,
  cartTotals,
  changeQuantity,
  emptyCart,
  removeLine,
  setLineDiscount,
  setLineDiscountPercent,
  setOrderDiscount,
  setOrderDiscountPercent,
  setQuantity,
  setServiceMode,
} from "./cart.ts";

const TENANT = "t1";

function product(over: Partial<Product> = {}): Product {
  return {
    id: "p-crepe",
    tenantId: TENANT,
    categoryId: "c1",
    name: "Crepe Zimt & Zucker",
    price: 450,
    taxKey: 2,
    taxKeyDineIn: 1,
    unit: "PIECE",
    sortOrder: 1,
    active: true,
    updatedAt: "2026-09-01T00:00:00+02:00",
    ...over,
  };
}

test("Artikel landet mit Menge 1 im Warenkorb", () => {
  const cart = addProduct(emptyCart(TENANT), product(), { id: "l1" });
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.lines[0]?.quantity, ONE);
  assert.equal(cartTotals(cart).total, 450);
});

test("gleicher Artikel wird zusammengefasst", () => {
  let cart = emptyCart(TENANT);
  cart = addProduct(cart, product(), { id: "l1" });
  cart = addProduct(cart, product(), { id: "l2" });
  cart = addProduct(cart, product(), { id: "l3" });
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.lines[0]?.quantity, 3 * ONE);
  assert.equal(cartTotals(cart).total, 1350);
});

test("Notiz, Rabatt oder abweichender Preis verhindern das Zusammenfassen", () => {
  let cart = addProduct(emptyCart(TENANT), product(), { id: "l1" });
  cart = addProduct(cart, product(), { id: "l2", note: "ohne Zimt" });
  assert.equal(cart.lines.length, 2);

  cart = setLineDiscount(cart, "l1", 50);
  cart = addProduct(cart, product(), { id: "l3" });
  assert.equal(cart.lines.length, 3);

  cart = addProduct(cart, product(), { id: "l4", price: 500 });
  assert.equal(cart.lines.length, 4);
});

test("Zusaetze gehen in den Einzelpreis ein und trennen die Zeile", () => {
  const sahne = { id: "m1", tenantId: TENANT, name: "Sahne", priceDelta: 50, sortOrder: 1, active: true };
  let cart = addProduct(emptyCart(TENANT), product(), { id: "l1", modifiers: [sahne] });
  cart = addProduct(cart, product(), { id: "l2" });
  assert.equal(cart.lines.length, 2);
  assert.equal(cartTotals(cart).total, 500 + 450);

  // Gleiche Zusaetze fassen wieder zusammen.
  cart = addProduct(cart, product(), { id: "l3", modifiers: [sahne] });
  assert.equal(cart.lines.length, 2);
  assert.equal(cartTotals(cart).total, 1000 + 450);
});

test("Zusatz mit eigenem Steuersatz wird abgelehnt, nicht falsch gebucht", () => {
  const pfand = { id: "m2", tenantId: TENANT, name: "Pfand", priceDelta: 25, taxKey: 1, sortOrder: 1, active: true };
  assert.throws(() => addProduct(emptyCart(TENANT), product(), { id: "l1", modifiers: [pfand] }), CartError);
});

test("offener Preis muss eingegeben werden", () => {
  const open = product({ id: "p-open", name: "Sonderposten", price: null });
  assert.throws(() => addProduct(emptyCart(TENANT), open, { id: "l1" }), CartError);
  const cart = addProduct(emptyCart(TENANT), open, { id: "l1", price: 1234 });
  assert.equal(cartTotals(cart).total, 1234);
});

test("Artikel eines fremden Mandanten wird abgewiesen", () => {
  assert.throws(() => addProduct(emptyCart(TENANT), product({ tenantId: "t2" }), { id: "l1" }), CartError);
});

test("Mengen aendern und Positionen entfernen", () => {
  let cart = addProduct(emptyCart(TENANT), product(), { id: "l1" });
  cart = setQuantity(cart, "l1", 5 * ONE);
  assert.equal(cartTotals(cart).total, 2250);
  cart = changeQuantity(cart, "l1", -2 * ONE);
  assert.equal(cartTotals(cart).total, 1350);
  // Bis auf 0 herunter: die Position verschwindet.
  cart = changeQuantity(cart, "l1", -3 * ONE);
  assert.equal(cart.lines.length, 0);
  assert.throws(() => removeLine(cart, "l1"), CartError);
});

test("Gewichtsartikel rechnet mit Tausendsteln", () => {
  const lose = product({ id: "p-lose", name: "Mutzen lose", price: 1200, unit: "KILOGRAM" });
  const cart = addProduct(emptyCart(TENANT), lose, { id: "l1", quantity: 350 });
  assert.equal(cartTotals(cart).total, 420);
});

test("ausser Haus 7 Prozent, im Haus 19 Prozent", () => {
  let cart = addProduct(emptyCart(TENANT), product(), { id: "l1" });
  const takeaway = cartTotals(cart);
  assert.deepEqual(takeaway.taxGroups.map((g) => [g.key, g.tax]), [[2, 29]]);
  assert.equal(takeaway.total, 450, "der Bruttopreis bleibt gleich, nur die Steuer darin wechselt");

  cart = setServiceMode(cart, "DINE_IN");
  const dineIn = cartTotals(cart);
  assert.deepEqual(dineIn.taxGroups.map((g) => [g.key, g.tax]), [[1, 72]]);
  assert.equal(dineIn.total, 450);
});

test("Getraenke bleiben bei 19 Prozent, Speisen wechseln", () => {
  const cola = product({ id: "p-cola", name: "Cola 0,33", price: 250, taxKey: 1, taxKeyDineIn: null });
  let cart = addProduct(emptyCart(TENANT), product(), { id: "l1" });
  cart = addProduct(cart, cola, { id: "l2" });
  cart = setServiceMode(cart, "DINE_IN");
  const totals = cartTotals(cart);
  assert.deepEqual(totals.taxGroups.map((g) => [g.key, g.gross]), [[1, 700]]);
  assert.equal(totals.total, 700);
});

test("Kleinunternehmer weist keine Steuer aus", () => {
  const cart = addProduct(emptyCart(TENANT), product(), { id: "l1" });
  const totals = cartTotals(cart, { smallBusiness: true });
  assert.deepEqual(totals.taxGroups.map((g) => [g.key, g.tax]), [[6, 0]]);
  assert.equal(totals.taxTotal, 0);
  assert.equal(totals.total, 450);
});

test("Positionsrabatt als Betrag und als Prozentsatz", () => {
  let cart = addProduct(emptyCart(TENANT), product(), { id: "l1", quantity: 2 * ONE });
  cart = setLineDiscount(cart, "l1", 100);
  assert.equal(cartTotals(cart).total, 800);

  cart = setLineDiscountPercent(cart, "l1", 1000); // 10 %
  assert.equal(cartTotals(cart).total, 810);
  assert.throws(() => setLineDiscount(cart, "l1", 10_000), CartError);
  assert.throws(() => setLineDiscount(cart, "l1", -100), CartError);
});

test("Belegrabatt wird verlustfrei auf die Positionen umgelegt", () => {
  let cart = emptyCart(TENANT);
  cart = addProduct(cart, product(), { id: "l1" });                                   // 4,50
  cart = addProduct(cart, product({ id: "p2", name: "Cola", price: 250, taxKey: 1, taxKeyDineIn: null }), { id: "l2" }); // 2,50
  cart = addProduct(cart, product({ id: "p3", name: "Kaffee", price: 220, taxKey: 1, taxKeyDineIn: null }), { id: "l3" }); // 2,20
  cart = setOrderDiscount(cart, 100);

  const totals = cartTotals(cart);
  assert.equal(totals.total, 920 - 100);
  assert.equal(sumCents(totals.lines.map((l) => l.allocatedDiscount)), 100, "kein Cent darf verloren gehen");
  assert.equal(sumCents(totals.lines.map((l) => l.gross)), totals.total);
  // Der Rabatt mindert die Steuer beider Saetze anteilig.
  assert.equal(sumCents(totals.taxGroups.map((g) => g.gross)), 820);
});

test("Belegrabatt in Prozent", () => {
  let cart = addProduct(emptyCart(TENANT), product(), { id: "l1", quantity: 2 * ONE });
  cart = setOrderDiscountPercent(cart, 1500); // 15 % von 9,00 = 1,35
  assert.equal(cart.orderDiscount, 135);
  assert.equal(cartTotals(cart).total, 765);
  assert.throws(() => setOrderDiscount(cart, 99_999), CartError);
});

test("Rabatt greift erst auf Positionsebene, dann auf Belegebene", () => {
  let cart = addProduct(emptyCart(TENANT), product(), { id: "l1", quantity: 2 * ONE }); // 9,00
  cart = setLineDiscount(cart, "l1", 100);                                             // -> 8,00
  cart = setOrderDiscountPercent(cart, 5000);                                          // 50 % von 8,00
  assert.equal(cart.orderDiscount, 400);
  const totals = cartTotals(cart);
  assert.equal(totals.subtotal, 900);
  assert.equal(totals.lineDiscountTotal, 100);
  assert.equal(totals.total, 400);
});

test("negative Position hebt eine positive exakt auf", () => {
  let cart = addProduct(emptyCart(TENANT), product(), { id: "l1" });
  cart = addFreeLine(cart, { id: "l2", name: "Storno Crepe", price: -450, taxKey: 2 });
  const totals = cartTotals(cart);
  assert.equal(totals.total, 0);
  assert.deepEqual(totals.taxGroups.map((g) => [g.key, g.gross, g.tax]), [[2, 0, 0]]);
});

test("Positionen tragen fortlaufende Nummern ab 1", () => {
  let cart = addProduct(emptyCart(TENANT), product(), { id: "l1" });
  cart = addFreeLine(cart, { id: "l2", name: "Trinkgeld", price: 100, taxKey: 5, businessCaseType: "TrinkgeldAN" });
  const totals = cartTotals(cart);
  assert.deepEqual(totals.lines.map((l) => l.position), [1, 2]);
  assert.equal(totals.lines[1]?.businessCaseType, "TrinkgeldAN");
});

test("Warenkorb ist unveraenderlich", () => {
  const before = addProduct(emptyCart(TENANT), product(), { id: "l1" });
  const after = addProduct(before, product({ id: "p2", name: "Cola", price: 250 }), { id: "l2" });
  assert.equal(before.lines.length, 1, "der alte Warenkorb bleibt unberuehrt");
  assert.equal(after.lines.length, 2);
});
