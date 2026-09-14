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
import { deflateSync } from "node:zlib";
import {
  NO_ATTEMPTS,
  ONE,
  attemptLogin,
  buildAuditEntry,
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
  parkSale,
  prepareEmail,
  prepareSms,
  recordDelivery,
  resumeSale,
  hashPin,
  summarizeAudit,
  summarizeCashbook,
  userCan,
  withCapability,
  renderReceiptText,
  sequentialIds,
  setServiceMode,
  stockState,
  MockTse,
  assignProduct,
  base64ToBytes,
  bookGoodsReceipt,
  checkInvoice,
  extractInvoiceXml,
  parseInvoiceXml,
  planGoodsReceipt,
  type AuditEvent,
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
  appendAudit,
  appendCashMovement,
  appendDelivery,
  applyStockMovement,
  countProductsInCategory,
  deactivateCategory,
  deactivateProduct,
  deleteParkedSale,
  getDevice,
  getLoginAttempts,
  getUser,
  getOrder,
  getStore,
  getTenant,
  listAudit,
  listCashMovements,
  listCategories,
  listDeliveries,
  listOpenCashMovements,
  listOpenForClosing,
  listParkedSales,
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
  saveLoginAttempts,
  saveOrder,
  saveParkedSale,
  saveUser,
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

// --- Anmeldung mit PIN ----------------------------------------------------

test("PIN setzen, anmelden und die falsche PIN abweisen", async () => {
  const base = await setup();
  try {
    // Die Ersteinrichtung legt den Inhaber ohne PIN an: beim ersten Start soll
    // niemand ausgesperrt sein, der die Kasse gerade aufbaut.
    assert.equal(base.user.pinHash, null);
    const fresh = await getLoginAttempts(base.db, base.user.id, base.device.id);
    assert.deepEqual(fresh, NO_ATTEMPTS);
    assert.equal(attemptLogin(base.user, "1234", fresh, NOW).result, "NO_PIN_SET");

    // Wenige Runden im Test: 60.000 Runden je Anmeldeversuch wuerden die
    // Testlaufzeit bestimmen, nicht die Aussage. In der App gilt PIN_ITERATIONS.
    await saveUser(base.db, { ...base.user, pinHash: hashPin("4711", { iterations: 1000 }) }, { pinSetAt: NOW });
    const withPin = (await getUser(base.db, base.user.id))!;
    assert.ok(withPin.pinHash?.startsWith("pbkdf2$sha256$1000$"), "die Rundenzahl steht im Hash");
    assert.ok(!withPin.pinHash?.includes("4711"), "die PIN selbst steht nirgends");

    assert.equal(attemptLogin(withPin, "4711", NO_ATTEMPTS, NOW).result, "OK");
    const wrong = attemptLogin(withPin, "0000", NO_ATTEMPTS, NOW);
    assert.equal(wrong.result, "WRONG_PIN");
    assert.equal(wrong.state.failedAttempts, 1);
  } finally {
    base.db.close();
  }
});

test("fuenf Fehlversuche sperren, die Sperre ueberlebt den Neustart", async () => {
  const base = await setup();
  try {
    await saveUser(base.db, { ...base.user, pinHash: hashPin("4711", { iterations: 1000 }) }, { pinSetAt: NOW });
    const user = (await getUser(base.db, base.user.id))!;

    let state = await getLoginAttempts(base.db, user.id, base.device.id);
    let outcome = attemptLogin(user, "0000", state, NOW);
    for (let attempt = 1; attempt <= 5; attempt++) {
      outcome = attemptLogin(user, "0000", state, NOW);
      state = outcome.state;
      await saveLoginAttempts(base.db, user.id, base.device.id, state, NOW);
    }
    assert.equal(outcome.result, "LOCKED", "der fuenfte Fehlversuch sperrt");

    // Die Sperre steht in der Datenbank, nicht im Arbeitsspeicher: ein
    // Neustart der App darf sie nicht aufheben - sonst ist sie wertlos.
    const stored = await getLoginAttempts(base.db, user.id, base.device.id);
    assert.ok(stored.lockedUntil, "die Sperre ist gespeichert");
    // Nach der Sperre stehen wieder volle Versuche zur Verfuegung, aber die
    // naechste Sperre dauert laenger - das haelt `lockCount` fest.
    assert.equal(stored.failedAttempts, 0);
    assert.equal(stored.lockCount, 1);
    assert.equal(attemptLogin(user, "4711", stored, NOW).result, "LOCKED", "auch die richtige PIN kommt jetzt nicht durch");

    // Nach Ablauf der Sperre zaehlt die richtige PIN wieder.
    const later = "2026-09-26T09:01:00+02:00";
    const afterLock = attemptLogin(user, "4711", stored, later);
    assert.equal(afterLock.result, "OK");
    await saveLoginAttempts(base.db, user.id, base.device.id, afterLock.state, later);
    assert.deepEqual(await getLoginAttempts(base.db, user.id, base.device.id), NO_ATTEMPTS);
  } finally {
    base.db.close();
  }
});

test("ein deaktivierter Zugang loest keine Sperre aus", async () => {
  const base = await setup();
  try {
    // Sonst koennte ein ausgeschiedener Mitarbeiter mit seiner alten PIN den
    // Zugang eines aktiven Bedieners sperren.
    const gone = { ...base.user, pinHash: hashPin("4711", { iterations: 1000 }), active: false };
    const outcome = attemptLogin(gone, "0000", NO_ATTEMPTS, NOW);
    assert.equal(outcome.result, "INACTIVE");
    assert.equal(outcome.state.failedAttempts, 0);
  } finally {
    base.db.close();
  }
});

test("Rechteabweichung ueberlebt das Speichern und wirkt", async () => {
  const base = await setup();
  try {
    // Der Fall, den ein Betrieb wirklich hat: eine Aushilfe darf Artikel
    // pflegen, aber weiterhin nicht stornieren.
    const helper: User = {
      id: newId(), tenantId: base.tenant.id, name: "Aushilfe Lena",
      role: "CASHIER", active: true, pinHash: null, permissionOverrides: null,
    };
    await saveUser(base.db, helper);
    const granted = withCapability((await getUser(base.db, helper.id))!, "MANAGE_PRODUCTS", true);
    await saveUser(base.db, { ...helper, permissionOverrides: granted });

    const reloaded = (await getUser(base.db, helper.id))!;
    assert.equal(userCan(reloaded, "MANAGE_PRODUCTS"), true);
    assert.equal(userCan(reloaded, "VOID_RECEIPT"), false, "Storno bleibt gesperrt");
    assert.equal(userCan(reloaded, "SELL"), true, "Kassieren kann sie weiterhin");

    // Ein Recht, das die Rolle schon hat, wird nicht als Abweichung
    // gespeichert - sonst sammelt sich Datenmuell an, der bei einem
    // Rollenwechsel falsch weiterwirkt.
    assert.equal(withCapability(reloaded, "SELL", true)["SELL"], undefined);
  } finally {
    base.db.close();
  }
});

test("Bediener wird deaktiviert, nicht geloescht - und verliert damit alle Rechte", async () => {
  const base = await setup();
  try {
    const helper: User = {
      id: newId(), tenantId: base.tenant.id, name: "Aushilfe Tom",
      role: "MANAGER", active: true, pinHash: null, permissionOverrides: null,
    };
    await saveUser(base.db, helper);
    await saveUser(base.db, { ...helper, active: false });

    assert.equal((await listUsers(base.db)).some((item) => item.id === helper.id), false);
    const inactive = (await getUser(base.db, helper.id))!;
    assert.equal(inactive.active, false);
    assert.equal(userCan(inactive, "SELL"), false, "auch Kassieren ist weg");
    assert.ok((await listUsers(base.db, true)).some((item) => item.id === helper.id), "fuer alte Belege bleibt er lesbar");
  } finally {
    base.db.close();
  }
});

test("beschaedigte Rechteabweichungen lassen die Rolle gelten", async () => {
  const base = await setup();
  try {
    // Kein erfundener Fall: eine halb geschriebene Datei, ein abgebrochener
    // Abgleich. Wichtig ist die Richtung - im Zweifel gilt die Rolle, nicht
    // ein zufaellig erteiltes Recht.
    base.db.handle.exec(`UPDATE app_user SET permission_overrides = '{kaputt' WHERE id = '${base.user.id}'`);
    const user = (await getUser(base.db, base.user.id))!;
    assert.equal(user.permissionOverrides, null);
    assert.equal(userCan(user, "SELL"), true, "die Rolle wirkt weiter");

    base.db.handle.exec(`UPDATE app_user SET permission_overrides = '{"SELL":"ja"}' WHERE id = '${base.user.id}'`);
    assert.equal((await getUser(base.db, base.user.id))!.permissionOverrides, null);
  } finally {
    base.db.close();
  }
});

// --- Pruefprotokoll -------------------------------------------------------

test("Pruefprotokoll ist nur anfuegbar", async () => {
  const base = await setup();
  try {
    await appendAudit(base.db, buildAuditEntry({
      id: newId(), tenantId: base.tenant.id, deviceId: base.device.id,
      userId: base.user.id, userName: base.user.name, event: "RECEIPT_VOIDED",
      subject: "K1-000001", detail: "Storno auf Wunsch des Kunden", amount: -450,
      createdAt: NOW,
    }));

    assert.throws(() => base.db.handle.exec("UPDATE audit_log SET detail = 'war nicht ich'"), /nicht geaendert/);
    assert.throws(() => base.db.handle.exec("DELETE FROM audit_log"), /nicht geloescht/);

    const entries = await listAudit(base.db);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.event, "RECEIPT_VOIDED");
    assert.equal(entries[0]?.amount, -450);
    assert.equal(entries[0]?.userName, base.user.name);
  } finally {
    base.db.close();
  }
});

test("Protokoll filtert nach Ereignis und wertet Storni je Bediener aus", async () => {
  const base = await setup();
  try {
    const write = async (event: AuditEvent, userName: string, amount: number | null): Promise<void> => {
      await appendAudit(base.db, buildAuditEntry({
        id: newId(), tenantId: base.tenant.id, deviceId: base.device.id,
        userId: base.user.id, userName, event, amount, createdAt: NOW,
      }));
    };
    await write("LOGIN_OK", "Petra", null);
    await write("RECEIPT_VOIDED", "Lena", -1200);
    await write("RECEIPT_VOIDED", "Lena", -800);
    await write("RECEIPT_VOIDED", "Tom", -300);
    await write("LOGIN_FAILED", "Lena", null);

    assert.equal((await listAudit(base.db, { events: ["RECEIPT_VOIDED"] })).length, 3);

    const summary = summarizeAudit(await listAudit(base.db));
    assert.equal(summary.totalEntries, 5);
    assert.equal(summary.failedLogins, 1);
    // Nach Betrag sortiert: wer am meisten storniert hat, steht oben. Das ist
    // die Frage, die am Monatsende gestellt wird.
    assert.equal(summary.voidsByUser[0]?.userName, "Lena");
    assert.equal(summary.voidsByUser[0]?.amount, 2000);
    assert.equal(summary.voidsByUser[0]?.count, 2);
  } finally {
    base.db.close();
  }
});

test("ein Geheimnis kommt nicht ins Protokoll", async () => {
  const base = await setup();
  try {
    assert.throws(
      () => buildAuditEntry({
        id: newId(), tenantId: base.tenant.id, deviceId: base.device.id,
        event: "SETTINGS_CHANGED", detail: `PIN neu: ${hashPin("4711", { iterations: 1000 })}`,
        createdAt: NOW,
      }),
      /PIN-Pruefwert/,
    );
    assert.equal((await listAudit(base.db)).length, 0, "und zwar bevor etwas geschrieben wird");
  } finally {
    base.db.close();
  }
});

// --- Bons parken ----------------------------------------------------------

test("Vorgang parken, zwischendurch kassieren, dann fortsetzen", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const products = await listProducts(base.db);
    const deposits = createDepositCatalog(products);
    const kaffee = find(products, "Kaffee");

    // Erster Kunde ist erfasst, will aber noch etwas holen.
    const open = await beginTransaction(ctx);
    const cart = addProduct(emptyCart(base.tenant.id, "TAKEAWAY"), kaffee, { id: newId(), quantity: 2 * ONE });
    const total = cartTotals(cart, { deposits }).total;
    const parked = await parkSale({
      id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      userId: base.user.id, label: "Tisch 4", cart, open, parkedAt: NOW, total, existing: [],
      tse: ctx.tse, tseClientId: base.device.tseClientId, processData: "Bestellung",
    });
    await saveParkedSale(base.db, parked);

    // Zweiter Kunde bezahlt dazwischen.
    await sell(base, ctx, (c) => addProduct(c, kaffee, { id: newId() }), { method: "CASH" });

    const list = await listParkedSales(base.db, base.device.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.label, "Tisch 4");
    assert.equal(list[0]?.total, total);
    assert.equal(list[0]?.lineCount, 1);
    assert.equal(list[0]?.cart.lines[0]?.quantity, 2 * ONE, "der Warenkorb kommt unveraendert zurueck");

    // Fortsetzen: Startzeit und TSE-Transaktion sind die des Originals.
    const resumed = resumeSale(list[0]!);
    assert.equal(resumed.open.startedAt, open.startedAt);
    assert.equal(resumed.open.tseStart?.transactionNumber, open.tseStart?.transactionNumber);

    const sequence = await nextSequence(base.db, base.device.id, "receipt");
    const { order } = await finishTransaction(
      ctx, resumed.open, resumed.cart, [{ method: "CASH", amount: total, tendered: total }],
      { sequence, deposits },
    );
    await saveOrder(base.db, order);
    await deleteParkedSale(base.db, parked.id);

    assert.equal(order.startedAt, open.startedAt, "der Beleg traegt den Beginn der Erfassung");
    assert.equal(order.total, total);
    assert.equal((await listParkedSales(base.db, base.device.id)).length, 0);
  } finally {
    base.db.close();
  }
});

test("zwei geparkte Vorgaenge duerfen nicht gleich heissen - auch nicht anders geschrieben", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const kaffee = find(await listProducts(base.db), "Kaffee");

    const park = async (label: string): Promise<void> => {
      const open = await beginTransaction(ctx);
      const cart = addProduct(emptyCart(base.tenant.id, "TAKEAWAY"), kaffee, { id: newId() });
      const sale = await parkSale({
        id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
        userId: base.user.id, label, cart, open, parkedAt: NOW, total: 250,
        existing: await listParkedSales(base.db, base.device.id),
      });
      await saveParkedSale(base.db, sale);
    };

    await park("Tisch 4");
    // Der Kern lehnt es ab, bevor die Datenbank es tut ...
    await assert.rejects(() => park("tisch 4"), /schon vergeben/);
    // ... und die Datenbank haelt es zusaetzlich fest, falls jemand am Kern
    // vorbei schreibt.
    assert.throws(
      () => base.db.handle.exec(
        `INSERT INTO parked_sale (id, tenant_id, store_id, device_id, user_id, label, cart_json,
            started_at, parked_at, total, line_count)
         VALUES ('x','${base.tenant.id}','${base.store.id}','${base.device.id}','u','TISCH 4','{}','${NOW}','${NOW}',0,0)`,
      ),
      /UNIQUE/,
    );
  } finally {
    base.db.close();
  }
});

test("ein leerer Vorgang wird nicht geparkt", async () => {
  const base = await setup();
  try {
    const open = await beginTransaction(context(base));
    await assert.rejects(
      () => parkSale({
        id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
        userId: base.user.id, label: "Leer", cart: emptyCart(base.tenant.id, "TAKEAWAY"),
        open, parkedAt: NOW, total: 0, existing: [],
      }),
      /leerer Vorgang/,
    );
    assert.equal((await listParkedSales(base.db, base.device.id)).length, 0);
  } finally {
    base.db.close();
  }
});

// --- Kassenbuch -----------------------------------------------------------

test("Tageseroeffnung, Entnahme und Einlage stehen im Kassenbuch", async () => {
  const base = await setup();
  try {
    const opening = openDay({
      id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      cashCount: [{ denomination: 5000, count: 2 }, { denomination: 1000, count: 5 }],
      userId: base.user.id, createdAt: NOW,
    });
    assert.equal(opening.amount, 15_000);
    await appendCashMovement(base.db, opening);

    await appendCashMovement(base.db, buildCashMovement({
      id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      type: "WITHDRAWAL", amount: 5000, reason: "Privatentnahme Petra",
      userId: base.user.id, createdAt: NOW,
    }));
    await appendCashMovement(base.db, buildCashMovement({
      id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      type: "DEPOSIT", amount: 2000, reason: "Wechselgeld nachgelegt",
      userId: base.user.id, createdAt: NOW,
    }));

    const movements = await listOpenCashMovements(base.db, base.device.id);
    assert.equal(movements.length, 3);
    // Das Zaehlprotokoll der Eroeffnung wird mitgespeichert - ohne es ist der
    // Anfangsbestand eine Behauptung.
    assert.equal(movements[0]?.cashCount?.length, 2);
    assert.equal(movements[1]?.amount, -5000, "die Entnahme ist negativ gespeichert");
    assert.equal(movements[2]?.cashCount, undefined, "ohne Zaehlung kein leeres Protokoll");

    const summary = summarizeCashbook(movements);
    assert.equal(summary.opening, 15_000);
    assert.equal(summary.withdrawals, -5000);
    assert.equal(summary.deposits, 2000);
    assert.equal(summary.netMovements, -3000);
    assert.equal(summary.opening + summary.netMovements, 12_000, "Bargeldbestand ohne Verkaeufe");
  } finally {
    base.db.close();
  }
});

test("eine gebuchte Kassenbewegung ist unveraenderlich", async () => {
  const base = await setup();
  try {
    await appendCashMovement(base.db, buildCashMovement({
      id: "cash-1", tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      type: "WITHDRAWAL", amount: 5000, reason: "Privatentnahme",
      userId: base.user.id, createdAt: NOW,
    }));

    assert.throws(() => base.db.handle.exec("UPDATE cash_movement SET amount = -100 WHERE id = 'cash-1'"), /nicht geaendert/);
    assert.throws(() => base.db.handle.exec("UPDATE cash_movement SET reason = 'Tankquittung' WHERE id = 'cash-1'"), /nicht geaendert/);
    assert.throws(() => base.db.handle.exec("DELETE FROM cash_movement"), /nicht geloescht/);

    // Erlaubt ist genau eine Aenderung: die Zuordnung zum Kassenabschluss.
    base.db.handle.exec("UPDATE cash_movement SET closing_id = 'abschluss-1' WHERE id = 'cash-1'");
    assert.equal((await listOpenCashMovements(base.db, base.device.id)).length, 0);
    assert.equal((await listCashMovements(base.db, base.device.id)).length, 1, "im Journal bleibt sie");
  } finally {
    base.db.close();
  }
});

test("eine Entnahme ohne Grund wird abgewiesen", async () => {
  const base = await setup();
  try {
    assert.throws(
      () => buildCashMovement({
        id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
        type: "WITHDRAWAL", amount: 5000, reason: "   ", userId: base.user.id, createdAt: NOW,
      }),
      /braucht einen Grund/,
    );
    assert.equal((await listCashMovements(base.db, base.device.id)).length, 0);
  } finally {
    base.db.close();
  }
});

test("der Kassenabschluss zieht die Bewegungen der Schicht mit", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const products = await listProducts(base.db);
    const order = await sell(base, ctx, (c) => addProduct(c, find(products, "Kaffee"), { id: newId() }), { method: "CASH" });

    const withdrawal = buildCashMovement({
      id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      type: "WITHDRAWAL", amount: 1000, reason: "Einkauf Milch",
      userId: base.user.id, createdAt: NOW,
    });
    await appendCashMovement(base.db, withdrawal);

    const report = buildClosing({
      tenant: base.tenant, store: base.store, device: base.device, userId: base.user.id,
      closingId: newId(), number: await nextSequence(base.db, base.device.id, "closing"),
      from: order.startedAt, to: "2026-09-26T22:00:00+02:00", createdAt: "2026-09-26T22:00:05+02:00",
      orders: [order], cashMovements: [withdrawal], cashCount: [],
    });
    await saveClosing(base.db, report.closing, JSON.stringify(report));

    // Nach dem Abschluss ist die Schicht leer - die naechste faengt bei null
    // an und die Entnahme wird nicht zweimal gerechnet.
    assert.equal((await listOpenCashMovements(base.db, base.device.id)).length, 0);
    assert.equal((await listCashMovements(base.db, base.device.id)).length, 1, "im Journal bleibt sie");
  } finally {
    base.db.close();
  }
});

// --- Kundenname und Bonversand -------------------------------------------

test("Kundenname steht auf dem Beleg und wird gespeichert", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const products = await listProducts(base.db);
    const deposits = createDepositCatalog(products);
    const open = await beginTransaction(ctx);
    const cart = addProduct(emptyCart(base.tenant.id, "TAKEAWAY"), find(products, "Kaffee"), { id: newId() });
    const total = cartTotals(cart, { deposits }).total;
    const sequence = await nextSequence(base.db, base.device.id, "receipt");
    const { order } = await finishTransaction(
      ctx, open, cart, [{ method: "CASH", amount: total, tendered: total }],
      { sequence, deposits, customerName: "Baubetrieb Harms" },
    );
    await saveOrder(base.db, order);

    const stored = (await getOrder(base.db, order.id))!;
    assert.equal(stored.customerName, "Baubetrieb Harms");

    const view = buildReceiptView(stored, { tenant: base.tenant, store: base.store, device: base.device });
    assert.equal(view.customerName, "Baubetrieb Harms");
    const text = renderReceiptText(view, 32);
    assert.ok(text.includes("Kunde: Baubetrieb Harms"));
    // Auch auf schmalem Papier bleibt keine Zeile zu lang.
    for (const line of text.split("\n")) assert.ok(line.length <= 32, `zu lang: "${line}"`);
  } finally {
    base.db.close();
  }
});

test("ein Beleg ohne Kundenname bleibt ohne Kundenzeile", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const products = await listProducts(base.db);
    const order = await sell(base, ctx, (c) => addProduct(c, find(products, "Kaffee"), { id: newId() }), { method: "CASH" });
    const view = buildReceiptView(order, { tenant: base.tenant, store: base.store, device: base.device });
    assert.equal(view.customerName, null);
    assert.ok(!renderReceiptText(view, 42).includes("Kunde:"));
  } finally {
    base.db.close();
  }
});

test("Bonversand per Mail und SMS wird protokolliert - mit verkuerztem Empfaenger", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const products = await listProducts(base.db);
    const order = await sell(base, ctx, (c) => addProduct(c, find(products, "Kaffee"), { id: newId() }), { method: "CASH" });
    const view = buildReceiptView(order, { tenant: base.tenant, store: base.store, device: base.device });

    const mail = prepareEmail(base.tenant, view, { email: "Petra.Harms@Beispiel.de", name: "Petra Harms" });
    // Die Domain wird kleingeschrieben, der Teil vor dem @ bleibt wie getippt:
    // Rechnernamen sind gross-/kleinschreibungsunabhaengig, Postfachnamen nicht.
    assert.equal(mail.to, "Petra.Harms@beispiel.de");
    assert.ok(mail.url.startsWith("mailto:Petra.Harms%40beispiel.de?"), mail.url);
    await appendDelivery(base.db, newId(), base.tenant.id,
      recordDelivery(order, mail, { sentAt: NOW, via: "device", ok: true }));

    const sms = prepareSms(base.tenant, view, { phone: "0170 1234567" });
    assert.ok(sms.url.startsWith("sms:%2B49170"), sms.url);
    assert.ok(sms.body.length <= 160, "eine SMS bleibt eine SMS");
    await appendDelivery(base.db, newId(), base.tenant.id,
      recordDelivery(order, sms, { sentAt: NOW, via: "device", ok: false, error: "SMS-App nicht vorhanden" }));

    const records = await listDeliveries(base.db, order.id);
    assert.equal(records.length, 2);
    // Gespeichert ist der Nachweis, nicht die Adresse: aus dem verkuerzten
    // Empfaenger laesst sich kein Kundenstamm bauen.
    assert.equal(records[0]?.recipient, "P**********@beispiel.de");
    assert.ok(!records[0]?.recipient.toLowerCase().includes("harms"));
    assert.equal(records[0]?.ok, true);
    assert.equal(records[1]?.channel, "SMS");
    assert.equal(records[1]?.ok, false);
    assert.equal(records[1]?.error, "SMS-App nicht vorhanden");
    assert.ok(!records[1]?.recipient.includes("1234567"));
  } finally {
    base.db.close();
  }
});

test("eine unbrauchbare Adresse oeffnet keine Mail-App", async () => {
  const base = await setup();
  try {
    const ctx = context(base);
    const products = await listProducts(base.db);
    const order = await sell(base, ctx, (c) => addProduct(c, find(products, "Kaffee"), { id: newId() }), { method: "CASH" });
    const view = buildReceiptView(order, { tenant: base.tenant, store: base.store, device: base.device });

    assert.throws(() => prepareEmail(base.tenant, view, { email: "petra@" }), /E-Mail/);
    assert.throws(() => prepareEmail(base.tenant, view, { email: "" }), /E-Mail/);
    assert.throws(() => prepareSms(base.tenant, view, { phone: "12" }), /Telefonnummer/);
    assert.equal((await listDeliveries(base.db, order.id)).length, 0, "nichts protokolliert");
  } finally {
    base.db.close();
  }
});

// --- Ein ganzer Tag -------------------------------------------------------

test("ein vollstaendiger Verkaufstag von der Anmeldung bis zum Abschluss", async () => {
  // Dieser Test geht genau die Folge, die die Bildschirme gehen - Anmeldung,
  // Tageseroeffnung, Verkauf, Parken, Fortsetzen, Pfandrueckgabe, Teilstorno,
  // Entnahme, Abschluss. Er ist absichtlich lang: die Fehler, die Geld kosten,
  // entstehen nicht in einer Funktion, sondern zwischen zweien.
  const base = await setup();
  try {
    const ctx = context(base);
    const products = await listProducts(base.db);
    const deposits = createDepositCatalog(products);
    const kaffee = find(products, "Kaffee");
    const limo = find(products, "Limonade 0,5 l");
    const becher = find(products, "Becher");

    // 1. Anmeldung mit PIN.
    await saveUser(base.db, { ...base.user, pinHash: hashPin("4711", { iterations: 1000 }) }, { pinSetAt: NOW });
    const user = (await getUser(base.db, base.user.id))!;
    const login = attemptLogin(user, "4711", await getLoginAttempts(base.db, user.id, base.device.id), NOW);
    assert.equal(login.result, "OK");
    await saveLoginAttempts(base.db, user.id, base.device.id, login.state, NOW);
    await appendAudit(base.db, buildAuditEntry({
      id: newId(), tenantId: base.tenant.id, deviceId: base.device.id,
      userId: user.id, userName: user.name, event: "LOGIN_OK", createdAt: NOW,
    }));

    // 2. Tageseroeffnung: 100 EUR Wechselgeld.
    const opening = openDay({
      id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      cashCount: [{ denomination: 2000, count: 4 }, { denomination: 1000, count: 2 }],
      userId: user.id, createdAt: NOW,
    });
    await appendCashMovement(base.db, opening);
    assert.equal(opening.amount, 10_000);

    // 3. Wareneingang: 24 Flaschen Limonade.
    const receipt = buildMovement({
      id: newId(), product: limo, storeId: base.store.id, userId: user.id,
      quantity: 24 * ONE, reason: "PURCHASE", note: "Lieferung Metro", createdAt: NOW,
    });
    await applyStockMovement(base.db, receipt.movement);
    assert.equal(receipt.stock, 24 * ONE);

    // 4. Erster Verkauf: zwei Kaffee mit Pfand, bar mit Rueckgeld.
    const first = await sell(
      base, ctx,
      (cart) => addProduct(cart, kaffee, { id: newId(), quantity: 2 * ONE }),
      { method: "CASH", tendered: 1000 },
    );
    // 2 x 2,50 + 2 x (1,00 Becher + 0,30 Deckel) = 7,60
    assert.equal(first.total, 760);
    assert.equal(first.payments[0]?.change, 240);
    assert.ok(isTseSecured(first));

    // 5. Zweiter Kunde will noch etwas holen - Vorgang parken.
    const open = await beginTransaction(ctx);
    const parkedCart = addProduct(emptyCart(base.tenant.id, "TAKEAWAY"), limo, { id: newId(), quantity: 3 * ONE });
    const parkedTotal = cartTotals(parkedCart, { deposits }).total;
    const parked = await parkSale({
      id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      userId: user.id, label: "Herr mit Hund", cart: parkedCart, open, parkedAt: NOW,
      total: parkedTotal, existing: [], tse: ctx.tse, tseClientId: base.device.tseClientId,
    });
    await saveParkedSale(base.db, parked);

    // 6. Dritter Kunde bezahlt dazwischen - mit Pfandrueckgabe.
    const third = await sell(
      base, ctx,
      (cart) => addDepositReturn(addProduct(cart, kaffee, { id: newId() }), { productId: becher.id, name: becher.name, price: becher.price ?? 0, taxKey: becher.taxKey }, { id: newId(), quantity: 2 * ONE }),
      { method: "CARD_DEBIT" },
    );
    // 2,50 + 1,00 Becher + 0,30 Deckel - 2 x 1,00 Rueckgabe = 1,80
    assert.equal(third.total, 180);

    // 7. Der geparkte Vorgang wird fortgesetzt und bezahlt.
    const stored = (await listParkedSales(base.db, base.device.id))[0]!;
    const resumed = resumeSale(stored);
    const resumeSequence = await nextSequence(base.db, base.device.id, "receipt");
    const { order: resumedOrder } = await finishTransaction(
      ctx, resumed.open, resumed.cart,
      [{ method: "CASH", amount: parkedTotal, tendered: parkedTotal }],
      { sequence: resumeSequence, deposits, customerName: "Herr mit Hund" },
    );
    await saveOrder(base.db, resumedOrder);
    await deleteParkedSale(base.db, stored.id);
    for (const result of movementsForOrder(resumedOrder, products, { newId, userId: user.id })) {
      await applyStockMovement(base.db, result.movement);
    }
    assert.equal(resumedOrder.startedAt, open.startedAt, "der Bon traegt den Beginn der Erfassung");
    assert.equal(resumedOrder.customerName, "Herr mit Hund");
    // 3 x 2,50 + 3 x 0,25 Flaschenpfand = 8,25
    assert.equal(resumedOrder.total, 825);

    // 8. Teilstorno: von den zwei Kaffee des ersten Belegs war einer falsch.
    const kaffeeLine = first.lines.find((line) => line.productId === kaffee.id)!;
    const voidCart = buildPartialVoidCart(first, [{ lineId: kaffeeLine.id, quantity: ONE }]);
    const voidSequence = await nextSequence(base.db, base.device.id, "receipt");
    const { order: partial } = await finishTransaction(
      ctx, await beginTransaction(ctx), voidCart,
      [{ method: "CASH", amount: cartTotals(voidCart, {}).total }],
      { sequence: voidSequence, note: `Teilstorno zu ${first.receiptNumber}: falsch gebucht` },
    );
    await saveOrder(base.db, { ...partial, voidsOrderId: first.id });
    await appendAudit(base.db, buildAuditEntry({
      id: newId(), tenantId: base.tenant.id, deviceId: base.device.id, userId: user.id,
      userName: user.name, event: "RECEIPT_VOIDED", subject: first.receiptNumber,
      detail: "Teilstorno: falsch gebucht", amount: partial.total, createdAt: NOW,
    }));
    // Ein Kaffee mit Becher und Deckel zurueck: -3,80
    assert.equal(partial.total, -380);

    // 9. Entnahme fuer einen Einkauf.
    const withdrawal = buildCashMovement({
      id: newId(), tenantId: base.tenant.id, storeId: base.store.id, deviceId: base.device.id,
      type: "WITHDRAWAL", amount: 2000, reason: "Einkauf Milch", userId: user.id, createdAt: NOW,
    });
    await appendCashMovement(base.db, withdrawal);

    // 10. Bestand: 3 Flaschen verkauft, 24 geliefert.
    const limoNow = (await listProducts(base.db)).find((item) => item.id === limo.id)!;
    assert.equal(limoNow.stock, 21 * ONE);
    assert.equal(stockState(limoNow), "OK");

    // 11. Abschluss. Der Soll-Bestand muss aufgehen: Eroeffnung + Barumsatz
    // + Bewegungen. Genau das ist die Zahl, die der Betrieb abends nachzaehlt.
    const orders = await listOpenForClosing(base.db, base.device.id);
    assert.equal(orders.length, 4, "vier Belege: drei Verkaeufe und ein Teilstorno");
    const movements = await listOpenCashMovements(base.db, base.device.id);

    const cashSales = orders
      .flatMap((order) => order.payments)
      .filter((payment) => payment.method === "CASH")
      .reduce((sum, payment) => sum + payment.amount, 0);
    // 7,60 + 8,25 - 3,80 = 12,05 bar; die Kartenzahlung zaehlt nicht mit.
    assert.equal(cashSales, 1205);

    const report = buildClosing({
      tenant: base.tenant, store: base.store, device: base.device, userId: user.id,
      closingId: newId(), number: await nextSequence(base.db, base.device.id, "closing"),
      from: first.startedAt, to: "2026-09-26T22:00:00+02:00", createdAt: "2026-09-26T22:00:05+02:00",
      orders, cashMovements: movements,
      // Gezaehlt wird, was rechnerisch da sein muss: 100 + 12,05 - 20 = 92,05
      cashCount: [
        { denomination: 5000, count: 1 }, { denomination: 2000, count: 2 },
        { denomination: 200, count: 1 }, { denomination: 5, count: 1 },
      ],
    });
    await saveClosing(base.db, report.closing, JSON.stringify(report));

    assert.equal(report.closing.openingCash, 10_000);
    assert.equal(report.expectedCash, 9205);
    assert.equal(report.countedCash, 9205);
    assert.equal(report.cashDifference, 0, `gezaehlt ${report.countedCash}, erwartet ${report.expectedCash}`);
    assert.equal(report.unsecuredOrderCount, 0);
    assert.equal(report.voidCount, 1);

    // 12. Danach ist alles zugeordnet: keine offenen Belege, keine offenen
    // Bewegungen, kein geparkter Vorgang.
    assert.equal((await listOpenForClosing(base.db, base.device.id)).length, 0);
    assert.equal((await listOpenCashMovements(base.db, base.device.id)).length, 0);
    assert.equal((await listParkedSales(base.db, base.device.id)).length, 0);

    // 13. Das Protokoll erzaehlt den Tag nach.
    const audit = summarizeAudit(await listAudit(base.db));
    assert.equal(audit.byEvent["LOGIN_OK"], 1);
    assert.equal(audit.voidsByUser[0]?.count, 1);
    assert.equal(audit.tseFailures, 0);

    // 14. Der Bon des Teilstornos ist lesbar und passt auf schmales Papier.
    const view = buildReceiptView((await getOrder(base.db, partial.id))!, {
      tenant: base.tenant, store: base.store, device: base.device,
    });
    const text = renderReceiptText(view, 32);
    for (const line of text.split("\n")) assert.ok(line.length <= 32, `zu lang: "${line}"`);
    assert.ok(text.includes("Teilstorno"));
  } finally {
    base.db.close();
  }
});

/**
 * Wareneingang aus einer Lieferantenrechnung, durch die echte Datenbank.
 *
 * Der Weg, den die App geht: PDF als Base64 lesen, das XML herausholen, gegen
 * den Artikelstamm halten, die unsicheren Zeilen von Hand zuordnen, buchen -
 * und danach steht der neue Bestand in der Datenbank und die Rechnungsnummer
 * im Bestandsjournal.
 */
test("Wareneingang aus einer ZUGFeRD-Rechnung bis in den Bestand", async () => {
  const base = await setup();
  try {
    // 1. Zwei Artikel mit Bestandsfuehrung. Der eine traegt die EAN des
    // Lieferanten, der andere nicht - das ist der Normalfall.
    const gruppe = base.categories[0]!;
    const cola: Product = {
      id: newId(), tenantId: base.tenant.id, categoryId: gruppe.id, name: "Cola 0,33 l",
      price: 250, taxKey: 1, sku: "4001234567890", unit: "PIECE", trackStock: true, stock: 6 * ONE,
      lowStockThreshold: 12 * ONE, sortOrder: 10, active: true, updatedAt: NOW,
    };
    const kaffee: Product = {
      id: newId(), tenantId: base.tenant.id, categoryId: gruppe.id, name: "Kaffeebohnen kräftig",
      price: 2500, taxKey: 2, unit: "KILOGRAM", trackStock: true, stock: ONE,
      sortOrder: 20, active: true, updatedAt: NOW,
    };
    await saveProduct(base.db, cola);
    await saveProduct(base.db, kaffee);

    // 2. Die Rechnung, wie ein Grosshaendler sie schickt: ZUGFeRD, also eine
    // PDF mit dem XML als gepacktem Anhang.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">
  <rsm:ExchangedDocument><ram:ID>RE-2026-4711</ram:ID>
    <ram:IssueDateTime><udt:DateTimeString format="102">20260926</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>1</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:GlobalID schemeID="0160">4001234567890</ram:GlobalID><ram:Name>Cola Dose 0,33</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>0.6300</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="H87">24</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:RateApplicablePercent>19.00</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>15.12</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>2</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>Roestkaffee 1000g Packung</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement><ram:NetPriceProductTradePrice><ram:ChargeAmount>14.90</ram:ChargeAmount></ram:NetPriceProductTradePrice></ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="GRM">2000</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax><ram:RateApplicablePercent>7.00</ram:RateApplicablePercent></ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>29.80</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>
    <ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty><ram:Name>Getraenke Mueller GmbH</ram:Name></ram:SellerTradeParty></ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:TaxBasisTotalAmount>44.92</ram:TaxBasisTotalAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

    const anhang = new Uint8Array(deflateSync(new TextEncoder().encode(xml)));
    const teile = [
      new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /EmbeddedFile /Filter /FlateDecode /Length " + anhang.length + " >>\nstream\n"),
      anhang,
      new TextEncoder().encode("\nendstream\nendobj\n2 0 obj\n<< /Type /Filespec /F (factur-x.xml) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"),
    ];
    const pdf = new Uint8Array(teile.reduce((sum, teil) => sum + teil.length, 0));
    let offset = 0;
    for (const teil of teile) { pdf.set(teil, offset); offset += teil.length; }

    // 3. So liest die App die Datei: als Base64 ueber die Bruecke zum
    // Betriebssystem, dann Bytes, dann der Anhang, dann die Rechnung.
    const invoice = parseInvoiceXml(extractInvoiceXml(base64ToBytes(Buffer.from(pdf).toString("base64"))).content);
    assert.equal(invoice.invoiceNumber, "RE-2026-4711");
    assert.equal(invoice.supplierName, "Getraenke Mueller GmbH");
    assert.deepEqual(checkInvoice(invoice), [], "die Summenprobe muss aufgehen");

    // 4. Gegen den Artikelstamm halten.
    const plan = planGoodsReceipt(invoice, await listProducts(base.db));
    assert.equal(plan.lines.length, 2);

    // Die Cola trifft ueber die EAN - obwohl der Lieferant sie anders nennt.
    assert.equal(plan.lines[0]!.match, "GTIN");
    assert.equal(plan.lines[0]!.product?.id, cola.id);
    assert.equal(plan.lines[0]!.selected, true);

    // Der Kaffee heisst beim Lieferanten voellig anders: kein Treffer, also
    // auch kein Vorschlag - der Bediener muss hinsehen.
    assert.equal(plan.lines[1]!.product, null);
    assert.equal(plan.lines[1]!.selected, false);
    assert.equal(plan.readyCount, 1);
    assert.equal(plan.openCount, 1);

    // 2000 Gramm sind zwei Kilo, nicht zweitausend.
    assert.equal(plan.lines[1]!.quantity, 2 * ONE);

    // 5. Von Hand zuordnen - das tut der Bediener im Zuordnungsfenster.
    const zugeordnet = {
      ...plan,
      lines: [plan.lines[0]!, assignProduct(plan.lines[1]!, kaffee)],
    };
    assert.equal(zugeordnet.lines[1]!.selected, true);

    // 6. Buchen.
    const { movements } = bookGoodsReceipt(
      { ...zugeordnet, readyCount: 2, openCount: 0 },
      { newId, storeId: base.store.id, userId: base.user.id, createdAt: "2026-09-26T10:15:00+02:00" },
    );
    assert.equal(movements.length, 2);
    for (const movement of movements) await applyStockMovement(base.db, movement);

    // 7. Der Bestand steht in der Datenbank, fortgeschrieben und nicht gesetzt.
    const nachher = await listProducts(base.db);
    assert.equal(nachher.find((item) => item.id === cola.id)!.stock, 30 * ONE, "6 + 24 Dosen");
    assert.equal(nachher.find((item) => item.id === kaffee.id)!.stock, 3 * ONE, "1 kg + 2 kg");

    // Und die Warnung "Bestand niedrig" ist damit weg.
    assert.equal(stockState(nachher.find((item) => item.id === cola.id)!), "OK");

    // 8. Das Journal fuehrt vom Bestand zurueck zur Rechnung im Ordner.
    const journal = await listStockMovements(base.db, { limit: 10 });
    const zugang = journal.filter((entry) => entry.reason === "PURCHASE");
    assert.equal(zugang.length, 2);
    assert.match(zugang[0]!.note ?? "", /RE-2026-4711/);
    assert.match(zugang[0]!.note ?? "", /Getraenke Mueller GmbH/);
    assert.match(zugang[0]!.note ?? "", /Pos\. [12]/);

    // 9. Dieselbe Rechnung ein zweites Mal einzulesen ist moeglich - eine
    // Nachlieferung sieht genauso aus. Der Bestand waechst dann erneut; das
    // Journal zeigt beide Buchungen mit derselben Rechnungsnummer, und genau
    // daran erkennt der Betrieb eine doppelte Buchung.
    const nochmal = planGoodsReceipt(invoice, nachher);
    assert.equal(nochmal.lines[0]!.selected, true);
  } finally {
    base.db.close();
  }
});
