/**
 * Das Rechnungs-XML aus einer ZUGFeRD-PDF holen.
 *
 * ## Was eine ZUGFeRD-Datei ist
 *
 * Eine gewoehnliche PDF-Rechnung - lesbar fuer den Menschen - mit dem
 * maschinenlesbaren XML **als Anhang** darin. Dasselbe gilt fuer Factur-X, das
 * franzoesische Gegenstueck; die Dateien sind technisch gleich, nur der Anhang
 * heisst anders (`factur-x.xml` statt `ZUGFeRD-invoice.xml`).
 *
 * ## Warum hier kein PDF-Leser steht
 *
 * Ein vollstaendiger PDF-Leser muesste Querverweistabellen, Objektstroeme und
 * beschaedigte Dateien beherrschen - Tausende Zeilen, die alle an fremden
 * Dateien arbeiten. Gebraucht wird aber genau eine Sache: der Anhang.
 *
 * Deshalb wird die Datei **nach Datenstroemen durchsucht**, jeder in Frage
 * kommende ausgepackt, und der genommen, der eine Rechnung ist. Das Kriterium
 * ist der Inhalt, nicht der Verweis: was sich als CII oder UBL lesen laesst,
 * *ist* die Rechnung. Ein Anhang, den eine kaputte Querverweistabelle
 * verschweigt, wird so trotzdem gefunden.
 *
 * ## Was nicht geht
 *
 *   - **Verschluesselte PDF-Dateien.** Sie werden erkannt und mit klarer
 *     Ansage abgewiesen, statt an einer unverstaendlichen Stelle zu scheitern.
 *   - **Eine PDF ohne Anhang.** Das ist eine gewoehnliche Rechnung als Bild
 *     und Text. Daraus etwas zu lesen hiesse Texterkennung - und eine falsch
 *     erkannte Menge ist schlimmer als gar keine, weil sie richtig aussieht.
 *     Siehe docs/ROADMAP.md.
 */

import { InflateError, inflate } from "./inflate.ts";

export class PdfError extends Error {}

/**
 * Groesse der PDF-Datei.
 *
 * Eine Rechnung mit ein paar Seiten liegt bei 100 KB bis 2 MB. 32 MB ist weit
 * darueber und begrenzt, was beim Durchsuchen im Speicher liegt.
 */
export const MAX_PDF_BYTES = 32 * 1024 * 1024;

/** Datenstroeme, die hoechstens geprueft werden. */
export const MAX_PDF_STREAMS = 5000;

/** Die ueblichen Namen des Anhangs - ZUGFeRD, Factur-X, XRechnung. */
export const INVOICE_ATTACHMENT_NAMES = [
  "factur-x.xml",
  "zugferd-invoice.xml",
  "zugferd-rechnung.xml",
  "xrechnung.xml",
  "order-x.xml",
];

/**
 * Bytes als Latin-1 lesen.
 *
 * Fuer die Suche nach Schluesselwoertern, nicht fuer Inhalte: Latin-1 bildet
 * jedes Byte auf genau ein Zeichen ab, damit stimmen Zeichenstellen mit
 * Bytestellen ueberein. Mit UTF-8 waere das nicht so, und jede gefundene
 * Stelle waere um die Zahl der Mehrbytezeichen davor verschoben.
 */
function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 8192;
  for (let start = 0; start < bytes.length; start += chunk) {
    out += String.fromCharCode(...bytes.subarray(start, Math.min(start + chunk, bytes.length)));
  }
  return out;
}

export interface PdfAttachment {
  /** Dateiname aus der PDF, soweit er dort steht. */
  readonly name: string | null;
  readonly content: string;
}

/** Ist das ueberhaupt eine PDF-Datei? */
export function looksLikePdf(bytes: Uint8Array): boolean {
  // "%PDF-" - laut Norm am Anfang, in der Praxis gelegentlich ein paar Bytes
  // spaeter, weil ein Werkzeug etwas davorgeschrieben hat.
  return latin1(bytes.subarray(0, 1024)).includes("%PDF-");
}

/**
 * Das Rechnungs-XML aus einer PDF-Datei holen.
 *
 * Wirft `PdfError`, wenn keines drin ist - mit einem Text, der sagt, was der
 * Bediener stattdessen tun kann.
 */
export function extractInvoiceXml(bytes: Uint8Array): PdfAttachment {
  if (bytes.length > MAX_PDF_BYTES) {
    throw new PdfError(`Die Datei ist zu gross (${Math.round(bytes.length / 1024 / 1024)} MB, verarbeitet werden bis zu 32 MB).`);
  }
  if (!looksLikePdf(bytes)) throw new PdfError("Die Datei ist keine PDF-Datei.");

  const source = latin1(bytes);

  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(source)) {
    throw new PdfError(
      "Die PDF-Datei ist verschluesselt. Bitten Sie den Lieferanten um die Datei ohne Schutz, oder um die reine XML-Rechnung.",
    );
  }

  const names = attachmentNames(source);
  let checked = 0;

  for (const stream of streams(source, bytes)) {
    if (++checked > MAX_PDF_STREAMS) break;
    const content = tryDecodeInvoice(stream);
    if (content) {
      return { name: names[0] ?? null, content };
    }
  }

  throw new PdfError(
    "In dieser PDF-Datei steckt keine maschinenlesbare Rechnung (ZUGFeRD, Factur-X oder XRechnung). Sie enthaelt nur die gedruckte Ansicht. Der Wareneingang kann aus einer XML-Datei, aus einer CSV-Datei oder von Hand gebucht werden.",
  );
}

/** Die Namen der Anhaenge, wie sie in der PDF stehen - nur zur Anzeige. */
function attachmentNames(source: string): string[] {
  const found: string[] = [];
  // /F (factur-x.xml) oder /UF <FEFF...>; gesucht wird die einfache Form.
  const pattern = /\/(?:UF|F)\s*\(([^)]{1,200})\)/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!;
    if (/\.xml$/i.test(name) && !found.includes(name)) found.push(name);
  }
  // Die bekannten Namen zuerst - in einer PDF koennen mehrere Anhaenge stecken.
  return found.sort((a, b) => rank(a) - rank(b));
}

function rank(name: string): number {
  const index = INVOICE_ATTACHMENT_NAMES.indexOf(name.toLowerCase());
  return index < 0 ? INVOICE_ATTACHMENT_NAMES.length : index;
}

interface RawStream {
  readonly dictionary: string;
  readonly data: Uint8Array;
}

/**
 * Alle Datenstroeme der Datei, mit dem Woerterbuch davor.
 *
 * Anhaenge zuerst: ein `/Type /EmbeddedFile` ist der wahrscheinlichste
 * Kandidat, und ihn zuerst zu pruefen spart das Auspacken jeder Seite.
 */
function* streams(source: string, bytes: Uint8Array): Generator<RawStream> {
  const found: RawStream[] = [];

  let position = 0;
  for (;;) {
    const start = source.indexOf("stream", position);
    if (start < 0) break;
    position = start + 6;

    // "endstream" enthaelt "stream" - diese Treffer sind keine Anfaenge.
    if (start >= 3 && source.startsWith("end", start - 3)) continue;

    // Nach dem Schluesselwort steht CRLF oder LF, sonst nichts.
    let dataStart = start + 6;
    if (source[dataStart] === "\r") dataStart++;
    if (source[dataStart] === "\n") dataStart++;
    else if (source[dataStart - 1] !== "\n") continue;

    const end = source.indexOf("endstream", dataStart);
    if (end < 0) continue;

    // Das Woerterbuch steht zwischen dem Objektkopf und dem Schluesselwort.
    const objectStart = source.lastIndexOf(" obj", start);
    const dictionary = source.slice(objectStart < 0 ? Math.max(0, start - 2000) : objectStart, start);

    // Der Zeilenumbruch vor "endstream" gehoert nicht zu den Daten.
    let dataEnd = end;
    if (source[dataEnd - 1] === "\n") dataEnd--;
    if (source[dataEnd - 1] === "\r") dataEnd--;

    found.push({ dictionary, data: bytes.subarray(dataStart, dataEnd) });
    position = end + 9;
  }

  const embedded = found.filter((stream) => stream.dictionary.includes("EmbeddedFile"));
  yield* embedded;
  for (const stream of found) if (!embedded.includes(stream)) yield stream;
}

/**
 * Einen Datenstrom auspacken und pruefen, ob eine Rechnung darin steht.
 *
 * Fehler sind hier **kein Abbruch**: ein Bild, das nicht aufgeht, sagt nur,
 * dass es nicht die Rechnung war. Abgebrochen wird erst, wenn kein einziger
 * Strom eine Rechnung enthaelt - dann mit einer Meldung, die weiterhilft.
 */
function tryDecodeInvoice(stream: RawStream): string | null {
  const filter = /\/Filter\s*(\/\w+|\[[^\]]*\])/.exec(stream.dictionary)?.[1] ?? "";

  let data: Uint8Array;
  if (filter.includes("FlateDecode")) {
    try {
      data = inflate(stream.data);
    } catch (error) {
      if (error instanceof InflateError) return null;
      throw error;
    }
  } else if (filter.trim().length === 0) {
    data = stream.data;
  } else {
    // ASCIIHexDecode, DCTDecode (JPEG), CCITTFaxDecode und die uebrigen:
    // darin steckt keine Rechnung.
    return null;
  }

  return asInvoiceXml(data);
}

/**
 * Sind das Bytes einer Rechnung?
 *
 * Geprueft wird auf das Wurzelelement, nicht auf irgendein XML: in einer PDF
 * stecken mit XMP auch Metadaten als XML, und die sind keine Rechnung.
 */
export function asInvoiceXml(data: Uint8Array): string | null {
  if (data.length < 32) return null;

  // Ein XML-Anhang ist praktisch immer UTF-8. `fatal` faengt Bilddaten ab, die
  // sonst als Zeichensalat durchkaemen.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return null;
  }

  const head = text.slice(0, 4096);
  if (!head.includes("<")) return null;
  if (/<(\w+:)?CrossIndustryInvoice[\s>]/.test(head)) return text;
  if (/<(\w+:)?(Invoice|CreditNote)[\s>]/.test(head)) return text;
  return null;
}

/**
 * Base64 in Bytes.
 *
 * Eine PDF-Datei ist binaer. `expo-file-system` liefert sie als Base64, weil
 * eine Zeichenkette der einzige Weg ueber die Bruecke zwischen JavaScript und
 * dem Betriebssystem ist. Hermes hat kein verlaessliches `atob` und kein
 * `Buffer` - also hier, in fuenfzehn Zeilen, statt eines Pakets dafuer.
 *
 * Leerraum und Zeilenumbrueche werden uebergangen: manche Werkzeuge brechen
 * Base64 alle 76 Zeichen um, und das ist kein Fehler.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = base64.replace(/[\s=]/g, "");
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));

  let buffer = 0;
  let bits = 0;
  let out = 0;
  for (const char of clean) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new PdfError("Die Datei konnte nicht gelesen werden (ungueltige Kodierung).");
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, out);
}
