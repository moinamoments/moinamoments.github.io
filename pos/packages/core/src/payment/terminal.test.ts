import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE } from "../money.ts";
import { fixedClock, sequentialIds } from "../clock.ts";
import { addProduct, cartTotals, emptyCart } from "../cart.ts";
import type { Device, Product, Store, Tenant, User } from "../model.ts";
import { MockTse } from "../tse/mock.ts";
import { beginTransaction, finishTransaction, type TransactionContext } from "../order.ts";
import {
  MANUAL_TERMINAL,
  SimulatedTerminal,
  TERMINAL_LABELS,
  TerminalError,
  terminalPaymentToIntent,
  terminalRequirements,
  validateTerminalConfig,
  DEFAULT_TERMINAL_CONFIG,
} from "./terminal.ts";

const NOW = "2026-09-26T09:00:00+02:00";

test("Tap to Pay kann kontaktlos, PIN und Rueckbuchung", () => {
  const terminal = new SimulatedTerminal({ kind: "TAP_TO_PAY", now: () => NOW });
  const capabilities = terminal.capabilities();
  assert.equal(capabilities.kind, "TAP_TO_PAY");
  assert.equal(capabilities.contactless, true);
  assert.equal(capabilities.chip, false, "ohne Lesegeraet gibt es keinen Chipschlitz");
  assert.equal(capabilities.pin, true);
  assert.equal(capabilities.refund, true);
  assert.equal(TERMINAL_LABELS.TAP_TO_PAY, "Tap to Pay (Telefon)");
});

test("ein Kartenleser kann zusaetzlich den Chip lesen", () => {
  const terminal = new SimulatedTerminal({ kind: "BLUETOOTH_READER", now: () => NOW });
  assert.equal(terminal.capabilities().chip, true);
});

test("Autorisierung liefert Referenz, Kartenmarke und Genehmigung", async () => {
  const terminal = new SimulatedTerminal({ now: () => NOW });
  const payment = await terminal.authorize({ amount: 1250, reference: "K1-000042" });

  assert.equal(payment.amount, 1250);
  assert.equal(payment.method, "CARD_DEBIT");
  assert.equal(payment.scheme, "girocard");
  assert.equal(payment.last4, "4242");
  assert.ok(payment.authorizationCode);
  assert.equal(payment.completedAt, NOW);
  // Die Referenz ist erkennbar eine Simulation - wie bei der Test-TSE.
  assert.match(payment.reference, /^SIM-/);
});

test("abgelehnte Karte und Abbruch sind unterscheidbar", async () => {
  const declined = new SimulatedTerminal({ outcome: "DECLINED" });
  await assert.rejects(
    () => declined.authorize({ amount: 500, reference: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof TerminalError);
      assert.equal(error.retryable, false, "eine gesperrte Karte wird nicht besser");
      assert.match(error.message, /abgelehnt/);
      return true;
    },
  );

  const aborted = new SimulatedTerminal({ outcome: "ABORTED" });
  await assert.rejects(
    () => aborted.authorize({ amount: 500, reference: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof TerminalError);
      assert.equal(error.retryable, true, "der Kunde kann es nochmal versuchen");
      return true;
    },
  );
});

test("nicht erreichbares Terminal meldet sich im Status", async () => {
  const terminal = new SimulatedTerminal({ outcome: "UNREACHABLE" });
  assert.equal(await terminal.status(), "UNREACHABLE");
  await assert.rejects(() => terminal.authorize({ amount: 500, reference: "x" }), TerminalError);
});

test("Betraege von null oder negativ werden nicht autorisiert", async () => {
  const terminal = new SimulatedTerminal();
  await assert.rejects(() => terminal.authorize({ amount: 0, reference: "x" }), TerminalError);
  await assert.rejects(() => terminal.authorize({ amount: -500, reference: "x" }), TerminalError);
});

test("Trinkgeld nur, wenn danach gefragt wurde", async () => {
  const terminal = new SimulatedTerminal({ tip: 150, now: () => NOW });
  const without = await terminal.authorize({ amount: 1000, reference: "x" });
  assert.equal(without.tip, 0);

  const withTip = await terminal.authorize({ amount: 1000, reference: "x", askForTip: true });
  assert.equal(withTip.tip, 150);
});

test("Rueckbuchung ist negativ und hat ihre eigene Referenz", async () => {
  const terminal = new SimulatedTerminal({ now: () => NOW });
  const payment = await terminal.authorize({ amount: 1000, reference: "K1-000001" });
  const refund = await terminal.refund({ reference: payment.reference, amount: 400 });

  assert.equal(refund.amount, -400, "ein Teilbetrag ist rueckbuchbar");
  assert.notEqual(refund.reference, payment.reference);
  await assert.rejects(() => terminal.refund({ reference: payment.reference, amount: 0 }), TerminalError);
});

test("ohne Terminal wird Kartenzahlung nur gebucht, nicht abgewickelt", async () => {
  assert.equal(await MANUAL_TERMINAL.status(), "NOT_CONFIGURED");
  assert.equal(MANUAL_TERMINAL.capabilities().contactless, false);
  await assert.rejects(() => MANUAL_TERMINAL.authorize({ amount: 500, reference: "x" }), TerminalError);
  await assert.rejects(() => MANUAL_TERMINAL.authorize({ amount: 500, reference: "x" }), /kein Bezahlterminal/);
  await assert.rejects(() => MANUAL_TERMINAL.refund({ reference: "x", amount: 500 }), /bar auszahlen/);
  // Abbrechen ohne laufenden Vorgang ist kein Fehler.
  await assert.doesNotReject(() => MANUAL_TERMINAL.cancel());
});

test("Terminal-Ergebnis wird zur Zahlung des Belegs, Trinkgeld getrennt", async () => {
  const terminal = new SimulatedTerminal({ tip: 200, now: () => NOW });
  const payment = await terminal.authorize({ amount: 1000, reference: "K1-000001", askForTip: true });
  const intent = terminalPaymentToIntent(payment);

  assert.equal(intent.amount, 1000, "das Trinkgeld steckt nicht im Zahlbetrag");
  assert.equal(intent.tip, 200, "es kommt als eigene Position auf den Beleg");
  assert.equal(intent.label, "girocard ...4242");
  assert.equal(intent.reference, payment.reference);
});

test("Voraussetzungen werden je Art genannt", () => {
  const tapToPay = terminalRequirements("TAP_TO_PAY");
  assert.ok(tapToPay.some((line) => line.includes("Zahlungsdienstleister")));
  assert.ok(tapToPay.some((line) => line.includes("Entitlement")));
  assert.ok(tapToPay.some((line) => line.includes("Expo Go")), "die Einschraenkung muss dastehen");

  assert.ok(terminalRequirements("MANUAL")[0]?.includes("Keine Voraussetzungen"));
});

test("Einrichtung wird geprueft, bevor eine Karte angenommen wird", () => {
  assert.equal(validateTerminalConfig(DEFAULT_TERMINAL_CONFIG).ok, true, "ohne Terminal ist zulaessig");

  const noProvider = validateTerminalConfig({ ...DEFAULT_TERMINAL_CONFIG, kind: "TAP_TO_PAY" });
  assert.equal(noProvider.ok, false);
  assert.ok(noProvider.ok === false && noProvider.reason.includes("Zahlungsdienstleister"));

  assert.equal(validateTerminalConfig({ ...DEFAULT_TERMINAL_CONFIG, kind: "TAP_TO_PAY", provider: "stripe" }).ok, true);

  const noHost = validateTerminalConfig({ ...DEFAULT_TERMINAL_CONFIG, kind: "NETWORK_READER", provider: "adyen" });
  assert.equal(noHost.ok, false);
  assert.ok(noHost.ok === false && noHost.reason.includes("Adresse"));

  const notPaired = validateTerminalConfig({ ...DEFAULT_TERMINAL_CONFIG, kind: "BLUETOOTH_READER", provider: "sumup" });
  assert.equal(notPaired.ok, false);
  assert.ok(notPaired.ok === false && notPaired.reason.includes("gekoppelt"));
});

// --- Zusammenspiel mit dem Belegabschluss --------------------------------

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

function context(): TransactionContext {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  return { tenant, store, device, user, clock, newId: sequentialIds("o"), tse: new MockTse({ clock }) };
}

test("Kartenzahlung: erst autorisieren, dann TSE abschliessen", async () => {
  const ctx = context();
  const terminal = new SimulatedTerminal({ now: () => NOW });

  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1", quantity: 2 * ONE });
  const total = cartTotals(cart).total;

  // Schritt 2: die Karte. Scheitert das, entsteht kein Beleg.
  const payment = await terminal.authorize({ amount: total, reference: "vorgang-1" });
  const intent = terminalPaymentToIntent(payment);

  // Schritt 3 und 4: TSE und Beleg.
  const { order } = await finishTransaction(
    ctx,
    open,
    cart,
    [{ method: intent.method, amount: intent.amount, reference: intent.reference }],
    { sequence: 1 },
  );

  assert.equal(order.total, 500);
  assert.equal(order.payments[0]?.reference, payment.reference);
  assert.equal(order.payments[0]?.change, 0, "bei Karte gibt es kein Rueckgeld");
  // In den TSE-Prozessdaten steht die Kartenzahlung als "Unbar".
  assert.ok(order.tse?.processData.includes("5.00:Unbar"));
});

test("abgelehnte Karte: kein Beleg, kein Umsatz", async () => {
  const ctx = context();
  const terminal = new SimulatedTerminal({ outcome: "DECLINED" });

  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1" });
  const total = cartTotals(cart).total;

  await assert.rejects(() => terminal.authorize({ amount: total, reference: "vorgang-1" }), TerminalError);

  // Der Warenkorb steht unveraendert da; die begonnene TSE-Transaktion bleibt
  // offen und kann mit einer anderen Zahlart abgeschlossen werden.
  assert.equal(cart.lines.length, 1);
  const { order } = await finishTransaction(ctx, open, cart, [{ method: "CASH", amount: total, tendered: 500 }], {
    sequence: 1,
  });
  assert.equal(order.payments[0]?.method, "CASH");
  assert.equal(order.payments[0]?.change, 250);
});

test("geteilte Zahlung: Teil Karte, Teil bar", async () => {
  const ctx = context();
  const terminal = new SimulatedTerminal({ now: () => NOW });

  const open = await beginTransaction(ctx);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1", quantity: 4 * ONE });
  const total = cartTotals(cart).total;
  assert.equal(total, 1000);

  const payment = await terminal.authorize({ amount: 600, reference: "vorgang-1" });
  const { order } = await finishTransaction(
    ctx,
    open,
    cart,
    [
      { method: "CARD_DEBIT", amount: 600, reference: payment.reference },
      { method: "CASH", amount: 400, tendered: 500 },
    ],
    { sequence: 1 },
  );

  assert.equal(order.payments.length, 2);
  assert.equal(order.payments[1]?.change, 100);
  assert.ok(order.tse?.processData.includes("6.00:Unbar_4.00:Bar"));
});
