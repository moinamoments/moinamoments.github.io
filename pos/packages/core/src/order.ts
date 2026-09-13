/**
 * Belegabschluss.
 *
 * Hier laufen Warenkorb, Zahlung und TSE zusammen. Die Reihenfolge ist die
 * heikelste Stelle der ganzen Anwendung:
 *
 *   TSE-Start  ->  Positionen erfassen  ->  Zahlung  ->  TSE-Abschluss  ->  Bon
 *
 * Der Beleg wird erst nach dem TSE-Abschluss als bezahlt gespeichert, damit
 * kein Beleg ohne Signatur im Bestand landet, solange die TSE erreichbar ist.
 * Ist sie es nicht, entsteht der Beleg *trotzdem* - mit dokumentiertem
 * Ausfallgrund. Ein Kassensystem, das bei Netzstoerung den Verkauf verweigert,
 * ist am Marktstand unbrauchbar, und der Gesetzgeber verlangt das auch nicht.
 */

import { type Cart, type CartOptions, type CartTotals, cartTotals } from "./cart.ts";
import type { Clock, IdFactory } from "./clock.ts";
import { type Cents, cents, formatDecimal, sumCents } from "./money.ts";
import type {
  Device,
  Id,
  Order,
  OrderLine,
  Payment,
  PaymentMethod,
  Store,
  Tenant,
  Timestamp,
  TseTransactionRecord,
  User,
} from "./model.ts";
import { kassenbelegTaxFields } from "./tax.ts";
import { TseError, type TseClient, type TseResponse } from "./tse/types.ts";
import { encodeProcessData } from "./tse/types.ts";

export class OrderError extends Error {}

/** Zahlungsabsicht, wie sie der Bezahlbildschirm liefert. */
export interface PaymentIntent {
  readonly method: PaymentMethod;
  /** Der auf diese Zahlart entfallende Betrag. */
  readonly amount: Cents;
  /** Nur bar: gegebenes Geld. Ohne Angabe gleich `amount`. */
  readonly tendered?: Cents;
  readonly reference?: string | null;
}

/** Bezeichnungen der Zahlarten fuer Bon und TSE-Prozessdaten. */
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  CASH: "Bar",
  CARD_DEBIT: "girocard",
  CARD_CREDIT: "Kreditkarte",
  VOUCHER: "Gutschein",
  INVOICE: "Rechnung",
  MOBILE: "Mobil",
  OTHER: "Sonstige",
};

/**
 * Bezeichnung der Zahlart in den TSE-Prozessdaten.
 *
 * Die technische Richtlinie kennt genau drei Werte: `Bar`, `Unbar` und
 * `Bar Anfangsbestand`. Jede andere Bezeichnung macht die Prozessdaten
 * ungueltig - deshalb wird hier auf zwei Werte reduziert, waehrend der Bon
 * die genaue Zahlart nennen darf.
 */
export function tsePaymentLabel(method: PaymentMethod): "Bar" | "Unbar" {
  return method === "CASH" ? "Bar" : "Unbar";
}

/** Eine begonnene, noch nicht bezahlte Kassiervorgang-Sitzung. */
export interface OpenTransaction {
  readonly orderId: Id;
  readonly startedAt: Timestamp;
  /** Ergebnis des TSE-Starts; `null`, wenn die TSE beim Start ausfiel. */
  readonly tseStart: TseResponse | null;
  readonly tseFailure: string | null;
}

export interface TransactionContext {
  readonly tenant: Tenant;
  readonly store: Store;
  readonly device: Device;
  readonly user: User;
  readonly clock: Clock;
  readonly newId: IdFactory;
  readonly tse: TseClient;
}

/**
 * Vorgang eroeffnen. Muss aufgerufen werden, *bevor* die erste Position
 * erfasst wird - die TSE stempelt hier den Beginn.
 */
export async function beginTransaction(context: TransactionContext): Promise<OpenTransaction> {
  const orderId = context.newId();
  const startedAt = context.clock.now();
  const clientId = context.device.tseClientId;

  if (!clientId) {
    return { orderId, startedAt, tseStart: null, tseFailure: "Kasse ist der TSE nicht zugeordnet" };
  }

  try {
    const tseStart = await context.tse.startTransaction({ clientId });
    return { orderId, startedAt, tseStart, tseFailure: null };
  } catch (error) {
    return { orderId, startedAt, tseStart: null, tseFailure: describeTseFailure(error) };
  }
}

function describeTseFailure(error: unknown): string {
  if (error instanceof TseError) return error.message;
  return `Unerwarteter TSE-Fehler: ${(error as Error)?.message ?? String(error)}`;
}

/**
 * Belegnummer bilden.
 *
 * Je Geraet ein eigener, lueckenloser Nummernkreis. Das Prefix trennt die
 * Geraete, damit zwei offline kassierende Kassen desselben Betriebs keine
 * doppelten Nummern erzeugen - ein Punkt, an dem Kassensysteme regelmaessig
 * bei der Kassennachschau auffallen.
 */
export function formatReceiptNumber(device: Device, sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new OrderError(`Belegnummer muss eine positive ganze Zahl sein, war ${sequence}`);
  }
  return `${device.receiptPrefix}-${String(sequence).padStart(6, "0")}`;
}

export interface FinishTransactionResult {
  readonly order: Order;
  readonly totals: CartTotals;
}

/**
 * Vorgang abschliessen: Zahlung pruefen, TSE abschliessen, Beleg bilden.
 *
 * `sequence` ist die naechste freie Belegnummer des Geraets; sie kommt aus der
 * Datenhaltung, damit die Nummern auch nach einem Neustart lueckenlos
 * weiterlaufen.
 */
export async function finishTransaction(
  context: TransactionContext,
  open: OpenTransaction,
  cart: Cart,
  payments: readonly PaymentIntent[],
  options: { readonly sequence: number; readonly note?: string | null } & CartOptions,
): Promise<FinishTransactionResult> {
  if (cart.tenantId !== context.tenant.id) {
    throw new OrderError("Warenkorb gehoert zu einem anderen Mandanten");
  }
  if (cart.lines.length === 0) throw new OrderError("Ein Beleg ohne Positionen kann nicht abgeschlossen werden");

  const totals = cartTotals(cart, {
    smallBusiness: options.smallBusiness ?? context.tenant.smallBusiness,
    ...(options.taxRegistry ? { taxRegistry: options.taxRegistry } : {}),
    ...(options.deposits ? { deposits: options.deposits } : {}),
  });

  const resolvedPayments = resolvePayments(totals.total, payments, context);
  const processData = encodeProcessData({
    processType: "Kassenbeleg-V1",
    grossByTaxRate: kassenbelegTaxFields(totals.taxGroups),
    payments: resolvedPayments.map((p) => `${formatDecimal(p.amount)}:${tsePaymentLabel(p.method)}`),
  });

  const tse = await closeTse(context, open, processData);
  const paidAt = context.clock.now();

  const lines: OrderLine[] = totals.lines.map((line) => ({
    id: line.lineId,
    position: line.position,
    productId: line.productId,
    name: line.name,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    gross: line.gross,
    taxKey: line.taxKey,
    businessCaseType: line.businessCaseType,
    modifiers: line.modifiers,
    discount: line.discount,
    allocatedDiscount: line.allocatedDiscount,
    note: line.note,
    depositForLineId: line.depositForLineId ?? null,
  }));

  const order: Order = {
    id: open.orderId,
    tenantId: context.tenant.id,
    storeId: context.store.id,
    deviceId: context.device.id,
    userId: context.user.id,
    receiptNumber: formatReceiptNumber(context.device, options.sequence),
    state: "PAID",
    serviceMode: cart.serviceMode,
    lines,
    payments: resolvedPayments,
    total: totals.total,
    orderDiscount: totals.orderDiscount,
    startedAt: open.startedAt,
    paidAt,
    tse,
    closingId: null,
    note: options.note ?? null,
  };

  return { order, totals };
}

/**
 * Zahlungen gegen die Belegsumme pruefen und vervollstaendigen.
 *
 * Regeln:
 *   - Die Summe der Zahlbetraege muss genau der Belegsumme entsprechen.
 *     "Fast passend" gibt es an der Kasse nicht.
 *   - Rueckgeld entsteht nur aus gegebenem Bargeld, nie aus Kartenzahlung.
 *   - Trinkgeld ist kein Rueckgeldverzicht: es gehoert als eigene Position
 *     auf den Beleg, sonst fehlt es in der Buchhaltung.
 */
export function resolvePayments(
  total: Cents,
  intents: readonly PaymentIntent[],
  context: Pick<TransactionContext, "clock" | "newId">,
): Payment[] {
  if (intents.length === 0) throw new OrderError("Ohne Zahlung kann kein Beleg abgeschlossen werden");

  const payments: Payment[] = intents.map((intent) => {
    cents(intent.amount);
    const tendered = intent.tendered ?? intent.amount;
    if (intent.method !== "CASH" && tendered !== intent.amount) {
      throw new OrderError("Rueckgeld gibt es nur bei Barzahlung");
    }
    if (tendered < intent.amount) {
      throw new OrderError(
        `Gegeben ${formatDecimal(tendered)} ist weniger als der Zahlbetrag ${formatDecimal(intent.amount)}`,
      );
    }
    return {
      id: context.newId(),
      method: intent.method,
      amount: intent.amount,
      tendered,
      change: tendered - intent.amount,
      label: PAYMENT_LABELS[intent.method],
      reference: intent.reference ?? null,
      createdAt: context.clock.now(),
    };
  });

  const paid = sumCents(payments.map((p) => p.amount));
  if (paid !== total) {
    throw new OrderError(
      `Zahlbetrag ${formatDecimal(paid)} passt nicht zur Belegsumme ${formatDecimal(total)}`,
    );
  }
  return payments;
}

async function closeTse(
  context: TransactionContext,
  open: OpenTransaction,
  processData: string,
): Promise<TseTransactionRecord> {
  const clientId = context.device.tseClientId;

  // Konnte die TSE beim Start nicht erreicht werden, wird auch nicht
  // abgeschlossen: eine Transaktion, die nie begonnen hat, kann die TSE
  // nicht signieren. Der Ausfall wird am Beleg dokumentiert.
  if (!open.tseStart || !clientId) {
    return failedRecord(open.tseFailure ?? "TSE beim Beginn des Vorgangs nicht erreichbar", open, processData, clientId);
  }

  try {
    const [response, info] = await Promise.all([
      context.tse.finishTransaction({
        clientId,
        transactionNumber: open.tseStart.transactionNumber,
        processData,
        processType: "Kassenbeleg-V1",
      }),
      context.tse.info(),
    ]);
    return {
      transactionNumber: response.transactionNumber,
      signatureCounter: response.signatureCounter,
      startTime: response.startTime,
      logTime: response.logTime,
      serialNumber: info.serialNumber,
      signature: response.signature,
      signatureAlgorithm: info.signatureAlgorithm,
      logTimeFormat: info.logTimeFormat,
      publicKey: info.publicKey,
      processType: "Kassenbeleg-V1",
      processData,
      clientId,
      failureReason: null,
    };
  } catch (error) {
    return failedRecord(describeTseFailure(error), open, processData, clientId);
  }
}

/**
 * Ersatzdatensatz fuer einen Beleg ohne TSE-Signatur.
 *
 * Die Zaehler bleiben auf 0 und `failureReason` traegt den Grund. Der
 * Bondruck macht daraus den vorgeschriebenen Hinweis, und die DSFinV-K
 * bekommt den Beleg mit leeren Signaturfeldern - genau so, wie es die
 * Ausfalldokumentation verlangt. Nichts davon darf stillschweigend
 * verschwinden.
 */
function failedRecord(
  reason: string,
  open: OpenTransaction,
  processData: string,
  clientId: string | null | undefined,
): TseTransactionRecord {
  return {
    transactionNumber: 0,
    signatureCounter: 0,
    startTime: open.startedAt,
    logTime: open.startedAt,
    serialNumber: "",
    signature: "",
    signatureAlgorithm: "",
    logTimeFormat: "",
    publicKey: "",
    processType: "Kassenbeleg-V1",
    processData,
    clientId: clientId ?? "",
    failureReason: reason,
  };
}

/** Ist der Beleg vollstaendig durch die TSE abgesichert? */
export function isTseSecured(order: Pick<Order, "tse">): boolean {
  return order.tse != null && !order.tse.failureReason && order.tse.signature !== "";
}

/**
 * Stornobeleg zu einem bezahlten Beleg bilden.
 *
 * Ein abgeschlossener Beleg wird niemals veraendert oder geloescht
 * (§ 146 Abs. 4 AO). Die Korrektur ist ein eigener Beleg mit gespiegelten
 * Mengen, eigener Belegnummer und eigener TSE-Transaktion. Der Rueckverweis
 * steht in `voidsOrderId`.
 */
export function buildVoidCart(order: Order): Cart {
  if (order.state !== "PAID") throw new OrderError("Nur bezahlte Belege koennen storniert werden");
  return {
    tenantId: order.tenantId,
    serviceMode: order.serviceMode,
    orderDiscount: 0,
    lines: order.lines.map((line) => ({
      id: `${line.id}-storno`,
      productId: line.productId,
      name: line.name,
      quantity: -line.quantity,
      // Einzelpreis und Menge bleiben die des Originals, nur das Vorzeichen
      // der Menge kippt. Rabatte werden zusammengefasst uebernommen: bei
      // negativer Menge rechnet die Summenbildung den Rabatt wieder hinzu,
      // sodass Beleg und Storno sich auf den Cent genau aufheben. Den Preis
      // aus dem Positionswert zurueckzurechnen waere rundungsanfaellig.
      unitPrice: line.unitPrice,
      taxKey: line.taxKey,
      taxKeyDineIn: null,
      modifiers: line.modifiers,
      discount: line.discount + line.allocatedDiscount,
      businessCaseType: line.businessCaseType,
      note: `Storno zu Beleg ${order.receiptNumber}`,
      // Die Pfandpositionen des Originals stehen schon als eigene Zeilen im
      // Beleg. Wuerde der Storno sie erneut ableiten, stuende das Pfand
      // doppelt drauf - der Kunde bekaeme zu viel zurueck.
      waiveDeposit: true,
    })),
  };
}
