/**
 * SHA-256, HMAC und PBKDF2 in reinem TypeScript.
 *
 * Warum selbst geschrieben und nicht die Kryptobibliothek der Plattform: die
 * JavaScript-Umgebung von React Native (Hermes) bringt **keine** Web-Crypto
 * mit. `crypto.subtle.deriveBits` gibt es dort nicht, und die verbreiteten
 * Ersatzpakete bringen entweder eine native Abhaengigkeit mit (die den Bau der
 * App verkompliziert) oder sind selbst reines JavaScript - dann aber ohne
 * Tests, die man nachvollziehen kann.
 *
 * Diese Umsetzung ist gegen die eingebaute Kryptobibliothek von Node geprueft
 * (siehe hash.test.ts), Byte fuer Byte. Bei einem Verfahren wie PBKDF2 ist ein
 * Vergleich mit einer unabhaengigen Umsetzung die einzige belastbare Pruefung -
 * eine falsche Ableitung sieht genauso zufaellig aus wie eine richtige.
 *
 * Grenzen, die man kennen muss:
 *
 *   - Reines JavaScript ist rund zehnmal langsamer als eine native Umsetzung.
 *     Fuer eine Anmeldung pro Schicht ist das gleichgueltig, fuer eine
 *     Verschluesselung von Nutzdaten nicht. Dafuer ist dieses Modul nicht
 *     gedacht.
 *   - Es gibt keinen Schutz gegen Seitenkanaele ueber die Laufzeit der
 *     JavaScript-Umgebung. Der Vergleich von Pruefwerten laeuft deshalb
 *     bewusst in konstanter Zeit (`timingSafeEqual`), aber die Ableitung selbst
 *     ist nicht gegen einen Angreifer gehaertet, der auf demselben Geraet
 *     Code ausfuehrt.
 */

// --- SHA-256 --------------------------------------------------------------

/** Rundenkonstanten von SHA-256: die ersten 32 Bit der Kubikwurzeln der ersten 64 Primzahlen. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_BLOCK = 64;
export const SHA256_DIGEST = 32;

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** SHA-256 eines Bytefeldes. */
export function sha256(message: Uint8Array): Uint8Array {
  // Anfangswerte: die ersten 32 Bit der Quadratwurzeln der ersten acht Primzahlen.
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  // Auffuellen: eine Eins, dann Nullen, dann die Laenge in Bit als 64-Bit-Zahl.
  const bitLength = message.length * 8;
  const paddedLength = (((message.length + 9 + 63) / 64) | 0) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  // Die Laenge passt in 53 Bit sicher - mehr Daten kann JavaScript nicht halten.
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  padded[paddedLength - 8] = (high >>> 24) & 0xff;
  padded[paddedLength - 7] = (high >>> 16) & 0xff;
  padded[paddedLength - 6] = (high >>> 8) & 0xff;
  padded[paddedLength - 5] = high & 0xff;
  padded[paddedLength - 4] = (low >>> 24) & 0xff;
  padded[paddedLength - 3] = (low >>> 16) & 0xff;
  padded[paddedLength - 2] = (low >>> 8) & 0xff;
  padded[paddedLength - 1] = low & 0xff;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += SHA256_BLOCK) {
    for (let i = 0; i < 16; i++) {
      w[i] =
        (((padded[offset + i * 4] as number) << 24) |
          ((padded[offset + i * 4 + 1] as number) << 16) |
          ((padded[offset + i * 4 + 2] as number) << 8) |
          (padded[offset + i * 4 + 3] as number)) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15] as number, 7) ^ rotr(w[i - 15] as number, 18) ^ ((w[i - 15] as number) >>> 3);
      const s1 = rotr(w[i - 2] as number, 17) ^ rotr(w[i - 2] as number, 19) ^ ((w[i - 2] as number) >>> 10);
      w[i] = (((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0);
    }

    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;

    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }

  const digest = new Uint8Array(SHA256_DIGEST);
  for (let i = 0; i < 8; i++) {
    const value = h[i] as number;
    digest[i * 4] = (value >>> 24) & 0xff;
    digest[i * 4 + 1] = (value >>> 16) & 0xff;
    digest[i * 4 + 2] = (value >>> 8) & 0xff;
    digest[i * 4 + 3] = value & 0xff;
  }
  return digest;
}

// --- HMAC-SHA256 ----------------------------------------------------------

/** HMAC-SHA256 nach RFC 2104. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  // Ein Schluessel laenger als die Blockgroesse wird zuerst gehasht.
  const normalized = key.length > SHA256_BLOCK ? sha256(key) : key;

  const inner = new Uint8Array(SHA256_BLOCK);
  const outer = new Uint8Array(SHA256_BLOCK);
  inner.set(normalized);
  outer.set(normalized);
  for (let i = 0; i < SHA256_BLOCK; i++) {
    inner[i] = (inner[i] as number) ^ 0x36;
    outer[i] = (outer[i] as number) ^ 0x5c;
  }

  const innerInput = new Uint8Array(SHA256_BLOCK + message.length);
  innerInput.set(inner);
  innerInput.set(message, SHA256_BLOCK);
  const innerDigest = sha256(innerInput);

  const outerInput = new Uint8Array(SHA256_BLOCK + SHA256_DIGEST);
  outerInput.set(outer);
  outerInput.set(innerDigest, SHA256_BLOCK);
  return sha256(outerInput);
}

// --- PBKDF2 ---------------------------------------------------------------

export class HashError extends Error {}

/**
 * PBKDF2-HMAC-SHA256 nach RFC 8018.
 *
 * Schluesselstreckung: dieselbe Eingabe wird `iterations` mal durch HMAC
 * geschickt, damit ein Angreifer, der die abgeleiteten Werte hat, fuer jeden
 * Rateversuch denselben Aufwand treiben muss. Das macht kurze Geheimnisse
 * nicht sicher - es macht sie nur teurer zu raten.
 */
export function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyLength: number,
): Uint8Array {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new HashError(`Die Zahl der Runden muss mindestens 1 sein, war ${iterations}`);
  }
  if (!Number.isInteger(keyLength) || keyLength < 1 || keyLength > 1024) {
    throw new HashError(`Die Schluessellaenge muss zwischen 1 und 1024 Byte liegen, war ${keyLength}`);
  }

  const blocks = Math.ceil(keyLength / SHA256_DIGEST);
  const out = new Uint8Array(blocks * SHA256_DIGEST);

  for (let block = 1; block <= blocks; block++) {
    // Erste Runde: HMAC ueber Salz und Blocknummer (4 Byte, hoechstwertiges zuerst).
    const input = new Uint8Array(salt.length + 4);
    input.set(salt);
    input[salt.length] = (block >>> 24) & 0xff;
    input[salt.length + 1] = (block >>> 16) & 0xff;
    input[salt.length + 2] = (block >>> 8) & 0xff;
    input[salt.length + 3] = block & 0xff;

    let u = hmacSha256(password, input);
    const result = new Uint8Array(u);

    // Weitere Runden: jeweils HMAC des vorigen Ergebnisses, alles verXORt.
    for (let round = 1; round < iterations; round++) {
      u = hmacSha256(password, u);
      for (let i = 0; i < SHA256_DIGEST; i++) {
        result[i] = (result[i] as number) ^ (u[i] as number);
      }
    }
    out.set(result, (block - 1) * SHA256_DIGEST);
  }
  return out.subarray(0, keyLength);
}

// --- Hilfsmittel ----------------------------------------------------------

/**
 * Zwei Bytefelder in konstanter Zeit vergleichen.
 *
 * Ein gewoehnlicher Vergleich bricht beim ersten Unterschied ab. Damit laesst
 * sich aus der Laufzeit ablesen, wie viele Bytes schon stimmen - und ein
 * Pruefwert Byte fuer Byte erraten. Der Aufwand, das richtig zu machen, ist
 * gering; der Schaden, es falsch zu machen, ist vollstaendig.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Die Laenge selbst ist kein Geheimnis; ein Unterschied darin wird trotzdem
  // erst am Ende ausgewertet.
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}

/** Text als UTF-8-Bytes. */
export function utf8(text: string): Uint8Array {
  // TextEncoder ist in Node, im Browser und in Hermes vorhanden.
  return new TextEncoder().encode(text);
}

/** Bytes als Hexadezimaltext, Kleinbuchstaben. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Hexadezimaltext als Bytes. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/.test(clean)) {
    throw new HashError("Kein gueltiger Hexadezimaltext");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Zufallsbytes von der Plattform.
 *
 * `crypto.getRandomValues` gibt es in Node, im Browser und - im Unterschied zu
 * `crypto.subtle` - auch in Hermes. Fehlt es doch, wird **abgebrochen** und
 * nicht auf `Math.random` zurueckgefallen: ein Salz aus einem vorhersagbaren
 * Zufallsgenerator ist kein Salz, und ein stillschweigender Rueckfall darauf
 * ist genau die Art Fehler, die niemand bemerkt.
 */
export function randomBytes(length: number): Uint8Array {
  const source = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (!source?.getRandomValues) {
    throw new HashError(
      "Auf diesem Geraet ist kein kryptographischer Zufallsgenerator verfuegbar. Ohne ihn koennen keine Zugaenge eingerichtet werden.",
    );
  }
  return source.getRandomValues(new Uint8Array(length));
}
