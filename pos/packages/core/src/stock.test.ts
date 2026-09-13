import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE } from "./money.ts";
import { fixedClock, sequentialIds } from "./clock.ts";
import { addProduct, emptyCart } from "./cart.ts";
import { createDepositCatalog } from "./deposit.ts";
import type { Device, Product, Store, Tenant, User } from "./model.ts";
import { MockTse } from "./tse/mock.ts";
import { beginTransaction, buildVoidCart, finishTransaction, type TransactionContext } from "./order.ts";
import {
  STOCK_REASON_LABELS,
  StockError,
  buildCountCorrection,
  buildMovement,
  formatStock,
  lowStockProducts,
  movementsForOrder,
  stockState,
  summarizeStock,
  tracksStock,
} from "./stock.ts";

const TENANT = "t1";

function prod(over: Partial<Product> = {}): Product {
  return {
    id: "p1", tenantId: TENANT, categoryId: "c1", name: "Limonade 0,5 l", price: 250, taxKey: 1,
    unit: "PIECE", trackStock: true, stock: 20 * ONE, lowStockThreshold: 5 * ONE,
    sortOrder: 0, active: true, updatedAt: "2026-09-01T00:00:00+02:00", ...over,
  };
}

const movementBase = {
  storeId: "s1",
  userId: "u1",
  createdAt: "2026-09-26T09:00:00+02:00",
};

test("Bestandsfuehrung ist je Artikel einschaltbar", () => {
  assert.equal(tracksStock(prod()), true);
  assert.equal(tracksStock(prod({ trackStock: false })), false);
  assert.equal(tracksStock(prod({ trackStock: undefined })), false);
  // Pfandartikel fuehren keinen Bestand - Becher sind Gebinde, kein Umsatz.
  assert.equal(tracksStock(prod({ isDeposit: true })), false);
});

test("Zustand des Bestands", () => {
  assert.equal(stockState(prod({ stock: 20 * ONE })), "OK");
  assert.equal(stockState(prod({ stock: 5 * ONE })), "LOW", "genau auf der Schwelle ist schon knapp");
  assert.equal(stockState(prod({ stock: 4 * ONE })), "LOW");
  assert.equal(stockState(prod({ stock: 0 })), "EMPTY");
  assert.equal(stockState(prod({ stock: -2 * ONE })), "NEGATIVE");
  assert.equal(stockState(prod({ trackStock: false })), "UNTRACKED");
  assert.equal(stockState(prod({ lowStockThreshold: null, stock: ONE })), "OK", "ohne Schwelle keine Warnung");
});

test("Bestand wird mit Einheit angezeigt", () => {
  assert.equal(formatStock(prod({ stock: 12 * ONE })), "12");
  assert.equal(formatStock(prod({ unit: "KILOGRAM", stock: 2500 })), "2,5 kg");
  assert.equal(formatStock(prod({ unit: "LITRE", stock: 500 })), "0,5 l");
  assert.equal(formatStock(prod({ trackStock: false })), null);
});

test("Bewegung schreibt den Bestand fort und haelt den Grund fest", () => {
  const result = buildMovement({ ...movementBase, id: "m1", product: prod(), quantity: 6 * ONE, reason: "PURCHASE" });
  assert.equal(result.stock, 26 * ONE);
  assert.equal(result.movement.resultingStock, 26 * ONE, "der Stand nach der Bewegung steht im Journal");
  assert.equal(result.movement.reason, "PURCHASE");
  assert.equal(result.movement.userId, "u1");
  assert.equal(result.movement.productId, "p1");
  assert.equal(result.movement.orderId, null);
});

test("Bewegung ohne Menge und auf Artikel ohne Bestandsfuehrung wird abgewiesen", () => {
  assert.throws(() => buildMovement({ ...movementBase, id: "m1", product: prod(), quantity: 0, reason: "LOSS" }), StockError);
  assert.throws(() => buildMovement({ ...movementBase, id: "m1", product: prod(), quantity: 1.5, reason: "LOSS" }), StockError);
  assert.throws(
    () => buildMovement({ ...movementBase, id: "m1", product: prod({ trackStock: false }), quantity: ONE, reason: "LOSS" }),
    StockError,
  );
});

test("Schwund und Eigenverbrauch mindern mit Grund", () => {
  const loss = buildMovement({ ...movementBase, id: "m1", product: prod(), quantity: -2 * ONE, reason: "LOSS", note: "Flasche zerbrochen" });
  assert.equal(loss.stock, 18 * ONE);
  assert.equal(loss.movement.note, "Flasche zerbrochen");
  assert.equal(STOCK_REASON_LABELS[loss.movement.reason], "Schwund");
  assert.equal(STOCK_REASON_LABELS.OWN_USE, "Eigenverbrauch");
});

test("Zaehlung buchht die Differenz, nicht den Zielwert", () => {
  // Gefuehrt 20, gezaehlt 17: es fehlen 3.
  const correction = buildCountCorrection({ ...movementBase, id: "m1", product: prod(), countedStock: 17 * ONE });
  assert.ok(correction);
  assert.equal(correction!.movement.quantity, -3 * ONE, "die Differenz steht im Journal");
  assert.equal(correction!.stock, 17 * ONE);
  assert.equal(correction!.movement.reason, "COUNT");
});

test("Zaehlung ohne Abweichung erzeugt keine Bewegung", () => {
  assert.equal(buildCountCorrection({ ...movementBase, id: "m1", product: prod(), countedStock: 20 * ONE }), null);
  assert.throws(
    () => buildCountCorrection({ ...movementBase, id: "m1", product: prod(), countedStock: 1.5 }),
    StockError,
  );
});

test("Bestand darf ins Negative laufen - der Verkauf wird nicht verweigert", () => {
  // Der Kunde steht am Stand, die Flasche ist in seiner Hand. Die Kasse hat
  // dann nicht recht zu haben, sondern zu kassieren.
  const result = buildMovement({ ...movementBase, id: "m1", product: prod({ stock: ONE }), quantity: -3 * ONE, reason: "SALE" });
  assert.equal(result.stock, -2 * ONE);
  assert.equal(stockState(prod({ stock: result.stock })), "NEGATIVE", "der negative Bestand ist das Signal");
});

test("lowStockProducts sortiert das Nachzubestellende nach oben", () => {
  const products = [
    prod({ id: "voll", stock: 50 * ONE }),
    prod({ id: "knapp", stock: 3 * ONE }),
    prod({ id: "leer", stock: 0 }),
    prod({ id: "negativ", stock: -2 * ONE }),
    prod({ id: "ohne", trackStock: false, stock: 0 }),
  ];
  assert.deepEqual(lowStockProducts(products).map((p) => p.id), ["negativ", "leer", "knapp"]);
});

test("summarizeStock zaehlt, worueber zu reden ist", () => {
  const products = [
    prod({ id: "a", stock: 50 * ONE }),
    prod({ id: "b", stock: 3 * ONE }),
    prod({ id: "c", stock: 0 }),
    prod({ id: "d", stock: -1 * ONE }),
    prod({ id: "e", trackStock: false }),
  ];
  assert.deepEqual(summarizeStock(products), { tracked: 4, low: 1, empty: 1, negative: 1 });
});

// --- Zusammenspiel mit dem Beleg -----------------------------------------

const tenant: Tenant = {
  id: TENANT, name: "Kiosk", legalName: "Kiosk", street: "Weg 1", postalCode: "24103", city: "Kiel",
  countryCode: "DE", taxNumber: "20/123/45678", vatId: null, email: null, phone: null,
  smallBusiness: false, receiptFooter: null, currency: "EUR", timeZone: "Europe/Berlin", createdAt: "x",
};
const store: Store = { id: "s1", tenantId: TENANT, name: "Stand", active: true };
const device: Device = {
  id: "d1", tenantId: TENANT, storeId: "s1", name: "Kasse 1", serialNumber: "KASSE-1",
  tseClientId: "c1", receiptPrefix: "K1", active: true,
};
const user: User = { id: "u1", tenantId: TENANT, name: "Bediener", role: "OWNER", active: true };

function context(): TransactionContext {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  return { tenant, store, device, user, clock, newId: sequentialIds("o"), tse: new MockTse({ clock }) };
}

test("Verkauf mindert den Bestand, Pfand bleibt aussen vor", () => {
  const becher = prod({ id: "d-becher", name: "Becher", price: 100, isDeposit: true, trackStock: false });
  const limo = prod({ id: "p-limo", name: "Limonade", stock: 10 * ONE, depositProductIds: ["d-becher"] });
  const deposits = createDepositCatalog([becher, limo]);

  return (async () => {
    const ctx = context();
    const open = await beginTransaction(ctx);
    const cart = addProduct(emptyCart(TENANT), limo, { id: "l1", quantity: 3 * ONE });
    const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 750 + 300 }], {
      sequence: 1, deposits,
    });

    const movements = movementsForOrder(order, [limo, becher], { newId: sequentialIds("m"), userId: "u1" });
    assert.equal(movements.length, 1, "nur die Ware, nicht das Becherpfand");
    assert.equal(movements[0]?.movement.quantity, -3 * ONE);
    assert.equal(movements[0]?.stock, 7 * ONE);
    assert.equal(movements[0]?.movement.reason, "SALE");
    assert.equal(movements[0]?.movement.orderId, order.id);
  })();
});

test("Storno bucht die Ware zurueck", async () => {
  const limo = prod({ id: "p-limo", stock: 10 * ONE });
  const ctx = context();
  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart(TENANT), limo, { id: "l1", quantity: 2 * ONE });
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 500 }], { sequence: 1 });

  const sold = movementsForOrder(order, [limo], { newId: sequentialIds("m"), userId: "u1" });
  assert.equal(sold[0]?.stock, 8 * ONE);

  const voidOpen = await beginTransaction(ctx);
  const { order: voidOrder } = await finishTransaction(ctx, voidOpen, buildVoidCart(order), [{ method: "CASH", amount: -500 }], { sequence: 2 });
  const returned = movementsForOrder({ ...voidOrder, voidsOrderId: order.id }, [{ ...limo, stock: 8 * ONE }], {
    newId: sequentialIds("r"), userId: "u1",
  });
  assert.equal(returned[0]?.movement.quantity, 2 * ONE, "die Belegmenge ist negativ, die Bewegung positiv");
  assert.equal(returned[0]?.stock, 10 * ONE, "der Ausgangsbestand ist wieder da");
  assert.equal(returned[0]?.movement.reason, "VOID");
});

test("mehrere Positionen desselben Artikels rechnen fortlaufend weiter", async () => {
  const limo = prod({ id: "p-limo", stock: 10 * ONE });
  const ctx = context();
  const open = await beginTransaction(ctx);
  // Zwei getrennte Zeilen, weil eine Notiz das Zusammenfassen verhindert.
  let cart = addProduct(emptyCart(TENANT), limo, { id: "l1", quantity: 2 * ONE, note: "kalt" });
  cart = addProduct(cart, limo, { id: "l2", quantity: 3 * ONE, note: "warm" });
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 1250 }], { sequence: 1 });

  const movements = movementsForOrder(order, [limo], { newId: sequentialIds("m"), userId: "u1" });
  assert.equal(movements.length, 2);
  assert.equal(movements[0]?.stock, 8 * ONE);
  assert.equal(movements[1]?.stock, 5 * ONE, "nicht zweimal vom Ausgangswert gerechnet");
});

test("Artikel ohne Bestandsfuehrung erzeugen keine Bewegungen", async () => {
  const crepe = prod({ id: "p-crepe", name: "Crepe", trackStock: false });
  const ctx = context();
  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart(TENANT), crepe, { id: "l1" });
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 250 }], { sequence: 1 });
  assert.deepEqual(movementsForOrder(order, [crepe], { newId: sequentialIds("m"), userId: "u1" }), []);
});
