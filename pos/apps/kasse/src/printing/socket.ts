/**
 * Die Steckdose zum Drucker, geraeteseitig.
 *
 * Der Kern kennt nur `SocketFactory` (printing/transport.ts). Hier wird sie
 * gefuellt - und zwar so, dass **das Fehlen des nativen Moduls die App nicht
 * zerlegt**.
 *
 * ## Warum das Modul nachgeladen wird und nicht oben importiert
 *
 * `react-native-tcp-socket` ist ein natives Modul. In Expo Go gibt es das
 * nicht: dort laeuft ein fertig gebautes Programm, in das keine fremden nativen
 * Module hineinkommen. Ein `import` am Dateikopf waere damit ein Absturz beim
 * Start der ganzen App - nicht ein fehlender Drucker, sondern eine Kasse, die
 * nicht startet.
 *
 * Deshalb `require` innerhalb einer Funktion, in `try`, mit einem klaren
 * `null`. Die Oberflaeche sagt dann, was fehlt, und der Bon geht per Anzeige,
 * Mail oder SMS heraus - die Belegausgabepflicht ist damit erfuellt
 * (§ 146a Abs. 2 AO). Der Druck ist Komfort, nicht Pflicht.
 *
 * ## Was fuer den Druck noetig ist
 *
 * Ein Entwicklungs-Build (`npx expo prebuild` und ein eigener Build) mit
 * `react-native-tcp-socket` in den Abhaengigkeiten. Bluetooth braucht
 * zusaetzlich ein SPP-Modul und die Kopplung im Betriebssystem; die Steckdose
 * dafuer ist unten vorgesehen und noch nicht belegt.
 */

import { PrinterError, type ConnectOptions, type PrinterSocket, type SocketFactory } from "@kp/core";

/**
 * Was `react-native-tcp-socket` an Form liefert, soweit hier gebraucht.
 *
 * Absichtlich eng getippt statt `any`: so faellt beim Bauen auf, wenn das Modul
 * seine Schnittstelle aendert - und nicht erst, wenn ein Bon nicht kommt.
 */
interface NativeSocket {
  write(data: Uint8Array | string, encoding?: string, callback?: (error?: Error) => void): boolean;
  end(callback?: () => void): void;
  destroy(): void;
  on(event: "error" | "close", listener: (error?: Error) => void): void;
  once(event: "connect", listener: () => void): void;
  removeAllListeners(): void;
}

interface TcpModule {
  createConnection(options: { host: string; port: number }, callback?: () => void): NativeSocket;
}

let cached: TcpModule | null | undefined;

/**
 * Das native Modul holen - einmal, und ohne zu werfen.
 *
 * `undefined` heisst "noch nicht versucht", `null` heisst "nicht vorhanden".
 * Der Unterschied spart bei jedem Druckversuch einen erneuten Ladeversuch.
 */
function tcpModule(): TcpModule | null {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require("react-native-tcp-socket") as { default?: TcpModule } & TcpModule;
    cached = loaded.default ?? loaded;
  } catch {
    cached = null;
  }
  return cached;
}

/** Ist der Druckzugriff auf diesem Geraet ueberhaupt moeglich? */
export function printingAvailable(): boolean {
  return tcpModule() !== null;
}

/**
 * Verbindung zu einem Netzwerkdrucker.
 *
 * Der Zeitgeber ist der Punkt: ohne ihn haengt ein Druckversuch an einer
 * Adresse, an der nichts antwortet, bis das Betriebssystem aufgibt - das sind
 * je nach Netz zwei Minuten, in denen der Bediener nicht weiss, was los ist.
 */
export const connectToPrinter: SocketFactory = (options: ConnectOptions) =>
  new Promise<PrinterSocket>((resolve, reject) => {
    const tcp = tcpModule();
    if (!tcp) {
      reject(
        new PrinterError(
          "Auf diesem Geraet ist kein Netzwerkzugriff fuer Drucker vorhanden. Er braucht einen Entwicklungs-Build der App.",
        ),
      );
      return;
    }

    let settled = false;
    const socket = tcp.createConnection({ host: options.host, port: options.port });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new PrinterError(`Der Drucker ${options.host}:${options.port} antwortet nicht.`));
    }, options.timeoutMs);

    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new PrinterError(`Der Drucker ${options.host}:${options.port} ist nicht erreichbar: ${error?.message ?? "unbekannt"}`));
    });

    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      resolve({
        write: (data) =>
          new Promise<void>((done, fail) => {
            socket.write(data, undefined, (error) => (error ? fail(new PrinterError(error.message)) : done()));
          }),
        close: () =>
          new Promise<void>((done) => {
            // Aufraeumen, bevor geschlossen wird: ein spaeter Fehler auf einem
            // Socket, den niemand mehr braucht, wuerde sonst als unbehandelt
            // gelten und die App beenden.
            socket.removeAllListeners();
            socket.on("error", () => undefined);
            socket.end(() => done());
            // Falls `end` nicht zurueckruft (Verbindung schon weg), nicht
            // ewig warten.
            setTimeout(done, 500);
          }),
      });
    });
  });

/**
 * Bluetooth.
 *
 * Noch nicht belegt: es braucht ein SPP-Modul und einen Entwicklungs-Build,
 * und die Kopplung selbst gehoert in die Einstellungen des Betriebssystems -
 * eine App, die Geraete selbst koppelt, braucht Rechte, die sie nicht braucht.
 *
 * Die Stelle steht hier, damit klar ist, wo sie hingehoert: `bluetoothTransport`
 * im Kern nimmt dieselbe Steckdose, und der Rest der App aendert sich nicht.
 */
export const connectToBluetoothPrinter: SocketFactory = () =>
  Promise.reject(
    new PrinterError(
      "Der Bluetooth-Druck ist in dieser Fassung noch nicht angebunden. Ein Netzwerkdrucker (LAN oder WLAN) funktioniert; der Bon kann ausserdem angezeigt und per Mail oder SMS herausgegeben werden.",
    ),
  );

/** Steckdose zur eingestellten Art - oder `null`, wenn nichts verfuegbar ist. */
export function socketFactoryFor(kind: "network" | "bluetooth" | "none"): SocketFactory | null {
  if (kind === "none") return null;
  if (kind === "bluetooth") return connectToBluetoothPrinter;
  return printingAvailable() ? connectToPrinter : null;
}
