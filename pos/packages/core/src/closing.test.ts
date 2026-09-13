import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE } from "./money.ts";
import { fixedClock, sequentialIds } from "./clock.ts";
import { addDepositReturn, addProduct, cartTotals, emptyCart } from "./cart.ts";
import { createDepositCatalog } from "./deposit.ts";
import type { Device, Order, Product, Store, Tenant } from "./model.ts";
import { MockTse } from "./tse/mock.ts";
import { beginTransaction, buildVoidCart, finishTransaction, type TransactionContext } from "./order.ts";
import { ClosingError, DENOMINATIONS, buildClosing, countCash, renderClosingText } from "./closing.ts";

const tenant: Tenant = {
  id: "t1", name: "MOINA", legalName: "Mehmet Gelgel", street: "Musterweg 1", postalCode: "24103", city: "Kiel",
  countryCode: "DE", taxNumber: "20/123/45678", vatId: null, email: null, phone: null, smallBusiness: false,
  receiptFooter: null, currency: "EUR", timeZone: "Europe/Berlin", createdAt: "2026-01-01T00:00:00+01:00",
};
const store: Store = { id: "s1", tenantId: "t1", name: "Anhaenger", active: true };
const device: Device = {
  id: "d1", tenantId: "t1", storeId: "s1", name: "Kasse 1", serialNumber: "KASSE-0001",
  tseClientId: "client-1", receiptPrefix: "K1", active: true,
};

function base(over: Partial<Product>): Product {
  return {
    id: "x", tenantId: "t1", categoryId: "c1", name: "x", price: 0, taxKey: 1, unit: "PIECE",
    sortOrder: 1, active: true, updatedAt: "2026-09-01T00:00:00+02:00", ...over,
  };
}
const becher = base({ id: "d-becher", name: "Mehrwegbecher", price: 100, taxKey: 1, deposit: { kind: "REUSABLE", refundable: true } });
const kaffee = base({ id: "p-kaffee", name: "Cafe Crema", price: 250, taxKey: 1, depositProductIds: ["d-becher"] });
const crepe = base({ id: "p-crepe", name: "Crepe", price: 450, taxKey: 2, taxKeyDineIn: 1 });
const deposits = createDepositCatalog([becher, kaffee, crepe]);

/** Baut eine Reihe fertiger Belege auf einer gemeinsamen Uhr und TSE. */
async function makeOrders(): Promise<{ orders: Order[]; ctx: TransactionContext }> {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  const ctx: TransactionContext = {
    tenant, store, device,
    user: { id: "u1", tenantId: "t1", name: "Mehmet", role: "OWNER", active: true },
    clock, newId: sequentialIds("o"), tse: new MockTse({ clock }),
  };
  const orders: Order[] = [];
  let sequence = 1;

  const sell = async (build: (cart: ReturnType<typeof emptyCart>) => ReturnType<typeof emptyCart>, method: "CASH" | "CARD_DEBIT") => {
    const open = await beginTransaction(ctx);
    clock.advance(30);
    const cart = build(emptyCart("t1"));
    const total = cartTotals(cart, { deposits }).total;
    const { order } = await finishTransaction(ctx, open, cart, [{ method, amount: total, tendered: method === "CASH" ? total : undefined }], {
      sequence: sequence++, deposits,
    });
    orders.push(order);
    return order;
  };

  // 2 Kaffee bar (5,00 Ware + 2,00 Pfand)
  await sell((c) => addProduct(c, kaffee, { id: "l1", quantity: 2 * ONE }), "CASH");
  // 1 Crepe Karte (4,50)
  await sell((c) => addProduct(c, crepe, { id: "l1" }), "CARD_DEBIT");
  // 1 Becher zurueck, bar (-1,00)
  await sell((c) => addDepositReturn(c, { productId: becher.id, name: becher.name, price: 100, taxKey: 1, refundable: true }, { id: "r1" }), "CASH");
  return { orders, ctx };
}

test("countCash summiert das Zaehlprotokoll", () => {
  assert.equal(countCash([{ denomination: 5000, count: 2 }, { denomination: 200, count: 3 }, { denomination: 5, count: 4 }]), 10620);
  assert.equal(countCash([]), 0);
  assert.throws(() => countCash([{ denomination: 300, count: 1 }]), ClosingError);
  assert.throws(() => countCash([{ denomination: 500, count: -1 }]), ClosingError);
  assert.throws(() => countCash([{ denomination: 500, count: 1.5 }]), ClosingError);
});

test("Stueckelung deckt alle Euro-Nennwerte ab", () => {
  assert.equal(DENOMINATIONS.length, 15);
  assert.equal(DENOMINATIONS[0], 50_000);
  assert.equal(DENOMINATIONS[DENOMINATIONS.length - 1], 1);
});

test("Abschluss summiert Umsatz, Steuer, Zahlarten und Pfand", async () => {
  const { orders } = await makeOrders();
  const report = buildClosing({
    tenant, store, device, userId: "u1", closingId: "z1", number: 1,
    from: "2026-09-26T09:00:00+00:00", to: "2026-09-26T22:00:00+00:00", createdAt: "2026-09-26T22:00:05+00:00",
    orders, openingCash: 5000,
  });

  assert.equal(report.orderCount, 3);
  assert.equal(report.grossTotal, 700 + 450 - 100);
  assert.equal(report.depositCharged, 200);
  assert.equal(report.depositRefunded, -100);
  assert.equal(report.depositBalance, 100);
  assert.equal(report.salesTotal, 500 + 450, "Warenumsatz ohne Pfand");

  // Zahlarten: bar 7,00 + (-1,00) = 6,00 aus zwei Belegen, Karte 4,50.
  assert.deepEqual(report.payments.map((p) => [p.method, p.amount, p.count]), [
    ["CARD_DEBIT", 450, 1],
    ["CASH", 600, 2],
  ]);

  // Steuer: 19 % auf Kaffee+Pfand-Saldo, 7 % auf Crepe.
  assert.deepEqual(report.taxGroups.map((g) => [g.key, g.gross]), [
    [1, 600],
    [2, 450],
  ]);
  assert.equal(report.firstReceiptNumber, "K1-000001");
  assert.equal(report.lastReceiptNumber, "K1-000003");
  assert.equal(report.unsecuredOrderCount, 0);
});

test("Soll-Kassenbestand ist Anfangsbestand plus Barumsatz", async () => {
  const { orders } = await makeOrders();
  const report = buildClosing({
    tenant, store, device, userId: "u1", closingId: "z1", number: 1,
    from: "a", to: "b", createdAt: "c", orders, openingCash: 5000,
  });
  assert.equal(report.expectedCash, 5000 + 600);
  assert.equal(report.countedCash, null);
  assert.equal(report.cashDifference, null);
});

test("Fehlbetrag wird ausgewiesen, nicht verschwiegen", async () => {
  const { orders } = await makeOrders();
  const report = buildClosing({
    tenant, store, device, userId: "u1", closingId: "z1", number: 1,
    from: "a", to: "b", createdAt: "c", orders, openingCash: 5000,
    // Gezaehlt: 55,00 statt der erwarteten 56,00.
    cashCount: [{ denomination: 5000, count: 1 }, { denomination: 500, count: 1 }],
  });
  assert.equal(report.countedCash, 5500);
  assert.equal(report.cashDifference, -100);
  const text = renderClosingText(report);
  assert.ok(text.includes("FEHLBETRAG"), text);
});

test("Ueberschuss wird als solcher benannt", async () => {
  const { orders } = await makeOrders();
  const report = buildClosing({
    tenant, store, device, userId: "u1", closingId: "z1", number: 1,
    from: "a", to: "b", createdAt: "c", orders, openingCash: 5000,
    cashCount: [{ denomination: 5000, count: 1 }, { denomination: 1000, count: 1 }],
  });
  assert.equal(report.cashDifference, 400);
  assert.ok(renderClosingText(report).includes("Ueberschuss"));
});

test("Belege ohne TSE-Signatur erscheinen im Abschluss", async () => {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  const tse = new MockTse({ clock, available: false });
  const ctx: TransactionContext = {
    tenant, store, device,
    user: { id: "u1", tenantId: "t1", name: "M", role: "OWNER", active: true },
    clock, newId: sequentialIds("o"), tse,
  };
  const open = await beginTransaction(ctx);
  const { order } = await finishTransaction(ctx, open, addProduct(emptyCart("t1"), crepe, { id: "l1" }), [{ method: "CASH", amount: 450 }], { sequence: 1 });

  const report = buildClosing({
    tenant, store, device, userId: "u1", closingId: "z1", number: 1,
    from: "a", to: "b", createdAt: "c", orders: [order],
  });
  assert.equal(report.unsecuredOrderCount, 1);
  assert.ok(renderClosingText(report).includes("OHNE TSE-SIGNATUR"));
});

test("Storni werden gezaehlt und saldieren den Umsatz", async () => {
  const { orders, ctx } = await makeOrders();
  const first = orders[0]!;
  const voidOpen = await beginTransaction(ctx);
  const voidCart = buildVoidCart(first);
  const { order: voidOrder } = await finishTransaction(ctx, voidOpen, voidCart, [{ method: "CASH", amount: -first.total }], { sequence: 4 });

  const report = buildClosing({
    tenant, store, device, userId: "u1", closingId: "z1", number: 1,
    from: "a", to: "b", createdAt: "c", orders: [...orders, { ...voidOrder, voidsOrderId: first.id }],
  });
  assert.equal(report.voidCount, 1);
  assert.equal(report.grossTotal, 450 - 100, "der stornierte Beleg hebt sich heraus");
});

test("Abschluss weist fremde, offene und schon abgeschlossene Belege ab", async () => {
  const { orders } = await makeOrders();
  const input = {
    tenant, store, device, userId: "u1", closingId: "z1", number: 1,
    from: "a", to: "b", createdAt: "c",
  };
  assert.throws(() => buildClosing({ ...input, orders: [{ ...orders[0]!, tenantId: "t2" }] }), ClosingError);
  assert.throws(() => buildClosing({ ...input, orders: [{ ...orders[0]!, deviceId: "d2" }] }), ClosingError);
  assert.throws(() => buildClosing({ ...input, orders: [{ ...orders[0]!, state: "OPEN" }] }), ClosingError);
  assert.throws(() => buildClosing({ ...input, orders: [{ ...orders[0]!, closingId: "z0" }] }), ClosingError);
  assert.throws(() => buildClosing({ ...input, number: 0, orders }), ClosingError);
});

test("leerer Abschluss ist moeglich - ein Tag ohne Verkauf ist auch ein Tag", () => {
  const report = buildClosing({
    tenant, store, device, userId: "u1", closingId: "z1", number: 7,
    from: "a", to: "b", createdAt: "c", orders: [], openingCash: 5000,
    cashCount: [{ denomination: 5000, count: 1 }],
  });
  assert.equal(report.orderCount, 0);
  assert.equal(report.grossTotal, 0);
  assert.equal(report.expectedCash, 5000);
  assert.equal(report.cashDifference, 0);
  assert.equal(report.firstReceiptNumber, null);
});

test("Abschlusstext bleibt in der Druckbreite", async () => {
  const { orders } = await makeOrders();
  const report = buildClosing({
    tenant, store, device, userId: "u1", closingId: "z1", number: 1,
    from: "2026-09-26T09:00:00+00:00", to: "2026-09-26T22:00:00+00:00", createdAt: "c",
    orders, openingCash: 5000, cashCount: [{ denomination: 5000, count: 1 }, { denomination: 500, count: 1 }, { denomination: 100, count: 1 }],
  });
  const text = renderClosingText(report, 42);
  assert.ok(text.includes("Kassenabschluss Nr. 1"));
  assert.ok(text.includes("Warenumsatz ohne Pfand"));
  for (const line of text.split("\n")) {
    assert.ok(line.length <= 42, `zu lang: "${line}" (${line.length})`);
  }
});
