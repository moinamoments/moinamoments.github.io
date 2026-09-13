import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TAX_RATES,
  TaxError,
  createTaxRegistry,
  grossFromNet,
  kassenbelegTaxFields,
  netFromGross,
  resolveTaxKey,
  summarizeTax,
  taxFromGross,
} from "./tax.ts";

test("taxFromGross rechnet die Steuer aus dem Bruttopreis heraus", () => {
  assert.equal(taxFromGross(1190, 1900), 190);
  assert.equal(taxFromGross(450, 700), 29); // 29,44 -> 29
  assert.equal(taxFromGross(500, 1900), 80); // 79,83 -> 80
  assert.equal(taxFromGross(1000, 0), 0);
  assert.equal(taxFromGross(0, 1900), 0);
});

test("netto plus Steuer ergibt immer genau brutto", () => {
  for (let gross = 0; gross <= 3000; gross++) {
    for (const rate of [1900, 700, 1070, 550, 0]) {
      assert.equal(netFromGross(gross, rate) + taxFromGross(gross, rate), gross);
    }
  }
});

test("grossFromNet ist die Gegenrichtung fuer Nettoimporte", () => {
  assert.equal(grossFromNet(1000, 1900), 1190);
  assert.equal(grossFromNet(378, 700), 404); // 26,46 Steuer -> 26
});

test("summarizeTax rundet je Steuersatz auf der Summe, nicht je Position", () => {
  // Drei Positionen zu 4,50 EUR mit 7 %: einzeln je 29,44 Cent Steuer.
  // Positionsweise gerundet waeren es 3 x 29 = 87 Cent, richtig sind 88.
  const groups = summarizeTax([
    { taxKey: 2, gross: 450 },
    { taxKey: 2, gross: 450 },
    { taxKey: 2, gross: 450 },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.gross, 1350);
  assert.equal(groups[0]?.tax, 88);
  assert.equal(groups[0]?.net, 1262);
});

test("summarizeTax trennt Steuersaetze und sortiert nach Schluessel", () => {
  const groups = summarizeTax([
    { taxKey: 2, gross: 450 },
    { taxKey: 1, gross: 250 },
    { taxKey: 2, gross: 550 },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.key, g.gross, g.tax]),
    [
      [1, 250, 40],
      [2, 1000, 65],
    ],
  );
});

test("summarizeTax laesst Nullgruppen weg, aber nie alle", () => {
  const mixed = summarizeTax([
    { taxKey: 1, gross: 0 },
    { taxKey: 2, gross: 450 },
  ]);
  assert.deepEqual(mixed.map((g) => g.key), [2]);

  // Ein Beleg ueber 0,00 EUR (z. B. reiner Storno-Ausgleich) behaelt seine Zeile.
  const zero = summarizeTax([{ taxKey: 1, gross: 0 }]);
  assert.deepEqual(zero.map((g) => g.key), [1]);
});

test("summarizeTax kennt nur registrierte Schluessel", () => {
  assert.throws(() => summarizeTax([{ taxKey: 99, gross: 100 }]), TaxError);
  const registry = createTaxRegistry([{ key: 11, rate: 1600, label: "16 % (2020)" }]);
  const groups = summarizeTax([{ taxKey: 11, gross: 1160 }], registry);
  assert.equal(groups[0]?.tax, 160);
});

test("eigene Steuersaetze duerfen die bundesweiten Schluessel nicht ueberschreiben", () => {
  assert.throws(() => createTaxRegistry([{ key: 1, rate: 1600, label: "falsch" }]), TaxError);
});

test("resolveTaxKey schaltet Speisen zwischen ausser Haus und im Haus um", () => {
  const crepe = { taxKey: TAX_RATES.REDUCED.key, taxKeyDineIn: TAX_RATES.NORMAL.key };
  assert.equal(resolveTaxKey(crepe, "TAKEAWAY"), 2);
  assert.equal(resolveTaxKey(crepe, "DINE_IN"), 1);

  // Getraenke bleiben in beiden Faellen bei 19 %.
  const cola = { taxKey: TAX_RATES.NORMAL.key, taxKeyDineIn: null };
  assert.equal(resolveTaxKey(cola, "TAKEAWAY"), 1);
  assert.equal(resolveTaxKey(cola, "DINE_IN"), 1);
});

test("resolveTaxKey zieht Kleinunternehmer auf steuerfrei", () => {
  const crepe = { taxKey: 2, taxKeyDineIn: 1 };
  assert.equal(resolveTaxKey(crepe, "DINE_IN", true), TAX_RATES.EXEMPT.key);
  assert.equal(resolveTaxKey(crepe, "TAKEAWAY", true), 6);
});

test("kassenbelegTaxFields liefert die fuenf Felder in vorgegebener Reihenfolge", () => {
  const groups = summarizeTax([
    { taxKey: 1, gross: 250 },
    { taxKey: 2, gross: 900 },
  ]);
  assert.deepEqual(kassenbelegTaxFields(groups), ["2.50", "9.00", "0.00", "0.00", "0.00"]);
});

test("kassenbelegTaxFields fasst steuerfrei und nicht steuerbar im fuenften Feld zusammen", () => {
  const groups = summarizeTax([
    { taxKey: 5, gross: 100 },
    { taxKey: 6, gross: 200 },
    { taxKey: 7, gross: 300 },
  ]);
  assert.deepEqual(kassenbelegTaxFields(groups), ["0.00", "0.00", "0.00", "0.00", "6.00"]);
});

test("kassenbelegTaxFields bildet auch eigene Saetze ab, mangels Feld im Nullfeld", () => {
  const registry = createTaxRegistry([{ key: 11, rate: 1600, label: "16 %" }]);
  const groups = summarizeTax([{ taxKey: 11, gross: 1160 }], registry);
  assert.deepEqual(kassenbelegTaxFields(groups), ["0.00", "0.00", "0.00", "0.00", "11.60"]);
});
