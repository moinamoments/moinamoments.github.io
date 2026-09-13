/**
 * Test- und Entwicklungs-TSE.
 *
 * ACHTUNG: Diese Implementierung erzeugt *keine* gueltigen Signaturen. Sie
 * ist ausschliesslich fuer Tests und die Entwicklung am Schreibtisch gedacht.
 * Ein Produktivbetrieb mit dieser Klasse ist eine Steuergefaehrdung nach
 * § 379 AO. Die Belege tragen deshalb sichtbar `TEST-TSE` in der
 * Seriennummer - damit ein versehentlich produktiv gedruckter Bon sofort
 * auffaellt und nicht als echter Beleg durchgeht.
 */

import type { Clock } from "../clock.ts";
import { fixedClock } from "../clock.ts";
import {
  type FinishTransactionRequest,
  type StartTransactionRequest,
  TseError,
  type TseClient,
  type TseInfo,
  type TseResponse,
} from "./types.ts";

export interface MockTseOptions {
  readonly clock?: Clock;
  readonly serialNumber?: string;
  /** Auf `false` gesetzt verhaelt sich die TSE wie ausgefallen. */
  available?: boolean;
}

/**
 * Deterministischer Pseudo-Pruefwert.
 *
 * FNV-1a ueber die Eingabe, als Base64 der 16 Bytes. Reicht, um im Test zu
 * pruefen, dass die richtigen Daten in die Signatur eingehen - und ist
 * offensichtlich keine Kryptografie.
 */
function pseudoSignature(input: string): string {
  const bytes = new Uint8Array(16);
  let hash = 0x811c9dc5;
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i) + round;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    bytes[round * 4 + 0] = (hash >>> 24) & 0xff;
    bytes[round * 4 + 1] = (hash >>> 16) & 0xff;
    bytes[round * 4 + 2] = (hash >>> 8) & 0xff;
    bytes[round * 4 + 3] = hash & 0xff;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // btoa ist in Node, im Browser und in React Native vorhanden.
  return globalThis.btoa(binary);
}

interface OpenTransaction {
  readonly transactionNumber: number;
  readonly clientId: string;
  readonly startTime: string;
  finished: boolean;
}

export class MockTse implements TseClient {
  private readonly clock: Clock;
  private readonly serialNumber: string;
  private transactionCounter = 0;
  private signatureCounter = 0;
  private readonly transactions = new Map<number, OpenTransaction>();
  available: boolean;

  constructor(options: MockTseOptions = {}) {
    this.clock = options.clock ?? fixedClock("2026-09-26T09:00:00Z");
    this.serialNumber = options.serialNumber ?? "TEST-TSE-0000000000000000";
    this.available = options.available ?? true;
  }

  async info(): Promise<TseInfo> {
    return {
      serialNumber: this.serialNumber,
      publicKey: pseudoSignature(`pubkey:${this.serialNumber}`),
      signatureAlgorithm: "ecdsa-plain-SHA256",
      logTimeFormat: "utcTime",
      certificate: null,
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async startTransaction(request: StartTransactionRequest): Promise<TseResponse> {
    this.assertAvailable();
    const transactionNumber = ++this.transactionCounter;
    const startTime = this.clock.now();
    this.transactions.set(transactionNumber, {
      transactionNumber,
      clientId: request.clientId,
      startTime,
      finished: false,
    });
    return this.sign(transactionNumber, startTime, startTime, request.processData ?? "", request.clientId);
  }

  async updateTransaction(request: FinishTransactionRequest): Promise<TseResponse> {
    const open = this.requireOpen(request);
    return this.sign(open.transactionNumber, open.startTime, this.clock.now(), request.processData, request.clientId);
  }

  async finishTransaction(request: FinishTransactionRequest): Promise<TseResponse> {
    const open = this.requireOpen(request);
    open.finished = true;
    return this.sign(open.transactionNumber, open.startTime, this.clock.now(), request.processData, request.clientId);
  }

  private requireOpen(request: FinishTransactionRequest): OpenTransaction {
    this.assertAvailable();
    const open = this.transactions.get(request.transactionNumber);
    if (!open) throw new TseError(`Transaktion ${request.transactionNumber} ist der TSE nicht bekannt`);
    if (open.finished) throw new TseError(`Transaktion ${request.transactionNumber} ist bereits abgeschlossen`);
    if (open.clientId !== request.clientId) {
      throw new TseError(`Transaktion ${request.transactionNumber} gehoert zu Kasse ${open.clientId}`);
    }
    return open;
  }

  private assertAvailable(): void {
    if (!this.available) throw new TseError("TSE nicht erreichbar", { retryable: true });
  }

  private sign(
    transactionNumber: number,
    startTime: string,
    logTime: string,
    processData: string,
    clientId: string,
  ): TseResponse {
    const signatureCounter = ++this.signatureCounter;
    return {
      transactionNumber,
      signatureCounter,
      startTime,
      logTime,
      signature: pseudoSignature([this.serialNumber, transactionNumber, signatureCounter, logTime, processData, clientId].join("|")),
    };
  }
}
