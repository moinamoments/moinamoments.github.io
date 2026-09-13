import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CASH_MOVEMENT_BUSINESS_CASE,
  CASH_MOVEMENT_LABELS,
  CashbookError,
  buildCashMovement,
  cashMovementTotal,
  cashMovementsWithoutOpening,
  formatCashMovement,
  openDay,
  openingCashFrom,
  summarizeCashbook,
} from "./cashbook.ts";

const base = {
  tenantId: "t1",
  storeId: "s1",
  deviceId: "d1",
  userId: "u1",
  createdAt: "2026-09-26T07:30:00+02:00",
};

test("Einlage erhoeht, Entnahme mindert - das Vorzeichen steckt im Betrag", () => {
  const deposit = buildCashMovement({ ...base, id: "m1", type: "DEPOSIT", amount: 5000, reason: "Wechselgeld nachgelegt" });
  assert.equal(deposit.amount, 5000);

  const withdrawal = buildCashMovement({ ...base, id: "m2", type: "WITHDRAWAL", amount: 10_000, reason: "Einkauf Markt" });
  assert.equal(withdrawal.amount, -10_000);

  const transit = buildCashMovement({ ...base, id: "m3", type: "TRANSIT", amount: 20_000, reason: "in den Tresor" });
  assert.equal(transit.amount, -20_000);

  const tip = buildCashMovement({ ...base, id: "m4", type: "TIP_OUT", amount: 1500, reason: "Trinkgeld Spaetschicht" });
  assert.equal(tip.amount, -1500);
});

test("Betrag wird ohne Vorzeichen erwartet und darf nicht null sein", () => {
  assert.throws(() => buildCashMovement({ ...base, id: "m1", type: "DEPOSIT", amount: -100, reason: "x" }), CashbookError);
  assert.throws(() => buildCashMovement({ ...base, id: "m1", type: "DEPOSIT", amount: 0, reason: "x" }), CashbookError);
});

test("jede Bewegung braucht einen Grund", () => {
  // Eine Entnahme ohne Grund ist bei einer Kassennachschau nicht erklaerbar.
  assert.throws(() => buildCashMovement({ ...base, id: "m1", type: "WITHDRAWAL", amount: 5000, reason: "" }), CashbookError);
  assert.throws(() => buildCashMovement({ ...base, id: "m1", type: "WITHDRAWAL", amount: 5000, reason: "   " }), CashbookError);
  const withReason = buildCashMovement({ ...base, id: "m1", type: "WITHDRAWAL", amount: 5000, reason: "  Bank  " });
  assert.equal(withReason.reason, "Bank", "Leerzeichen werden abgeschnitten");
});

test("Zaehlprotokoll muss zum Betrag passen", () => {
  const count = [{ denomination: 5000, count: 1 }, { denomination: 1000, count: 2 }];
  assert.doesNotThrow(() =>
    buildCashMovement({ ...base, id: "m1", type: "OPENING", amount: 7000, reason: "gezaehlt", cashCount: count }),
  );
  assert.throws(
    () => buildCashMovement({ ...base, id: "m1", type: "OPENING", amount: 6000, reason: "gezaehlt", cashCount: count }),
    CashbookError,
  );
});

test("Tag eroeffnen bildet den Anfangsbestand aus dem Zaehlprotokoll", () => {
  const movement = openDay({
    ...base,
    id: "m1",
    cashCount: [{ denomination: 5000, count: 2 }, { denomination: 500, count: 4 }, { denomination: 100, count: 10 }],
  });
  assert.equal(movement.type, "OPENING");
  assert.equal(movement.amount, 10_000 + 2000 + 1000);
  assert.equal(movement.reason, "Anfangsbestand gezaehlt");
  assert.equal(movement.cashCount?.length, 3);
});

test("Eroeffnung ohne Wechselgeld braucht keine Buchung", () => {
  assert.throws(() => openDay({ ...base, id: "m1", cashCount: [] }), CashbookError);
  assert.throws(() => openDay({ ...base, id: "m1", cashCount: [{ denomination: 500, count: 0 }] }), CashbookError);
});

test("Arten sind den Geschaeftsvorfallarten der DSFinV-K zugeordnet", () => {
  assert.equal(CASH_MOVEMENT_BUSINESS_CASE.DEPOSIT, "Privateinlage");
  assert.equal(CASH_MOVEMENT_BUSINESS_CASE.WITHDRAWAL, "Privatentnahme");
  assert.equal(CASH_MOVEMENT_BUSINESS_CASE.TRANSIT, "Geldtransit");
  assert.equal(CASH_MOVEMENT_BUSINESS_CASE.OPENING, "Geldtransit");
  assert.equal(CASH_MOVEMENT_BUSINESS_CASE.TIP_OUT, "TrinkgeldAN");
});

test("Summen und Verdichtung", () => {
  const movements = [
    openDay({ ...base, id: "m0", cashCount: [{ denomination: 5000, count: 1 }] }),
    buildCashMovement({ ...base, id: "m1", type: "DEPOSIT", amount: 2000, reason: "nachgelegt" }),
    buildCashMovement({ ...base, id: "m2", type: "WITHDRAWAL", amount: 3000, reason: "Einkauf" }),
    buildCashMovement({ ...base, id: "m3", type: "TRANSIT", amount: 10_000, reason: "Tresor" }),
  ];

  assert.equal(openingCashFrom(movements), 5000);
  assert.equal(cashMovementTotal(movements), 5000 + 2000 - 3000 - 10_000);
  assert.equal(cashMovementsWithoutOpening(movements).length, 3);

  const summary = summarizeCashbook(movements);
  assert.equal(summary.opening, 5000);
  assert.equal(summary.deposits, 2000);
  assert.equal(summary.withdrawals, -3000);
  assert.equal(summary.transits, -10_000);
  assert.equal(summary.netMovements, 2000 - 3000 - 10_000, "ohne die Eroeffnung");
});

test("Zeile fuers Kassenbuch ist ohne Nachschlagen lesbar", () => {
  const movement = buildCashMovement({ ...base, id: "m1", type: "WITHDRAWAL", amount: 2550, reason: "Einkauf Markt" });
  assert.equal(formatCashMovement(movement), "Entnahme: -25,50 - Einkauf Markt");
  assert.equal(CASH_MOVEMENT_LABELS.OPENING, "Anfangsbestand");
});
