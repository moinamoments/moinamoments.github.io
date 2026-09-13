import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { QrError, createQrCode, qrInternals, qrRuns, qrToText } from "./qr.ts";

/**
 * Vergleichsquelle.
 *
 * `qrcode` ist eine seit Jahren verbreitete, unabhaengige Umsetzung derselben
 * Norm und nur als Entwicklungsabhaengigkeit eingebunden. Stimmt unsere Matrix
 * Modul fuer Modul mit ihrer ueberein, sind damit auch Reed-Solomon-Codes,
 * Verschraenkung, Zickzack-Platzierung, Formatinformation und Maskenwahl
 * geprueft - Dinge, die sich einzeln kaum sinnvoll pruefen lassen.
 *
 * Wichtig: Die Referenz muss auf den **Byte-Modus** festgelegt werden. Sie
 * optimiert sonst und kodiert "A" alphanumerisch, weil das kuerzer ist. Das
 * waere ein ebenso gueltiger, aber anderer QR-Code - und der Vergleich wuerde
 * einen Fehler melden, wo keiner ist. Genau darauf ist dieser Test beim ersten
 * Schreiben hereingefallen.
 */
const require_ = createRequire(import.meta.url);
const reference = require_("qrcode") as {
  create(
    segments: { data: string; mode: string }[],
    options: { errorCorrectionLevel: string; maskPattern?: number },
  ): { version: number; maskPattern: number; modules: { size: number; data: Uint8Array } };
};

function referenceMatrix(text: string, mask?: number) {
  const created = reference.create(
    [{ data: text, mode: "byte" }],
    mask === undefined ? { errorCorrectionLevel: "M" } : { errorCorrectionLevel: "M", maskPattern: mask },
  );
  const size = created.modules.size;
  const matrix: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) row.push(created.modules.data[y * size + x] === 1);
    matrix.push(row);
  }
  return { size, version: created.version, mask: created.maskPattern, matrix };
}

function assertMatchesReference(text: string, label: string, mask?: number): void {
  const own = createQrCode(text, mask === undefined ? {} : { mask });
  const expected = referenceMatrix(text, mask);

  assert.equal(own.version, expected.version, `${label}: Version`);
  assert.equal(own.size, expected.size, `${label}: Kantenlaenge`);

  for (let y = 0; y < expected.size; y++) {
    for (let x = 0; x < expected.size; x++) {
      const mine = (own.matrix[y] as boolean[])[x];
      const theirs = (expected.matrix[y] as boolean[])[x];
      if (mine !== theirs) {
        assert.fail(
          `${label}: Modul (${x}, ${y}) weicht ab - eigen ${mine ? "dunkel" : "hell"}, erwartet ${theirs ? "dunkel" : "hell"}\n${qrToText(own)}`,
        );
      }
    }
  }
}

/** Der Beleg-QR-Code, wie er tatsaechlich auf dem Bon steht. */
const RECEIPT_PAYLOAD = [
  "V0",
  "KASSE-0001",
  "Kassenbeleg-V1",
  "Kassenbeleg-V1^2.58_12.42_0.00_0.00_0.00^15.00:Bar",
  "128",
  "256",
  "2026-09-26T09:02:00+02:00",
  "2026-09-26T09:02:53+02:00",
  "ecdsa-plain-SHA256",
  "utcTime",
  "MEUCIQDx8kZm5vQ2hK9wN1pR7sT4uV6xY8zA0bC2dE4fG6hIjAIgKlMnOpQrStUvWxYz",
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEexamplePublicKeyBase64Value1234567890abcdefGHIJKL",
].join(";");

test("Datencodewoerter und Auffuellung entsprechen der Norm", () => {
  // Byte-Modus 0100, Zeichenzahl 1, Zeichen 0x41, Abschluss, dann die
  // vorgeschriebenen Auffuellbytes 0xEC / 0x11 im Wechsel.
  const data = qrInternals.encodeData("A", 1);
  assert.equal(data.length, 16, "Version 1 Stufe M hat 16 Datencodewoerter");
  assert.deepEqual([...data.subarray(0, 5)], [0x40, 0x14, 0x10, 0xec, 0x11]);
  assert.equal(data[15], 0xec);
});

test("Reed-Solomon stimmt mit einer unabhaengigen Umsetzung ueberein", () => {
  const encoder = require_("qrcode/lib/core/reed-solomon-encoder.js") as new (degree: number) => {
    encode(data: Buffer): Uint8Array;
  };
  // Nur Versionen mit einem einzigen Block, damit sich die Fehlerkorrektur
  // ohne Verschraenkung direkt vergleichen laesst.
  // Grenzen der Stufe M bei 4 Bit Modus- und 8 Bit Zeichenzahlfeld:
  // Version 1 fasst 14, Version 2 fasst 26, Version 3 fasst 42 Zeichen.
  const singleBlock: { text: string; version: number; degree: number }[] = [
    { text: "A", version: 1, degree: 10 },
    { text: "B".repeat(14), version: 1, degree: 10 },
    { text: "C".repeat(15), version: 2, degree: 16 },
    { text: "D".repeat(26), version: 2, degree: 16 },
    { text: "E".repeat(27), version: 3, degree: 26 },
    { text: "Kassenbeleg-V1^4.50:Bar#1234567890", version: 3, degree: 26 },
  ];
  for (const { text, version, degree } of singleBlock) {
    assert.equal(qrInternals.pickVersion(text.length), version, `Version fuer "${text.slice(0, 12)}"`);
    const data = qrInternals.encodeData(text, version);
    const own = qrInternals.errorCorrection(data, degree);
    const theirs = new encoder(degree).encode(Buffer.from(data));
    assert.deepEqual([...own], [...theirs], `Fehlerkorrektur fuer "${text.slice(0, 12)}"`);
  }
});

test("alle acht Maskenmuster ergeben dieselbe Matrix wie die Referenz", () => {
  // Der schaerfste Test: bei fest vorgegebener Maske faellt jeder Fehler in
  // Codewoertern, Verschraenkung, Platzierung und Formatinformation auf,
  // unabhaengig von der Maskenwahl.
  for (let mask = 0; mask < 8; mask++) {
    assertMatchesReference("A", `kurz, Maske ${mask}`, mask);
    assertMatchesReference(RECEIPT_PAYLOAD, `Beleg, Maske ${mask}`, mask);
  }
});

test("die Maskenwahl trifft dieselbe Maske wie die Referenz", () => {
  for (const text of ["A", "HELLO", "Kassenbeleg-V1", RECEIPT_PAYLOAD, "X".repeat(120)]) {
    const own = createQrCode(text);
    const expected = referenceMatrix(text);
    assert.equal(own.version, expected.version);
    for (let y = 0; y < expected.size; y++) {
      assert.deepEqual(own.matrix[y], expected.matrix[y], `Zeile ${y} bei "${text.slice(0, 16)}"`);
    }
  }
});

test("Beleg-QR-Code, wie er tatsaechlich entsteht", () => {
  assertMatchesReference(RECEIPT_PAYLOAD, "Belegpruefung");
  const code = createQrCode(RECEIPT_PAYLOAD);
  assert.ok(code.version >= 10, `Version war ${code.version} - erwartet wurde eine zweistellige`);
});

test("Versionswechsel ueber den ganzen Bereich, auch mit Versionsinformation ab 7", () => {
  for (const length of [10, 30, 60, 100, 130, 180, 230, 300, 400, 600, 900, 1200]) {
    assertMatchesReference("X".repeat(length), `${length} Zeichen`);
  }
});

test("ab Version 10 ist das Zeichenzahlfeld 16 Bit lang", () => {
  assert.equal(qrInternals.pickVersion(10), 1);
  const code = createQrCode("Y".repeat(280));
  assert.ok(code.version >= 10, `Version war ${code.version}`);
  assertMatchesReference("Y".repeat(280), "280 Zeichen");
});

test("alle druckbaren ASCII-Zeichen", () => {
  let text = "";
  for (let code = 32; code < 127; code++) text += String.fromCharCode(code);
  assertMatchesReference(text, "ASCII");
});

test("Umlaute sind zulaessig, das Euro-Zeichen nicht", () => {
  // ISO-8859-1 kennt Umlaute, aber kein Euro-Zeichen. Ein stillschweigend
  // ersetztes Zeichen wuerde den Beleginhalt verfaelschen.
  assert.doesNotThrow(() => createQrCode("Grüße"));
  assert.throws(() => createQrCode("Preis 4,50 €"), QrError);
});

test("leerer Inhalt und zu lange Nutzlast werden abgewiesen", () => {
  assert.throws(() => createQrCode(""), QrError);
  assert.throws(() => createQrCode("Z".repeat(3000)), QrError);
});

test("unzulaessige Angaben werden nicht stillschweigend uebergangen", () => {
  assert.throws(() => createQrCode("A", { errorCorrection: "H" as "M" }), QrError);
  assert.throws(() => createQrCode("A", { mask: 8 }), QrError);
  assert.throws(() => createQrCode("A", { mask: -1 }), QrError);
  assert.throws(() => createQrCode("A", { mask: 1.5 }), QrError);
});

test("Formatbits enthalten Stufe M und die Maske, mit BCH-Sicherung", () => {
  // Stufe M mit Maske 0 hat lauter Nullen als Nutzbits; uebrig bleibt genau
  // die in der Norm festgelegte XOR-Maske.
  assert.equal(qrInternals.formatBits(0), 0b101010000010010);
  for (let mask = 0; mask < 8; mask++) {
    const bits = qrInternals.formatBits(mask);
    const unmasked = bits ^ 0b101010000010010;
    assert.equal((unmasked >> 13) & 0b11, 0b00, "Stufe M");
    assert.equal((unmasked >> 10) & 0b111, mask, "Maske");
  }
});

test("Versionsinformation ab Version 7 traegt die Versionsnummer", () => {
  for (const version of [7, 10, 20, 40]) {
    assert.equal(qrInternals.versionBits(version) >>> 12, version);
  }
});

test("qrRuns fasst dunkle Module zu Balken zusammen", () => {
  const code = createQrCode(RECEIPT_PAYLOAD);
  const runs = qrRuns(code);

  let modules = 0;
  for (const run of runs) {
    assert.ok(run.y >= 0 && run.y < code.size);
    assert.ok(run.x >= 0 && run.x + run.length <= code.size);
    for (let x = run.x; x < run.x + run.length; x++) {
      assert.equal((code.matrix[run.y] as boolean[])[x], true, `Balken bei (${x}, ${run.y})`);
    }
    modules += run.length;
  }

  const dark = code.matrix.flat().filter(Boolean).length;
  assert.equal(modules, dark, "die Balken decken genau die dunklen Module ab");
  // Ein QR-Code ist kleinteilig, die Balken sind im Schnitt knapp zwei Module
  // lang. Etwa die Haelfte der Elemente einzusparen ist das Erreichbare -
  // mehr zu erwarten waere Wunschdenken.
  assert.ok(runs.length < dark * 0.75, `${runs.length} Balken fuer ${dark} Module - keine Einsparung`);
});

test("qrToText zeichnet die Matrix", () => {
  const code = createQrCode("A");
  const lines = qrToText(code, "#", ".").split("\n");
  assert.equal(lines.length, code.size);
  assert.equal(lines[0]?.length, code.size);
  assert.equal(lines[0]?.slice(0, 7), "#######", "Suchmuster links oben");
  assert.equal(lines[0]?.[7], ".", "Trennstreifen daneben");
});
