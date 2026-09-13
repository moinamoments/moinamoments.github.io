import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE } from "./money.ts";
import { fixedClock, sequentialIds } from "./clock.ts";
import { addProduct, cartTotals, emptyCart } from "./cart.ts";
import type { Device, Product, Store, Tenant, User } from "./model.ts";
import { MockTse } from "./tse/mock.ts";
import { beginTransaction, finishTransaction, type TransactionContext } from "./order.ts";
import {
  MAX_PARKED_SALES,
  ParkError,
  type ParkedSale,
  parkSale,
  parkedMinutes,
  parkedSalesBlockingClosing,
  resumeSale,
  sortParkedSales,
} from "./park.ts";

const tenant: Tenant = {
  id: "t1", name: "Kiosk", legalName: "Kiosk", street: "Weg 1", postalCode: "24103", city: "Kiel",
  countryCode: "DE", taxNumber: "20/1", vatId: null, email: null, phone: null, smallBusiness: false,
  receiptFooter: null, currency: "EUR", timeZone: "Europe/Berlin", createdAt: "x",
};
const store: Store = { id: "s1", tenantId: "t1", name: "Stand", active: true };
const device: Device = {
  id: "d1", tenantId: "t1", storeId: "s1", name: "Kasse 1", serialNumber: "KASSE-1",
  tseClientId: "c1", receiptPrefix: "K1", active: true,
};
const user: User = { id: "u1", tenantId: "t1", name: "Bediener", role: "OWNER", active: true };
const kaffee: Product = {
  id: "p1", tenantId: "t1", categoryId: "c1", name: "Kaffee", price: 250, taxKey: 1,
  unit: "PIECE", sortOrder: 0, active: true, updatedAt: "x",
};
const crepe: Product = { ...kaffee, id: "p2", name: "Crepe", price: 450, taxKey: 2, taxKeyDineIn: 1 };

const base = {
  tenantId: "t1",
  storeId: "s1",
  deviceId: "d1",
  userId: "u1",
};

function context(clock = fixedClock("2026-09-26T09:00:00Z"), tse = new MockTse({ clock })) {
  const ctx: TransactionContext = { tenant, store, device, user, clock, newId: sequentialIds("o"), tse };
  return { ctx, clock, tse };
}

test("Vorgang parken haelt Warenkorb, Startzeit und TSE-Transaktion fest", async () => {
  const { ctx, clock, tse } = context();
  const open = await beginTransaction(ctx);
  clock.advance(40);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1", quantity: 2 * ONE });

  const parked = await parkSale({
    ...base,
    id: "park-1",
    label: " Tisch 4 ",
    cart,
    open,
    parkedAt: clock.now(),
    total: cartTotals(cart).total,
    existing: [],
    tse,
    tseClientId: device.tseClientId,
    processData: "Bestellung",
  });

  assert.equal(parked.label, "Tisch 4", "Rand wird geglaettet");
  assert.equal(parked.total, 500);
  assert.equal(parked.lineCount, 1);
  assert.equal(parked.startedAt, "2026-09-26T09:00:00+00:00", "die Startzeit ist die der ersten Position");
  assert.equal(parked.tseTransactionNumber, 1);
  assert.equal(parked.tseFailure, null);
});

test("fortsetzen stellt Startzeit und Transaktionsnummer wieder her", async () => {
  const { ctx, clock, tse } = context();
  const open = await beginTransaction(ctx);
  clock.advance(40);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1" });
  const parked = await parkSale({
    ...base, id: "park-1", label: "Tisch 4", cart, open, parkedAt: clock.now(),
    total: cartTotals(cart).total, existing: [], tse, tseClientId: device.tseClientId,
  });

  // Zwischendurch bedient die Kasse einen anderen Kunden.
  clock.advance(120);
  const other = await beginTransaction(ctx);
  const otherCart = addProduct(emptyCart("t1"), crepe, { id: "l9" });
  const { order: otherOrder } = await finishTransaction(ctx, other, otherCart, [{ method: "CASH", amount: 450 }], {
    sequence: 1,
  });
  assert.equal(otherOrder.receiptNumber, "K1-000001", "der spaetere Kunde zahlt zuerst");

  // Jetzt der geparkte Vorgang.
  clock.advance(60);
  const resumed = resumeSale(parked);
  assert.equal(resumed.open.startedAt, "2026-09-26T09:00:00+00:00");
  assert.equal(resumed.open.tseStart?.transactionNumber, 1);
  assert.equal(resumed.cart.lines.length, 1);

  const { order } = await finishTransaction(ctx, resumed.open, resumed.cart, [{ method: "CASH", amount: 250 }], {
    sequence: 2,
  });

  assert.equal(order.receiptNumber, "K1-000002", "und bekommt die naechste Nummer");
  // Der Beleg traegt die Startzeit der Bestellung, nicht die des Bezahlens.
  assert.equal(order.startedAt, "2026-09-26T09:00:00+00:00");
  assert.equal(order.paidAt, "2026-09-26T09:03:40+00:00");
  assert.equal(order.tse?.transactionNumber, 1, "dieselbe TSE-Transaktion wie beim Beginn");
  assert.notEqual(order.tse?.transactionNumber, otherOrder.tse?.transactionNumber);
});

test("beim Parken wird die offene TSE-Transaktion aktualisiert", async () => {
  const { ctx, clock, tse } = context();
  const open = await beginTransaction(ctx);
  const counterBefore = (await tse.startTransaction({ clientId: "hilfs" })).signatureCounter;

  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1" });
  await parkSale({
    ...base, id: "park-1", label: "Tisch 4", cart, open, parkedAt: clock.now(),
    total: 250, existing: [], tse, tseClientId: device.tseClientId, processData: "Bestellung",
  });

  // Das Aktualisieren erzeugt eine weitere Signatur - damit ist protokolliert,
  // was zum Zeitpunkt des Parkens im Warenkorb lag.
  const counterAfter = (await tse.startTransaction({ clientId: "hilfs2" })).signatureCounter;
  assert.ok(counterAfter > counterBefore + 1, `Zaehler ${counterBefore} -> ${counterAfter}`);
});

test("TSE-Ausfall beim Parken verhindert das Parken nicht", async () => {
  const { ctx, clock, tse } = context();
  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1" });

  tse.available = false; // Netz bricht weg, waehrend geparkt wird
  const parked = await parkSale({
    ...base, id: "park-1", label: "Tisch 4", cart, open, parkedAt: clock.now(),
    total: 250, existing: [], tse, tseClientId: device.tseClientId,
  });

  assert.equal(parked.lineCount, 1, "geparkt wird trotzdem");
  assert.match(parked.tseFailure ?? "", /Beim Parken nicht erreichbar/);
  assert.equal(parked.tseTransactionNumber, 1, "die begonnene Transaktion bleibt bekannt");
});

test("war die TSE schon beim Beginn aus, wird der Vorgang ohne Transaktion geparkt", async () => {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  const { ctx, tse } = context(clock, new MockTse({ clock, available: false }));
  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1" });

  const parked = await parkSale({
    ...base, id: "park-1", label: "Tisch 4", cart, open, parkedAt: clock.now(),
    total: 250, existing: [], tse, tseClientId: device.tseClientId,
  });
  assert.equal(parked.tseTransactionNumber, null);
  assert.match(parked.tseFailure ?? "", /nicht erreichbar/);

  const resumed = resumeSale(parked);
  assert.equal(resumed.open.tseStart, null);
  assert.equal(resumed.open.tseFailure, parked.tseFailure);
});

test("leerer Warenkorb und fehlende Bezeichnung werden abgewiesen", async () => {
  const { ctx, clock } = context();
  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1" });
  const request = {
    ...base, id: "park-1", label: "Tisch 4", cart, open, parkedAt: clock.now(), total: 250, existing: [],
  };

  await assert.rejects(() => parkSale({ ...request, cart: emptyCart("t1") }), ParkError);
  await assert.rejects(() => parkSale({ ...request, cart: emptyCart("t1") }), /leerer Vorgang/);
  await assert.rejects(() => parkSale({ ...request, label: "   " }), /Bezeichnung/);
  await assert.rejects(() => parkSale({ ...request, label: "x".repeat(100) }), /hoechstens 60/);
});

test("zwei Vorgaenge mit derselben Bezeichnung gibt es nicht", async () => {
  const { ctx, clock } = context();
  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1" });
  const first = await parkSale({
    ...base, id: "park-1", label: "Tisch 4", cart, open, parkedAt: clock.now(), total: 250, existing: [],
  });

  const request = {
    ...base, id: "park-2", label: "tisch 4", cart, open, parkedAt: clock.now(), total: 250, existing: [first],
  };
  await assert.rejects(() => parkSale(request), ParkError);
  await assert.rejects(() => parkSale(request), /schon vergeben/);
  // Eine andere Bezeichnung geht.
  await assert.doesNotReject(() => parkSale({ ...request, label: "Tisch 5" }));
});

test("die Zahl geparkter Vorgaenge ist begrenzt", async () => {
  const { ctx, clock } = context();
  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1" });
  const existing: ParkedSale[] = Array.from({ length: MAX_PARKED_SALES }, (_, index) => ({
    ...base, id: `p${index}`, label: `Vorgang ${index}`, cart, startedAt: "x", parkedAt: "x",
    tseTransactionNumber: null, tseFailure: null, total: 100, lineCount: 1,
  }));

  await assert.rejects(
    () => parkSale({ ...base, id: "neu", label: "Noch einer", cart, open, parkedAt: clock.now(), total: 250, existing }),
    /schon \d+ Vorgaenge geparkt/,
  );
});

test("die Liste sortiert den aeltesten nach oben", () => {
  const make = (id: string, parkedAt: string): ParkedSale => ({
    ...base, id, label: id, cart: emptyCart("t1"), startedAt: parkedAt, parkedAt,
    tseTransactionNumber: null, tseFailure: null, total: 100, lineCount: 1,
  });
  const sales = [
    make("spaet", "2026-09-26T12:00:00+02:00"),
    make("frueh", "2026-09-26T09:00:00+02:00"),
    make("mittag", "2026-09-26T11:00:00+02:00"),
  ];
  assert.deepEqual(sortParkedSales(sales).map((sale) => sale.id), ["frueh", "mittag", "spaet"]);

  // Auch ueber unterschiedliche Offsets hinweg richtig - als Zeichenkette
  // sortiert stimmte das nicht.
  const mixed = [make("utc", "2026-09-26T09:00:00+00:00"), make("berlin", "2026-09-26T09:00:00+02:00")];
  assert.deepEqual(sortParkedSales(mixed).map((sale) => sale.id), ["berlin", "utc"]);
});

test("die Wartezeit steht fuer den Hinweis in der Liste bereit", () => {
  const sale: ParkedSale = {
    ...base, id: "p1", label: "Tisch 4", cart: emptyCart("t1"),
    startedAt: "2026-09-26T09:00:00+02:00", parkedAt: "2026-09-26T09:00:00+02:00",
    tseTransactionNumber: 1, tseFailure: null, total: 250, lineCount: 1,
  };
  assert.equal(parkedMinutes(sale, "2026-09-26T09:35:00+02:00"), 35);
  assert.equal(parkedMinutes(sale, "2026-09-26T08:00:00+02:00"), 0, "nie negativ");
  assert.equal(parkedMinutes(sale, "kaputt"), 0);
});

test("geparkte Vorgaenge werden vor dem Kassenabschluss gemeldet", () => {
  assert.equal(parkedSalesBlockingClosing([]), null);

  const make = (id: string): ParkedSale => ({
    ...base, id, label: `Tisch ${id}`, cart: emptyCart("t1"), startedAt: "2026-09-26T09:00:00+02:00",
    parkedAt: "2026-09-26T09:00:00+02:00", tseTransactionNumber: 1, tseFailure: null, total: 250, lineCount: 1,
  });

  const warning = parkedSalesBlockingClosing([make("1"), make("2")]);
  assert.ok(warning);
  assert.ok(warning!.includes("2 Vorgaenge geparkt"));
  assert.ok(warning!.includes("Tisch 1"));
  assert.ok(warning!.includes("nicht verkauft"));

  // Bei vielen wird gekuerzt, damit die Meldung lesbar bleibt.
  const many = parkedSalesBlockingClosing(Array.from({ length: 9 }, (_, index) => make(String(index))));
  assert.ok(many!.includes("und 4 weitere"));
});
