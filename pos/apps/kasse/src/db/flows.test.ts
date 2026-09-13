/**
 * Ablauftests.
 *
 * Diese Tests gehen die Wege, die am Verkaufsstand tatsaechlich gegangen
 * werden - vom Anlegen eines Artikels bis zum Kassenabschluss -, und zwar
 * durch die **echte Datenbank**: dasselbe Schema, dieselben Trigger, dieselben
 * Abfragen wie in der App. Was hier gruen ist, ist nicht nur Rechenlogik,
 * sondern der vollstaendige Weg durch die Datenhaltung.
 *
 * Nicht abgedeckt: das Zeichnen der Bildschirme. Dass eine Kachel an der
 * richtigen Stelle sitzt, kann nur ein Geraet oder ein Emulator zeigen.
 * Getestet ist alles, was unter der Oberflaeche liegt - und dort sitzen die
 * Fehler, die Geld kosten.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ONE,
  buildCashMovement,
  buildCategoryTree,
  buildClosing,
  buildCountCorrection,
  buildExport,
  buildMovement,
  buildPartialVoidCart,
  buildReceiptCommands,
  buildReceiptView,
  buildVoidCart,
  addDepositReturn,
  addProduct,
  beginTransaction,
  canAddProduct,
  cartTotals,
  countCash,
  createDepositCatalog,
  emptyCart,
  finishTransaction,
  fixedClock,
  flattenCategoryTree,
  formatCategoryPath,
  formatEuro,
  isTseSecured,
  lowStockProducts,
  movementsForOrder,
  openDay,
  outboxKey,
  renderReceiptText,
  sequentialIds,
  setServiceMode,
  stockState,
  MockTse,
  type Category,
  type Device,
  type Order,
  type Product,
  type Store,
  type Tenant,
  type TransactionContext,
  type User,
} from "@kp/core";
import { openTestDb, type TestDb } from "./testing/nodeDb.ts";
import { ensureSeeded } from "../state/seed.ts";
import {
  applyStockMovement,
  countProductsInCategory,
  deactivateCategory,
  deactivateProduct,
  getDevice,
  getOrder,
  getStore,
  getTenant,
  listCategories,
  listOpenForClosing,
  listProducts,
  listRecentOrders,
  listStockMovements,
  listTseIncidents,
  listUsers,
  nextSequence,
  peekSequence,
  saveCategory,
  saveClosing,
  saveDevice,
  saveOrder,
  saveProduct,
  saveTenant,
  upsertOutboxEntry,
  countOutbox,
  loadOutbox,
} from "./repositories.ts";

const NOW = "2026-09-26T09:00:00+02:00";
let counter = 0;
const newId = (): string => `id-${++counter}`;

/** Frische Kasse mit Ersteinrichtung, wie beim ersten Start der App. */
async function setup(): Promise<{
  db: TestDb;
  tenant: Tenant;
  store: Store;
  device: Device;
  user: User;
  products: Product[];
  categories: Category[];
}> {
  counter = 0;
  const db = openTestDb();
  await ensureSeeded(db, NOW, newId);

  const tenant = (await getTenant(db))!;
  // Die Ersteinrichtung legt Platzhalter an - der Betrieb fuellt sie aus.
  await saveTenant(db, {
    ...tenant,
    name: "Kiosk am Markt",
    legalName: "Petra Beispiel",
    street: "Marktweg 3",
    postalCode: "24103",
    city: "Kiel",
    taxNumber: "20/123/45678",
  });

  // Die Ersteinrichtung laesst die TSE bewusst unkonfiguriert - die App warnt
  // darauf hin. Fuer die Ablauftests wird sie eingerichtet, damit die Belege
  // signiert sind; der Ausfallfall hat seinen eigenen Test.
  const device = (await getDevice(db))!;
  await saveDevice(db, { ...device, tseClientId: "client-1", serialNumber: "KASSE-0001" });

  return {
    db,
    tenant: (await getTenant(db))!,
    store: (await getStore(db))!,
    device: (await getDevice(db))!,
    user: (await listUsers(db))[0]!,
    products: await listProducts(db),
    categories: await listCategories(db),
  };
}

function context(base: Awaited<ReturnType<typeof setup>>, clock = fixedClock("2026-09-26T09:00:00Z")): TransactionContext {
  return {
    tenant: base.tenant,
    store: base.store,
    device: base.device,
    user: base.user,
    clock,
    newId,
    tse: new MockTse({ clock }),
  };
}

/** Verkauf durchfuehren und speichern - der Weg, den `pay()` in der App geht. */
async function sell(
  base: Awaited<ReturnType<typeof setup>>,
  ctx: TransactionContext,
  build: (cart: ReturnType<typeof emptyCart>) => ReturnType<typeof emptyCart>,
  payment: { method: "CASH" | "CARD_DEBIT"; tendered?: number },
): Promise<Order> {
  const products = await listProducts(base.db);
  const deposits = createDepositCatalog(products);

  const open = await beginTransaction(ctx);
  const cart = build(emptyCart(base.tenant.id, "TAKEAWAY"));
  const total = cartTotals(cart, { deposits }).total;

  const sequence = await nextSequence(base.db, base.device.id, "receipt");
  const { order } = await finishTransaction(
    ctx,
    open,
    cart,
    [{ method: payment.method, amount: total, ...(payment.method === "CASH" ? { tendered: payment.tendered ?? total } : {}) }],
    { sequence, deposits },
  );
  await saveOrder(base.db, order);
  await upsertOutboxEntry(base.db, {
    key: outboxKey("order", order.id),
    kind: "order",
    entityId: order.id,
    tenantId: order.tenantId,
    payload: JSON.stringify(order),
    createdAt: order.paidAt ?? order.startedAt,
    attempts: 0,
    nextAttemptAt: order.paidAt ?? order.startedAt,
    lastError: null,
  });

  // Bestand fortschreiben, wie es die App nach dem Speichern tut.
  for (const result of movementsForOrder(order, products, { newId, userId: base.user.id })) {
    await applyStockMovement(base.db, result.movement);
  }
  return order;
}

function find(products: readonly Product[], name: string): Product {
  const product = products.find((item) => item.name === name);
  if (!product) throw new Error(`Artikel "${name}" fehlt - die Ersteinrichtung hat sich geaendert`);
  return product;
}

// --- Ersteinrichtung ------------------------------------------------------

test("Ersteinrichtung liefert eine arbeitsfaehige Kasse mit Untergruppen", async () => {
  const base = await setup();
  try {
    assert.ok(base.tenant && base.store && base.device && base.user);
    assert.equal(base.device.receiptPrefix, "K1");

    const tree = buildCategoryTree(base.categories, base.products);
    const flat = flattenCategoryTree(tree);
    // Getraenke hat Untergruppen - der Baum ist nicht flach.
    const getraenke = tree.find((node) => node.category.name === "Getraenke");
    assert.ok(getraenke, "Warengruppe Getraenke fehlt");
    assert.ok(getraenke!.children.length >= 2, "Getraenke braucht Untergruppen");
    assert.ok(flat.some((node) => node.depth === 1), "es gibt eine zweite Ebene");

    const kaffee = find(base.products, "Kaffee");
    assert.equal(formatCategoryPath(base.categories, kaffee.categoryId), "Getraenke › Heissgetraenke");

    // Pfandartikel sind angelegt und haengen an den richtigen Artikeln.
    assert.equal(kaffee.depositProductIds?.length, 2, "Becher und Deckel");
    const deposits = createDepositCatalog(base.products);
    assert.equal(deposits.for(kaffee.id).length, 2);
    assert.ok(deposits.all().length >= 4, "mehrere Pfandartikel anlegbar");

    // Bestandsfuehrung nur dort, wo sie Sinn hat.
    assert.equal(find(base.products, "Limonade 0,5 l").trackStock, true);
    assert.equal(find(base.products, "Kaffee").trackStock, false, "Kaffee aus der Maschine zaehlt man nicht");
  } finally {
    base.db.close();
  }
});

// --- Artikel anlegen -----------------------------------------------------

test("Artikel anlegen, aendern und ausblenden", async () => {
  const base = await setup();
  try {
    const kalt = base.categories.find((category) => category.name === "Kaltgetraenke")!;
    const neu: Product = {
      id: newId(),
      tenantId: base.tenant.id,
      categoryId: kalt.id,
      name: "Apfelschorle 0,33 l",
      description: null,
      price: 220,
      taxKey: 1,
      taxKeyDineIn: null,
      sku: null,
      unit: "PIECE",
      depositProductIds: [find(base.products, "Flaschenpfand").id],
      isDeposit: false,
      color: null,
      image: {
        url: "https://example.invalid/schorle.jpg",
        license: "CC BY-SA 3.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
        creator: "Open Food Facts",
        sourceUrl: "https://example.invalid/produkt",
        provider: "openfoodfacts",
      },
      trackStock: true,
      stock: 0,
      lowStockThreshold: 6 * ONE,
      sortOrder: 5,
      active: true,
      updatedAt: NOW,
    };
    await saveProduct(base.db, neu);

    const reloaded = find(await listProducts(base.db), "Apfelschorle 0,33 l");
    assert.equal(reloaded.price, 220);
    assert.equal(reloaded.depositProductIds?.length, 1);
    assert.equal(reloaded.image?.license, "CC BY-SA 3.0", "die Lizenz ueberlebt den Weg durch die Datenbank");
    assert.equal(reloaded.trackStock, true);
    assert.equal(reloaded.lowStockThreshold, 6 * ONE);

    // Preis aendern: der Artikel wird ueberschrieben, nicht dupliziert.
    await saveProduct(base.db, { ...reloaded, price: 240, updatedAt: "2026-09-27T09:00:00+02:00" });
    const afterChange = (await listProducts(base.db)).filter((p) => p.name === "Apfelschorle 0,33 l");
    assert.equal(afterChange.length, 1);
    assert.equal(afterChange[0]?.price, 240);

    // Ausblenden statt loeschen.
    await deactivateProduct(base.db, reloaded.id);
    assert.equal((await listProducts(base.db)).some((p) => p.id === reloaded.id), false);
    assert.equal((await listProducts(base.db, true)).some((p) => p.id === reloaded.id), true, "im Bestand bleibt er");
  } finally {
    base.db.close();
  }
});

test("Artikelbild ohne Lizenzangabe kommt nicht in die Datenbank", async () => {
  const base = await setup();
  try {
    const kalt = base.categories.find((category) => category.name === "Kaltgetraenke")!;
    const broken = {
      ...find(base.products, "Limonade 0,5 l"),
      id: newId(),
      name: "Ohne Lizenz",
      categoryId: kalt.id,
      // Ein Bild ohne Lizenz - der CHECK im Schema muss das ablehnen.
      image: { url: "https://example.invalid/bild.jpg", license: "" } as never,
    };
    await assert.rejects(() => saveProduct(base.db, broken));
  } finally {
    base.db.close();
  }
});

test("Warengruppe ausblenden hebt Untergruppen nach oben", async () => {
  const base = await setup();
  try {
    const getraenke = base.categories.find((c) => c.name === "Getraenke")!;
    assert.ok((await countProductsInCategory(base.db, getraenke.id)) === 0, "Getraenke selbst ist leer");

    await deactivateCategory(base.db, getraenke.id);
    const after = await listCategories(base.db);
    assert.equal(after.some((c) => c.id === getraenke.id), false);
    const heiss = after.find((c) => c.name === "Heissgetraenke")!;
    assert.equal(heiss.parentId, null, "die Untergruppe ist jetzt auf der obersten Ebene");

    // Und ihre Artikel sind weiter erreichbar - genau das ist der Zweck.
    const tree = buildCategoryTree(after, await listProducts(base.db));
    assert.ok(flattenCategoryTree(tree).some((node) => node.category.id === heiss.id && node.productCount > 0));
  } finally {
    base.db.close();
  }
});

test("Obergrenze je Warengruppe wird durchgesetzt und erklaert", async () => {
  const base = await setup();
  try {
    const kalt = base.categories.find((c) => c.name === "Kaltgetraenke")!;
    const many: Product[] = Array.from({ length: 200 }, (_, index) => ({
      ...find(base.products, "Limonade 0,5 l"),
      id: `fill-${index}`,
      name: `Artikel ${index}`,
      categoryId: kalt.id,
      depositProductIds: null,
    }));
    const allowed = canAddProduct(many, kalt.id);
    assert.equal(allowed.ok, false);
    assert.ok(allowed.ok === false && allowed.reason.includes("Untergruppen"), "der Hinweis sagt, was stattdessen geht");
  } finally {
    base.db.close();
  }
});

// --- Artikeleingabe und Verkauf ------------------------------------------

test("Artikeleingabe und Barzahlung mit Rueckgeld", async () => {
  const base = await setup();
  try {
    const clock = fixedClock("2026-09-26T09:00:00Z");
    const ctx = context(base, clock);
    const kaffee = find(base.products, "Kaffee");

    const order = await sell(base, ctx, (cart) => addProduct(cart, kaffee, { id: newId(), quantity: 2 * ONE }), {
      method: "CASH",
      tendered: 1000,
    });

    // 2 x 2,50 Kaffee + 2 x (1,00 Becher + 0,30 Deckel) Pfand = 7,60
    assert.equal(order.total, 500 + 260);
    assert.equal(order.payments[0]?.change, 1000 - 760);
    assert.equal(order.receiptNumber, "K1-000001");
    assert.ok(isTseSecured(order));

    // Der Beleg steht vollstaendig in der Datenbank.
    const stored = await getOrder(base.db, order.id);
    assert.ok(stored);
    assert.equal(stored!.total, order.total);
    assert.equal(stored!.lines.length, 3, "Kaffee, Becher, Deckel");
    assert.equal(stored!.payments.length, 1);
    assert.equal(stored!.tse?.signature, order.tse?.signature);

    // Und der Bon laesst sich daraus erzeugen.
    const view = buildReceiptView(stored!, { tenant: base.tenant, store: base.store, device: base.device });
    const text = renderReceiptText(view, 42);
    assert.ok(text.includes("Kiosk am Markt"));
    assert.ok(text.includes("7,60"));
    assert.ok(text.includes("darin Pfand"));
    assert.ok(view.qrPayload, "der Beleg hat einen Pruef-QR-Code");
  } finally {
    base.db.close();
  }
});

test("im Haus statt ausser Haus verschiebt den Steuersatz, nicht den Preis", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const crepe = find(base.products, "Crepe Zucker & Zimt");
    const order = await sell(base, ctx, (cart) => setServiceMode(addProduct(cart, crepe, { id: newId() }), "DINE_IN"), {
      method: "CARD_DEBIT",
    });
    assert.equal(order.total, 450);
    assert.equal(order.serviceMode, "DINE_IN");
    assert.equal(order.lines[0]?.taxKey, 1, "vor Ort 19 Prozent");
  } finally {
    base.db.close();
  }
});

test("Belegnummern laufen lueckenlos weiter, auch nach einem Neustart", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const kaffee = find(base.products, "Kaffee");
    for (let i = 0; i < 3; i++) {
      await sell(base, ctx, (cart) => addProduct(cart, kaffee, { id: newId() }), { method: "CASH" });
    }
    assert.equal(await peekSequence(base.db, base.device.id, "receipt"), 3);

    // "Neustart": die Nummer kommt aus der Datenbank, nicht aus dem Speicher.
    const next = await nextSequence(base.db, base.device.id, "receipt");
    assert.equal(next, 4);

    const numbers = (await listRecentOrders(base.db, base.device.id)).map((order) => order.receiptNumber);
    assert.deepEqual(numbers, ["K1-000003", "K1-000002", "K1-000001"]);
  } finally {
    base.db.close();
  }
});

// --- Pfand ---------------------------------------------------------------

test("Pfandausgabe: Becher zurueck, Geld raus", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const products = await listProducts(base.db);
    const becher = find(products, "Becher");

    const order = await sell(
      base,
      ctx,
      (cart) =>
        addDepositReturn(cart, { productId: becher.id, name: becher.name, price: becher.price!, taxKey: becher.taxKey }, {
          id: newId(),
          quantity: 3 * ONE,
        }),
      { method: "CASH" },
    );

    assert.equal(order.total, -300, "drei Becher zu 1,00 werden ausgezahlt");
    assert.equal(order.lines[0]?.businessCaseType, "PfandRueckzahlung");
    assert.ok(isTseSecured(order), "auch eine Auszahlung ist ein Geschaeftsvorfall");

    const stored = await getOrder(base.db, order.id);
    assert.equal(stored!.total, -300);
    assert.equal(stored!.payments[0]?.amount, -300);
  } finally {
    base.db.close();
  }
});

test("Verkauf mit Pfand und Ruecknahme im selben Beleg saldieren", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const products = await listProducts(base.db);
    const kaffee = find(products, "Kaffee");
    const becher = find(products, "Becher");

    const order = await sell(
      base,
      ctx,
      (cart) => {
        const withGoods = addProduct(cart, kaffee, { id: newId() });
        return addDepositReturn(
          withGoods,
          { productId: becher.id, name: becher.name, price: becher.price!, taxKey: becher.taxKey },
          { id: newId() },
        );
      },
      { method: "CASH" },
    );

    // Kaffee 2,50 + Becher 1,00 + Deckel 0,30 - Becher zurueck 1,00 = 2,80
    assert.equal(order.total, 250 + 130 - 100);
  } finally {
    base.db.close();
  }
});

test("eigener Becher: Pfand wird nicht berechnet", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const kaffee = find(base.products, "Kaffee");
    const order = await sell(base, ctx, (cart) => addProduct(cart, kaffee, { id: newId(), waiveDeposit: true }), {
      method: "CASH",
    });
    assert.equal(order.total, 250);
    assert.equal(order.lines.length, 1, "keine Pfandposition");
  } finally {
    base.db.close();
  }
});

// --- Storno und Barauszahlung -------------------------------------------

test("Vollstorno zahlt aus und hebt den Beleg auf", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const kaffee = find(base.products, "Kaffee");
    const order = await sell(base, ctx, (cart) => addProduct(cart, kaffee, { id: newId(), quantity: 2 * ONE }), {
      method: "CASH",
    });

    const products = await listProducts(base.db);
    const deposits = createDepositCatalog(products);
    const voidCart = buildVoidCart(order);
    const total = cartTotals(voidCart, { deposits }).total;
    assert.equal(total, -order.total);

    const open = await beginTransaction(ctx);
    const sequence = await nextSequence(base.db, base.device.id, "receipt");
    const { order: storno } = await finishTransaction(ctx, open, voidCart, [{ method: "CASH", amount: total }], {
      sequence, deposits, note: `Storno zu ${order.receiptNumber}`,
    });
    await saveOrder(base.db, { ...storno, voidsOrderId: order.id });

    const stored = await getOrder(base.db, storno.id);
    assert.equal(stored!.total, -order.total);
    assert.equal(stored!.voidsOrderId, order.id);
    assert.notEqual(stored!.receiptNumber, order.receiptNumber, "eigener Nummernkreis-Eintrag");
  } finally {
    base.db.close();
  }
});

test("Teilstorno: eine von drei Flaschen zurueck, Bargeld anteilig raus", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const limo = find(base.products, "Limonade 0,5 l");

    // Bestand auffuellen, damit der Verkauf nicht negativ laeuft.
    const receipt = buildMovement({
      id: newId(), product: limo, storeId: base.store.id, userId: base.user.id,
      quantity: 24 * ONE, reason: "PURCHASE", createdAt: NOW,
    });
    await applyStockMovement(base.db, receipt.movement);

    const order = await sell(base, ctx, (cart) => addProduct(cart, limo, { id: newId(), quantity: 3 * ONE }), {
      method: "CASH",
    });
    // 3 x 2,50 + 3 x 0,25 Pfand
    assert.equal(order.total, 750 + 75);

    const limoLine = order.lines.find((line) => line.productId === limo.id)!;
    const partial = buildPartialVoidCart(order, [{ lineId: limoLine.id, quantity: ONE }]);
    const products = await listProducts(base.db);
    const deposits = createDepositCatalog(products);
    const total = cartTotals(partial, { deposits }).total;
    assert.equal(total, -275, "eine Flasche 2,50 plus 0,25 Pfand");

    const open = await beginTransaction(ctx);
    const sequence = await nextSequence(base.db, base.device.id, "receipt");
    const { order: storno } = await finishTransaction(ctx, open, partial, [{ method: "CASH", amount: total }], {
      sequence, deposits, note: `Teilstorno zu ${order.receiptNumber}`,
    });
    await saveOrder(base.db, { ...storno, voidsOrderId: order.id });

    // Bestand kommt zurueck: 24 - 3 + 1 = 22
    for (const result of movementsForOrder({ ...storno, voidsOrderId: order.id }, await listProducts(base.db), {
      newId, userId: base.user.id,
    })) {
      await applyStockMovement(base.db, result.movement);
    }
    assert.equal(find(await listProducts(base.db), "Limonade 0,5 l").stock, 22 * ONE);
  } finally {
    base.db.close();
  }
});

test("ein bezahlter Beleg laesst sich nicht aendern oder loeschen", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const order = await sell(base, ctx, (cart) => addProduct(cart, find(base.products, "Kaffee"), { id: newId() }), {
      method: "CASH",
    });

    // Der Trigger im Schema haelt das ab, nicht nur die Anwendung.
    assert.throws(() =>
      base.db.handle.prepare("UPDATE sales_order SET total = 1 WHERE id = ?").run(order.id),
    );
    assert.throws(() => base.db.handle.prepare("DELETE FROM sales_order WHERE id = ?").run(order.id));
    assert.throws(() => base.db.handle.prepare("DELETE FROM order_line WHERE order_id = ?").run(order.id));

    // Die Zuordnung zu einem Kassenabschluss ist die eine erlaubte Aenderung.
    assert.doesNotThrow(() =>
      base.db.handle.prepare("UPDATE sales_order SET closing_id = 'z1' WHERE id = ?").run(order.id),
    );
  } finally {
    base.db.close();
  }
});

// --- Bestand -------------------------------------------------------------

test("Bestand: Wareneingang, Verkauf, Zaehlung, Schwund", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const limo = find(base.products, "Limonade 0,5 l");
    assert.equal(limo.stock, 0);

    // Wareneingang 24 Flaschen
    const purchase = buildMovement({
      id: newId(), product: limo, storeId: base.store.id, userId: base.user.id,
      quantity: 24 * ONE, reason: "PURCHASE", note: "Markt, Rechnung 4711", createdAt: NOW,
    });
    await applyStockMovement(base.db, purchase.movement);
    assert.equal(find(await listProducts(base.db), "Limonade 0,5 l").stock, 24 * ONE);

    // Verkauf von fuenf
    await sell(base, ctx, (cart) => addProduct(cart, limo, { id: newId(), quantity: 5 * ONE }), { method: "CASH" });
    let current = find(await listProducts(base.db), "Limonade 0,5 l");
    assert.equal(current.stock, 19 * ONE);
    assert.equal(stockState(current), "OK");

    // Schwund: zwei zerbrochen
    const loss = buildMovement({
      id: newId(), product: current, storeId: base.store.id, userId: base.user.id,
      quantity: -2 * ONE, reason: "LOSS", note: "Kiste gefallen", createdAt: NOW,
    });
    await applyStockMovement(base.db, loss.movement);
    current = find(await listProducts(base.db), "Limonade 0,5 l");
    assert.equal(current.stock, 17 * ONE);

    // Zaehlung ergibt 15 - die Differenz wird gebucht, nicht der Zielwert.
    const correction = buildCountCorrection({
      id: newId(), product: current, storeId: base.store.id, userId: base.user.id,
      countedStock: 15 * ONE, createdAt: NOW,
    });
    assert.ok(correction);
    assert.equal(correction!.movement.quantity, -2 * ONE);
    await applyStockMovement(base.db, correction!.movement);
    current = find(await listProducts(base.db), "Limonade 0,5 l");
    assert.equal(current.stock, 15 * ONE);

    // Das Journal erklaert den Weg von 24 auf 15.
    const journal = await listStockMovements(base.db, { productId: limo.id });
    assert.deepEqual(
      journal.map((movement) => movement.reason),
      ["COUNT", "LOSS", "SALE", "PURCHASE"],
      "neueste zuerst",
    );
    assert.equal(journal.reduce((sum, movement) => sum + movement.quantity, 0), 15 * ONE, "die Summe ist der Bestand");

    // Eine Bewegung ist unveraenderlich.
    assert.throws(() => base.db.handle.prepare("UPDATE stock_movement SET quantity = 0").run());
    assert.throws(() => base.db.handle.prepare("DELETE FROM stock_movement").run());
  } finally {
    base.db.close();
  }
});

test("Warnung bei knappem Bestand, Verkauf laeuft trotzdem ins Negative", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const limo = find(base.products, "Limonade 0,5 l");
    const purchase = buildMovement({
      id: newId(), product: limo, storeId: base.store.id, userId: base.user.id,
      quantity: 4 * ONE, reason: "PURCHASE", createdAt: NOW,
    });
    await applyStockMovement(base.db, purchase.movement);

    let current = find(await listProducts(base.db), "Limonade 0,5 l");
    assert.equal(stockState(current), "LOW", "unter dem Mindestbestand von 6");
    assert.ok(lowStockProducts(await listProducts(base.db)).some((p) => p.id === limo.id));

    // Der Kunde nimmt sechs, obwohl nur vier gezaehlt sind - die Kasse
    // kassiert und weist den negativen Bestand aus.
    await sell(base, ctx, (cart) => addProduct(cart, current, { id: newId(), quantity: 6 * ONE }), { method: "CASH" });
    current = find(await listProducts(base.db), "Limonade 0,5 l");
    assert.equal(current.stock, -2 * ONE);
    assert.equal(stockState(current), "NEGATIVE");
  } finally {
    base.db.close();
  }
});

// --- Kassenoeffnung, Kassenbuch, Abschluss -------------------------------

test("Tag eroeffnen, Entnahme, Abschluss mit Zaehlprotokoll", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const kaffee = find(base.products, "Kaffee");

    // Tag eroeffnen: 50 Euro Wechselgeld gezaehlt.
    const opening = openDay({
      id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      userId: base.user.id, createdAt: "2026-09-26T07:30:00+02:00",
      cashCount: [{ denomination: 2000, count: 2 }, { denomination: 500, count: 2 }],
    });
    assert.equal(opening.amount, 5000);

    // Zwei Verkaeufe bar: je 2,50 + 1,30 Pfand = 3,80
    await sell(base, ctx, (cart) => addProduct(cart, kaffee, { id: newId() }), { method: "CASH" });
    await sell(base, ctx, (cart) => addProduct(cart, kaffee, { id: newId() }), { method: "CASH" });

    // Entnahme 20 Euro fuer den Einkauf.
    const withdrawal = buildCashMovement({
      id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      userId: base.user.id, createdAt: "2026-09-26T12:00:00+02:00",
      type: "WITHDRAWAL", amount: 2000, reason: "Einkauf Markt",
    });

    const orders = await listOpenForClosing(base.db, base.device.id);
    assert.equal(orders.length, 2);

    // Soll: 50,00 + 7,60 - 20,00 = 37,60
    const expected = 5000 + 760 - 2000;
    const report = buildClosing({
      tenant: base.tenant, store: base.store, device: base.device, userId: base.user.id,
      closingId: newId(), number: await nextSequence(base.db, base.device.id, "closing"),
      from: orders[0]!.startedAt, to: "2026-09-26T22:00:00+02:00", createdAt: "2026-09-26T22:00:05+02:00",
      orders, cashMovements: [opening, withdrawal],
      cashCount: [{ denomination: 2000, count: 1 }, { denomination: 1000, count: 1 }, { denomination: 500, count: 1 }, { denomination: 200, count: 1 }, { denomination: 50, count: 1 }, { denomination: 10, count: 1 }],
    });

    assert.equal(report.closing.openingCash, 5000);
    assert.equal(report.expectedCash, expected);
    assert.equal(report.countedCash, countCash(report.closing.cashCount));
    assert.equal(report.cashDifference, 0, `gezaehlt ${report.countedCash}, erwartet ${expected}`);
    assert.equal(report.unsecuredOrderCount, 0);
    assert.equal(report.depositCharged, 260);
    assert.equal(report.salesTotal, 500);

    await saveClosing(base.db, report.closing, JSON.stringify(report));
    // Danach sind die Belege zugeordnet und tauchen nicht wieder auf.
    assert.deepEqual(await listOpenForClosing(base.db, base.device.id), []);
  } finally {
    base.db.close();
  }
});

test("DSFinV-K-Export entsteht aus den Daten der Datenbank", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    await sell(base, ctx, (cart) => addProduct(cart, find(base.products, "Kaffee"), { id: newId() }), { method: "CASH" });
    await sell(base, ctx, (cart) => addProduct(cart, find(base.products, "Crepe Nutella"), { id: newId() }), { method: "CARD_DEBIT" });

    const orders = await listOpenForClosing(base.db, base.device.id);
    const report = buildClosing({
      tenant: base.tenant, store: base.store, device: base.device, userId: base.user.id,
      closingId: newId(), number: 1, from: orders[0]!.startedAt, to: "2026-09-26T22:00:00+02:00",
      createdAt: "2026-09-26T22:00:05+02:00", orders,
    });

    const files = buildExport({ tenant: base.tenant, store: base.store, device: base.device, closings: [{ report, orders }] });
    const names = files.map((file) => file.name);
    assert.ok(names.includes("cashpointclosing.csv"));
    assert.ok(names.includes("lines.csv"));
    assert.ok(names.includes("index.xml"));

    const lines = files.find((file) => file.name === "lines.csv")!.content;
    assert.ok(lines.includes("Kaffee"));
    assert.ok(lines.includes("Pfand"), "die Pfandposition steht als eigene Zeile");
    // Jede Zeile hat gleich viele Felder.
    const widths = new Set(
      lines.split("\r\n").filter((line) => line !== "").map((line) => (line.match(/"((?:[^"]|"")*)"/g) ?? []).length),
    );
    assert.equal(widths.size, 1, `unterschiedliche Feldzahlen: ${[...widths].join(", ")}`);
  } finally {
    base.db.close();
  }
});

// --- TSE-Ausfall ---------------------------------------------------------

test("TSE-Ausfall: Verkauf laeuft weiter, Ausfall wird protokolliert", async () => {
  const base = await setup();
  try {
    const clock = fixedClock("2026-09-26T09:00:00Z");
    const ctx: TransactionContext = { ...context(base, clock), tse: new MockTse({ clock, available: false }) };
    const order = await sell(base, ctx, (cart) => addProduct(cart, find(base.products, "Kaffee"), { id: newId() }), {
      method: "CASH",
    });

    assert.equal(order.state, "PAID", "kassiert wird trotzdem");
    assert.equal(isTseSecured(order), false);

    const incidents = await listTseIncidents(base.db);
    assert.equal(incidents.length, 1, "der Ausfall steht im Protokoll");
    assert.ok(incidents[0]?.reason.includes("nicht erreichbar"));

    const view = buildReceiptView((await getOrder(base.db, order.id))!, {
      tenant: base.tenant, store: base.store, device: base.device,
    });
    assert.equal(view.qrPayload, null, "kein QR-Code ohne Signatur");
    assert.ok(renderReceiptText(view).includes("Sicherheitseinrichtung ausgefallen"));
  } finally {
    base.db.close();
  }
});

// --- Outbox und Bondruck -------------------------------------------------

test("jeder Beleg landet genau einmal in der Outbox", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const kaffee = find(base.products, "Kaffee");
    const order = await sell(base, ctx, (cart) => addProduct(cart, kaffee, { id: newId() }), { method: "CASH" });
    await sell(base, ctx, (cart) => addProduct(cart, kaffee, { id: newId() }), { method: "CASH" });

    assert.equal(await countOutbox(base.db), 2);
    const outbox = await loadOutbox(base.db);
    assert.deepEqual(outbox.entries.map((entry) => entry.kind), ["order", "order"]);

    // Zweimal derselbe Beleg bleibt ein Eintrag.
    await upsertOutboxEntry(base.db, { ...outbox.entries[0]!, payload: JSON.stringify(order) });
    assert.equal(await countOutbox(base.db), 2);
  } finally {
    base.db.close();
  }
});

test("Bondruck erzeugt gueltige ESC/POS-Bytes mit QR-Code", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const order = await sell(base, ctx, (cart) => addProduct(cart, find(base.products, "Kaffee"), { id: newId() }), {
      method: "CASH", tendered: 1000,
    });
    const view = buildReceiptView((await getOrder(base.db, order.id))!, {
      tenant: base.tenant, store: base.store, device: base.device,
    });

    for (const width of [32, 42] as const) {
      const bytes = buildReceiptCommands(view, { width, openDrawer: true });
      assert.ok(bytes.length > 500, `zu wenig Daten fuer ${width} Zeichen`);
      // Beginnt mit dem Zuruecksetzen und der Codepage.
      assert.deepEqual([...bytes.subarray(0, 5)], [0x1b, 0x40, 0x1b, 0x74, 19]);
      // Enthaelt ein Rasterbild (GS v 0) fuer den QR-Code.
      assert.ok(containsSequence(bytes, [0x1d, 0x76, 0x30, 0x00]), "QR-Code fehlt");
      // Schublade und Schnitt am Ende.
      assert.ok(containsSequence(bytes, [0x1b, 0x70, 0x00]), "Schubladenimpuls fehlt");
      assert.ok(containsSequence(bytes, [0x1d, 0x56, 0x42, 0x00]), "Schnitt fehlt");
      // Der Euro als Codepage-858-Byte 213, nicht als Fragezeichen.
      assert.ok([...bytes].includes(213), "Euro-Zeichen fehlt");
    }
  } finally {
    base.db.close();
  }
});

function containsSequence(haystack: Uint8Array, needle: readonly number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
