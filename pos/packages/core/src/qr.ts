/**
 * QR-Code-Erzeugung.
 *
 * Warum eigener Code und keine Bibliothek: der Beleg-QR-Code wird an zwei
 * Stellen gebraucht, auf dem Bildschirm und auf dem Bondrucker. Der Drucker
 * bekommt kein SVG, sondern die Modulmatrix als Bitmuster. Eine Bibliothek,
 * die nur React-Native-Elemente ausgibt, hilft dort nicht - und die verbreitete
 * zieht ueber eine ungenutzte Logofunktion einen vollstaendigen CSS-Parser
 * (rund 3 MB) in das Bundle.
 *
 * Umfang: Byte-Modus (ISO-8859-1), Fehlerkorrekturstufe M, Versionen 1 bis 40.
 * Das genuegt fuer den Beleg-QR-Code, der aus ASCII besteht. Ziffern- und
 * Alphanumerik-Modus wuerden den Code kleiner machen, bringen hier aber
 * nichts: die Signatur ist Base64 und damit gemischt.
 *
 * Grundlage ist ISO/IEC 18004. Geprueft wird gegen eine unabhaengige
 * Umsetzung (siehe qr.test.ts) - bei einem Verfahren mit Reed-Solomon-Codes
 * und acht Maskenmustern ist ein Vergleich mit bekannten Ergebnissen die
 * einzige belastbare Pruefung.
 */

export class QrError extends Error {}

/** Fehlerkorrekturstufe. Nur M ist umgesetzt - siehe Modulkopf. */
export type QrErrorCorrection = "M";

export interface QrCode {
  /** Kantenlaenge in Modulen. */
  readonly size: number;
  /** `true` = dunkles Modul. Zeilenweise, `matrix[y][x]`. */
  readonly matrix: readonly (readonly boolean[])[];
  readonly version: number;
}

/**
 * Gesamtzahl der Codewoerter je Version (Daten plus Fehlerkorrektur).
 * Index = Version - 1.
 */
const TOTAL_CODEWORDS: readonly number[] = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
  1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034,
  3196, 3362, 3532, 3706,
];

/**
 * Blockaufteilung fuer Stufe M, je Version:
 * [Fehlerkorrektur-Codewoerter je Block, Bloecke Gruppe 1, Datencodewoerter Gruppe 1,
 *  Bloecke Gruppe 2, Datencodewoerter Gruppe 2]
 */
const EC_BLOCKS_M: readonly (readonly [number, number, number, number, number])[] = [
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38],
  [24, 4, 40, 5, 41],
  [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47],
  [26, 9, 43, 4, 44],
  [26, 3, 44, 11, 45],
  [26, 3, 41, 13, 42],
  [26, 17, 42, 0, 0],
  [28, 17, 46, 0, 0],
  [28, 4, 47, 14, 48],
  [28, 6, 45, 14, 46],
  [28, 8, 47, 13, 48],
  [28, 19, 46, 4, 47],
  [28, 22, 45, 3, 46],
  [28, 3, 45, 23, 46],
  [28, 21, 45, 7, 46],
  [28, 19, 47, 10, 48],
  [28, 2, 46, 29, 47],
  [28, 10, 46, 23, 47],
  [28, 14, 46, 21, 47],
  [28, 14, 46, 23, 47],
  [28, 12, 47, 26, 48],
  [28, 6, 47, 34, 48],
  [28, 29, 46, 14, 47],
  [28, 13, 46, 32, 47],
  [28, 40, 47, 7, 48],
  [28, 18, 47, 31, 48],
];

/** Mittelpunkte der Ausrichtungsmuster je Version. Version 1 hat keine. */
const ALIGNMENT_CENTERS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

// --- Galois-Feld GF(256), Generator 0x11D ---------------------------------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let value = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] as number;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] as number) + (GF_LOG[b] as number)] as number;
}

/** Generatorpolynom fuer `degree` Fehlerkorrektur-Codewoerter. */
function generatorPolynomial(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] as number) ^ (poly[j] as number);
      next[j + 1] = (next[j + 1] as number) ^ gfMul(poly[j] as number, GF_EXP[i] as number);
    }
    poly = next;
  }
  return poly;
}

/** Fehlerkorrektur-Codewoerter eines Datenblocks. */
function errorCorrection(data: Uint8Array, count: number): Uint8Array {
  const generator = generatorPolynomial(count);
  const remainder = new Uint8Array(count);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.copyWithin(0, 1);
    remainder[count - 1] = 0;
    if (factor !== 0) {
      for (let i = 0; i < count; i++) {
        remainder[i] = (remainder[i] as number) ^ gfMul(generator[i + 1] as number, factor);
      }
    }
  }
  return remainder;
}

// --- Bitfolge ------------------------------------------------------------

class BitBuffer {
  private bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** Auf ganze Bytes auffuellen und als Codewoerter ausgeben. */
  toBytes(): Uint8Array {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const bytes = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < bytes.length; i++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) byte = (byte << 1) | (this.bits[i * 8 + bit] as number);
      bytes[i] = byte;
    }
    return bytes;
  }
}

/** Datencodewoerter einer Version fuer Stufe M. */
function dataCapacity(version: number): number {
  const [ecPerBlock, blocks1, data1, blocks2, data2] = EC_BLOCKS_M[version - 1] as [number, number, number, number, number];
  void ecPerBlock;
  return blocks1 * data1 + blocks2 * data2;
}

/** Laenge des Zeichenzahl-Feldes im Byte-Modus. */
function lengthBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Kleinste Version, die die Nutzlast aufnimmt. */
function pickVersion(byteLength: number): number {
  for (let version = 1; version <= 40; version++) {
    // 4 Bit Modusanzeige + Zeichenzahl + Daten
    const needed = 4 + lengthBits(version) + byteLength * 8;
    if (needed <= dataCapacity(version) * 8) return version;
  }
  throw new QrError(`Nutzlast mit ${byteLength} Byte passt in keinen QR-Code der Stufe M`);
}

/**
 * Text in Bytes nach ISO-8859-1.
 *
 * Der Beleg-QR-Code enthaelt nur ASCII. Ein Zeichen ausserhalb von
 * ISO-8859-1 wuerde stillschweigend falsch kodiert - deshalb wird es
 * gemeldet, statt ein "?" zu schreiben.
 */
function toLatin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new QrError(`Zeichen "${text[i]}" an Position ${i} ist in einem QR-Code im Byte-Modus nicht darstellbar`);
    }
    bytes[i] = code;
  }
  return bytes;
}

/** Datencodewoerter einschliesslich Auffuellung. */
function encodeData(text: string, version: number): Uint8Array {
  const payload = toLatin1(text);
  const capacity = dataCapacity(version);
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // Modus: Byte
  buffer.push(payload.length, lengthBits(version));
  for (const byte of payload) buffer.push(byte, 8);

  // Abschlussfolge, soweit Platz ist.
  const remaining = capacity * 8 - buffer.length;
  buffer.push(0, Math.min(4, remaining));

  const bytes = buffer.toBytes();
  const result = new Uint8Array(capacity);
  result.set(bytes.subarray(0, Math.min(bytes.length, capacity)));
  // Auffuellbytes 0xEC / 0x11 im Wechsel, wie in der Norm vorgegeben.
  for (let i = bytes.length; i < capacity; i++) result[i] = i % 2 === bytes.length % 2 ? 0xec : 0x11;
  return result;
}

/**
 * Daten- und Fehlerkorrektur-Codewoerter verschraenken.
 *
 * Die Norm schreibt vor, die Bloecke spaltenweise zu verschachteln, damit ein
 * beschaedigter Bereich des Codes sich auf mehrere Bloecke verteilt und
 * korrigierbar bleibt.
 */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const [ecPerBlock, blocks1, data1, blocks2, data2] = EC_BLOCKS_M[version - 1] as [number, number, number, number, number];

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < blocks1; i++) {
    const block = data.subarray(offset, offset + data1);
    offset += data1;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrection(block, ecPerBlock));
  }
  for (let i = 0; i < blocks2; i++) {
    const block = data.subarray(offset, offset + data2);
    offset += data2;
    dataBlocks.push(block);
    ecBlocks.push(errorCorrection(block, ecPerBlock));
  }

  const out: number[] = [];
  const maxData = Math.max(data1, data2);
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i] as number);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i] as number);
  }
  return new Uint8Array(out);
}

// --- Matrix --------------------------------------------------------------

type Cell = 0 | 1 | null;

function placeFunctionPatterns(matrix: Cell[][], version: number): void {
  const size = matrix.length;

  const finder = (row: number, col: number): void => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const y = row + dy;
        const x = col + dx;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inner = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
        const ring = dy === 0 || dy === 6 || dx === 0 || dx === 6;
        const inside = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
        (matrix[y] as Cell[])[x] = inside && (ring || inner) ? 1 : 0;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  // Taktmuster
  for (let i = 8; i < size - 8; i++) {
    const value: Cell = i % 2 === 0 ? 1 : 0;
    (matrix[6] as Cell[])[i] = value;
    (matrix[i] as Cell[])[6] = value;
  }

  // Ausrichtungsmuster
  const centers = ALIGNMENT_CENTERS[version - 1] as readonly number[];
  for (const row of centers) {
    for (const col of centers) {
      // Nicht ueber die Suchmuster legen.
      if ((row === 6 && col === 6) || (row === 6 && col === size - 7) || (row === size - 7 && col === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.abs(dy) === 2 || Math.abs(dx) === 2;
          const center = dy === 0 && dx === 0;
          (matrix[row + dy] as Cell[])[col + dx] = ring || center ? 1 : 0;
        }
      }
    }
  }

  // Immer dunkles Modul
  (matrix[size - 8] as Cell[])[8] = 1;
}

/** Felder der Formatinformation belegen (Inhalt kommt spaeter). */
function reserveFormatAreas(matrix: Cell[][], version: number): void {
  const size = matrix.length;
  for (let i = 0; i < 9; i++) {
    if ((matrix[8] as Cell[])[i] === null) (matrix[8] as Cell[])[i] = 0;
    if ((matrix[i] as Cell[])[8] === null) (matrix[i] as Cell[])[8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    (matrix[8] as Cell[])[size - 1 - i] = 0;
    (matrix[size - 1 - i] as Cell[])[8] = 0;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        (matrix[size - 11 + j] as Cell[])[i] = 0;
        (matrix[i] as Cell[])[size - 11 + j] = 0;
      }
    }
  }
}

/** Codewoerter im Zickzack von rechts unten nach links oben einsetzen. */
function placeData(matrix: Cell[][], codewords: Uint8Array): void {
  const size = matrix.length;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    // Die Spalte 6 ist das Taktmuster und wird uebersprungen.
    const columnRight = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [columnRight, columnRight - 1]) {
        if ((matrix[y] as Cell[])[x] !== null) continue;
        const byte = codewords[bitIndex >>> 3] ?? 0;
        const bit = (byte >>> (7 - (bitIndex & 7))) & 1;
        (matrix[y] as Cell[])[x] = bit as Cell;
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

/** Die acht Maskenmuster der Norm. */
function maskBit(mask: number, y: number, x: number): boolean {
  switch (mask) {
    case 0: return (y + x) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (y + x) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((y * x) % 2) + ((y * x) % 3) === 0;
    case 6: return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0;
    case 7: return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0;
    default: throw new QrError(`Unbekanntes Maskenmuster ${mask}`);
  }
}

const FORMAT_GENERATOR = 0b10100110111;
const FORMAT_XOR = 0b101010000010010;

/** 15 Bit Formatinformation: Stufe, Maske, BCH-Fehlerkorrektur. */
function formatBits(mask: number): number {
  // Stufe M hat die Kennung 00.
  const data = (0b00 << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((value >>> (10 + i)) & 1) value ^= FORMAT_GENERATOR << i;
  }
  return ((data << 10) | value) ^ FORMAT_XOR;
}

const VERSION_GENERATOR = 0b1111100100101;

/** 18 Bit Versionsinformation, ab Version 7. */
function versionBits(version: number): number {
  let value = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((value >>> (12 + i)) & 1) value ^= VERSION_GENERATOR << i;
  }
  return (version << 12) | value;
}

function applyFormatInfo(matrix: Cell[][], mask: number, version: number): void {
  const size = matrix.length;
  const format = formatBits(mask);

  // Jedes Bit steht zweimal im Code, damit die Formatinformation auch bei
  // einer beschaedigten Ecke lesbar bleibt. Die beiden Kopien laufen in
  // unterschiedlicher Richtung, und welches Bit wohin gehoert, gibt die Norm
  // Feld fuer Feld vor - hier ist keine Systematik zu erraten.
  for (let i = 0; i < 15; i++) {
    const bit = ((format >>> i) & 1) as Cell;

    // Senkrecht in Spalte 8: Bits 0 bis 7 von oben nach unten (Zeile 6 ist
    // Taktmuster und wird uebersprungen), Bits 8 bis 14 unten links.
    if (i < 6) (matrix[i] as Cell[])[8] = bit;
    else if (i < 8) (matrix[i + 1] as Cell[])[8] = bit;
    else (matrix[size - 15 + i] as Cell[])[8] = bit;

    // Waagerecht in Zeile 8: Bits 0 bis 7 von rechts nach links, Bit 8 auf
    // Spalte 7, Bits 9 bis 14 weiter nach links.
    if (i < 8) (matrix[8] as Cell[])[size - 1 - i] = bit;
    else if (i === 8) (matrix[8] as Cell[])[7] = bit;
    else (matrix[8] as Cell[])[14 - i] = bit;
  }
  (matrix[size - 8] as Cell[])[8] = 1;

  if (version >= 7) {
    const info = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((info >>> i) & 1) as Cell;
      const row = Math.floor(i / 3);
      const col = i % 3;
      (matrix[size - 11 + col] as Cell[])[row] = bit;
      (matrix[row] as Cell[])[size - 11 + col] = bit;
    }
  }
}

/**
 * Bewertung eines maskierten Codes nach den vier Strafregeln der Norm.
 * Die Maske mit der niedrigsten Punktzahl wird verwendet.
 */
function penalty(matrix: readonly (readonly boolean[])[]): number {
  const size = matrix.length;
  let score = 0;

  // Regel 1: Reihen gleicher Farbe ab Laenge 5.
  const runScore = (get: (i: number, j: number) => boolean): number => {
    let total = 0;
    for (let i = 0; i < size; i++) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (get(i, j) === get(i, j - 1)) {
          run++;
        } else {
          if (run >= 5) total += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) total += 3 + (run - 5);
    }
    return total;
  };
  score += runScore((y, x) => (matrix[y] as readonly boolean[])[x] as boolean);
  score += runScore((x, y) => (matrix[y] as readonly boolean[])[x] as boolean);

  // Regel 2: gleichfarbige 2x2-Bloecke.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const value = (matrix[y] as readonly boolean[])[x];
      if (
        value === (matrix[y] as readonly boolean[])[x + 1] &&
        value === (matrix[y + 1] as readonly boolean[])[x] &&
        value === (matrix[y + 1] as readonly boolean[])[x + 1]
      ) {
        score += 3;
      }
    }
  }

  // Regel 3: Muster, die ein Lesegeraet mit einem Suchmuster verwechseln kann.
  //
  // Gesucht wird das Verhaeltnis 1:1:3:1:1 mit vier hellen Modulen auf einer
  // Seite - als Bitmuster `10111010000` oder `00001011101`, jeweils elf
  // Module. Das Fenster muss vollstaendig im Symbol liegen: ein Muster, das
  // erst durch den Rand entsteht, ist keines. Andernfalls bekommen Codes mit
  // Muster am Rand zu viele Strafpunkte, und die Maskenwahl faellt anders aus
  // als bei jedem anderen Erzeuger.
  const FORWARD = 0b10111010000;
  const BACKWARD = 0b00001011101;
  for (let line = 0; line < size; line++) {
    let horizontal = 0;
    let vertical = 0;
    for (let index = 0; index < size; index++) {
      horizontal = ((horizontal << 1) & 0x7ff) | (((matrix[line] as readonly boolean[])[index] as boolean) ? 1 : 0);
      vertical = ((vertical << 1) & 0x7ff) | (((matrix[index] as readonly boolean[])[line] as boolean) ? 1 : 0);
      if (index >= 10) {
        if (horizontal === FORWARD || horizontal === BACKWARD) score += 40;
        if (vertical === FORWARD || vertical === BACKWARD) score += 40;
      }
    }
  }

  // Regel 4: Abweichung vom Verhaeltnis hell zu dunkel, in Schritten von
  // fuenf Prozentpunkten.
  let dark = 0;
  for (const row of matrix) for (const value of row) if (value) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.abs(Math.ceil(percent / 5) - 10) * 10;

  return score;
}

/**
 * QR-Code erzeugen.
 *
 * Die Maske wird nach den Strafregeln der Norm gewaehlt, nicht fest gesetzt:
 * eine ungeeignete Maske erzeugt Muster, die Lesegeraete mit den Suchmustern
 * verwechseln - und ein Beleg-QR-Code, den das Pruefgeraet des Finanzamts
 * nicht liest, ist wertlos.
 */
export function createQrCode(
  text: string,
  options: {
    readonly errorCorrection?: QrErrorCorrection;
    /**
     * Maskenmuster festsetzen (0 bis 7).
     *
     * Im Betrieb nicht gesetzt: die Norm verlangt die Wahl nach den
     * Strafregeln. Gebraucht wird das nur, um den Code gegen eine andere
     * Umsetzung zu vergleichen - dann muessen beide dieselbe Maske
     * verwenden, sonst vergleicht man zwei gueltige, aber verschiedene
     * Codes.
     */
    readonly mask?: number;
  } = {},
): QrCode {
  if (options.errorCorrection && options.errorCorrection !== "M") {
    throw new QrError(`Fehlerkorrekturstufe ${options.errorCorrection} ist nicht umgesetzt`);
  }
  if (options.mask !== undefined && !(Number.isInteger(options.mask) && options.mask >= 0 && options.mask <= 7)) {
    throw new QrError(`Maskenmuster muss eine ganze Zahl von 0 bis 7 sein, war ${options.mask}`);
  }
  if (text === "") throw new QrError("Ein QR-Code ohne Inhalt ist nicht erzeugbar");

  const payload = toLatin1(text);
  const version = pickVersion(payload.length);
  const size = version * 4 + 17;

  const codewords = interleave(encodeData(text, version), version);
  if (codewords.length !== TOTAL_CODEWORDS[version - 1]) {
    throw new QrError(
      `Codewortzahl ${codewords.length} passt nicht zu Version ${version} (erwartet ${TOTAL_CODEWORDS[version - 1]})`,
    );
  }

  const template: Cell[][] = Array.from({ length: size }, () => new Array<Cell>(size).fill(null));
  placeFunctionPatterns(template, version);
  const reserved: Cell[][] = template.map((row) => [...row]);
  reserveFormatAreas(reserved, version);
  // Nur die Datenfelder sind jetzt noch `null`.
  placeData(reserved, codewords);

  const candidates = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];
  let best: { matrix: boolean[][]; score: number } | null = null;
  for (const mask of candidates) {
    const candidate: Cell[][] = reserved.map((row) => [...row]);
    // Maskiert werden nur die Datenfelder - erkennbar daran, dass sie in der
    // Vorlage ohne Formatfelder noch leer waren.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((template[y] as Cell[])[x] !== null) continue;
        if (isFormatArea(x, y, size, version)) continue;
        if (maskBit(mask, y, x)) {
          (candidate[y] as Cell[])[x] = ((candidate[y] as Cell[])[x] === 1 ? 0 : 1) as Cell;
        }
      }
    }
    applyFormatInfo(candidate, mask, version);
    const matrix = candidate.map((row) => row.map((cell) => cell === 1));
    const score = penalty(matrix);
    if (!best || score < best.score) best = { matrix, score };
  }

  return { size, matrix: best!.matrix, version };
}

/** Gehoert das Feld zur Format- oder Versionsinformation? */
function isFormatArea(x: number, y: number, size: number, version: number): boolean {
  if (x === 8 && (y < 9 || y >= size - 8)) return true;
  if (y === 8 && (x < 9 || x >= size - 8)) return true;
  if (version >= 7) {
    if (y < 6 && x >= size - 11 && x < size - 8) return true;
    if (x < 6 && y >= size - 11 && y < size - 8) return true;
  }
  return false;
}

/**
 * Matrix in waagerechte Balken zerlegen.
 *
 * Fuer die Anzeige: ein Rechteck je zusammenhaengender dunkler Strecke statt
 * eines je Modul. Ein QR-Code ist kleinteilig, die Balken sind im Schnitt
 * knapp zwei Module lang - bei einem Beleg-QR-Code der Version 13 sind es
 * rund 1240 Rechtecke statt 2390 Einzelmodulen. Keine Groessenordnung, aber
 * die Haelfte der Elemente, und die Anzeige bleibt ohne Zeichenbibliothek
 * auskommend.
 */
export function qrRuns(code: QrCode): { y: number; x: number; length: number }[] {
  const runs: { y: number; x: number; length: number }[] = [];
  for (let y = 0; y < code.size; y++) {
    const row = code.matrix[y] as readonly boolean[];
    let x = 0;
    while (x < code.size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < code.size && row[x]) x++;
      runs.push({ y, x: start, length: x - start });
    }
  }
  return runs;
}

/**
 * Zwischenschritte, offengelegt fuer die Tests.
 *
 * Reed-Solomon-Codewoerter und Formatbits lassen sich an der fertigen Matrix
 * nur mittelbar pruefen. Sie hier zugaenglich zu machen, macht aus einem
 * "irgendwo stimmt etwas nicht" ein "dieses Codewort ist falsch". Nicht Teil
 * der Schnittstelle fuer die Anwendung.
 */
export const qrInternals = {
  encodeData,
  interleave,
  errorCorrection,
  dataCapacity,
  maskBit,
  formatBits,
  versionBits,
  pickVersion,
};

/** Matrix als Text, fuer Tests und die Fehlersuche im Terminal. */
export function qrToText(code: QrCode, dark = "██", light = "  "): string {
  return code.matrix.map((row) => row.map((cell) => (cell ? dark : light)).join("")).join("\n");
}
