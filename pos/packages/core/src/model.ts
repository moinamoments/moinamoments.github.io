/**
 * Datenmodell.
 *
 * Das Produkt ist von Anfang an mandantenfaehig: jeder Datensatz gehoert zu
 * genau einem `tenantId`. Es gibt keine Tabelle ohne Mandantenbezug, auch
 * nicht die Artikel. Nachtraeglich Mandantenfaehigkeit einzubauen ist der
 * teuerste Umbau, den ein Kassensystem erleben kann - deshalb steht sie hier
 * vor dem ersten Bildschirm.
 *
 * Aufbewahrungspflicht: Belege, Abschluesse und TSE-Daten sind nach § 147 AO
 * zehn Jahre unveraenderbar vorzuhalten. Deshalb ist nichts an einem
 * abgeschlossenen Beleg loeschbar oder aenderbar - Korrekturen laufen immer
 * ueber einen neuen Beleg mit negativen Mengen.
 */

import type { Cents, Quantity } from "./money.ts";
import type { ServiceMode, TaxKey } from "./tax.ts";

/** ISO-8601 mit Zeitzonen-Offset, z. B. `2026-09-26T11:04:12+02:00`. */
export type Timestamp = string;

/** UUID v4 oder ULID. Wird vom Client erzeugt, damit offline Belege entstehen koennen. */
export type Id = string;

// --- Mandant und Organisation ---------------------------------------------

/**
 * Ein Betrieb, der die Kasse nutzt. Die Adressfelder landen unveraendert auf
 * jedem Bon (§ 6 Nr. 1 KassenSichV: vollstaendiger Name und Adresse).
 */
export interface Tenant {
  readonly id: Id;
  name: string;
  /** Rechtlicher Name, falls abweichend von der Marke. */
  legalName: string;
  street: string;
  postalCode: string;
  city: string;
  countryCode: string;
  /** Steuernummer. Genau eine von beiden gehoert auf den Bon. */
  taxNumber?: string | null;
  /** Umsatzsteuer-Identifikationsnummer. */
  vatId?: string | null;
  email?: string | null;
  phone?: string | null;
  /**
   * Kleinunternehmer nach § 19 UStG: keine Umsatzsteuer auf dem Bon, dafuer
   * der vorgeschriebene Hinweis. Aendert die Steuerberechnung jedes Belegs.
   */
  smallBusiness: boolean;
  /** Zusatzzeile unter dem Betrag, bei Kleinunternehmern der § 19-Hinweis. */
  receiptFooter?: string | null;
  currency: "EUR";
  timeZone: string;
  createdAt: Timestamp;
}

/** Betriebsstaette. Ein Mandant kann mehrere haben (Anhaenger, Filiale, Marktstand). */
export interface Store {
  readonly id: Id;
  readonly tenantId: Id;
  name: string;
  /** Abweichende Adresse; leer bedeutet: Adresse des Mandanten. */
  street?: string | null;
  postalCode?: string | null;
  city?: string | null;
  active: boolean;
}

/**
 * Eine Kasse im Sinne der DSFinV-K ("Client"). Jedes Geraet braucht eine
 * eigene, dauerhafte Id und einen eigenen Belegnummernkreis, sonst kollidieren
 * zwei Geraete im Offline-Betrieb.
 */
export interface Device {
  readonly id: Id;
  readonly tenantId: Id;
  readonly storeId: Id;
  /** Anzeigename am Geraet, z. B. "Anhaenger vorne". */
  name: string;
  /** Kassen-Seriennummer fuer Bon und DSFinV-K. */
  serialNumber: string;
  /** Die der Kasse in der TSE zugeordnete Client-Id. */
  tseClientId?: string | null;
  /** Prefix des Belegnummernkreises, haelt die Nummern je Geraet eindeutig. */
  receiptPrefix: string;
  active: boolean;
}

export type UserRole = "OWNER" | "MANAGER" | "CASHIER";

/** Bediener. Der Name steht als `Bediener` in der DSFinV-K und auf dem Bon. */
export interface User {
  readonly id: Id;
  readonly tenantId: Id;
  name: string;
  role: UserRole;
  /**
   * Nur der Hash der Anmelde-PIN wird gespeichert, nie die PIN selbst -
   * auch nicht lokal auf dem Geraet.
   */
  pinHash?: string | null;
  active: boolean;
}

// --- Artikelstamm ---------------------------------------------------------

export interface Category {
  readonly id: Id;
  readonly tenantId: Id;
  name: string;
  /** Farbe der Kacheln, damit der Kassenbildschirm ohne Lesen bedienbar ist. */
  color?: string | null;
  sortOrder: number;
  active: boolean;
}

/**
 * Ein Artikel. Preise sind immer brutto in Cent.
 *
 * Preisaenderungen erzeugen keine Historie im Artikel: der Beleg speichert
 * Name und Preis als Kopie (siehe `OrderLine`). Damit bleibt ein alter Beleg
 * auch nach einer Preisrunde exakt so nachvollziehbar wie am Verkaufstag.
 */
export interface Product {
  readonly id: Id;
  readonly tenantId: Id;
  categoryId: Id;
  name: string;
  description?: string | null;
  /** Bruttopreis in Cent. `null` = offener Preis, wird am Stand eingegeben. */
  price: Cents | null;
  /** Standard-Steuerschluessel (ausser Haus / Lieferung). */
  taxKey: TaxKey;
  /** Abweichender Schluessel bei Verzehr vor Ort; `null` = kein Unterschied. */
  taxKeyDineIn?: TaxKey | null;
  /** Artikelnummer / GTIN fuer Scanner und Warenwirtschaft. */
  sku?: string | null;
  /** Verkaufseinheit. `PIECE` zaehlt Stueck, `KILOGRAM` wiegt. */
  unit: "PIECE" | "KILOGRAM" | "LITRE" | "HOUR";
  /** Pfand, das beim Verkauf automatisch als eigene Position gebucht wird. */
  depositProductId?: Id | null;
  color?: string | null;
  sortOrder: number;
  active: boolean;
  updatedAt: Timestamp;
}

/**
 * Wahlmoeglichkeit an einem Artikel (Sahne, Sirupsorte, Becher gross).
 * Eigene Tabelle statt Varianten-Matrix: am Imbiss kommen Aufpreise dazu,
 * keine Kombinationen aus Groesse und Farbe wie im Einzelhandel.
 */
export interface Modifier {
  readonly id: Id;
  readonly tenantId: Id;
  name: string;
  /** Aufpreis brutto in Cent, darf negativ sein (z. B. "ohne Sahne -0,30"). */
  priceDelta: Cents;
  /** Erbt den Steuerschluessel des Artikels, wenn `null`. */
  taxKey?: TaxKey | null;
  sortOrder: number;
  active: boolean;
}

export interface ModifierGroup {
  readonly id: Id;
  readonly tenantId: Id;
  name: string;
  /** Mindest- und Hoechstzahl der Auswahl; 0/1 = optionale Einzelauswahl. */
  minSelect: number;
  maxSelect: number;
  modifierIds: readonly Id[];
}

// --- Beleg ---------------------------------------------------------------

export type OrderState = "OPEN" | "PAID" | "VOIDED";

/**
 * Geschaeftsvorfallart nach DSFinV-K. `Umsatz` ist der Normalfall,
 * die uebrigen betreffen Kassenbewegungen ohne Umsatz.
 */
export type BusinessCaseType =
  | "Umsatz"
  | "Anzahlungseinstellung"
  | "Anzahlungsaufloesung"
  | "Privateinlage"
  | "Privatentnahme"
  | "Geldtransit"
  | "Pfand"
  | "PfandRueckzahlung"
  | "Rabatt"
  | "TrinkgeldAG"
  | "TrinkgeldAN";

export interface OrderLine {
  readonly id: Id;
  /** Laufende Nummer der Position im Beleg, beginnend bei 1. */
  readonly position: number;
  readonly productId: Id | null;
  /** Kopie des Artikelnamens zum Verkaufszeitpunkt. */
  readonly name: string;
  readonly quantity: Quantity;
  /** Bruttoeinzelpreis zum Verkaufszeitpunkt, in Cent. */
  readonly unitPrice: Cents;
  /** Positionsbrutto nach Rabatt: das, was in der Zeile steht. */
  readonly gross: Cents;
  readonly taxKey: TaxKey;
  readonly businessCaseType: BusinessCaseType;
  /** Gewaehlte Zusaetze, bereits in `gross` eingerechnet. */
  readonly modifiers: readonly { readonly name: string; readonly priceDelta: Cents }[];
  /** Positionsrabatt in Cent, positiv angegeben. */
  readonly discount: Cents;
  /** Anteil eines Belegrabatts, der auf diese Position umgelegt wurde. */
  readonly allocatedDiscount: Cents;
  readonly note?: string | null;
}

export type PaymentMethod =
  | "CASH"
  | "CARD_DEBIT"
  | "CARD_CREDIT"
  | "VOUCHER"
  | "INVOICE"
  | "MOBILE"
  | "OTHER";

export interface Payment {
  readonly id: Id;
  readonly method: PaymentMethod;
  /** Verrechneter Betrag in Cent. */
  readonly amount: Cents;
  /** Bei Barzahlung das gegebene Geld; sonst gleich `amount`. */
  readonly tendered: Cents;
  /** Rueckgeld. Immer `tendered - amount`, nie separat gepflegt. */
  readonly change: Cents;
  /** Name der Zahlart auf dem Bon, z. B. "Bar", "girocard". */
  readonly label: string;
  /** Referenz des Kartenterminals, falls vorhanden. */
  readonly reference?: string | null;
  readonly createdAt: Timestamp;
}

/**
 * Ergebnis einer TSE-Transaktion. Genau diese Felder muessen auf den Bon und
 * in die DSFinV-K; sie sind der Beweis, dass der Beleg zum Zeitpunkt des
 * Verkaufs abgesichert wurde.
 */
export interface TseTransactionRecord {
  readonly transactionNumber: number;
  readonly signatureCounter: number;
  readonly startTime: Timestamp;
  readonly logTime: Timestamp;
  readonly serialNumber: string;
  readonly signature: string;
  readonly signatureAlgorithm: string;
  readonly logTimeFormat: string;
  readonly publicKey: string;
  readonly processType: string;
  readonly processData: string;
  readonly clientId: string;
  /**
   * Gesetzt, wenn der Beleg ohne funktionierende TSE entstanden ist.
   * Nach § 146a AO ist der Ausfall zu dokumentieren und der Bon zu
   * kennzeichnen - verschwiegen werden darf er nicht.
   */
  readonly failureReason?: string | null;
}

export interface Order {
  readonly id: Id;
  readonly tenantId: Id;
  readonly storeId: Id;
  readonly deviceId: Id;
  readonly userId: Id;
  /** Fortlaufende Belegnummer je Geraet, lueckenlos. */
  readonly receiptNumber: string;
  state: OrderState;
  serviceMode: ServiceMode;
  readonly lines: readonly OrderLine[];
  readonly payments: readonly Payment[];
  /** Belegsumme brutto in Cent. */
  readonly total: Cents;
  /** Belegrabatt in Cent, positiv, bereits auf die Positionen umgelegt. */
  readonly orderDiscount: Cents;
  /** Beginn der Erfassung - Pflichtangabe auf dem Bon. */
  readonly startedAt: Timestamp;
  /** Abschluss der Bezahlung - Pflichtangabe auf dem Bon. */
  paidAt?: Timestamp | null;
  tse?: TseTransactionRecord | null;
  /** Id des Belegs, den dieser Beleg storniert. */
  voidsOrderId?: Id | null;
  /** Id des Kassenabschlusses, in dem dieser Beleg enthalten ist. */
  closingId?: Id | null;
  note?: string | null;
}

// --- Kassenabschluss -----------------------------------------------------

export interface CashCountEntry {
  /** Nennwert in Cent, z. B. 500 fuer den 5-Euro-Schein. */
  readonly denomination: Cents;
  readonly count: number;
}

export interface Closing {
  readonly id: Id;
  readonly tenantId: Id;
  readonly storeId: Id;
  readonly deviceId: Id;
  /** Fortlaufende Abschlussnummer je Kasse, lueckenlos. */
  readonly number: number;
  readonly from: Timestamp;
  readonly to: Timestamp;
  readonly createdAt: Timestamp;
  readonly userId: Id;
  readonly orderIds: readonly Id[];
  /** Gezaehltes Bargeld; leer, wenn ohne Zaehlprotokoll abgeschlossen wurde. */
  readonly cashCount: readonly CashCountEntry[];
  /** Bargeldbestand zu Beginn der Schicht. */
  readonly openingCash: Cents;
}
