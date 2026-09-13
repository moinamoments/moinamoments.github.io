import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE, sumCents } from "./money.ts";
import { fixedClock, sequentialIds } from "./clock.ts";
import { addProduct, cartTotals, emptyCart, setLineDiscount, setOrderDiscount, setServiceMode } from "./cart.ts";
import type { Device, Product, Store, Tenant, User } from "./model.ts";
import { MockTse } from "./tse/mock.ts";
import {
  OrderError,
  beginTransaction,
  buildVoidCart,
  finishTransaction,
  formatReceiptNumber,
  isTseSecured,
  resolvePayments,
  tsePaymentLabel,
  type TransactionContext,
} from "./order.ts";

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
  email: "info@example.invalid",
  phone: null,
  smallBusiness: false,
  receiptFooter: null,
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

function context(over: Partial<TransactionContext> = {}): TransactionContext {
  return {
    tenant,
    store,
    device,
    user,
    clock: fixedClock("2026-09-26T09:00:00Z"),
    newId: sequentialIds("o"),
    tse: new MockTse(),
    ...over,
  };
}

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

test("formatReceiptNumber nummeriert je Geraet mit Prefix", () => {
  assert.equal(formatReceiptNumber(device, 1), "K1-000001");
  assert.equal(formatReceiptNumber(device, 4711), "K1-004711");
  assert.throws(() => formatReceiptNumber(device, 0), OrderError);
  assert.throws(() => formatReceiptNumber(device, 1.5), OrderError);
});

test("tsePaymentLabel reduziert auf die zwei erlaubten Werte", () => {
  assert.equal(tsePaymentLabel("CASH"), "Bar");
  assert.equal(tsePaymentLabel("CARD_DEBIT"), "Unbar");
  assert.equal(tsePaymentLabel("VOUCHER"), "Unbar");
});

test("Barzahlung mit Rueckgeld", () => {
  const ctx = context();
  const payments = resolvePayments(920, [{ method: "CASH", amount: 920, tendered: 1000 }], ctx);
  assert.equal(payments[0]?.change, 80);
  assert.equal(payments[0]?.label, "Bar");
});

test("Zahlbetrag muss die Belegsumme genau treffen", () => {
  const ctx = context();
  assert.throws(() => resolvePayments(920, [{ method: "CASH", amount: 900, tendered: 1000 }], ctx), OrderError);
  assert.throws(() => resolvePayments(920, [], ctx), OrderError);
  assert.throws(() => resolvePayments(920, [{ method: "CASH", amount: 920, tendered: 900 }], ctx), OrderError);
});

test("Rueckgeld nur bei Barzahlung", () => {
  const ctx = context();
  assert.throws(
    () => resolvePayments(920, [{ method: "CARD_DEBIT", amount: 920, tendered: 1000 }], ctx),
    OrderError,
  );
});

test("geteilte Zahlung bar und Karte", () => {
  const ctx = context();
  const payments = resolvePayments(
    1000,
    [
      { method: "CASH", amount: 500, tendered: 500 },
      { method: "CARD_DEBIT", amount: 500, reference: "TX-99" },
    ],
    ctx,
  );
  assert.equal(payments.length, 2);
  assert.equal(sumCents(payments.map((p) => p.amount)), 1000);
  assert.equal(payments[1]?.reference, "TX-99");
});

test("vollstaendiger Verkauf: TSE-Start, Erfassung, Abschluss", async () => {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  const tse = new MockTse({ clock });
  const ctx = context({ clock, tse });

  const open = await beginTransaction(ctx);
  assert.equal(open.tseFailure, null);
  assert.equal(open.tseStart?.transactionNumber, 1);

  clock.advance(42); // Kunde waehlt aus
  let cart = addProduct(emptyCart(tenant.id), crepe, { id: "l1", quantity: 2 * ONE });
  const { order, totals } = await finishTransaction(
    ctx,
    open,
    cart,
    [{ method: "CASH", amount: 900, tendered: 1000 }],
    { sequence: 1 },
  );

  assert.equal(order.state, "PAID");
  assert.equal(order.receiptNumber, "K1-000001");
  assert.equal(order.total, 900);
  assert.equal(totals.taxGroups[0]?.tax, 59);
  assert.equal(order.payments[0]?.change, 100);
  assert.equal(order.startedAt, "2026-09-26T09:00:00+00:00");
  assert.equal(order.paidAt, "2026-09-26T09:00:42+00:00");
  assert.ok(isTseSecured(order));
  assert.equal(order.tse?.processData, "Kassenbeleg-V1^0.00_9.00_0.00_0.00_0.00^9.00:Bar");
  assert.equal(order.tse?.startTime, "2026-09-26T09:00:00+00:00", "TSE-Startzeit ist der Beginn der Erfassung");
  assert.equal(order.tse?.signatureCounter, 2);
  assert.equal(order.lines[0]?.position, 1);
});

test("Prozessdaten tragen beide Steuersaetze und beide Zahlarten", async () => {
  const ctx = context();
  const open = await beginTransaction(ctx);
  let cart = addProduct(emptyCart(tenant.id), crepe, { id: "l1" });
  cart = addProduct(cart, { ...crepe, id: "p2", name: "Cola", price: 250, taxKey: 1, taxKeyDineIn: null }, { id: "l2" });
  const { order } = await finishTransaction(
    ctx,
    open,
    cart,
    [
      { method: "CASH", amount: 300, tendered: 300 },
      { method: "CARD_DEBIT", amount: 400 },
    ],
    { sequence: 7 },
  );
  assert.equal(order.tse?.processData, "Kassenbeleg-V1^2.50_4.50_0.00_0.00_0.00^3.00:Bar_4.00:Unbar");
  assert.equal(order.receiptNumber, "K1-000007");
});

test("im Haus verschiebt den Steuersatz in den Prozessdaten", async () => {
  const ctx = context();
  const open = await beginTransaction(ctx);
  const cart = setServiceMode(addProduct(emptyCart(tenant.id), crepe, { id: "l1" }), "DINE_IN");
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 450, tendered: 450 }], { sequence: 1 });
  assert.equal(order.tse?.processData, "Kassenbeleg-V1^4.50_0.00_0.00_0.00_0.00^4.50:Bar");
  assert.equal(order.serviceMode, "DINE_IN");
});

test("Kleinunternehmer: Beleg ohne Steuer, Betrag im Nullfeld", async () => {
  const ctx = context({ tenant: { ...tenant, smallBusiness: true } });
  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart(tenant.id), crepe, { id: "l1" });
  const { order, totals } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 450, tendered: 450 }], { sequence: 1 });
  assert.equal(totals.taxTotal, 0);
  assert.equal(order.tse?.processData, "Kassenbeleg-V1^0.00_0.00_0.00_0.00_4.50^4.50:Bar");
});

test("leerer Warenkorb und fremder Mandant werden abgewiesen", async () => {
  const ctx = context();
  const open = await beginTransaction(ctx);
  await assert.rejects(
    () => finishTransaction(ctx, open, emptyCart(tenant.id), [{ method: "CASH", amount: 0 }], { sequence: 1 }),
    OrderError,
  );
  await assert.rejects(
    () => finishTransaction(ctx, open, addProduct(emptyCart("fremd"), { ...crepe, tenantId: "fremd" }, { id: "l1" }), [{ method: "CASH", amount: 450 }], { sequence: 1 }),
    OrderError,
  );
});

test("TSE-Ausfall beim Start: der Verkauf laeuft weiter, der Ausfall steht am Beleg", async () => {
  const tse = new MockTse({ available: false });
  const ctx = context({ tse });
  const open = await beginTransaction(ctx);
  assert.equal(open.tseStart, null);
  assert.match(open.tseFailure ?? "", /nicht erreichbar/);

  const cart = addProduct(emptyCart(tenant.id), crepe, { id: "l1" });
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 450, tendered: 500 }], { sequence: 1 });

  assert.equal(order.state, "PAID", "kassiert wird trotzdem");
  assert.equal(order.total, 450);
  assert.equal(isTseSecured(order), false);
  assert.match(order.tse?.failureReason ?? "", /nicht erreichbar/);
  assert.equal(order.tse?.signature, "");
  assert.equal(order.tse?.signatureCounter, 0);
  assert.equal(
    order.tse?.processData,
    "Kassenbeleg-V1^0.00_4.50_0.00_0.00_0.00^4.50:Bar",
    "die Prozessdaten werden trotzdem gebildet und archiviert",
  );
});

test("TSE-Ausfall erst beim Abschluss wird ebenfalls dokumentiert", async () => {
  const tse = new MockTse();
  const ctx = context({ tse });
  const open = await beginTransaction(ctx);
  tse.available = false; // Netz bricht zwischen Erfassung und Bezahlen weg
  const cart = addProduct(emptyCart(tenant.id), crepe, { id: "l1" });
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 450, tendered: 450 }], { sequence: 1 });
  assert.equal(order.state, "PAID");
  assert.equal(isTseSecured(order), false);
  assert.match(order.tse?.failureReason ?? "", /nicht erreichbar/);
});

test("Kasse ohne TSE-Zuordnung wird als Ausfall behandelt", async () => {
  const ctx = context({ device: { ...device, tseClientId: null } });
  const open = await beginTransaction(ctx);
  assert.match(open.tseFailure ?? "", /nicht zugeordnet/);
  const cart = addProduct(emptyCart(tenant.id), crepe, { id: "l1" });
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 450 }], { sequence: 1 });
  assert.equal(isTseSecured(order), false);
});

test("Storno hebt den Beleg auf den Cent genau auf", async () => {
  const ctx = context();
  const open = await beginTransaction(ctx);
  let cart = addProduct(emptyCart(tenant.id), crepe, { id: "l1", quantity: 3 * ONE });
  cart = addProduct(cart, { ...crepe, id: "p2", name: "Cola", price: 250, taxKey: 1, taxKeyDineIn: null }, { id: "l2" });
  cart = setLineDiscount(cart, "l1", 137);
  cart = setOrderDiscount(cart, 113);
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: cartTotals(cart).total }], { sequence: 1 });

  const voidCart = buildVoidCart(order);
  const voidTotals = cartTotals(voidCart);
  assert.equal(voidTotals.total, -order.total, "Summe gegengleich");
  // Auch je Steuersatz muss sich alles aufheben, sonst stimmt die
  // Umsatzsteuervoranmeldung nicht.
  const originalByKey = new Map(cartTotals(cart).taxGroups.map((g) => [g.key, g.gross]));
  for (const group of voidTotals.taxGroups) {
    assert.equal(group.gross, -(originalByKey.get(group.key) ?? 0), `Steuersatz ${group.key}`);
  }
});

test("Storno eines nicht bezahlten Belegs ist nicht moeglich", async () => {
  const ctx = context();
  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart(tenant.id), crepe, { id: "l1" });
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 450 }], { sequence: 1 });
  assert.throws(() => buildVoidCart({ ...order, state: "OPEN" }), OrderError);
  assert.throws(() => buildVoidCart({ ...order, state: "VOIDED" }), OrderError);
});

test("Stornobeleg laeuft als eigener Beleg durch die TSE", async () => {
  const ctx = context();
  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart(tenant.id), crepe, { id: "l1" });
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: 450 }], { sequence: 1 });

  const voidOpen = await beginTransaction(ctx);
  const { order: voidOrder } = await finishTransaction(
    ctx,
    voidOpen,
    buildVoidCart(order),
    [{ method: "CASH", amount: -450 }],
    { sequence: 2 },
  );
  assert.equal(voidOrder.receiptNumber, "K1-000002");
  assert.notEqual(voidOrder.tse?.transactionNumber, order.tse?.transactionNumber);
  assert.equal(voidOrder.total, -450);
  assert.equal(voidOrder.tse?.processData, "Kassenbeleg-V1^0.00_-4.50_0.00_0.00_0.00^-4.50:Bar");
});
