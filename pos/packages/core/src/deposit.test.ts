import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE, sumCents } from "./money.ts";
import type { Product } from "./model.ts";
import {
  CartError,
  addDepositReturn,
  addProduct,
  cartTotals,
  changeQuantity,
  emptyCart,
  isDeposit,
  removeLine,
  setOrderDiscount,
  setOrderDiscountPercent,
  setWaiveDeposit,
} from "./cart.ts";
import { DepositError, createDepositCatalog, depositQuantity } from "./deposit.ts";

const TENANT = "t1";

function base(over: Partial<Product>): Product {
  return {
    id: "x",
    tenantId: TENANT,
    categoryId: "c1",
    name: "x",
    price: 0,
    taxKey: 1,
    unit: "PIECE",
    sortOrder: 1,
    active: true,
    updatedAt: "2026-09-01T00:00:00+02:00",
    ...over,
  };
}

// Pfandartikel: Mehrwegbecher 1,00 EUR, Deckel 0,30 EUR, Einwegflasche 0,25 EUR.
const becher = base({ id: "d-becher", name: "Becher", price: 100, taxKey: 1, isDeposit: true });
const deckel = base({ id: "d-deckel", name: "Deckel", price: 30, taxKey: 1, isDeposit: true });
const einweg = base({ id: "d-einweg", name: "Flaschenpfand", price: 25, taxKey: 1, isDeposit: true });
const schale = base({ id: "d-schale", name: "Schale", price: 200, taxKey: 1, isDeposit: true });

const kaffee = base({ id: "p-kaffee", name: "Cafe Crema", price: 250, taxKey: 1, depositProductIds: ["d-becher", "d-deckel"] });
const crepe = base({ id: "p-crepe", name: "Crepe", price: 450, taxKey: 2, taxKeyDineIn: 1 });
const cola = base({ id: "p-cola", name: "Cola 0,5", price: 250, taxKey: 1, depositProductIds: ["d-einweg"] });
const mutzen = base({ id: "p-mutzen", name: "Mutzen lose", price: 1200, taxKey: 2, unit: "KILOGRAM", depositProductIds: ["d-schale"] });

const catalog = createDepositCatalog([becher, deckel, einweg, schale, kaffee, crepe, cola, mutzen]);
const options = { deposits: catalog };

test("Kaffee bringt Becher und Deckel automatisch mit", () => {
  const cart = addProduct(emptyCart(TENANT), kaffee, { id: "l1" });
  const totals = cartTotals(cart, options);

  assert.deepEqual(
    totals.lines.map((l) => [l.name, l.gross, l.businessCaseType]),
    [
      ["Cafe Crema", 250, "Umsatz"],
      ["Becher", 100, "Pfand"],
      ["Deckel", 30, "Pfand"],
    ],
  );
  assert.equal(totals.total, 380);
  assert.equal(totals.deposits.charged, 130);
  assert.equal(totals.deposits.balance, 130);
  // Die Pfandzeilen verweisen auf ihre Warenposition.
  assert.equal(totals.lines[1]?.depositForLineId, "l1");
  assert.equal(totals.lines[2]?.depositForLineId, "l1");
  // Pfand zaehlt nicht als verkaufter Artikel.
  assert.equal(totals.itemCount, ONE);
});

test("Pfand folgt der Menge - immer, ohne Zutun", () => {
  let cart = addProduct(emptyCart(TENANT), kaffee, { id: "l1" });
  cart = changeQuantity(cart, "l1", 2 * ONE);
  const totals = cartTotals(cart, options);
  assert.equal(totals.lines[0]?.gross, 750);
  assert.equal(totals.deposits.charged, 3 * 130);
  assert.equal(totals.total, 750 + 390);
});

test("Warenposition entfernt heisst Pfand entfernt", () => {
  let cart = addProduct(emptyCart(TENANT), kaffee, { id: "l1" });
  cart = addProduct(cart, crepe, { id: "l2" });
  assert.equal(cartTotals(cart, options).lines.length, 4, "Kaffee, Becher, Deckel, Crepe");
  cart = removeLine(cart, "l1");
  const totals = cartTotals(cart, options);
  assert.equal(totals.lines.length, 1, "kein verwaistes Becherpfand");
  assert.equal(totals.deposits.charged, 0);
});

test("eigener Becher: Pfand abwaehlbar", () => {
  let cart = addProduct(emptyCart(TENANT), kaffee, { id: "l1" });
  cart = setWaiveDeposit(cart, "l1", true);
  const totals = cartTotals(cart, options);
  assert.equal(totals.lines.length, 1);
  assert.equal(totals.total, 250);

  // Und wieder zurueck.
  cart = setWaiveDeposit(cart, "l1", false);
  assert.equal(cartTotals(cart, options).total, 380);
});

test("Position mit eigenem Becher wird nicht mit einer ohne zusammengefasst", () => {
  let cart = addProduct(emptyCart(TENANT), kaffee, { id: "l1", waiveDeposit: true });
  cart = addProduct(cart, kaffee, { id: "l2" });
  assert.equal(cart.lines.length, 2);
  const totals = cartTotals(cart, options);
  assert.equal(totals.total, 250 + 380);
});

test("ohne Pfandkatalog entsteht kein Pfand", () => {
  const cart = addProduct(emptyCart(TENANT), kaffee, { id: "l1" });
  const totals = cartTotals(cart);
  assert.equal(totals.lines.length, 1);
  assert.equal(totals.deposits.charged, 0);
});

test("Belegrabatt mindert das Pfand nicht", () => {
  let cart = addProduct(emptyCart(TENANT), kaffee, { id: "l1" });
  cart = addProduct(cart, crepe, { id: "l2" });
  // Rabattierbar sind 2,50 + 4,50 = 7,00 - nicht die 1,30 Pfand.
  cart = setOrderDiscountPercent(cart, 1000);
  assert.equal(cart.orderDiscount, 70);

  const totals = cartTotals(cart, options);
  assert.equal(totals.deposits.charged, 130, "Pfand bleibt unangetastet");
  assert.equal(totals.total, 700 - 70 + 130);
  const depositLines = totals.lines.filter(isDeposit);
  assert.equal(sumCents(depositLines.map((l) => l.allocatedDiscount)), 0);
});

test("Belegrabatt darf nicht ueber die Warensumme hinausgehen, auch nicht mit Pfand", () => {
  const cart = addProduct(emptyCart(TENANT), kaffee, { id: "l1" });
  // Ware 2,50, Pfand 1,30. Ein Rabatt von 3,00 waere ohne die Trennung
  // faelschlich erlaubt.
  assert.throws(() => setOrderDiscount(cart, 300), CartError);
  assert.doesNotThrow(() => setOrderDiscount(cart, 250));
});

test("Pfandrueckgabe ist eine eigene negative Position", () => {
  const cart = addDepositReturn(emptyCart(TENANT), becherItem(), { id: "r1", quantity: 3 * ONE });
  const totals = cartTotals(cart, options);
  assert.equal(totals.total, -300);
  assert.equal(totals.lines[0]?.businessCaseType, "PfandRueckzahlung");
  assert.equal(totals.lines[0]?.name, "Becher zurueck");
  assert.equal(totals.deposits.refunded, -300);
  assert.equal(totals.deposits.balance, -300);
});

test("Verkauf und Rueckgabe im selben Beleg saldieren", () => {
  let cart = addProduct(emptyCart(TENANT), kaffee, { id: "l1" });
  cart = addDepositReturn(cart, becherItem(), { id: "r1" });
  const totals = cartTotals(cart, options);
  assert.equal(totals.total, 250 + 130 - 100);
  assert.equal(totals.deposits.charged, 130);
  assert.equal(totals.deposits.refunded, -100);
  assert.equal(totals.deposits.balance, 30);
});

test("Ruecknahme braucht einen Betrag und eine positive Menge", () => {
  assert.throws(() => addDepositReturn(emptyCart(TENANT), { ...becherItem(), price: 0 }, { id: "r1" }), CartError);
  assert.throws(() => addDepositReturn(emptyCart(TENANT), becherItem(), { id: "r1", quantity: 0 }), CartError);
  assert.throws(() => addDepositReturn(emptyCart(TENANT), becherItem(), { id: "r1", quantity: -1000 }), CartError);
});

test("Pfandrueckgabe nimmt nicht am Belegrabatt teil", () => {
  let cart = addProduct(emptyCart(TENANT), crepe, { id: "l1" });
  cart = addDepositReturn(cart, becherItem(), { id: "r1" });
  cart = setOrderDiscountPercent(cart, 1000);
  assert.equal(cart.orderDiscount, 45, "10 % von 4,50 - die Rueckgabe zaehlt nicht mit");
  assert.equal(cartTotals(cart, options).total, 450 - 45 - 100);
});

test("Flaschenpfand haengt genauso am Artikel", () => {
  const cart = addProduct(emptyCart(TENANT), cola, { id: "l1", quantity: 6 * ONE });
  const totals = cartTotals(cart, options);
  assert.equal(totals.deposits.charged, 150);
  assert.equal(totals.total, 1500 + 150);
});

test("Pfand auf Gewichtsware wird in ganzen Schalen berechnet", () => {
  // 0,350 kg Mutzen zu 12,00 EUR/kg = 4,20 EUR, dazu eine Schale.
  const cart = addProduct(emptyCart(TENANT), mutzen, { id: "l1", quantity: 350 });
  const totals = cartTotals(cart, options);
  assert.equal(totals.lines[0]?.gross, 420);
  assert.equal(totals.deposits.charged, 200, "eine angefangene Schale ist eine ganze");

  // 1,2 kg brauchen zwei Schalen.
  const bigger = addProduct(emptyCart(TENANT), mutzen, { id: "l1", quantity: 1200 });
  assert.equal(cartTotals(bigger, options).deposits.charged, 400);
});

test("depositQuantity rundet auf ganze Einheiten auf", () => {
  assert.equal(depositQuantity(ONE), ONE);
  assert.equal(depositQuantity(350), ONE);
  assert.equal(depositQuantity(1200), 2 * ONE);
  assert.equal(depositQuantity(2 * ONE), 2 * ONE);
  assert.equal(depositQuantity(0), 0);
  assert.equal(depositQuantity(-350), -ONE, "auch beim Storno");
});

test("Pfand traegt seinen eigenen Steuersatz, unabhaengig von der Ware", () => {
  // Crepe ausser Haus 7 %, Schale 19 %.
  const withDeposit = base({ ...crepe, id: "p-crepe-schale", depositProductIds: ["d-schale"] });
  const localCatalog = createDepositCatalog([schale, withDeposit]);
  const cart = addProduct(emptyCart(TENANT), withDeposit, { id: "l1" });
  const totals = cartTotals(cart, { deposits: localCatalog });
  assert.deepEqual(totals.taxGroups.map((g) => [g.key, g.gross]), [
    [1, 200],
    [2, 450],
  ]);
});

test("Pfandposition wechselt nicht mit der Bewirtungsform", () => {
  const withDeposit = base({ ...crepe, id: "p2", depositProductIds: ["d-schale"] });
  const localCatalog = createDepositCatalog([schale, withDeposit]);
  const cart = addProduct(emptyCart(TENANT), withDeposit, { id: "l1" });
  const away = cartTotals(cart, { deposits: localCatalog });
  const inHouse = cartTotals({ ...cart, serviceMode: "DINE_IN" }, { deposits: localCatalog });
  const depositAway = away.lines.find(isDeposit);
  const depositIn = inHouse.lines.find(isDeposit);
  assert.equal(depositAway?.taxKey, 1);
  assert.equal(depositIn?.taxKey, 1);
});

test("Katalog meldet fehlerhafte Verweise sofort", () => {
  assert.throws(
    () => createDepositCatalog([base({ id: "p", name: "Kaffee", price: 250, depositProductIds: ["fehlt"] })]),
    DepositError,
  );
  // Verweis auf einen Artikel, der kein Pfandartikel ist.
  assert.throws(
    () => createDepositCatalog([crepe, base({ id: "p", name: "Kaffee", price: 250, depositProductIds: ["p-crepe"] })]),
    DepositError,
  );
  // Pfandartikel ohne Betrag.
  assert.throws(
    () => createDepositCatalog([base({ id: "d", name: "Becher", price: null, isDeposit: true })]),
    DepositError,
  );
  // Pfand auf Pfand.
  assert.throws(
    () =>
      createDepositCatalog([
        becher,
        base({ id: "d2", name: "Deckel", price: 30, isDeposit: true, depositProductIds: ["d-becher"] }),
      ]),
    DepositError,
  );
});

test("Katalog listet alle Pfandartikel fuer den Ruecknahmebildschirm", () => {
  const localCatalog = createDepositCatalog([becher, deckel, einweg, schale]);
  assert.deepEqual(localCatalog.all().map((d) => d.name), ["Becher", "Deckel", "Flaschenpfand", "Schale"]);
  assert.deepEqual(localCatalog.for("unbekannt"), []);
});

test("beliebig viele Pfandartikel mit beliebigem Betrag", () => {
  // Kein Kassenhersteller kennt die Gebinde eines Betriebs. Also muss der
  // Betrieb sie anlegen koennen - ohne Obergrenze und ohne vorgegebene Arten.
  const eigene = Array.from({ length: 12 }, (_, index) =>
    base({ id: `d-${index}`, name: `Pfand ${index}`, price: (index + 1) * 5, isDeposit: true }),
  );
  const ware = base({ id: "p-set", name: "Set", price: 900, depositProductIds: eigene.map((d) => d.id) });
  const localCatalog = createDepositCatalog([...eigene, ware]);
  assert.equal(localCatalog.all().length, 12);
  assert.equal(localCatalog.for("p-set").length, 12);

  const totals = cartTotals(addProduct(emptyCart(TENANT), ware, { id: "l1" }), { deposits: localCatalog });
  // 5 + 10 + ... + 60 Cent
  assert.equal(totals.deposits.charged, 390);
  assert.equal(totals.total, 900 + 390);
});

test("Pfandposition hat eine stabile, ableitbare Id", () => {
  const cart = addProduct(emptyCart(TENANT), kaffee, { id: "l1" });
  const first = cartTotals(cart, options).lines.map((l) => l.lineId);
  const second = cartTotals(cart, options).lines.map((l) => l.lineId);
  assert.deepEqual(first, second, "ein Nachdruck muss dieselben Ids ergeben");
  assert.deepEqual(first, ["l1", "l1:pfand:d-becher", "l1:pfand:d-deckel"]);
});

function becherItem() {
  return { productId: becher.id, name: becher.name, price: 100, taxKey: 1 };
}
