/**
 * Wege zum Bondrucker.
 *
 * Der Kern kennt keinen Socket und kein Bluetooth - er kennt eine
 * **Steckdose**: `SocketFactory`. Die App steckt hinein, was das Geraet
 * hergibt; im Test steckt ein echter TCP-Server von Node hinein oder eine
 * Attrappe. Damit ist der Transport prueffbar, ohne dass ein Drucker im Raum
 * steht - und genau daran scheitern Druckanbindungen sonst: sie lassen sich nur
 * am Gerät testen, also werden sie nicht getestet.
 *
 * ## Warum ESC/POS in Stuecken gesendet wird
 *
 * Ein Bondrucker hat einen Puffer von wenigen Kilobyte. Wer einen Bon mit
 * QR-Code - leicht 8 kB Rastergrafik - in einem Schwung sendet, bekommt bei
 * manchen Geraeten abgeschnittene Bons oder Zeichensalat. Deshalb geht es in
 * Stuecken mit einer kurzen Pause; der Drucker kommt so mit dem Papiervorschub
 * nach.
 *
 * ## Warum kein Nachdruck-Zwischenspeicher
 *
 * Ein fehlgeschlagener Druck **verliert nichts**: der Beleg steht schon in der
 * Datenbank, bevor gedruckt wird, und die Belegliste kann ihn erneut ausgeben.
 * Eine Warteschlange fuer Druckaufträge waere ein zweiter Ort, an dem Belege
 * liegen - und damit eine zweite Wahrheit darüber, was ausgegeben wurde.
 *
 * ## Der Grund fuer die Adresspruefung
 *
 * Ein Bondrucker spricht kein TLS. Er darf deshalb nur im eigenen Netz stehen
 * (`checkLocalPrinterUrl` in security/device.ts) - ein "Drucker" im Internet
 * bekaeme den Tagesumsatz im Klartext zugeschickt. Die Pruefung sitzt hier im
 * Transport und nicht nur in der Einstellung: eine Adresse kann sich zwischen
 * Einrichtung und Druck geaendert haben.
 */

import { NO_PRINTER, PrinterError, type PrinterConfig, type PrinterTransport, validatePrinterConfig } from "../escpos.ts";
import { checkLocalPrinterUrl } from "../security/device.ts";

/**
 * Eine offene Verbindung zum Drucker.
 *
 * Absichtlich winzig: schreiben und schliessen. Alles, was ein Bondrucker
 * braucht - er antwortet nicht, und wenn doch, interessiert es nicht.
 */
export interface PrinterSocket {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  readonly host: string;
  readonly port: number;
  /** Zeit bis zum Abbruch des Verbindungsversuchs. */
  readonly timeoutMs: number;
}

/** Verbindung aufbauen. Die App bringt die Umsetzung mit. */
export type SocketFactory = (options: ConnectOptions) => Promise<PrinterSocket>;

/** Groesse eines Stuecks. 1 kB liegt unter dem Puffer jedes gaengigen Geraets. */
export const CHUNK_SIZE = 1024;

/** Pause zwischen zwei Stuecken, damit der Drucker nachkommt. */
export const CHUNK_PAUSE_MS = 20;

/** Zeit bis zum Abbruch. Ein Drucker im eigenen Netz antwortet in Millisekunden. */
export const CONNECT_TIMEOUT_MS = 4000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface NetworkTransportOptions {
  readonly host: string;
  readonly port: number;
  readonly connect: SocketFactory;
  readonly chunkSize?: number;
  readonly pauseMs?: number;
  readonly timeoutMs?: number;
  /** Nur fuer Tests: Pausen ueberspringen. */
  readonly sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Drucker im Netzwerk (LAN oder WLAN).
 *
 * Port 9100 ist der verbreitete Standard fuer rohe Druckdaten ("JetDirect");
 * ein Bondrucker mit Netzwerkanschluss nimmt dort ESC/POS-Bytes an, ohne
 * Protokoll darum.
 *
 * Je Auftrag wird neu verbunden und danach geschlossen. Eine offen gehaltene
 * Verbindung klingt sparsamer, ist es aber nicht: Bondrucker schliessen sie von
 * sich aus nach kurzer Zeit, und dann scheitert der naechste Druck an einer
 * Verbindung, die es nicht mehr gibt - der aergerlichste Fehler, weil er nur
 * beim zweiten Bon auftritt.
 */
export function networkTransport(options: NetworkTransportOptions): PrinterTransport {
  const host = options.host.trim();
  const port = options.port;
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  const pauseMs = options.pauseMs ?? CHUNK_PAUSE_MS;
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const pause = options.sleepFn ?? sleep;

  const assertLocal = (): void => {
    const local = checkLocalPrinterUrl(host);
    if (!local.ok) throw new PrinterError(local.reason);
  };

  return {
    kind: "network",
    label: `${host}:${port}`,

    async send(data: Uint8Array) {
      assertLocal();
      const socket = await options.connect({ host, port, timeoutMs });
      try {
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          await socket.write(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
          if (offset + chunkSize < data.length) await pause(pauseMs);
        }
      } finally {
        // Auch nach einem Fehler schliessen: ein offener Socket haelt den
        // einzigen Anschluss des Druckers belegt, und der naechste Versuch
        // scheitert dann mit einer irrefuehrenden Meldung.
        await socket.close().catch(() => undefined);
      }
    },

    async isReachable() {
      // Darf nie werfen - der Statusanzeige ist ein `false` lieber als ein
      // Absturz.
      try {
        assertLocal();
        const socket = await options.connect({ host, port, timeoutMs });
        await socket.close().catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export interface BluetoothTransportOptions {
  readonly address: string;
  readonly connect: SocketFactory;
  readonly chunkSize?: number;
  readonly pauseMs?: number;
  readonly timeoutMs?: number;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Drucker ueber Bluetooth.
 *
 * Technisch dasselbe Byteschreiben wie im Netzwerk, nur ueber einen anderen
 * Kanal (SPP). Die Kopplung selbst geschieht in den Einstellungen des
 * Betriebssystems - eine App, die Geraete selbst koppelt, braucht Rechte, die
 * sie nicht braucht.
 *
 * Die Adresse wird als `host` durchgereicht; die Umsetzung in der App
 * unterscheidet daran, ob sie einen TCP-Socket oder einen Bluetooth-Kanal
 * oeffnet. Kleinere Stuecke als im Netzwerk: der Durchsatz einer
 * Bluetooth-Verbindung ist deutlich geringer.
 */
export function bluetoothTransport(options: BluetoothTransportOptions): PrinterTransport {
  const address = options.address.trim();
  const chunkSize = options.chunkSize ?? 256;
  const pauseMs = options.pauseMs ?? 40;
  const timeoutMs = options.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const pause = options.sleepFn ?? sleep;

  if (address === "") throw new PrinterError("Der Bluetooth-Drucker ist noch nicht gekoppelt.");

  return {
    kind: "bluetooth",
    label: address,

    async send(data: Uint8Array) {
      const socket = await options.connect({ host: address, port: 0, timeoutMs });
      try {
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          await socket.write(data.subarray(offset, Math.min(offset + chunkSize, data.length)));
          if (offset + chunkSize < data.length) await pause(pauseMs);
        }
      } finally {
        await socket.close().catch(() => undefined);
      }
    },

    async isReachable() {
      try {
        const socket = await options.connect({ host: address, port: 0, timeoutMs });
        await socket.close().catch(() => undefined);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Transport aus der Einstellung bilden.
 *
 * Gibt `NO_PRINTER` zurueck, wenn keiner eingerichtet ist - und **wirft nicht**:
 * eine Kasse ohne Drucker ist ein gueltiger Zustand, der Bon wird dann angezeigt
 * und per Mail oder SMS herausgegeben. Die Belegausgabepflicht ist damit erfuellt
 * (§ 146a Abs. 2 AO).
 *
 * Bei einer unbrauchbaren Einstellung wird ebenfalls `NO_PRINTER` geliefert,
 * zusammen mit dem Grund - so kann die Oberflaeche ihn anzeigen, ohne dass ein
 * Verkauf an einer Druckereinstellung haengt.
 */
export function transportFor(
  config: PrinterConfig,
  connect: SocketFactory | null,
): { readonly transport: PrinterTransport; readonly reason: string | null } {
  if (config.kind === "none") return { transport: NO_PRINTER, reason: "Es ist kein Drucker eingerichtet." };
  if (!connect) {
    return {
      transport: NO_PRINTER,
      reason:
        "Auf diesem Geraet ist der Druckzugriff nicht verfuegbar. Er braucht einen Entwicklungs-Build der App - in Expo Go gibt es keinen Netzwerk- und keinen Bluetooth-Zugriff.",
    };
  }

  const valid = validatePrinterConfig(config);
  if (!valid.ok) return { transport: NO_PRINTER, reason: valid.reason };

  try {
    if (config.kind === "network") {
      return {
        transport: networkTransport({ host: config.host ?? "", port: config.port ?? 9100, connect }),
        reason: null,
      };
    }
    return { transport: bluetoothTransport({ address: config.bluetoothAddress ?? "", connect }), reason: null };
  } catch (issue) {
    return { transport: NO_PRINTER, reason: (issue as Error).message };
  }
}
