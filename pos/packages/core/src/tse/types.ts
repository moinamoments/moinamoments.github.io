/**
 * Technische Sicherheitseinrichtung (TSE).
 *
 * Seit dem 1.1.2020 muss jede elektronische Aufzeichnung eines
 * Geschaeftsvorfalls durch eine zertifizierte TSE protokolliert werden
 * (§ 146a AO, § 2 KassenSichV). Die TSE ist eine fremde, zertifizierte
 * Komponente - sie wird nicht nachgebaut, sondern angebunden. Deshalb steht
 * hier nur ein Interface.
 *
 * Der Ablauf pro Beleg ist dreiteilig und die Reihenfolge ist zwingend:
 *
 *   1. `startTransaction` - *bevor* die erste Position erfasst wird. Die TSE
 *      stempelt den Startzeitpunkt. Wer erst beim Bezahlen startet, hat auf
 *      dem Bon eine falsche Startzeit.
 *   2. optional `updateTransaction` - bei laufenden Bestellungen (Tisch).
 *   3. `finishTransaction` - beim Abschluss, mit den endgueltigen Betraegen
 *      und Zahlarten. Erst deren Antwort enthaelt Signaturzaehler und
 *      Signatur, die auf den Bon gehoeren.
 *
 * Alle Implementierungen muessen so gebaut sein, dass ein Ausfall der TSE den
 * Verkauf nicht blockiert: der Beleg entsteht trotzdem, wird als
 * "ohne TSE" gekennzeichnet und der Ausfall protokolliert. Das ist der vom
 * Gesetzgeber vorgesehene Weg (Ausfalldokumentation), Verkauf einstellen ist
 * es nicht.
 */

import type { Timestamp } from "../model.ts";

/** Antwort der TSE auf Start, Update oder Abschluss einer Transaktion. */
export interface TseResponse {
  /** Transaktionsnummer der TSE, fortlaufend je TSE. */
  readonly transactionNumber: number;
  /** Signaturzaehler der TSE, fortlaufend je TSE. Gehoert auf den Bon. */
  readonly signatureCounter: number;
  /** Von der TSE gestempelte Startzeit der Transaktion. */
  readonly startTime: Timestamp;
  /** Von der TSE gestempelte Zeit dieses Protokolleintrags. */
  readonly logTime: Timestamp;
  /** Signatur als Base64. Gehoert auf den Bon ("Pruefwert"). */
  readonly signature: string;
}

/** Unveraenderliche Eigenschaften der eingesetzten TSE. */
export interface TseInfo {
  /** Seriennummer der TSE als Hexstring. Gehoert auf den Bon. */
  readonly serialNumber: string;
  /** Oeffentlicher Schluessel als Base64, fuer die Belegpruefung. */
  readonly publicKey: string;
  /** Signaturalgorithmus, z. B. `ecdsa-plain-SHA256`. */
  readonly signatureAlgorithm: string;
  /** Zeitformat der Protokolleintraege, z. B. `unixTime` oder `utcTime`. */
  readonly logTimeFormat: string;
  /** Zertifikat der TSE als Base64-DER, fuer die Archivierung. */
  readonly certificate?: string | null;
}

/**
 * Prozessdaten eines Kassenbelegs nach der technischen Richtlinie.
 *
 * Format `Kassenbeleg-V1`:
 *   `Kassenbeleg-V1^<brutto 5 Felder getrennt durch _>^<zahlungen getrennt durch _>`
 * Beispiel:
 *   `Kassenbeleg-V1^0.00_4.50_0.00_0.00_0.00^4.50:Bar`
 */
export interface ReceiptProcessData {
  /** Immer `Kassenbeleg-V1`, bis eine neue Version der Richtlinie gilt. */
  readonly processType: "Kassenbeleg-V1";
  /** Die fuenf Bruttofelder in der vorgeschriebenen Reihenfolge. */
  readonly grossByTaxRate: readonly string[];
  /** Zahlungen als `betrag:bezeichnung`, z. B. `4.50:Bar`. */
  readonly payments: readonly string[];
}

/** Prozessdaten in den String, den die TSE signiert. */
export function encodeProcessData(data: ReceiptProcessData): string {
  return `${data.processType}^${data.grossByTaxRate.join("_")}^${data.payments.join("_")}`;
}

export interface StartTransactionRequest {
  /** Id der Kasse, wie sie in der TSE registriert ist. */
  readonly clientId: string;
  /** Beim Start ueblicherweise leer - die Betraege stehen noch nicht fest. */
  readonly processData?: string;
  readonly processType?: string;
}

export interface FinishTransactionRequest {
  readonly clientId: string;
  readonly transactionNumber: number;
  readonly processData: string;
  readonly processType: string;
}

export interface TseErrorOptions {
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export class TseError extends Error {
  readonly options: TseErrorOptions;

  constructor(message: string, options: TseErrorOptions = { retryable: false }) {
    super(message);
    this.name = "TseError";
    this.options = options;
  }
}

export interface TseClient {
  /** Feste Eigenschaften der TSE. Darf zwischengespeichert werden. */
  info(): Promise<TseInfo>;
  startTransaction(request: StartTransactionRequest): Promise<TseResponse>;
  updateTransaction(request: FinishTransactionRequest): Promise<TseResponse>;
  finishTransaction(request: FinishTransactionRequest): Promise<TseResponse>;
  /**
   * Erreichbarkeitspruefung fuer die Anzeige am Kassenstand. Soll nie werfen -
   * `false` bedeutet: es wird ohne TSE kassiert und dokumentiert.
   */
  isAvailable(): Promise<boolean>;
}
