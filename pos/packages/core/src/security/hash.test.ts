import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, pbkdf2Sync, randomBytes as nodeRandom } from "node:crypto";
import {
  HashError,
  fromHex,
  hmacSha256,
  pbkdf2Sha256,
  randomBytes,
  sha256,
  timingSafeEqual,
  toHex,
  utf8,
} from "./hash.ts";

/**
 * Geprueft wird gegen die eingebaute Kryptobibliothek von Node.
 *
 * Bei einem Hash oder einer Schluesselableitung sieht ein falsches Ergebnis
 * genauso zufaellig aus wie ein richtiges. Der Vergleich mit einer
 * unabhaengigen, seit Jahren geprueften Umsetzung ist die einzige belastbare
 * Pruefung - Augenschein genuegt hier nicht.
 */

function nodeSha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

test("SHA-256 stimmt mit der Kryptobibliothek von Node ueberein", () => {
  const cases: Uint8Array[] = [
    utf8(""),
    utf8("a"),
    utf8("abc"),
    utf8("Kaffee mit Milch"),
    utf8("Grüße aus Kiel"),
    // Genau eine Blockgroesse minus eins, genau eine, genau eine plus eins:
    // an diesen Stellen bricht eine falsche Auffuellung.
    utf8("x".repeat(55)),
    utf8("x".repeat(56)),
    utf8("x".repeat(57)),
    utf8("x".repeat(63)),
    utf8("x".repeat(64)),
    utf8("x".repeat(65)),
    utf8("x".repeat(1000)),
    new Uint8Array(0),
    new Uint8Array([0, 1, 2, 255]),
  ];
  for (const data of cases) {
    assert.equal(toHex(sha256(data)), nodeSha256(data), `SHA-256 von ${data.length} Byte`);
  }
});

test("SHA-256 der leeren Eingabe ist der bekannte Wert", () => {
  assert.equal(
    toHex(sha256(utf8(""))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("SHA-256 stimmt auch fuer zufaellige Eingaben", () => {
  for (let run = 0; run < 200; run++) {
    const data = new Uint8Array(nodeRandom(1 + (run % 200)));
    assert.equal(toHex(sha256(data)), nodeSha256(data));
  }
});

test("HMAC-SHA256 stimmt mit Node ueberein, auch bei langen Schluesseln", () => {
  const cases: { key: Uint8Array; message: Uint8Array }[] = [
    { key: utf8("key"), message: utf8("The quick brown fox jumps over the lazy dog") },
    { key: utf8(""), message: utf8("") },
    { key: utf8("kurz"), message: utf8("Nachricht") },
    // Schluessel genau in Blockgroesse, darunter und darueber - ein zu langer
    // Schluessel muss zuerst gehasht werden.
    { key: new Uint8Array(63).fill(7), message: utf8("abc") },
    { key: new Uint8Array(64).fill(7), message: utf8("abc") },
    { key: new Uint8Array(65).fill(7), message: utf8("abc") },
    { key: new Uint8Array(200).fill(9), message: utf8("abc") },
  ];
  for (const { key, message } of cases) {
    const expected = createHmac("sha256", key).update(message).digest("hex");
    assert.equal(toHex(hmacSha256(key, message)), expected, `HMAC mit ${key.length}-Byte-Schluessel`);
  }
});

test("PBKDF2-HMAC-SHA256 stimmt mit Node ueberein", () => {
  const cases: { password: string; salt: string; iterations: number; length: number }[] = [
    { password: "password", salt: "salt", iterations: 1, length: 32 },
    { password: "password", salt: "salt", iterations: 2, length: 32 },
    { password: "password", salt: "salt", iterations: 4096, length: 32 },
    // Laenger als ein Hashblock: dann werden mehrere Blocke abgeleitet und
    // verkettet - eine falsche Blocknummer faellt erst hier auf.
    { password: "passwort", salt: "salzsalz", iterations: 1000, length: 64 },
    { password: "passwort", salt: "salzsalz", iterations: 1000, length: 100 },
    { password: "1234", salt: "abcdefgh", iterations: 10_000, length: 32 },
    { password: "", salt: "salt", iterations: 100, length: 16 },
    { password: "ümlaut", salt: "ßalz", iterations: 100, length: 32 },
  ];
  for (const { password, salt, iterations, length } of cases) {
    const expected = pbkdf2Sync(password, salt, iterations, length, "sha256").toString("hex");
    const own = toHex(pbkdf2Sha256(utf8(password), utf8(salt), iterations, length));
    assert.equal(own, expected, `PBKDF2 ${iterations} Runden, ${length} Byte`);
  }
});

test("PBKDF2 weist unbrauchbare Angaben ab", () => {
  assert.throws(() => pbkdf2Sha256(utf8("a"), utf8("b"), 0, 32), HashError);
  assert.throws(() => pbkdf2Sha256(utf8("a"), utf8("b"), -1, 32), HashError);
  assert.throws(() => pbkdf2Sha256(utf8("a"), utf8("b"), 1.5, 32), HashError);
  assert.throws(() => pbkdf2Sha256(utf8("a"), utf8("b"), 100, 0), HashError);
  assert.throws(() => pbkdf2Sha256(utf8("a"), utf8("b"), 100, 2000), HashError);
});

test("mehr Runden ergeben ein anderes Ergebnis", () => {
  const a = toHex(pbkdf2Sha256(utf8("pin"), utf8("salz"), 100, 32));
  const b = toHex(pbkdf2Sha256(utf8("pin"), utf8("salz"), 101, 32));
  assert.notEqual(a, b);
});

test("ein anderes Salz ergibt ein anderes Ergebnis", () => {
  // Das ist der ganze Zweck des Salzes: zwei gleiche PINs duerfen nicht
  // denselben Pruefwert haben, sonst verraet die Datenbank, wer dieselbe PIN
  // benutzt.
  const a = toHex(pbkdf2Sha256(utf8("8261"), utf8("salz-a"), 100, 32));
  const b = toHex(pbkdf2Sha256(utf8("8261"), utf8("salz-b"), 100, 32));
  assert.notEqual(a, b);
});

test("timingSafeEqual vergleicht richtig", () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])), false);
  assert.equal(timingSafeEqual(new Uint8Array(0), new Uint8Array(0)), true);
  // Auch der erste Byte-Unterschied darf nicht zum Abbruch fuehren; das
  // Ergebnis muss trotzdem stimmen.
  assert.equal(timingSafeEqual(new Uint8Array([9, 2, 3]), new Uint8Array([1, 2, 3])), false);
});

test("Hexadezimaltext hin und zurueck", () => {
  const data = new Uint8Array([0, 1, 15, 16, 254, 255]);
  assert.equal(toHex(data), "00010f10feff");
  assert.deepEqual([...fromHex("00010f10feff")], [...data]);
  assert.deepEqual([...fromHex("  00FF  ")], [0, 255], "Rand und Grossbuchstaben");
  assert.deepEqual([...fromHex("")], []);
  assert.throws(() => fromHex("abc"), HashError, "ungerade Laenge");
  assert.throws(() => fromHex("zz"), HashError, "keine Hexziffern");
});

test("UTF-8-Kodierung", () => {
  assert.deepEqual([...utf8("abc")], [97, 98, 99]);
  // Ein Umlaut braucht zwei Byte, ein Euro-Zeichen drei.
  assert.equal(utf8("ü").length, 2);
  assert.equal(utf8("€").length, 3);
});

test("Zufallsbytes kommen vom Zufallsgenerator der Plattform", () => {
  const a = randomBytes(16);
  const b = randomBytes(16);
  assert.equal(a.length, 16);
  assert.notDeepEqual([...a], [...b], "zwei Aufrufe liefern nicht dasselbe");
  // Nicht alles null - ein haeufiger Fehler bei falsch angebundenen
  // Zufallsgeneratoren.
  assert.ok(a.some((byte) => byte !== 0));
});

test("ohne Zufallsgenerator wird abgebrochen, nicht auf Math.random gewechselt", () => {
  const original = (globalThis as { crypto?: unknown }).crypto;
  try {
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    assert.throws(() => randomBytes(16), HashError);
    assert.throws(() => randomBytes(16), /Zufallsgenerator/);
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
  }
});
