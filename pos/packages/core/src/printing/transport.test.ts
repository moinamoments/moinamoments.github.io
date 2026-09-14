/**
 * Tests des Druckertransports.
 *
 * Der Kern davon: es wird gegen einen **echten TCP-Server** geprueft, den Node
 * selbst aufmacht. Damit ist das Byteschreiben wirklich getestet und nicht nur
 * eine Attrappe befragt - die Stelle, an der Druckanbindungen sonst
 * ungeprueft bleiben, weil sie angeblich nur am Geraet zu testen sind.
 *
 * Was hier nicht geprueft werden kann: dass ein bestimmter Bondrucker die
 * ESC/POS-Befehle so versteht, wie die Norm es sagt. Dafuer braucht es das
 * Geraet. Geprueft ist alles davor - dass die richtigen Bytes in der richtigen
 * Reihenfolge und in verdaulichen Stuecken ankommen.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  CHUNK_SIZE,
  DEFAULT_PRINTER_CONFIG,
  NO_PRINTER,
  PrinterError,
  bluetoothTransport,
  networkTransport,
  transportFor,
  type ConnectOptions,
  type PrinterConfig,
  type PrinterSocket,
  type SocketFactory,
} from "../index.ts";

/** Kein Warten in Tests - die Pausen sind fuer den Drucker, nicht fuer uns. */
const noSleep = async (): Promise<void> => undefined;

// --- Ein echter TCP-Server ------------------------------------------------

interface FakePrinter {
  readonly port: number;
  /** Alles, was der "Drucker" empfangen hat. */
  received(): Uint8Array;
  connections(): number;
  close(): Promise<void>;
}

/** Einen Bondrucker auf einem freien Port nachstellen. */
async function startFakePrinter(): Promise<FakePrinter> {
  const parts: Buffer[] = [];
  let connections = 0;

  const server = net.createServer((socket) => {
    connections++;
    socket.on("data", (data) => parts.push(data));
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("kein Port");

  return {
    port: address.port,
    received: () => new Uint8Array(Buffer.concat(parts)),
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Die Steckdose, die die App sonst mitbringt - hier auf Node-Sockets. */
const tcpConnect: SocketFactory = (options: ConnectOptions) =>
  new Promise<PrinterSocket>((resolve, reject) => {
    const socket = net.connect({ host: options.host, port: options.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new PrinterError(`Der Drucker ${options.host}:${options.port} antwortet nicht.`));
    }, options.timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve({
        write: (data) =>
          new Promise<void>((done, fail) => {
            socket.write(data, (error) => (error ? fail(error) : done()));
          }),
        close: () =>
          new Promise<void>((done) => {
            socket.end(() => done());
          }),
      });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

// --- Netzwerkdrucker ------------------------------------------------------

test("die Bytes kommen vollstaendig und in der richtigen Reihenfolge an", async () => {
  const printer = await startFakePrinter();
  try {
    const transport = networkTransport({
      host: "127.0.0.1",
      port: printer.port,
      connect: tcpConnect,
      sleepFn: noSleep,
    });
    assert.equal(transport.kind, "network");
    assert.equal(transport.label, `127.0.0.1:${printer.port}`);

    const data = new Uint8Array([0x1b, 0x40, 0x48, 0x61, 0x6c, 0x6c, 0x6f, 0x0a]);
    await transport.send(data);

    // Kurz warten, bis der Server alles gelesen hat - `end()` garantiert nur
    // das Senden, nicht das Empfangen.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual([...printer.received()], [...data]);
  } finally {
    await printer.close();
  }
});

test("ein grosser Bon kommt vollstaendig durch", async () => {
  const printer = await startFakePrinter();
  try {
    const transport = networkTransport({
      host: "127.0.0.1",
      port: printer.port,
      connect: tcpConnect,
      sleepFn: noSleep,
    });

    const data = new Uint8Array(CHUNK_SIZE * 3 + 17).fill(0x41);
    await transport.send(data);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(printer.received().length, data.length, "nichts verloren");
  } finally {
    await printer.close();
  }
});

test("ein grosser Bon wird in Stuecken geschrieben", async () => {
  // Der Grund: ein Bondrucker hat einen Puffer von wenigen Kilobyte. Ein Bon
  // mit QR-Code als Rastergrafik ist leicht 8 kB - in einem Schwung gesendet
  // gibt das bei manchen Geraeten abgeschnittene Bons.
  //
  // Geprueft wird am **Socket**, nicht am Server: TCP ist ein Datenstrom, der
  // Empfaenger sieht Schreibgrenzen gar nicht. Ein Test, der die Stueckelung
  // aus den Empfangsereignissen ablesen will, prueft das Zusammenfassen des
  // Betriebssystems und nicht unseren Code - das war der erste Anlauf hier,
  // und er ist zu Recht fehlgeschlagen.
  const written: number[] = [];
  const transport = networkTransport({
    host: "192.168.1.50",
    port: 9100,
    connect: async () => ({
      write: async (data) => {
        written.push(data.length);
      },
      close: async () => undefined,
    }),
    sleepFn: noSleep,
  });

  const size = CHUNK_SIZE * 3 + 17;
  await transport.send(new Uint8Array(size));

  assert.equal(written.length, 4, `erwartet vier Stuecke, waren ${written.join(", ")}`);
  assert.ok(Math.max(...written) <= CHUNK_SIZE);
  assert.equal(written.reduce((sum, value) => sum + value, 0), size, "nichts verloren, nichts doppelt");
});

test("zwischen den Stuecken wird gewartet, nach dem letzten nicht", async () => {
  // Die Pause gibt dem Drucker Zeit fuer den Papiervorschub. Nach dem letzten
  // Stueck waere sie nur Verzoegerung.
  let pauses = 0;
  const transport = networkTransport({
    host: "192.168.1.50",
    port: 9100,
    connect: async () => ({ write: async () => undefined, close: async () => undefined }),
    sleepFn: async () => {
      pauses++;
    },
  });

  await transport.send(new Uint8Array(CHUNK_SIZE * 3));
  assert.equal(pauses, 2, "drei Stuecke, zwei Pausen");

  pauses = 0;
  await transport.send(new Uint8Array(10));
  assert.equal(pauses, 0, "ein Stueck, keine Pause");
});

test("je Auftrag wird neu verbunden", async () => {
  // Eine offen gehaltene Verbindung klingt sparsamer, ist es aber nicht:
  // Bondrucker schliessen sie von sich aus, und dann scheitert der *zweite*
  // Bon - der aergerlichste Fehler, weil er beim ersten nicht auftritt.
  const printer = await startFakePrinter();
  try {
    const transport = networkTransport({
      host: "127.0.0.1",
      port: printer.port,
      connect: tcpConnect,
      sleepFn: noSleep,
    });
    await transport.send(new Uint8Array([1, 2, 3]));
    await transport.send(new Uint8Array([4, 5, 6]));
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(printer.connections(), 2);
    assert.deepEqual([...printer.received()], [1, 2, 3, 4, 5, 6]);
  } finally {
    await printer.close();
  }
});

test("ein nicht erreichbarer Drucker meldet sich, statt haengen zu bleiben", async () => {
  // Auf einem geschlossenen Port lehnt das Betriebssystem sofort ab.
  const printer = await startFakePrinter();
  const port = printer.port;
  await printer.close();

  const transport = networkTransport({ host: "127.0.0.1", port, connect: tcpConnect, sleepFn: noSleep });
  await assert.rejects(() => transport.send(new Uint8Array([1])));
  assert.equal(await transport.isReachable(), false, "die Statusanzeige darf nie werfen");
});

test("die Erreichbarkeitspruefung wirft nie", async () => {
  const printer = await startFakePrinter();
  try {
    const reachable = networkTransport({
      host: "127.0.0.1",
      port: printer.port,
      connect: tcpConnect,
      sleepFn: noSleep,
    });
    assert.equal(await reachable.isReachable(), true);

    // Auch eine Steckdose, die selbst wirft, darf die Anzeige nicht umbringen.
    const broken = networkTransport({
      host: "127.0.0.1",
      port: printer.port,
      connect: async () => {
        throw new Error("kaputt");
      },
      sleepFn: noSleep,
    });
    assert.equal(await broken.isReachable(), false);
  } finally {
    await printer.close();
  }
});

test("ein Drucker ausserhalb des eigenen Netzes wird abgelehnt", async () => {
  // Bondrucker sprechen kein TLS. Ein "Drucker" im Internet bekaeme den
  // Tagesumsatz im Klartext zugeschickt.
  const transport = networkTransport({
    host: "93.184.216.34",
    port: 9100,
    connect: async () => {
      throw new Error("haette gar nicht verbinden duerfen");
    },
    sleepFn: noSleep,
  });

  await assert.rejects(() => transport.send(new Uint8Array([1])), PrinterError);
  await assert.rejects(() => transport.send(new Uint8Array([1])), /eigenen Netz/);
  assert.equal(await transport.isReachable(), false);
});

test("die Adresspruefung sitzt im Transport, nicht nur in der Einstellung", async () => {
  // Eine Adresse kann sich zwischen Einrichtung und Druck geaendert haben -
  // etwa durch eine eingespielte Sicherung.
  let connected = false;
  const transport = networkTransport({
    host: "drucker.beispiel.de",
    port: 9100,
    connect: async () => {
      connected = true;
      throw new Error("unerreichbar");
    },
    sleepFn: noSleep,
  });
  await assert.rejects(() => transport.send(new Uint8Array([1])), /eigenen Netz/);
  assert.equal(connected, false, "es wurde gar nicht erst verbunden");
});

test("nach einem Fehler beim Schreiben wird trotzdem geschlossen", async () => {
  // Ein offener Socket haelt den einzigen Anschluss des Druckers belegt, und
  // der naechste Versuch scheitert dann mit einer irrefuehrenden Meldung.
  let closed = false;
  const transport = networkTransport({
    host: "192.168.1.50",
    port: 9100,
    connect: async () => ({
      write: async () => {
        throw new Error("Papier alle");
      },
      close: async () => {
        closed = true;
      },
    }),
    sleepFn: noSleep,
  });

  await assert.rejects(() => transport.send(new Uint8Array([1])), /Papier alle/);
  assert.equal(closed, true);
});

test("ein Fehler beim Schliessen verdeckt nicht den eigentlichen Fehler", async () => {
  const transport = networkTransport({
    host: "192.168.1.50",
    port: 9100,
    connect: async () => ({
      write: async () => {
        throw new Error("Papier alle");
      },
      close: async () => {
        throw new Error("Socket kaputt");
      },
    }),
    sleepFn: noSleep,
  });
  // Der Bediener soll "Papier alle" lesen, nicht "Socket kaputt".
  await assert.rejects(() => transport.send(new Uint8Array([1])), /Papier alle/);
});

// --- Bluetooth ------------------------------------------------------------

test("Bluetooth sendet in kleineren Stuecken", async () => {
  // Der Durchsatz einer Bluetooth-Verbindung ist deutlich geringer als im
  // Netzwerk.
  const written: number[] = [];
  const transport = bluetoothTransport({
    address: "00:11:22:33:44:55",
    connect: async () => ({
      write: async (data) => {
        written.push(data.length);
      },
      close: async () => undefined,
    }),
    sleepFn: noSleep,
  });

  assert.equal(transport.kind, "bluetooth");
  assert.equal(transport.label, "00:11:22:33:44:55");
  await transport.send(new Uint8Array(1000));
  assert.ok(written.length >= 4, `zu grosse Stuecke: ${written.join(", ")}`);
  assert.ok(Math.max(...written) <= 256);
  assert.equal(written.reduce((sum, value) => sum + value, 0), 1000);
});

test("ein ungekoppelter Bluetooth-Drucker wird beim Anlegen abgewiesen", () => {
  assert.throws(
    () => bluetoothTransport({ address: "  ", connect: async () => ({ write: async () => undefined, close: async () => undefined }) }),
    /nicht gekoppelt/,
  );
});

// --- Aus der Einstellung --------------------------------------------------

test("ohne Drucker gibt es keinen Fehler, sondern den Hinweis", () => {
  // Eine Kasse ohne Drucker ist ein gueltiger Zustand: der Bon wird angezeigt
  // und per Mail oder SMS herausgegeben. Die Belegausgabepflicht ist damit
  // erfuellt.
  const result = transportFor(DEFAULT_PRINTER_CONFIG, tcpConnect);
  assert.equal(result.transport, NO_PRINTER);
  assert.match(result.reason ?? "", /kein Drucker eingerichtet/);
});

test("ohne Druckzugriff steht der Grund dabei", () => {
  const config: PrinterConfig = { ...DEFAULT_PRINTER_CONFIG, kind: "network", host: "192.168.1.50", port: 9100 };
  const result = transportFor(config, null);
  assert.equal(result.transport, NO_PRINTER);
  assert.match(result.reason ?? "", /Entwicklungs-Build/);
});

test("eine unvollstaendige Einstellung haelt keinen Verkauf auf", () => {
  // Sie liefert NO_PRINTER samt Grund - und wirft nicht, denn dann haenge ein
  // Verkauf an einer Druckereinstellung.
  const noHost: PrinterConfig = { ...DEFAULT_PRINTER_CONFIG, kind: "network", host: "", port: 9100 };
  const result = transportFor(noHost, tcpConnect);
  assert.equal(result.transport, NO_PRINTER);
  assert.match(result.reason ?? "", /Adresse/);

  const noPairing: PrinterConfig = { ...DEFAULT_PRINTER_CONFIG, kind: "bluetooth", bluetoothAddress: null };
  const bluetooth = transportFor(noPairing, tcpConnect);
  assert.equal(bluetooth.transport, NO_PRINTER);
  assert.match(bluetooth.reason ?? "", /gekoppelt/);
});

test("eine gueltige Einstellung ergibt einen brauchbaren Transport", () => {
  const network = transportFor(
    { ...DEFAULT_PRINTER_CONFIG, kind: "network", host: "192.168.1.50", port: 9100 },
    tcpConnect,
  );
  assert.equal(network.reason, null);
  assert.equal(network.transport.kind, "network");
  assert.equal(network.transport.label, "192.168.1.50:9100");

  const bluetooth = transportFor(
    { ...DEFAULT_PRINTER_CONFIG, kind: "bluetooth", bluetoothAddress: "00:11:22:33:44:55" },
    tcpConnect,
  );
  assert.equal(bluetooth.reason, null);
  assert.equal(bluetooth.transport.kind, "bluetooth");
});
