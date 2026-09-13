import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ONE,
  applyBasisPoints,
  distribute,
  formatAmount,
  formatDecimal,
  formatEuro,
  formatQuantity,
  formatQuantityDecimal,
  lineTotal,
  parseAmount,
  roundHalfUp,
  sumCents,
  cents,
  MoneyError,
} from "./money.ts";

test("roundHalfUp rundet symmetrisch vom Nullpunkt weg", () => {
  assert.equal(roundHalfUp(0.5), 1);
  assert.equal(roundHalfUp(-0.5), -1);
  assert.equal(roundHalfUp(1.5), 2);
  assert.equal(roundHalfUp(-1.5), -2);
  assert.equal(roundHalfUp(2.4), 2);
  assert.equal(roundHalfUp(-2.4), -2);
});

test("cents weist Nachkommastellen ab", () => {
  assert.throws(() => cents(4.5), MoneyError);
  assert.equal(cents(450), 450);
});

test("lineTotal rechnet Stueckzahlen und Gewichte", () => {
  assert.equal(lineTotal(450, ONE), 450);
  assert.equal(lineTotal(450, 3 * ONE), 1350);
  // 0,350 kg zu 12,90 EUR/kg = 4,515 -> 4,52 EUR
  assert.equal(lineTotal(1290, 350), 452);
  // 1/3 Einheit zu 1,00 EUR = 0,333 -> 0,33 EUR
  assert.equal(lineTotal(100, 333), 33);
});

test("lineTotal storniert exakt gegengleich", () => {
  assert.equal(lineTotal(1290, 350) + lineTotal(-1290, 350), 0);
  assert.equal(lineTotal(1290, -350), -452);
});

test("applyBasisPoints rechnet Prozente ohne Gleitkommadrift", () => {
  assert.equal(applyBasisPoints(1000, 1900), 190);
  assert.equal(applyBasisPoints(499, 1000), 50); // 49,9 -> 50
  assert.equal(applyBasisPoints(-499, 1000), -50);
  assert.equal(applyBasisPoints(2350, 250), 59); // 58,75 -> 59
});

test("distribute verteilt ohne Cent-Verlust", () => {
  assert.deepEqual(distribute(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(distribute(10, [1, 1]), [5, 5]);
  assert.deepEqual(distribute(1, [1, 1, 1]), [1, 0, 0]);
  assert.deepEqual(distribute(-100, [1, 1, 1]), [-34, -33, -33]);
  assert.deepEqual(distribute(0, [5, 3]), [0, 0]);
  assert.deepEqual(distribute(500, [0, 0]), [500, 0]);
  assert.deepEqual(distribute(100, []), []);
});

test("distribute summiert immer exakt auf den Ausgangsbetrag", () => {
  // Zufaellige Gewichte: die Invariante muss fuer jede Kombination halten,
  // weil sonst ein Belegrabatt Cent erzeugt oder verschluckt.
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let run = 0; run < 500; run++) {
    const n = 1 + Math.floor(rnd() * 8);
    const weights = Array.from({ length: n }, () => Math.floor(rnd() * 5000));
    const amount = Math.floor(rnd() * 200000) - 100000;
    const parts = distribute(amount, weights);
    assert.equal(sumCents(parts), amount, `Gewichte ${weights.join("/")} Betrag ${amount}`);
  }
});

test("formatAmount schreibt deutsche Betraege mit Tausenderpunkt", () => {
  assert.equal(formatAmount(450), "4,50");
  assert.equal(formatAmount(5), "0,05");
  assert.equal(formatAmount(0), "0,00");
  assert.equal(formatAmount(-450), "-4,50");
  assert.equal(formatAmount(123456789), "1.234.567,89");
  assert.equal(formatEuro(450), "4,50 €");
});

test("formatDecimal schreibt das Punktformat fuer TSE und DSFinV-K", () => {
  assert.equal(formatDecimal(450), "4.50");
  assert.equal(formatDecimal(0), "0.00");
  assert.equal(formatDecimal(-1234), "-12.34");
  assert.equal(formatDecimal(7), "0.07");
});

test("Mengen werden lesbar und maschinenlesbar formatiert", () => {
  assert.equal(formatQuantity(ONE), "1");
  assert.equal(formatQuantity(2500), "2,5");
  assert.equal(formatQuantity(350), "0,35");
  assert.equal(formatQuantityDecimal(ONE), "1.000");
  assert.equal(formatQuantityDecimal(350), "0.350");
  assert.equal(formatQuantityDecimal(-2500), "-2.500");
});

test("parseAmount liest Eingaben vom Kassenstand", () => {
  assert.equal(parseAmount("4,50"), 450);
  assert.equal(parseAmount("4.50"), 450);
  assert.equal(parseAmount("4"), 400);
  assert.equal(parseAmount(" 12,9 "), 1290);
  assert.equal(parseAmount("0,05"), 5);
  assert.equal(parseAmount("4,50 €"), 450);
  assert.equal(parseAmount("-4,50"), -450);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount("4,505"), null);
  assert.equal(parseAmount("1,2,3"), null);
});
