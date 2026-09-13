/**
 * Bondruck ueber ESC/POS.
 *
 * ESC/POS ist die Befehlssprache, die praktisch jeder Thermobondrucker
 * versteht - von Epson ueber Star bis zu den namenlosen Geraeten fuer 60 Euro.
 * Gedruckt wird ein Bytestrom, und der ist derselbe, gleich ob er ueber
 * Netzwerk, Bluetooth oder USB zum Drucker kommt. Deshalb steht der Aufbau
 * hier im Kern und der Transportweg in der App.
 *
 * **Netzwerk ist der Regelfall am festen Stand.** Ein Bondrucker mit
 * Netzwerkanschluss nimmt auf Port 9100 rohe ESC/POS-Bytes an (das ist der
 * verbreitete "JetDirect"-Weg). Das ist stabiler als Bluetooth: keine
 * Kopplung, die verloren geht, kein Akku, und mehrere Geraete koennen denselben
 * Drucker ansprechen. Bluetooth bleibt fuer den mobilen Einsatz - Marktstand,
 * Lieferung, Tischabrechnung.
 *
 * Zeichensatz: Codepage 858 (PC858, Westeuropa mit Euro-Zeichen). Umlaute und
 * das Euro-Zeichen sind auf einem deutschen Kassenbon nicht optional, und die
 * Werkseinstellung vieler Drucker (PC437) kennt sie nicht.
 */

import { type QrCode, createQrCode } from "./qr.ts";
import type { ReceiptView } from "./receipt.ts";
import { formatAmount } from "./money.ts";

export class PrinterError extends Error {}

/** ESC/POS-Steuerbytes. */
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Alignment = "left" | "center" | "right";

/**
 * Bytestrom fuer einen Drucker zusammenbauen.
 *
 * Sammelt Bytes in einem Puffer. Bewusst ohne Zeichenkettenverkettung: ein Bon
 * ist zur Haelfte Steuerbytes, und die ueberleben keine Textumwandlung.
 */
export class EscPosBuilder {
  private readonly bytes: number[] = [];

  /** Drucker zuruecksetzen und Zeichensatz einstellen. */
  initialize(): this {
    this.raw(ESC, 0x40); // ESC @ - Grundzustand
    // ESC t 19 - Codepage 858 (PC858, Westeuropa mit Euro). Ohne diese Zeile
    // druckt der Drucker Umlaute als Zufallszeichen.
    this.raw(ESC, 0x74, 19);
    return this;
  }

  raw(...values: number[]): this {
    for (const value of values) {
      if (!Number.isInteger(value) || value < 0 || value > 255) {
        throw new PrinterError(`${value} ist kein Byte`);
      }
      this.bytes.push(value);
    }
    return this;
  }

  align(alignment: Alignment): this {
    const code = alignment === "left" ? 0 : alignment === "center" ? 1 : 2;
    return this.raw(ESC, 0x61, code);
  }

  /** Fettschrift, fuer die Summenzeile. */
  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /** Doppelte Hoehe und Breite, fuer den Betrag. */
  doubleSize(on: boolean): this {
    return this.raw(GS, 0x21, on ? 0x11 : 0x00);
  }

  /** Text in Codepage 858. */
  text(value: string): this {
    for (const byte of encodeCp858(value)) this.bytes.push(byte);
    return this;
  }

  line(value = ""): this {
    return this.text(value).raw(LF);
  }

  feed(lines = 1): this {
    return this.raw(ESC, 0x64, Math.max(0, Math.min(255, lines)));
  }

  /**
   * QR-Code drucken.
   *
   * Nicht ueber die eingebaute QR-Funktion des Druckers (GS ( k): die ist bei
   * guenstigen Geraeten haeufig nicht oder falsch umgesetzt, und ein Bon mit
   * unlesbarem Pflicht-QR-Code ist schlimmer als einer ohne. Stattdessen wird
   * die Modulmatrix aus dem eigenen Encoder als Bild gedruckt - dieselbe
   * Matrix, die der Bildschirm zeigt.
   */
  qrCode(payload: string, options: { readonly scale?: number } = {}): this {
    const code = createQrCode(payload);
    return this.rasterImage(qrToRaster(code, options.scale ?? 4));
  }

  /**
   * Rasterbild drucken (GS v 0).
   *
   * Der Bildkopf enthaelt die Breite in Bytes und die Hoehe in Punkten, jeweils
   * als zwei Bytes mit dem niederwertigen zuerst.
   */
  rasterImage(image: { readonly widthBytes: number; readonly height: number; readonly data: Uint8Array }): this {
    if (image.data.length !== image.widthBytes * image.height) {
      throw new PrinterError(
        `Bilddaten passen nicht zu ${image.widthBytes} x ${image.height}: ${image.data.length} Bytes`,
      );
    }
    this.raw(GS, 0x76, 0x30, 0x00);
    this.raw(image.widthBytes & 0xff, (image.widthBytes >> 8) & 0xff);
    this.raw(image.height & 0xff, (image.height >> 8) & 0xff);
    for (const byte of image.data) this.bytes.push(byte);
    return this;
  }

  /**
   * Papier schneiden.
   *
   * Mit Vorschub, damit der Schnitt nicht durch die letzte Textzeile geht -
   * der Schneider sitzt einige Millimeter hinter dem Druckkopf.
   */
  cut(): this {
    return this.feed(4).raw(GS, 0x56, 0x42, 0x00);
  }

  /**
   * Geldschublade oeffnen.
   *
   * Der Impuls geht an Anschluss 2 mit 100 ms Dauer - die Werte, die die
   * verbreiteten Schubladen erwarten.
   */
  openDrawer(): this {
    return this.raw(ESC, 0x70, 0x00, 0x32, 0x32);
  }

  build(): Uint8Array {
    return new Uint8Array(this.bytes);
  }

  get length(): number {
    return this.bytes.length;
  }
}

/**
 * Text nach Codepage 858 umwandeln.
 *
 * Zeichen, die die Codepage nicht kennt, werden auf eine sinnvolle Entsprechung
 * abgebildet, statt als Zufallszeichen zu erscheinen. Ein Bon, auf dem "für"
 * als "f³r" steht, wirkt wie ein Fehler im Kassensystem - und genau so wird er
 * dem Betrieb gemeldet.
 */
export function encodeCp858(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0x3f;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const mapped = CP858[char];
    if (mapped !== undefined) {
      out.push(mapped);
      continue;
    }
    // Nicht darstellbar: auf die naechstliegende ASCII-Form bringen.
    const fallback = FALLBACK[char];
    if (fallback) {
      for (const byte of fallback) out.push(byte.charCodeAt(0));
    } else {
      out.push(0x3f); // Fragezeichen
    }
  }
  return new Uint8Array(out);
}

/** Die im deutschen Kassenbetrieb gebrauchten Zeichen aus PC858. */
const CP858: Record<string, number> = {
  "Ç": 128, "ü": 129, "é": 130, "â": 131, "ä": 132, "à": 133,
  "å": 134, "ç": 135, "ê": 136, "ë": 137, "è": 138, "ï": 139,
  "î": 140, "ì": 141, "Ä": 142, "Å": 143, "É": 144, "æ": 145,
  "Æ": 146, "ô": 147, "ö": 148, "ò": 149, "û": 150, "ù": 151,
  "ÿ": 152, "Ö": 153, "Ü": 154, "ø": 155, "£": 156, "Ø": 157,
  "×": 158, "ƒ": 159, "á": 160, "í": 161, "ó": 162, "ú": 163,
  "ñ": 164, "Ñ": 165, "ª": 166, "º": 167, "¿": 168, "®": 169,
  "¬": 170, "½": 171, "¼": 172, "¡": 173, "«": 174, "»": 175,
  // Der Euro liegt in PC858 auf 213 - das ist der Unterschied zu PC850.
  "€": 213,
  "ß": 225, "µ": 230, "±": 241, "°": 248, "·": 250, "²": 253,
};

/** Ersatzdarstellungen fuer Zeichen, die die Codepage nicht kennt. */
const FALLBACK: Record<string, string> = {
  "–": "-", // Halbgeviertstrich
  "—": "-",
  "‘": "'",
  "’": "'",
  "‚": ",",
  "“": '"',
  "”": '"',
  "„": '"',
  "…": "...",
  "›": ">",
  "‹": "<",
  "█": "#",
  " ": " ",
};

/**
 * QR-Matrix in ein Rasterbild umwandeln.
 *
 * `scale` ist die Kantenlaenge eines Moduls in Druckpunkten. Bei 203 dpi
 * (Standard bei Bondruckern) sind 4 Punkte rund 0,5 mm je Modul - damit ist ein
 * Beleg-QR-Code auf 80-mm-Papier gut lesbar und passt in die Breite. Die stille
 * Zone von vier Modulen ist Teil der Norm und nicht Zierrat: ohne sie findet
 * ein Lesegeraet die Suchmuster nicht zuverlaessig.
 */
export function qrToRaster(code: QrCode, scale = 4): { widthBytes: number; height: number; data: Uint8Array } {
  if (!Number.isInteger(scale) || scale < 1 || scale > 16) {
    throw new PrinterError(`Modulgroesse muss zwischen 1 und 16 liegen, war ${scale}`);
  }
  const quiet = 4;
  const modules = code.size + quiet * 2;
  const pixels = modules * scale;
  const widthBytes = Math.ceil(pixels / 8);
  const data = new Uint8Array(widthBytes * pixels);

  for (let y = 0; y < pixels; y++) {
    const moduleY = Math.floor(y / scale) - quiet;
    if (moduleY < 0 || moduleY >= code.size) continue;
    const row = code.matrix[moduleY] as readonly boolean[];
    for (let x = 0; x < pixels; x++) {
      const moduleX = Math.floor(x / scale) - quiet;
      if (moduleX < 0 || moduleX >= code.size) continue;
      if (!row[moduleX]) continue;
      const index = y * widthBytes + (x >> 3);
      data[index] = (data[index] as number) | (0x80 >> (x & 7));
    }
  }
  return { widthBytes, height: pixels, data };
}

/** Zeichenbreite des Papiers: 32 bei 58 mm, 42 bei 80 mm. */
export type PaperWidth = 32 | 42;

/**
 * Bon druckfertig aufbauen.
 *
 * Baut auf derselben `ReceiptView` auf, die der Bildschirm zeigt - Bon und
 * Anzeige koennen so nicht auseinanderlaufen. Der QR-Code wird als Bild
 * gedruckt, damit er auf jedem Geraet gleich aussieht.
 */
export function buildReceiptCommands(
  view: ReceiptView,
  options: { readonly width?: PaperWidth; readonly qrScale?: number; readonly openDrawer?: boolean; readonly cut?: boolean } = {},
): Uint8Array {
  const width = options.width ?? 42;
  const builder = new EscPosBuilder().initialize();

  const row = (left: string, right: string): string => {
    const space = Math.max(1, width - left.length - right.length);
    return left.length + right.length + 1 > width
      ? `${left.slice(0, Math.max(0, width - right.length - 1))} ${right}`
      : left + " ".repeat(space) + right;
  };

  builder.align("center").bold(true);
  for (const line of view.header) builder.line(line);
  builder.bold(false).line();

  builder.align("left");
  builder.line(row(`Beleg ${view.receiptNumber}`, view.serviceMode));
  builder.line(view.issuedAt);
  builder.line("-".repeat(width));

  for (const line of view.lines) {
    const prefix = line.isDeposit ? "  " : "";
    builder.line(row(`${prefix}${line.quantity} x ${line.name}`, line.total));
    if (!line.isDeposit && line.quantity !== "1") builder.line(`    Einzelpreis ${line.unitPrice}`);
    for (const note of line.notes) builder.line(`    ${note}`);
  }

  builder.line("-".repeat(width));
  // Die Summe in doppelter Groesse: das ist die Zeile, die der Kunde liest.
  builder.bold(true).doubleSize(true).line(`${view.total} €`).doubleSize(false).bold(false);
  if (view.depositBalance != null) builder.line(row("darin Pfand", formatAmount(view.depositBalance)));

  if (view.taxGroups.length > 0) {
    builder.line();
    for (const group of view.taxGroups) {
      builder.line(row(`${group.label} netto ${formatAmount(group.net)}`, `USt ${formatAmount(group.tax)}`));
    }
  }

  builder.line();
  for (const payment of view.payments) builder.line(row(payment.label, payment.amount));
  if (view.change !== 0) builder.line(row("Rueckgeld", formatAmount(view.change)));

  builder.line("-".repeat(width));
  builder.line(row("Beginn", view.startedAt));
  builder.line(row("Ende", view.finishedAt));

  if (view.qrPayload) {
    builder.align("center").feed(1);
    builder.qrCode(view.qrPayload, { qrScale: options.qrScale } as { scale?: number });
    builder.line();
    builder.line("Belegpruefung: QR-Code scannen");
    builder.align("left");
  } else {
    // Ohne QR-Code muessen die TSE-Angaben im Klartext auf den Bon - sie sind
    // Pflicht, der QR-Code ist nur die kuerzere Form davon.
    for (const line of view.tseLines) builder.line(line);
  }

  if (view.footer.length > 0) {
    builder.line("-".repeat(width));
    builder.align("center");
    for (const line of view.footer) builder.line(line);
    builder.align("left");
  }

  if (options.openDrawer) builder.openDrawer();
  if (options.cut !== false) builder.cut();
  return builder.build();
}

/**
 * Transportweg zum Drucker.
 *
 * Die App bringt die Umsetzung mit: Netzwerk ueber eine TCP-Verbindung,
 * Bluetooth ueber die Kopplung des Geraets. Der Kern kennt nur diese
 * Schnittstelle - ein neuer Weg (USB, Cloud-Drucker) ist damit eine Datei und
 * keine Umbauaktion.
 */
export interface PrinterTransport {
  readonly kind: "network" | "bluetooth" | "none";
  /** Beschreibung fuer die Anzeige, z. B. "192.168.1.50:9100". */
  readonly label: string;
  /** Bytes senden. Wirft `PrinterError`, wenn der Drucker nicht erreichbar ist. */
  send(data: Uint8Array): Promise<void>;
  /** Erreichbarkeit pruefen, ohne zu drucken. Soll nie werfen. */
  isReachable(): Promise<boolean>;
}

/** Kein Drucker eingerichtet - die App zeigt den Bon dann nur an. */
export const NO_PRINTER: PrinterTransport = {
  kind: "none",
  label: "kein Drucker",
  async send() {
    throw new PrinterError("Es ist kein Drucker eingerichtet");
  },
  async isReachable() {
    return false;
  },
};

export interface PrinterConfig {
  readonly kind: "network" | "bluetooth" | "none";
  /** Netzwerk: Adresse des Druckers. */
  readonly host?: string | null;
  /** Netzwerk: Port. 9100 ist der verbreitete Standard fuer rohe ESC/POS-Daten. */
  readonly port?: number | null;
  /** Bluetooth: Geraeteadresse aus der Kopplung. */
  readonly bluetoothAddress?: string | null;
  readonly paperWidth: PaperWidth;
  /** Geldschublade beim Barverkauf oeffnen. */
  readonly openDrawerOnCash: boolean;
}

export const DEFAULT_PRINTER_CONFIG: PrinterConfig = {
  kind: "none",
  host: null,
  port: 9100,
  bluetoothAddress: null,
  paperWidth: 42,
  openDrawerOnCash: false,
};

/** Druckereinstellungen pruefen, bevor gedruckt wird. */
export function validatePrinterConfig(config: PrinterConfig): { ok: true } | { ok: false; reason: string } {
  if (config.kind === "none") return { ok: false, reason: "Es ist kein Drucker eingerichtet." };
  if (config.kind === "network") {
    const host = config.host?.trim() ?? "";
    if (host === "") return { ok: false, reason: "Der Netzwerkdrucker braucht eine Adresse, z. B. 192.168.1.50." };
    const port = config.port ?? 9100;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      return { ok: false, reason: `${port} ist kein Port. Bondrucker nehmen ueblicherweise 9100.` };
    }
    return { ok: true };
  }
  if ((config.bluetoothAddress?.trim() ?? "") === "") {
    return { ok: false, reason: "Der Bluetooth-Drucker ist noch nicht gekoppelt." };
  }
  return { ok: true };
}
