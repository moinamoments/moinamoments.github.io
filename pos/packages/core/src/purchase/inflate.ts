/**
 * DEFLATE auspacken (RFC 1951), mit und ohne zlib-Huelle (RFC 1950).
 *
 * ## Warum das hier steht
 *
 * Eine ZUGFeRD-Rechnung ist eine PDF-Datei mit dem Rechnungs-XML als Anhang.
 * Dieser Anhang liegt fast immer als `FlateDecode`-Datenstrom vor - also
 * zlib-verpackt. Ohne Auspacken koennte die App aus einer ZUGFeRD-Datei nichts
 * lesen, und ZUGFeRD ist genau das Format, das ein Grosshaendler schickt.
 *
 * Node hat `zlib` eingebaut, React Native nicht: Hermes bringt keine
 * Kompression mit. Es bliebe ein natives Modul - das aber einen
 * Entwicklungs-Build erzwingen wuerde, und zwar fuer das blosse *Lesen* einer
 * Datei. Reines JavaScript laeuft ueberall, im Test wie auf dem Geraet.
 *
 * ## Wie geprueft wird, dass es stimmt
 *
 * Nicht an Beispielen, sondern **gegen `node:zlib`**: der Test packt mit Node
 * ein und mit diesem Code wieder aus, auch mit Zufallsdaten und mit Text, der
 * sich stark wiederholt (dort greifen die Rueckverweise). Wenn beides bei
 * jeder Eingabe uebereinstimmt, ist der Decoder richtig - das ist deutlich mehr
 * wert als eine Handvoll fester Beispiele.
 *
 * Der Code ist bewusst nah an der Norm geschrieben und nicht auf
 * Geschwindigkeit getrimmt: eine Rechnung wird einmal eingelesen, nicht
 * hundertmal je Sekunde.
 */

export class InflateError extends Error {}

/**
 * Obergrenze fuer das Ergebnis.
 *
 * Kompression kann ein Verhaeltnis von 1:1000 erreichen. Eine kleine Datei
 * kann damit zu einem Gigabyte auspacken - eine "Zip-Bombe". Eine Kasse, die
 * fremde Dateien oeffnet, braucht diese Grenze, nicht erst der Server dahinter.
 * 64 MB liegt weit ueber jeder Rechnung und weit unter dem, was ein Telefon
 * zum Absturz bringt.
 */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/** Liest Bits in der Reihenfolge, die DEFLATE vorschreibt: von unten nach oben. */
class BitReader {
  private position = 0;
  private bitBuffer = 0;
  private bitCount = 0;
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  bits(count: number): number {
    while (this.bitCount < count) {
      if (this.position >= this.data.length) throw new InflateError("Die gepackten Daten brechen mitten im Block ab.");
      this.bitBuffer |= this.data[this.position++]! << this.bitCount;
      this.bitCount += 8;
    }
    const value = this.bitBuffer & ((1 << count) - 1);
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    return value;
  }

  /** Auf die naechste Bytegrenze springen - vor einem ungepackten Block. */
  alignToByte(): void {
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  readBytes(count: number): Uint8Array {
    if (this.position + count > this.data.length) throw new InflateError("Ein ungepackter Block reicht ueber das Dateiende hinaus.");
    const slice = this.data.subarray(this.position, this.position + count);
    this.position += count;
    return slice;
  }

  get offset(): number {
    return this.position;
  }
}

/**
 * Ein kanonischer Huffman-Baum, als Tabelle.
 *
 * `counts[n]` ist die Anzahl der Symbole mit Codelaenge n, `symbols` sind die
 * Symbole nach Laenge und Wert sortiert. So beschreibt es RFC 1951 selbst; das
 * Dekodieren ist dann ein Durchlauf ueber die Laengen.
 */
interface Huffman {
  readonly counts: Int32Array;
  readonly symbols: Int32Array;
}

const MAX_BITS = 15;

function buildHuffman(lengths: readonly number[]): Huffman {
  const counts = new Int32Array(MAX_BITS + 1);
  for (const length of lengths) {
    if (length > MAX_BITS) throw new InflateError("Ungueltige Huffman-Codelaenge.");
    counts[length]!++;
  }
  counts[0] = 0;

  const offsets = new Int32Array(MAX_BITS + 2);
  for (let bits = 1; bits <= MAX_BITS; bits++) offsets[bits + 1] = offsets[bits]! + counts[bits]!;

  const symbols = new Int32Array(lengths.length);
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!;
    if (length !== 0) symbols[offsets[length]!++] = symbol;
  }
  return { counts, symbols };
}

function decodeSymbol(reader: BitReader, tree: Huffman): number {
  let code = 0;
  let first = 0;
  let index = 0;
  for (let length = 1; length <= MAX_BITS; length++) {
    code |= reader.bits(1);
    const count = tree.counts[length]!;
    if (code - first < count) return tree.symbols[index + (code - first)]!;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new InflateError("Ungueltiger Huffman-Code in den gepackten Daten.");
}

/* Tabellen aus RFC 1951, Abschnitt 3.2.5. */
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** Reihenfolge, in der die Codelaengen des Laengenalphabets stehen. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let fixedLiteral: Huffman | null = null;
let fixedDistance: Huffman | null = null;

/** Die festen Baeume aus RFC 1951, Abschnitt 3.2.6 - einmal gebaut, dann behalten. */
function fixedTrees(): { literal: Huffman; distance: Huffman } {
  if (!fixedLiteral || !fixedDistance) {
    const lengths: number[] = [];
    for (let symbol = 0; symbol < 288; symbol++) {
      lengths.push(symbol < 144 ? 8 : symbol < 256 ? 9 : symbol < 280 ? 7 : 8);
    }
    fixedLiteral = buildHuffman(lengths);
    fixedDistance = buildHuffman(new Array<number>(30).fill(5));
  }
  return { literal: fixedLiteral, distance: fixedDistance };
}

/** Waechst mit - das Ergebnis steht vorher nicht fest. */
class Output {
  private buffer: Uint8Array;
  private length = 0;
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
    this.buffer = new Uint8Array(1024);
  }

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) return;
    if (this.length + extra > this.limit) {
      throw new InflateError(
        `Die ausgepackten Daten sind groesser als ${this.limit} Bytes. Eine so grosse Datei wird nicht verarbeitet.`,
      );
    }
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const grown = new Uint8Array(Math.min(size, this.limit));
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  push(byte: number): void {
    this.ensure(1);
    this.buffer[this.length++] = byte;
  }

  append(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  /**
   * Ein Rueckverweis: `length` Bytes ab `distance` zurueck kopieren.
   *
   * Byte fuer Byte, absichtlich: Quelle und Ziel duerfen sich ueberlappen.
   * `distance` 1 mit `length` 100 wiederholt ein einzelnes Byte hundertmal -
   * so packt DEFLATE lange gleiche Strecken, und ein Blockkopieren waere hier
   * schlicht falsch.
   */
  copyBack(distance: number, length: number): void {
    if (distance > this.length) throw new InflateError("Ein Rueckverweis zeigt vor den Anfang der Daten.");
    this.ensure(length);
    let from = this.length - distance;
    for (let index = 0; index < length; index++) this.buffer[this.length++] = this.buffer[from++]!;
  }

  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/**
 * Rohes DEFLATE auspacken (ohne zlib-Huelle).
 */
export function inflateRaw(data: Uint8Array, limit: number = MAX_INFLATED_BYTES): Uint8Array {
  const reader = new BitReader(data);
  const output = new Output(limit);

  for (;;) {
    const isLast = reader.bits(1);
    const type = reader.bits(2);

    if (type === 0) {
      // Ungepackt: Laenge und ihr Einerkomplement, dann die Bytes roh.
      reader.alignToByte();
      const header = reader.readBytes(4);
      const length = header[0]! | (header[1]! << 8);
      const check = header[2]! | (header[3]! << 8);
      if ((length ^ 0xffff) !== check) throw new InflateError("Ein ungepackter Block hat eine falsche Laengenangabe.");
      output.append(reader.readBytes(length));
    } else if (type === 1 || type === 2) {
      const trees = type === 1 ? fixedTrees() : dynamicTrees(reader);
      inflateBlock(reader, output, trees.literal, trees.distance);
    } else {
      throw new InflateError("Unbekannte Blockart in den gepackten Daten.");
    }

    if (isLast) break;
  }

  return output.toBytes();
}

function dynamicTrees(reader: BitReader): { literal: Huffman; distance: Huffman } {
  const literalCount = reader.bits(5) + 257;
  const distanceCount = reader.bits(5) + 1;
  const codeLengthCount = reader.bits(4) + 4;

  const codeLengths = new Array<number>(19).fill(0);
  for (let index = 0; index < codeLengthCount; index++) {
    codeLengths[CODE_LENGTH_ORDER[index]!] = reader.bits(3);
  }
  const codeLengthTree = buildHuffman(codeLengths);

  // Die Laengen beider Alphabete stehen hintereinander in einem Strom und
  // werden gemeinsam gelesen: eine Wiederholung darf ueber die Grenze reichen.
  const lengths: number[] = [];
  const total = literalCount + distanceCount;
  while (lengths.length < total) {
    const symbol = decodeSymbol(reader, codeLengthTree);
    if (symbol < 16) {
      lengths.push(symbol);
    } else if (symbol === 16) {
      const previous = lengths[lengths.length - 1];
      if (previous === undefined) throw new InflateError("Eine Wiederholung steht vor der ersten Codelaenge.");
      const repeat = reader.bits(2) + 3;
      for (let index = 0; index < repeat; index++) lengths.push(previous);
    } else if (symbol === 17) {
      const repeat = reader.bits(3) + 3;
      for (let index = 0; index < repeat; index++) lengths.push(0);
    } else {
      const repeat = reader.bits(7) + 11;
      for (let index = 0; index < repeat; index++) lengths.push(0);
    }
  }
  if (lengths.length > total) throw new InflateError("Die Codelaengen reichen ueber das Alphabet hinaus.");

  return {
    literal: buildHuffman(lengths.slice(0, literalCount)),
    distance: buildHuffman(lengths.slice(literalCount)),
  };
}

function inflateBlock(reader: BitReader, output: Output, literal: Huffman, distance: Huffman): void {
  for (;;) {
    const symbol = decodeSymbol(reader, literal);
    if (symbol < 256) {
      output.push(symbol);
      continue;
    }
    if (symbol === 256) return;

    const lengthIndex = symbol - 257;
    if (lengthIndex >= LENGTH_BASE.length) throw new InflateError("Ungueltiger Laengencode.");
    const length = LENGTH_BASE[lengthIndex]! + reader.bits(LENGTH_EXTRA[lengthIndex]!);

    const distanceIndex = decodeSymbol(reader, distance);
    if (distanceIndex >= DISTANCE_BASE.length) throw new InflateError("Ungueltiger Abstandscode.");
    const back = DISTANCE_BASE[distanceIndex]! + reader.bits(DISTANCE_EXTRA[distanceIndex]!);

    output.copyBack(back, length);
  }
}

/**
 * Auspacken mit zlib-Huelle (RFC 1950), wie `FlateDecode` im PDF sie liefert.
 *
 * Die Huelle sind zwei Bytes davor und eine Pruefsumme dahinter. Geprueft wird
 * der Kopf: die unteren vier Bit des ersten Bytes muessen 8 sein
 * (Kompressionsverfahren "deflate"), und die beiden Bytes zusammen muessen
 * durch 31 teilbar sein. Ohne diese Pruefung wuerde eine PDF-Datei mit einem
 * anders gepackten Anhang erst tief im Bitstrom auffallen - mit einer
 * Fehlermeldung, mit der niemand etwas anfangen kann.
 */
export function inflate(data: Uint8Array, limit: number = MAX_INFLATED_BYTES): Uint8Array {
  if (data.length >= 2) {
    const cmf = data[0]!;
    const flg = data[1]!;
    if ((cmf & 0x0f) === 8 && ((cmf << 8) | flg) % 31 === 0) {
      // FDICT: ein vereinbartes Woerterbuch, das hier niemand hat.
      if ((flg & 0x20) !== 0) throw new InflateError("Der Datenstrom verlangt ein Woerterbuch, das nicht mitgeliefert wird.");
      return inflateRaw(data.subarray(2), limit);
    }
  }
  // Kein zlib-Kopf: dann ist es roh. PDF-Erzeuger liefern beides.
  return inflateRaw(data, limit);
}
