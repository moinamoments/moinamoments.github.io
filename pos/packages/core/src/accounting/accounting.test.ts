import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountingError,
  DATEV_BOM,
  DATEV_COLUMNS,
  DATEV_FORMAT_VERSION,
  LEXWARE_COLUMNS,
  ONE,
  SKR03_PROPOSAL,
  SKR04_PROPOSAL,
  TAX_RATES,
  addDepositReturn,
  addProduct,
  beginTransaction,
  buildBookings,
  buildCashMovement,
  buildClosing,
  buildDatevFile,
  buildLexwareFile,
  buildPartialVoidCart,
  buildVoidCart,
  cartTotals,
  checkAccountMapping,
  checkBookingBalance,
  checkDatevHeader,
  createDepositCatalog,
  datevFileName,
  emptyCart,
  finishTransaction,
  fixedClock,
  lexwareFileName,
  MockTse,
  proposalFor,
  sequentialIds,
  usedInBookings,
  type AccountMapping,
  type BookingEntry,
  type Category,
  type ClosingReport,
  type DatevHeader,
  type Device,
  type Order,
  type Product,
  type Store,
  type Tenant,
  type TransactionContext,
  type User,
} from "../index.ts";

// --- Aufbau ---------------------------------------------------------------

const tenant: Tenant = {
  id: "t1", name: "Kiosk am Markt", legalName: "Petra Beispiel", street: "Marktweg 3",
  postalCode: "24103", city: "Kiel", countryCode: "DE", taxNumber: "20/123/45678",
  vatId: null, email: null, phone: null, smallBusiness: false, receiptFooter: null,
  currency: "EUR", timeZone: "Europe/Berlin", createdAt: "2026-01-01T00:00:00+01:00",
};
const store: Store = { id: "s1", tenantId: "t1", name: "Stand", street: null, postalCode: null, city: null, active: true };
const device: Device = {
  id: "d1", tenantId: "t1", storeId: "s1", name: "Kasse 1", serialNumber: "KASSE-0001",
  tseClientId: "client-1", receiptPrefix: "K1", active: true,
};
const user: User = { id: "u1", tenantId: "t1", name: "Petra", role: "OWNER", pinHash: null, active: true };

const categories: Category[] = [
  { id: "c-speisen", tenantId: "t1", name: "Speisen", parentId: null, color: null, sortOrder: 1, active: true },
  { id: "c-getr", tenantId: "t1", name: "Getraenke", parentId: null, color: null, sortOrder: 2, active: true },
  { id: "c-pfand", tenantId: "t1", name: "Pfand", parentId: null, color: null, sortOrder: 9, active: true },
];

function product(over: Partial<Product> & Pick<Product, "id" | "name" | "categoryId" | "taxKey">): Product {
  return {
    tenantId: "t1", description: null, price: 250, taxKeyDineIn: null, sku: null, unit: "PIECE",
    depositProductIds: null, isDeposit: false, color: null, image: null, trackStock: false,
    stock: 0, lowStockThreshold: null, sortOrder: 0, active: true, updatedAt: "2026-01-01T00:00:00+01:00",
    ...over,
  };
}

const becher = product({ id: "p-becher", name: "Becher", categoryId: "c-pfand", price: 100, taxKey: TAX_RATES.NORMAL.key, isDeposit: true });
const kaffee = product({ id: "p-kaffee", name: "Kaffee", categoryId: "c-getr", price: 250, taxKey: TAX_RATES.NORMAL.key, depositProductIds: ["p-becher"] });
const crepe = product({ id: "p-crepe", name: "Crepe", categoryId: "c-speisen", price: 450, taxKey: TAX_RATES.REDUCED.key, taxKeyDineIn: TAX_RATES.NORMAL.key });
const products = [becher, kaffee, crepe];
const deposits = createDepositCatalog(products);

const NOW = "2026-09-26T09:00:00+02:00";
let ids = sequentialIds("id");

function context(): TransactionContext {
  const clock = fixedClock("2026-09-26T09:00:00+02:00");
  return { tenant, store, device, user, clock, newId: ids, tse: new MockTse({ clock }) };
}

/** Einen Beleg erzeugen, wie `pay()` es tut. */
async function sell(
  build: (cart: ReturnType<typeof emptyCart>) => ReturnType<typeof emptyCart>,
  payments: readonly { method: "CASH" | "CARD_DEBIT"; amount?: number }[],
  sequence: number,
): Promise<Order> {
  const ctx = context();
  const open = await beginTransaction(ctx);
  const cart = build(emptyCart(tenant.id, "TAKEAWAY"));
  const total = cartTotals(cart, { deposits }).total;
  const resolved =
    payments.length === 1
      ? [{ method: payments[0]!.method, amount: total, ...(payments[0]!.method === "CASH" ? { tendered: total } : {}) }]
      : payments.map((payment) => ({ method: payment.method, amount: payment.amount ?? 0 }));
  const { order } = await finishTransaction(ctx, open, cart, resolved, { sequence, deposits });
  return order;
}

/** Ein vollstaendiger Abschluss mit Belegen und Bargeldbewegungen. */
async function day(options: { readonly cashCount?: readonly { denomination: number; count: number }[] } = {}): Promise<{
  report: ClosingReport;
  orders: Order[];
}> {
  ids = sequentialIds("id");
  const orders: Order[] = [];

  // Bar, 19 % mit Pfand: 2,50 + 1,00 = 3,50
  orders.push(await sell((cart) => addProduct(cart, kaffee, { id: ids() }), [{ method: "CASH" }], 1));
  // Karte, 7 %: 4,50
  orders.push(await sell((cart) => addProduct(cart, crepe, { id: ids() }), [{ method: "CARD_DEBIT" }], 2));
  // Bar, gemischt 7 % und 19 % mit Pfand: 4,50 + 2,50 + 1,00 = 8,00
  orders.push(
    await sell(
      (cart) => addProduct(addProduct(cart, crepe, { id: ids() }), kaffee, { id: ids() }),
      [{ method: "CASH" }],
      3,
    ),
  );

  const withdrawal = buildCashMovement({
    id: ids(), tenantId: tenant.id, storeId: store.id, deviceId: device.id,
    type: "WITHDRAWAL", amount: 2000, reason: "Einkauf Milch", userId: user.id, createdAt: NOW,
  });

  const report = buildClosing({
    tenant, store, device, userId: user.id, closingId: "z1", number: 1,
    from: NOW, to: "2026-09-26T22:00:00+02:00", createdAt: "2026-09-26T22:00:05+02:00",
    orders, cashMovements: [withdrawal],
    ...(options.cashCount ? { cashCount: options.cashCount } : {}),
  });
  return { report, orders };
}

const mapping = SKR03_PROPOSAL;

// --- Kontenzuordnung ------------------------------------------------------

test("die Vorschlaege sind als unbestaetigt gekennzeichnet", () => {
  // Wichtiger als jede Kontonummer: niemand soll glauben, die Zuordnung sei
  // abgestimmt.
  assert.equal(SKR03_PROPOSAL.confirmed, false);
  assert.equal(SKR04_PROPOSAL.confirmed, false);
  assert.equal(proposalFor("SKR04").chart, "SKR04");
  assert.equal(proposalFor("CUSTOM").chart, "SKR03", "ohne Kontenrahmen ist SKR03 der Ausgangspunkt");
});

test("die Pruefung meldet fehlende Konten einzeln und alle auf einmal", () => {
  const broken: AccountMapping = {
    ...mapping,
    revenue: { [TAX_RATES.NORMAL.key]: "8400" },
    payment: { CASH: "1000" },
    clearing: "",
  };
  const check = checkAccountMapping(broken, {
    taxKeys: [TAX_RATES.NORMAL.key, TAX_RATES.REDUCED.key],
    methods: ["CASH", "CARD_DEBIT"],
    hasDeposit: true,
  });
  assert.equal(check.ok, false);
  assert.equal(check.problems.length, 3, check.problems.join(" | "));
  assert.ok(check.problems.some((problem) => problem.includes("7 %")));
  assert.ok(check.problems.some((problem) => problem.includes("CARD_DEBIT")));
  assert.ok(check.problems.some((problem) => problem.includes("Verrechnungskonto")));
});

test("eine Kontonummer mit falscher Laenge wird abgewiesen", () => {
  const wrong: AccountMapping = { ...mapping, revenue: { [TAX_RATES.NORMAL.key]: "84" } };
  const check = checkAccountMapping(wrong, { taxKeys: [TAX_RATES.NORMAL.key] });
  assert.equal(check.ok, false);
  assert.match(check.problems[0] ?? "", /2 Stellen/);

  // Ein Personenkonto ist eine Stelle laenger und zulaessig.
  const person: AccountMapping = { ...mapping, payment: { ...mapping.payment, INVOICE: "10001" } };
  assert.equal(checkAccountMapping(person, { methods: ["INVOICE"] }).ok, true);
});

test("Buchstaben in einer Kontonummer werden abgewiesen", () => {
  const wrong: AccountMapping = { ...mapping, clearing: "159A" };
  const check = checkAccountMapping(wrong);
  assert.equal(check.ok, false);
  assert.match(check.problems[0] ?? "", /nur Ziffern/);
});

test("ohne BU-Schluessel und ohne Bestaetigung gibt es Hinweise, aber keinen Fehler", () => {
  const check = checkAccountMapping(mapping, { taxKeys: [TAX_RATES.NORMAL.key], methods: ["CASH"] });
  assert.equal(check.ok, true);
  assert.equal(check.notes.length, 2);
  assert.ok(check.notes.some((note) => note.includes("Steuerberater")));
  assert.ok(check.notes.some((note) => note.includes("Automatikkonten")));
});

// --- Buchungssaetze -------------------------------------------------------

test("das Verrechnungskonto geht auf null auf", async () => {
  // Die wichtigste Zusicherung dieses Moduls. "Soll gleich Haben" waere hier
  // keine: jede Zeile ist ein vollstaendiger Satz und bucht denselben Betrag
  // einmal ins Soll und einmal ins Haben.
  const { report, orders } = await day();
  const entries = buildBookings({ report, orders, mapping });
  const balance = checkBookingBalance(entries, mapping.clearing);

  assert.equal(balance.ok, true, balance.problems.join(" | "));
  assert.equal(balance.openClearing, 0);
  assert.equal(balance.total, entries.reduce((sum, entry) => sum + entry.amount, 0));

  // Die Salden je Konto sind die Zahlen, die der Steuerberater sieht.
  // Erloese stehen im Haben, also negativ; die Kasse im Soll, also positiv.
  assert.equal(balance.byAccount["8400"], -700, "2 x 2,50 Kaffee im Haben");
  assert.equal(balance.byAccount["8300"], -900, "2 x 4,50 Crepe im Haben");
  assert.equal(balance.byAccount["1000"], 1150 - 2000, "Barumsatz minus Entnahme");
});

test("ein Stapel mit einer fehlenden Zahlung wird als unausgeglichen erkannt", async () => {
  // Genau der Fall, den die Pruefung faengt: Umsatz ohne Geld dahinter.
  const { report, orders } = await day();
  const entries = buildBookings({ report, orders, mapping });
  const withoutPayment = entries.filter((entry) => entry.kind !== "PAYMENT" || entry.documentField !== "K1-000001");

  const balance = checkBookingBalance(withoutPayment, mapping.clearing);
  assert.equal(balance.ok, false);
  assert.notEqual(balance.openClearing, 0);
  assert.match(balance.problems[0] ?? "", /Verrechnungskonto/);
});

test("Konto gleich Gegenkonto wird abgewiesen", () => {
  const entry: BookingEntry = {
    date: "2026-09-26", amount: 100, side: "S", account: "1000", contraAccount: "1000",
    text: "unsinnig", documentField: "K1-000001", taxKey: null, taxCode: "", kind: "PAYMENT",
  };
  const balance = checkBookingBalance([entry], mapping.clearing);
  assert.equal(balance.ok, false);
  assert.match(balance.problems[0] ?? "", /gleich/);
});

test("Erloese laufen je Steuersatz, Pfand auf sein eigenes Konto", async () => {
  const { report, orders } = await day();
  const entries = buildBookings({ report, orders, mapping });

  const revenue19 = entries.filter((entry) => entry.kind === "REVENUE" && entry.taxKey === TAX_RATES.NORMAL.key);
  const revenue7 = entries.filter((entry) => entry.kind === "REVENUE" && entry.taxKey === TAX_RATES.REDUCED.key);
  const deposit = entries.filter((entry) => entry.kind === "DEPOSIT");

  // Zwei Kaffee zu 2,50 auf zwei Belegen.
  assert.equal(revenue19.reduce((sum, entry) => sum + entry.amount, 0), 500);
  assert.equal(revenue19.every((entry) => entry.account === "8400"), true);
  // Zwei Crepes zu 4,50.
  assert.equal(revenue7.reduce((sum, entry) => sum + entry.amount, 0), 900);
  assert.equal(revenue7.every((entry) => entry.account === "8300"), true);
  // Zwei Becher zu 1,00 - auf dem Pfandkonto, nicht im Warenumsatz.
  assert.equal(deposit.reduce((sum, entry) => sum + entry.amount, 0), 200);
  assert.equal(deposit.every((entry) => entry.account === mapping.deposit), true);

  // Alle Erloese im Haben, Gegenkonto Verrechnung.
  assert.equal(entries.filter((entry) => entry.kind === "REVENUE").every((entry) => entry.side === "H"), true);
  assert.equal(entries.filter((entry) => entry.kind === "REVENUE").every((entry) => entry.contraAccount === mapping.clearing), true);
});

test("Zahlungen laufen je Zahlart auf ihr Geldkonto", async () => {
  const { report, orders } = await day();
  const entries = buildBookings({ report, orders, mapping });
  const payments = entries.filter((entry) => entry.kind === "PAYMENT");

  const cash = payments.filter((entry) => entry.account === "1000");
  const card = payments.filter((entry) => entry.account === "1360");
  // 3,50 + 8,00 bar, 4,50 mit Karte.
  assert.equal(cash.reduce((sum, entry) => sum + entry.amount, 0), 1150);
  assert.equal(card.reduce((sum, entry) => sum + entry.amount, 0), 450);
  assert.equal(payments.every((entry) => entry.side === "S"), true, "Geldeingang im Soll");
  // Ein Geldkonto traegt keine Umsatzsteuer - der Satz steht an der
  // Erloesbuchung.
  assert.equal(payments.every((entry) => entry.taxCode === "" && entry.taxKey === null), true);
});

test("jede Zeile traegt ihre Belegnummer", async () => {
  const { report, orders } = await day();
  const entries = buildBookings({ report, orders, mapping });
  const belegBookings = entries.filter((entry) => entry.kind !== "CASH_MOVEMENT" && entry.kind !== "CASH_DIFFERENCE");
  assert.ok(belegBookings.length > 0);
  assert.equal(belegBookings.every((entry) => /^K1-\d+$/.test(entry.documentField)), true);
});

test("ein gemischt bezahlter Beleg wird nicht umgelegt, sondern verrechnet", async () => {
  // Der Fall, um den es beim Verrechnungskonto geht: 7 % und 19 % auf einem
  // Beleg, halb bar, halb mit Karte. Jede direkte Zuordnung waere erfunden.
  ids = sequentialIds("mix");
  const order = await sell(
    (cart) => addProduct(addProduct(cart, crepe, { id: ids() }), kaffee, { id: ids() }),
    [
      { method: "CASH", amount: 400 },
      { method: "CARD_DEBIT", amount: 400 },
    ],
    9,
  );
  assert.equal(order.total, 800);

  const report = buildClosing({
    tenant, store, device, userId: user.id, closingId: "z-mix", number: 2,
    from: NOW, to: "2026-09-26T22:00:00+02:00", createdAt: "2026-09-26T22:00:05+02:00",
    orders: [order], cashMovements: [],
  });
  const entries = buildBookings({ report, orders: [order], mapping });
  const balance = checkBookingBalance(entries, mapping.clearing);
  assert.equal(balance.ok, true, balance.problems.join(" | "));

  // Drei Erloesseiten (7 %, 19 %, Pfand) und zwei Zahlungen - und trotzdem
  // ausgeglichen.
  assert.equal(entries.filter((entry) => entry.kind === "PAYMENT").length, 2);
  assert.equal(entries.filter((entry) => entry.contraAccount === mapping.clearing).length, 5);
});

test("ein Storno dreht die Buchung, statt einen negativen Betrag zu schreiben", async () => {
  ids = sequentialIds("storno");
  const original = await sell((cart) => addProduct(cart, kaffee, { id: ids() }), [{ method: "CASH" }], 20);

  const ctx = context();
  const voidCart = buildVoidCart(original);
  const open = await beginTransaction(ctx);
  const { order: voided } = await finishTransaction(
    ctx, open, voidCart, [{ method: "CASH", amount: -original.total }],
    { sequence: 21, note: `Storno zu ${original.receiptNumber}` },
  );
  const stored: Order = { ...voided, voidsOrderId: original.id };

  const report = buildClosing({
    tenant, store, device, userId: user.id, closingId: "z-storno", number: 3,
    from: NOW, to: "2026-09-26T22:00:00+02:00", createdAt: "2026-09-26T22:00:05+02:00",
    orders: [original, stored], cashMovements: [],
  });
  const entries = buildBookings({ report, orders: [original, stored], mapping });

  const stornoEntries = entries.filter((entry) => entry.documentField === stored.receiptNumber);
  assert.ok(stornoEntries.length > 0);
  // Betraege bleiben positiv, die Seiten sind gedreht.
  assert.equal(stornoEntries.every((entry) => entry.amount > 0), true);
  assert.equal(stornoEntries.filter((entry) => entry.kind === "REVENUE").every((entry) => entry.side === "S"), true);
  assert.equal(stornoEntries.filter((entry) => entry.kind === "PAYMENT").every((entry) => entry.side === "H"), true);
  assert.ok(stornoEntries.some((entry) => entry.text.startsWith("Storno")));

  // Verkauf und Storno heben sich im Stapel auf.
  const balance = checkBookingBalance(entries, mapping.clearing);
  assert.equal(balance.ok, true, balance.problems.join(" | "));
});

test("ein Teilstorno bucht den anteiligen Betrag", async () => {
  ids = sequentialIds("teil");
  const original = await sell((cart) => addProduct(cart, kaffee, { id: ids(), quantity: 2 * ONE }), [{ method: "CASH" }], 30);
  assert.equal(original.total, 700, "2 x 2,50 + 2 x 1,00 Pfand");

  const line = original.lines.find((entry) => entry.productId === kaffee.id)!;
  const ctx = context();
  const partialCart = buildPartialVoidCart(original, [{ lineId: line.id, quantity: ONE }]);
  const amount = cartTotals(partialCart, {}).total;
  const { order: partial } = await finishTransaction(
    ctx, await beginTransaction(ctx), partialCart, [{ method: "CASH", amount }],
    { sequence: 31, note: `Teilstorno zu ${original.receiptNumber}` },
  );
  const stored: Order = { ...partial, voidsOrderId: original.id };
  assert.equal(stored.total, -350);

  const report = buildClosing({
    tenant, store, device, userId: user.id, closingId: "z-teil", number: 4,
    from: NOW, to: "2026-09-26T22:00:00+02:00", createdAt: "2026-09-26T22:00:05+02:00",
    orders: [original, stored], cashMovements: [],
  });
  const entries = buildBookings({ report, orders: [original, stored], mapping });
  const balance = checkBookingBalance(entries, mapping.clearing);
  assert.equal(balance.ok, true, balance.problems.join(" | "));

  // Vom Erloes 19 % bleiben 2,50 stehen, vom Pfand 1,00.
  const net = (kind: BookingEntry["kind"]): number =>
    entries
      .filter((entry) => entry.kind === kind)
      .reduce((sum, entry) => sum + (entry.side === "H" ? entry.amount : -entry.amount), 0);
  assert.equal(net("REVENUE"), 250);
  assert.equal(net("DEPOSIT"), 100);
});

test("eine Pfandrueckgabe bucht gegen das Pfandkonto", async () => {
  ids = sequentialIds("pfand");
  const order = await sell(
    (cart) =>
      addDepositReturn(cart, { productId: becher.id, name: becher.name, price: becher.price ?? 0, taxKey: becher.taxKey }, {
        id: ids(),
        quantity: 2 * ONE,
      }),
    [{ method: "CASH" }],
    40,
  );
  assert.equal(order.total, -200);

  const report = buildClosing({
    tenant, store, device, userId: user.id, closingId: "z-pfand", number: 5,
    from: NOW, to: "2026-09-26T22:00:00+02:00", createdAt: "2026-09-26T22:00:05+02:00",
    orders: [order], cashMovements: [],
  });
  const entries = buildBookings({ report, orders: [order], mapping });

  const deposit = entries.filter((entry) => entry.kind === "DEPOSIT");
  assert.equal(deposit.length, 1);
  assert.equal(deposit[0]?.amount, 200);
  assert.equal(deposit[0]?.side, "S", "eine Rueckgabe mindert den Pfanderloes");
  // Die Auszahlung mindert die Kasse.
  const payment = entries.find((entry) => entry.kind === "PAYMENT");
  assert.equal(payment?.side, "H");
  assert.equal(checkBookingBalance(entries, mapping.clearing).ok, true);
});

test("Bargeldbewegungen werden gebucht, die Tageseroeffnung nicht", async () => {
  const { report, orders } = await day();
  const entries = buildBookings({ report, orders, mapping });
  const movements = entries.filter((entry) => entry.kind === "CASH_MOVEMENT");

  assert.equal(movements.length, 1);
  // Privatentnahme im Soll, Kasse im Haben.
  assert.equal(movements[0]?.account, "1800");
  assert.equal(movements[0]?.contraAccount, "1000");
  assert.equal(movements[0]?.side, "S");
  assert.equal(movements[0]?.amount, 2000);
  assert.match(movements[0]?.text ?? "", /Einkauf Milch/);
  // Der gezaehlte Anfangsbestand ist keine Buchung - ihn zu buchen wuerde ihn
  // verdoppeln.
  assert.equal(entries.some((entry) => entry.text.includes("Anfangsbestand")), false);
});

test("eine Kassendifferenz wird gebucht, eine Null nicht", async () => {
  // Soll: 11,50 bar - 20,00 Entnahme = -8,50. Gezaehlt 8,00 zu wenig ergibt
  // einen Fehlbetrag.
  const withDifference = await day({ cashCount: [{ denomination: 500, count: 1 }] });
  assert.equal(withDifference.report.expectedCash, -850);
  assert.equal(withDifference.report.countedCash, 500);
  assert.equal(withDifference.report.cashDifference, 1350);

  const entries = buildBookings({ report: withDifference.report, orders: withDifference.orders, mapping });
  const difference = entries.filter((entry) => entry.kind === "CASH_DIFFERENCE");
  assert.equal(difference.length, 1);
  assert.equal(difference[0]?.amount, 1350);
  assert.equal(difference[0]?.side, "H", "ein Ueberschuss ist ein Ertrag");
  assert.equal(checkBookingBalance(entries, mapping.clearing).ok, true);

  // Ohne Zaehlung gibt es keine Differenz und keine Buchung.
  const withoutCount = await day();
  const plain = buildBookings({ report: withoutCount.report, orders: withoutCount.orders, mapping });
  assert.equal(plain.some((entry) => entry.kind === "CASH_DIFFERENCE"), false);
});

test("verdichtet je Abschluss ergibt weniger Zeilen und dieselbe Summe", async () => {
  const { report, orders } = await day();
  const receipts = buildBookings({ report, orders, mapping, granularity: "RECEIPT" });
  const summary = buildBookings({ report, orders, mapping, granularity: "CLOSING" });

  assert.ok(summary.length < receipts.length);
  assert.equal(checkBookingBalance(summary, mapping.clearing).ok, true);
  assert.equal(
    checkBookingBalance(summary, mapping.clearing).total,
    checkBookingBalance(receipts, mapping.clearing).total,
    "dieselbe Summe, nur anders verteilt",
  );
  // Und dieselben Salden je Konto - das ist, was in der Buchhaltung ankommt.
  assert.deepEqual(
    checkBookingBalance(summary, mapping.clearing).byAccount,
    checkBookingBalance(receipts, mapping.clearing).byAccount,
  );
  // Der Bezug auf den einzelnen Beleg fehlt - dafuer steht die Spanne im Text.
  assert.equal(summary.every((entry) => !entry.documentField.startsWith("K1-")), true);
  assert.ok(summary.some((entry) => entry.text.includes("K1-")));
});

test("ein fehlendes Konto bricht ab, statt eine Luecke zu schreiben", async () => {
  const { report, orders } = await day();
  const incomplete: AccountMapping = { ...mapping, revenue: { [TAX_RATES.NORMAL.key]: "8400" } };
  assert.throws(() => buildBookings({ report, orders, mapping: incomplete }), AccountingError);
  assert.throws(() => buildBookings({ report, orders, mapping: incomplete }), /Erloeskonto fuer 7 %/);
});

test("welche Konten gebraucht werden, sagt usedInBookings", async () => {
  const { report, orders } = await day({ cashCount: [{ denomination: 500, count: 1 }] });
  const used = usedInBookings(report, orders);
  assert.deepEqual(used.taxKeys, [TAX_RATES.NORMAL.key, TAX_RATES.REDUCED.key]);
  assert.deepEqual([...used.methods].sort(), ["CARD_DEBIT", "CASH"]);
  assert.deepEqual(used.movements, ["WITHDRAWAL"]);
  assert.equal(used.hasDeposit, true);
  assert.equal(used.hasCashDifference, true);
  // Die Kasse ist immer dabei: Bewegungen und Differenz laufen darueber.
  assert.ok(used.methods.includes("CASH"));
});

// --- DATEV ----------------------------------------------------------------

const header: DatevHeader = {
  consultantNumber: 123456,
  clientNumber: 4711,
  fiscalYearStart: "2026-01-01",
  from: "2026-09-26",
  to: "2026-09-26",
  label: "Kasse 1 Markttag",
  createdBy: "Kassensystem",
  createdAt: "2026-09-26T22:05:00+02:00",
  initials: "PB",
};

test("der Kopf wird geprueft, bevor die Datei entsteht", () => {
  assert.equal(checkDatevHeader(header).ok, true);

  const bad = checkDatevHeader({ ...header, consultantNumber: 12, clientNumber: 0, label: "", initials: "XYZ" });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 4, bad.problems.join(" | "));
  assert.ok(bad.problems.some((problem) => problem.includes("Beraternummer")));
  assert.ok(bad.problems.some((problem) => problem.includes("anderen Betriebs")), "die Folge einer falschen Nummer steht dabei");

  const reversed = checkDatevHeader({ ...header, from: "2026-09-27", to: "2026-09-26" });
  assert.equal(reversed.ok, false);
  assert.ok(reversed.problems.some((problem) => problem.includes("endet vor")));
});

test("eine Datei mit falschem Kopf wird nicht geschrieben", async () => {
  const { report, orders } = await day();
  const entries = buildBookings({ report, orders, mapping });
  assert.throws(() => buildDatevFile(entries, { ...header, clientNumber: 0 }, mapping), AccountingError);
});

test("Kopfzeile und Spaltenzeile haben die vorgeschriebene Form", async () => {
  const { report, orders } = await day();
  const file = buildDatevFile(buildBookings({ report, orders, mapping }), header, mapping);

  assert.ok(file.startsWith(DATEV_BOM), "ohne Marke liest DATEV UTF-8 als Windows-1252");
  const lines = file.slice(DATEV_BOM.length).split("\r\n");
  const head = lines[0]!.split(";");

  assert.equal(head[0], '"EXTF"');
  assert.equal(head[1], String(DATEV_FORMAT_VERSION));
  assert.equal(head[2], "21", "Formatkategorie Buchungsstapel");
  assert.equal(head[3], '"Buchungsstapel"');
  assert.equal(head[5], "20260926220500000", "erzeugt am, als JJJJMMTTHHMMSSFFF");
  assert.equal(head[10], "123456", "Beraternummer");
  assert.equal(head[11], "4711", "Mandantennummer");
  assert.equal(head[12], "20260101", "Beginn des Wirtschaftsjahres");
  assert.equal(head[13], "4", "Sachkontenlaenge");
  assert.equal(head[14], "20260926");
  assert.equal(head[15], "20260926");
  assert.equal(head[16], '"Kasse 1 Markttag"');
  assert.equal(head[20], "0", "nicht festgeschrieben - ein Stapel muss korrigierbar bleiben");
  assert.equal(head[21], '"EUR"');
  assert.equal(head[26], '"03"', "Kontenrahmen SKR03");
  assert.equal(head.length, 31);

  assert.deepEqual(lines[1]!.split(";").map((value) => value.replace(/^"|"$/g, "")), [...DATEV_COLUMNS]);
});

test("eine Buchungszeile schreibt Betrag mit Komma, Konten ohne Anfuehrungszeichen", async () => {
  const { report, orders } = await day();
  const file = buildDatevFile(buildBookings({ report, orders, mapping }), header, mapping);
  const lines = file.slice(DATEV_BOM.length).trimEnd().split("\r\n");
  const first = lines[2]!.split(";");

  assert.match(first[0]!, /^"\d+,\d{2}"$/, "Dezimalkomma, zwei Stellen, ohne Vorzeichen");
  assert.ok(first[1] === '"S"' || first[1] === '"H"');
  assert.equal(first[2], '"EUR"');
  assert.match(first[6]!, /^\d+$/, "Konto ohne Anfuehrungszeichen");
  assert.match(first[7]!, /^\d+$/, "Gegenkonto ohne Anfuehrungszeichen");
  assert.equal(first[8], '""', "BU-Schluessel leer bei Automatikkonten");
  assert.equal(first[9], "2609", "Belegdatum als TTMM");
  assert.match(first[10]!, /^"K1-\d+"$/);
  assert.equal(first.length, 14);
  // Eine Zeile je Buchung, plus zwei Kopfzeilen.
  assert.equal(lines.length, buildBookings({ report, orders, mapping }).length + 2);
});

test("Anfuehrungszeichen im Buchungstext zerlegen die Datei nicht", () => {
  const entry: BookingEntry = {
    date: "2026-09-26", amount: 450, side: "H", account: "8300", contraAccount: "1590",
    text: 'Erloes Crepe "Hausgemacht" Beleg K1-000001', documentField: "K1-000001",
    taxKey: TAX_RATES.REDUCED.key, taxCode: "", kind: "REVENUE",
  };
  const file = buildDatevFile([entry], header, mapping);
  const line = file.slice(DATEV_BOM.length).trimEnd().split("\r\n")[2]!;
  assert.ok(line.includes('"Erloes Crepe ""Hausgemacht"" Beleg K1-000001"'));
  // Die Zeile hat weiterhin genau 14 Felder - das Anfuehrungszeichen hat kein
  // Feld aufgebrochen.
  assert.equal(line.split(";").length, 14);
});

test("ein negativer Betrag kommt nicht in die Datei", () => {
  const entry: BookingEntry = {
    date: "2026-09-26", amount: -100, side: "H", account: "8400", contraAccount: "1590",
    text: "falsch", documentField: "K1-000001", taxKey: null, taxCode: "", kind: "REVENUE",
  };
  assert.throws(() => buildDatevFile([entry], header, mapping), /nicht negativ/);
});

test("ein BU-Schluessel wird uebernommen, wenn einer eingestellt ist", async () => {
  const { report, orders } = await day();
  const withCodes: AccountMapping = {
    ...mapping,
    taxCode: { [TAX_RATES.NORMAL.key]: "9", [TAX_RATES.REDUCED.key]: "8" },
  };
  const entries = buildBookings({ report, orders, mapping: withCodes });
  const revenue = entries.find((entry) => entry.kind === "REVENUE" && entry.taxKey === TAX_RATES.NORMAL.key)!;
  assert.equal(revenue.taxCode, "9");

  const file = buildDatevFile(entries, header, withCodes);
  assert.ok(file.includes(';"9";'));
  // Der Hinweis auf die Automatikkonten verschwindet, sobald Schluessel da sind.
  assert.equal(
    checkAccountMapping(withCodes, { taxKeys: [TAX_RATES.NORMAL.key] }).notes.some((note) => note.includes("Automatikkonten")),
    false,
  );
});

test("der Dateiname nennt Bezeichnung und Zeitraum", () => {
  assert.equal(datevFileName(header), "EXTF_kasse-1-markttag_20260926-20260926.csv");
  assert.equal(
    datevFileName({ ...header, label: "Müller & Söhne" }),
    "EXTF_mueller-soehne_20260926-20260926.csv",
  );
});

test("SKR04 schreibt seine eigenen Konten und seinen Kontenrahmen", async () => {
  const { report, orders } = await day();
  const entries = buildBookings({ report, orders, mapping: SKR04_PROPOSAL });
  assert.ok(entries.some((entry) => entry.account === "4400"), "Erloese 19 % SKR04");
  assert.ok(entries.some((entry) => entry.account === "1600"), "Kasse SKR04");
  assert.equal(checkBookingBalance(entries, SKR04_PROPOSAL.clearing).ok, true);

  const file = buildDatevFile(entries, header, SKR04_PROPOSAL);
  assert.equal(file.slice(DATEV_BOM.length).split("\r\n")[0]!.split(";")[26], '"04"');
});

test("eigene Konten lassen das Kontenrahmenfeld leer", async () => {
  const { report, orders } = await day();
  const own: AccountMapping = { ...mapping, chart: "CUSTOM" };
  const file = buildDatevFile(buildBookings({ report, orders, mapping: own }), header, own);
  assert.equal(file.slice(DATEV_BOM.length).split("\r\n")[0]!.split(";")[26], '""');
});

// --- Lexware --------------------------------------------------------------

test("Lexware schreibt Soll- und Habenkonto in eigene Spalten", async () => {
  const { report, orders } = await day();
  const entries = buildBookings({ report, orders, mapping });
  const file = buildLexwareFile(entries);
  const lines = file.replace(/^﻿/, "").trimEnd().split("\r\n");

  assert.deepEqual(lines[0]!.split(";"), [...LEXWARE_COLUMNS]);
  assert.equal(lines.length, entries.length + 1);

  // Erste Buchung: Erloes im Haben. In Lexware steht das Erloeskonto damit im
  // Haben und die Verrechnung im Soll - genau umgekehrt zu DATEV.
  const first = entries[0]!;
  const row = lines[1]!.split(";");
  assert.equal(row[0], "26.09.2026", "volles Datum, nicht nur Tag und Monat");
  assert.equal(row[1], first.documentField);
  assert.match(row[3]!, /^\d+,\d{2}$/);
  if (first.side === "H") {
    assert.equal(row[4], first.contraAccount, "Sollkonto ist das Gegenkonto");
    assert.equal(row[5], first.account);
  } else {
    assert.equal(row[4], first.account);
    assert.equal(row[5], first.contraAccount);
  }
});

test("Lexware nennt den Steuersatz in Prozent, aber nicht bei Geldkonten", async () => {
  const { report, orders } = await day();
  const file = buildLexwareFile(buildBookings({ report, orders, mapping }));
  const rows = file.replace(/^﻿/, "").trimEnd().split("\r\n").slice(1).map((line) => line.split(";"));

  assert.ok(rows.some((row) => row[6] === "19" && row[7] === "Erloes"));
  assert.ok(rows.some((row) => row[6] === "7" && row[7] === "Erloes"));
  // Zahlungen und Kassenbewegungen tragen keinen Satz.
  assert.equal(rows.filter((row) => row[7] === "Zahlung").every((row) => row[6] === ""), true);
  assert.equal(rows.filter((row) => row[7] === "Kassenbewegung").every((row) => row[6] === ""), true);
});

test("steuerfrei bleibt in Lexware leer und wird nicht als 0 % ausgegeben", () => {
  // "steuerfrei", "nicht steuerbar" und "nicht ermittelbar" haben alle 0 %.
  // Eine 0 wuerde eine Aussage vortaeuschen, die in der Zahl nicht steckt.
  const entry: BookingEntry = {
    date: "2026-09-26", amount: 1000, side: "H", account: "8200", contraAccount: "1590",
    text: "Erloes steuerfrei", documentField: "K1-000001",
    taxKey: TAX_RATES.EXEMPT.key, taxCode: "", kind: "REVENUE",
  };
  const row = buildLexwareFile([entry]).replace(/^﻿/, "").trimEnd().split("\r\n")[1]!.split(";");
  assert.equal(row[6], "");
});

test("ein Semikolon im Buchungstext zerlegt die Lexware-Datei nicht", () => {
  const entry: BookingEntry = {
    date: "2026-09-26", amount: 450, side: "H", account: "8300", contraAccount: "1590",
    text: "Erloes 7 %; Beleg K1-000001", documentField: "K1-000001",
    taxKey: TAX_RATES.REDUCED.key, taxCode: "", kind: "REVENUE",
  };
  const line = buildLexwareFile([entry]).replace(/^﻿/, "").trimEnd().split("\r\n")[1]!;
  assert.ok(line.includes('"Erloes 7 %; Beleg K1-000001"'));
  assert.equal(line.split(";").length, 9, "das Semikolon steckt im Feld, nicht dazwischen");
});

test("der Lexware-Dateiname nennt den Zeitraum", () => {
  assert.equal(lexwareFileName("2026-09-01", "2026-09-30"), "lexware-buchungen-20260901-20260930.csv");
});

test("beide Formate beschreiben denselben Stapel", async () => {
  // Dieselben Saetze, zwei Schreibweisen: die Summe der Betraege muss gleich
  // sein, sonst rechnet ein Format anders.
  const { report, orders } = await day();
  const entries = buildBookings({ report, orders, mapping });

  const sumOf = (text: string, columnCount: number, amountColumn: number): number =>
    text
      .replace(/^﻿/, "")
      .trimEnd()
      .split("\r\n")
      .filter((line) => line.split(";").length === columnCount)
      .map((line) => line.split(";")[amountColumn]!.replace(/"/g, "").replace(",", "."))
      .filter((value) => /^\d+(\.\d+)?$/.test(value))
      .reduce((sum, value) => sum + Math.round(Number(value) * 100), 0);

  const datev = sumOf(buildDatevFile(entries, header, mapping), 14, 0);
  const lexware = sumOf(buildLexwareFile(entries), 8, 3);
  assert.equal(datev, lexware);
  assert.equal(datev, entries.reduce((sum, entry) => sum + entry.amount, 0));
});
