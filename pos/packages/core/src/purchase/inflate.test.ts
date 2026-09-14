import { strict as assert } from "node:assert";
import { deflateRawSync, deflateSync } from "node:zlib";
import test from "node:test";

import { InflateError, MAX_INFLATED_BYTES, inflate, inflateRaw } from "./inflate.ts";

/**
 * Geprueft wird gegen `node:zlib`: was Node packt, muss dieser Code auspacken.
 * Das ist mehr wert als feste Beispiele - es deckt alle drei Blockarten und
 * die Rueckverweise ab, ohne dass ein Test sie einzeln nachstellen muesste.
 */
function hin(data: Uint8Array | string, options?: Parameters<typeof deflateRawSync>[1]): Uint8Array {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new Uint8Array(deflateRawSync(bytes, options));
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

test("kurzer Text hin und zurueck", () => {
  assert.equal(text(inflateRaw(hin("Hallo Welt"))), "Hallo Welt");
});

test("leere Daten", () => {
  assert.equal(inflateRaw(hin("")).length, 0);
});

test("stark wiederholter Text - hier greifen die Rueckverweise", () => {
  const quelle = "Cola 0,33 l Dose; ".repeat(500);
  assert.equal(text(inflateRaw(hin(quelle))), quelle);
});

test("ein einziges Zeichen tausendfach - Rueckverweis mit Abstand 1", () => {
  // Quelle und Ziel ueberlappen sich; ein Blockkopieren waere hier falsch.
  const quelle = "a".repeat(10_000);
  assert.equal(text(inflateRaw(hin(quelle))), quelle);
});

test("ungepackte Bloecke (Stufe 0)", () => {
  const quelle = new TextEncoder().encode("Ungepackt bleibt ungepackt.");
  assert.deepEqual(inflateRaw(hin(quelle, { level: 0 })), quelle);
});

test("feste Huffman-Baeume bei kurzer Eingabe, dynamische bei langer", () => {
  // Kurz und ohne Struktur waehlt zlib die festen Baeume, lang und
  // strukturiert die dynamischen. Beide Wege muessen gehen.
  assert.equal(text(inflateRaw(hin("abc"))), "abc");
  const lang = Array.from({ length: 2000 }, (_, index) => `Position ${index} Artikel ${index % 7}\n`).join("");
  assert.equal(text(inflateRaw(hin(lang))), lang);
});

test("Zufallsdaten - unkomprimierbar, deckt den ungepackten Weg mit ab", () => {
  for (const size of [1, 2, 255, 256, 1000, 70_000]) {
    const zufall = new Uint8Array(size);
    for (let index = 0; index < size; index++) zufall[index] = Math.floor(Math.random() * 256);
    assert.deepEqual(inflateRaw(hin(zufall)), zufall, `Groesse ${size}`);
  }
});

test("alle 256 Byte-Werte kommen unveraendert zurueck", () => {
  const alle = new Uint8Array(256);
  for (let index = 0; index < 256; index++) alle[index] = index;
  assert.deepEqual(inflateRaw(hin(alle)), alle);
});

test("jede Kompressionsstufe von 1 bis 9", () => {
  const quelle = "Getraenke Mueller GmbH, Rechnung RE-2026-0815, 24 Dosen Cola.\n".repeat(50);
  for (let level = 1; level <= 9; level++) {
    assert.equal(text(inflateRaw(hin(quelle, { level }))), quelle, `Stufe ${level}`);
  }
});

test("mit zlib-Huelle, wie FlateDecode im PDF sie liefert", () => {
  const quelle = "<?xml version=\"1.0\"?><rsm:CrossIndustryInvoice/>";
  const verpackt = new Uint8Array(deflateSync(new TextEncoder().encode(quelle)));
  // Der Huellenkopf ist da - der rohe Weg darf daran scheitern.
  assert.equal(verpackt[0]! & 0x0f, 8);
  assert.equal(text(inflate(verpackt)), quelle);
});

test("inflate nimmt auch rohe Daten ohne Huelle", () => {
  assert.equal(text(inflate(hin("ohne Huelle"))), "ohne Huelle");
});

test("Umlaute ueberleben, weil byteweise gearbeitet wird", () => {
  const quelle = "Müller & Söhne – Getränke für 3,50 €";
  assert.equal(text(inflate(new Uint8Array(deflateSync(new TextEncoder().encode(quelle))))), quelle);
});

test("abgeschnittene Daten werden gemeldet und laufen nicht ins Leere", () => {
  const halb = hin("Ein Text, der lang genug ist, um abgeschnitten zu werden.".repeat(20)).subarray(0, 10);
  assert.throws(() => inflateRaw(halb), InflateError);
});

test("Unsinn ist kein gueltiger Datenstrom", () => {
  assert.throws(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff])), InflateError);
});

test("ein ungepackter Block mit falscher Laengenangabe wird abgewiesen", () => {
  // Bit 0: letzter Block, Bits 1-2: Art 0, dann LEN und ~LEN - hier absichtlich
  // nicht zueinander passend.
  const kaputt = new Uint8Array([0x01, 0x05, 0x00, 0x00, 0x00, 1, 2, 3, 4, 5]);
  assert.throws(() => inflateRaw(kaputt), (error: unknown) => error instanceof InflateError && /Laengenangabe/.test((error as Error).message));
});

test("die Grenze gegen Zip-Bomben greift", () => {
  // Eine Datei aus lauter Nullen packt extrem stark - genau der Fall, gegen
  // den die Grenze da ist.
  const gross = hin(new Uint8Array(200_000));
  assert.ok(gross.length < 1000, "sollte winzig sein");
  assert.throws(
    () => inflateRaw(gross, 1000),
    (error: unknown) => error instanceof InflateError && /groesser als 1000/.test((error as Error).message),
  );
  // Ohne enge Grenze geht dieselbe Datei durch.
  assert.equal(inflateRaw(gross).length, 200_000);
});

test("die voreingestellte Grenze liegt bei 64 MB", () => {
  assert.equal(MAX_INFLATED_BYTES, 64 * 1024 * 1024);
});

test("ein Datenstrom mit vereinbartem Woerterbuch wird abgewiesen", () => {
  const mitWoerterbuch = new Uint8Array(deflateSync(new TextEncoder().encode("x"), { dictionary: Buffer.from("abc") }));
  assert.throws(
    () => inflate(mitWoerterbuch),
    (error: unknown) => error instanceof InflateError && /Woerterbuch/.test((error as Error).message),
  );
});

test("hundert zufaellige Eingaben stimmen mit node:zlib ueberein", () => {
  for (let runde = 0; runde < 100; runde++) {
    const size = Math.floor(Math.random() * 5000);
    const quelle = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
      // Gemischt: teils wenige Werte (komprimiert gut), teils zufaellig.
      quelle[index] = runde % 2 === 0 ? Math.floor(Math.random() * 256) : Math.floor(Math.random() * 4);
    }
    assert.deepEqual(inflateRaw(hin(quelle)), quelle, `Runde ${runde}, Groesse ${size}`);
  }
});
