import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { QrError, createQrCode, qrRuns, qrToText } from "./qr.ts";

/**
 * Vergleichsquelle.
 *
 * `qrcode` ist eine seit Jahren verbreitete, unabhaengige Umsetzung derselben
 * Norm und nur als Entwicklungsabhaengigkeit eingebunden. Stimmt unsere Matrix
 * Modul fuer Modul mit ihrer ueberein, ist auch die Maskenwahl, die
 * Reed-Solomon-Berechnung und die Formatinformation richtig - diese Dinge
 * lassen sich sonst nicht sinnvoll einzeln pruefen.
 */
const require_ = createRequire(import.meta.url);
const reference = require_("qrcode") as {
  create(text: string, options: { errorCorrectionLevel: string }): {
    version: number;
    modules: { size: number; data: Uint8Array };
  };
};

function referenceMatrix(text: string): { size: number; version: number; matrix: boolean[][] } {
  const created = reference.create(text, { errorCorrectionLevel: "M" });
  const size = created.modules.size;
  const matrix: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) row.push(created.modules.data[y * size + x] === 1);
    matrix.push(row);
  }
  return { size, version: created.version, matrix };
}

function assertMatchesReference(text: string, label: string): void {
  const own = createQrCode(text);
  const expected = referenceMatrix(text);

  assert.equal(own.version, expected.version, `${label}: Version`);
  assert.equal(own.size, expected.size, `${label}: Kantenlaenge`);

  for (let y = 0; y < expected.size; y++) {
    for (let x = 0; x < expected.size; x++) {
      const mine = (own.matrix[y] as boolean[])[x];
      const theirs = (expected.matrix[y] as boolean[])[x];
      if (mine !== theirs) {
        assert.fail(
          `${label}: Modul (${x}, ${y}) weicht ab - eigen ${mine ? "dunkel" : "hell"}, erwartet ${theirs ? "dunkel" : "hell"}\n` +
            `eigen:\n${qrToText(own)}`,
        );
      }
    }
  }
}

test("kurzer Text (Version 1)", () => {
  assertMatchesReference("A", "A");
  assertMatchesReference("HELLO", "HELLO");
});

test("Beleg-QR-Code, wie er tatsaechlich entsteht", () => {
  const payload = [
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
  assertMatchesReference(payload, "Belegpruefung");
});

test("Versionswechsel und Versionsinformation ab Version 7", () => {
  // Laengen so gewaehlt, dass mehrere Versionsstufen getroffen werden.
  for (const length of [10, 30, 60, 100, 130, 180, 230, 300, 400, 600]) {
    const text = "X".repeat(length);
    assertMatchesReference(text, `${length} Zeichen`);
  }
});

test("Version 10 und darueber: Zeichenzahlfeld hat 16 Bit", () => {
  const own = createQrCode("Y".repeat(280));
  assert.ok(own.version >= 10, `Version war ${own.version}`);
  assertMatchesReference("Y".repeat(280), "280 Zeichen");
});

test("alle druckbaren ASCII-Zeichen", () => {
  let text = "";
  for (let code = 32; code < 127; code++) text += String.fromCharCode(code);
  assertMatchesReference(text, "ASCII");
});

test("Zeichen ausserhalb von ISO-8859-1 werden gemeldet, nicht ersetzt", () => {
  assert.throws(() => createQrCode("Preis 4,50 €"), QrError);
  // Umlaute liegen in ISO-8859-1 und sind zulaessig.
  assert.doesNotThrow(() => createQrCode("Grüße"));
});

test("leerer Inhalt und zu lange Nutzlast werden abgewiesen", () => {
  assert.throws(() => createQrCode(""), QrError);
  assert.throws(() => createQrCode("Z".repeat(3000)), QrError);
});

test("andere Fehlerkorrekturstufen werden nicht stillschweigend ignoriert", () => {
  assert.throws(() => createQrCode("A", { errorCorrection: "H" as "M" }), QrError);
});

test("qrRuns fasst dunkle Module zu Balken zusammen", () => {
  const code = createQrCode("HELLO");
  const runs = qrRuns(code);

  // Jeder Balken liegt in der Matrix und ist vollstaendig dunkel.
  let modules = 0;
  for (const run of runs) {
    assert.ok(run.y >= 0 && run.y < code.size);
    assert.ok(run.x >= 0 && run.x + run.length <= code.size);
    for (let x = run.x; x < run.x + run.length; x++) {
      assert.equal((code.matrix[run.y] as boolean[])[x], true, `Balken bei (${x}, ${run.y})`);
    }
    modules += run.length;
  }

  // Und die Balken decken genau alle dunklen Module ab.
  const dark = code.matrix.flat().filter(Boolean).length;
  assert.equal(modules, dark);
  assert.ok(runs.length < dark, `${runs.length} Balken fuer ${dark} Module`);
});

test("qrToText zeichnet die Matrix", () => {
  const code = createQrCode("A");
  const text = qrToText(code, "#", ".");
  const lines = text.split("\n");
  assert.equal(lines.length, code.size);
  assert.equal(lines[0]?.length, code.size);
  // Das Suchmuster links oben beginnt mit sieben dunklen Modulen.
  assert.equal(lines[0]?.slice(0, 7), "#######");
});
