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

import { type Cart, type CartLine, type CartOptions, type CartTotals, cartTotals, effectiveUnitPrice } from "./cart.ts";
import type { Clock, IdFactory } from "./clock.ts";
import {
  ONE,
  type Cents,
  type Quantity,
  cents,
  formatDecimal,
  formatQuantity,
  lineTotal,
  roundHalfUp,
  sumCents,
} from "./money.ts";
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
import { kassenbelegTaxFields, type TaxKey } from "./tax.ts";
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
  options: {
    readonly sequence: number;
    readonly note?: string | null;
    /** Kundenname, falls der Kunde einen genannt hat. */
    readonly customerName?: string | null;
  } & CartOptions,
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
    customerName: options.customerName ?? null,
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
  return buildPartialVoidCart(
    order,
    order.lines.map((line) => ({ lineId: line.id, quantity: line.quantity })),
  );
}

/** Welche Position in welcher Menge zurueckgenommen wird. */
export interface VoidSelection {
  readonly lineId: Id;
  /** Zurueckzunehmende Menge, positiv. */
  readonly quantity: Quantity;
}

/**
 * Teilstorno: einzelne Positionen oder Teilmengen zurueckgeben.
 *
 * Der haeufigere Fall als der Vollstorno. Der Kunde nimmt eine Flasche wieder
 * mit, eine Portion war falsch, von drei Crepes ist einer misslungen - dann
 * wird genau das zurueckgenommen und ausgezahlt, nicht der ganze Beleg
 * aufgeloest.
 *
 * Was dabei stimmen muss und hier stimmt:
 *
 *   - **Der Steuersatz je Position.** Ein Beleg mit 7 % und 19 % darf nicht
 *     pauschal mit einem Mischsatz erstattet werden; jede Position traegt
 *     ihren eigenen.
 *   - **Rabatte anteilig.** War die Position rabattiert, wird auch nur der
 *     tatsaechlich gezahlte Anteil erstattet - sonst bekommt der Kunde mehr
 *     zurueck, als er gegeben hat.
 *   - **Pfand geht mit.** Wer die Flasche zurueckbringt, bekommt das Pfand
 *     mit; die Pfandposition haengt an der Warenposition und wird im selben
 *     Verhaeltnis zurueckgenommen.
 *
 * Gerechnet wird ueber den anteiligen Positionswert, nicht ueber den
 * Einzelpreis: nur so hebt sich der Teilstorno bei voller Menge auf den Cent
 * genau gegen das Original auf.
 */
export function buildPartialVoidCart(order: Order, selections: readonly VoidSelection[]): Cart {
  if (order.state !== "PAID") throw new OrderError("Nur bezahlte Belege koennen storniert werden");
  if (selections.length === 0) throw new OrderError("Es ist keine Position zum Storno ausgewaehlt");

  const byLineId = new Map<Id, typeof order.lines[number]>();
  for (const line of order.lines) byLineId.set(line.id, line);

  // Mengen je Position zusammenfassen, damit zweimal dieselbe Position nicht
  // mehr zurueckgibt als verkauft wurde.
  const wanted = new Map<Id, Quantity>();
  for (const selection of selections) {
    const line = byLineId.get(selection.lineId);
    if (!line) throw new OrderError(`Position ${selection.lineId} gehoert nicht zu Beleg ${order.receiptNumber}`);
    if (selection.quantity <= 0) throw new OrderError(`Die Stornomenge fuer "${line.name}" muss positiv sein`);
    const total = (wanted.get(selection.lineId) ?? 0) + selection.quantity;
    if (total > Math.abs(line.quantity)) {
      throw new OrderError(
        `Von "${line.name}" wurden ${formatQuantity(Math.abs(line.quantity))} verkauft - mehr kann nicht zurueckgenommen werden`,
      );
    }
    wanted.set(selection.lineId, total);
  }

  // Pfandpositionen folgen ihrer Warenposition im selben Verhaeltnis.
  for (const line of order.lines) {
    if (line.depositForLineId == null) continue;
    const parentWanted = wanted.get(line.depositForLineId);
    if (parentWanted == null || wanted.has(line.id)) continue;
    const parent = byLineId.get(line.depositForLineId);
    if (!parent || parent.quantity === 0) continue;
    const share = parentWanted / Math.abs(parent.quantity);
    const depositQuantity = Math.round(Math.abs(line.quantity) * share);
    if (depositQuantity > 0) wanted.set(line.id, depositQuantity);
  }

  const lines: CartLine[] = [];
  for (const line of order.lines) {
    const quantity = wanted.get(line.id);
    if (quantity == null || quantity === 0) continue;

    const full = Math.abs(line.quantity);
    // Anteiliger Positionswert. Bei voller Menge ist das genau `line.gross`,
    // sodass sich Beleg und Storno exakt aufheben.
    const share = quantity === full ? line.gross : roundHalfUp((line.gross * quantity) / full);
    const signedQuantity = line.quantity >= 0 ? -quantity : quantity;

    const storno: CartLine = {
      id: `${line.id}-storno`,
      productId: line.productId,
      name: line.name,
      quantity: signedQuantity,
      unitPrice: line.unitPrice,
      taxKey: line.taxKey,
      taxKeyDineIn: null,
      modifiers: line.modifiers,
      // Der Rabatt traegt die Differenz zwischen dem rohen Positionswert und
      // dem tatsaechlich gezahlten Anteil. Bei negativer Menge rechnet die
      // Summenbildung ihn wieder hinzu - so trifft die Zeile genau den
      // anteiligen Wert, ohne den Einzelpreis zurueckzurechnen (das waere
      // rundungsanfaellig und wuerde Beleg und Storno auseinanderlaufen
      // lassen).
      discount: 0,
      businessCaseType: line.businessCaseType,
      note: `Storno zu Beleg ${order.receiptNumber}`,
      // Die Pfandpositionen des Originals stehen schon als eigene Zeilen im
      // Beleg. Wuerde der Storno sie erneut ableiten, stuende das Pfand
      // doppelt drauf - der Kunde bekaeme zu viel zurueck.
      waiveDeposit: true,
    };

    const raw = lineTotal(effectiveUnitPrice(storno), signedQuantity);
    // raw ist negativ (Rueckgabe), das Ziel ebenfalls; die Differenz ist der
    // Rabatt, der die Zeile auf den gezahlten Anteil bringt.
    lines.push({ ...storno, discount: Math.abs(raw) - Math.abs(share) });
  }

  if (lines.length === 0) throw new OrderError("Es ist keine Position zum Storno ausgewaehlt");

  return {
    tenantId: order.tenantId,
    serviceMode: order.serviceMode,
    orderDiscount: 0,
    lines,
  };
}

/**
 * Freie Auszahlung ohne Bezug auf eine Position.
 *
 * Die Rueckfallebene fuer Faelle, die sich keiner Position zuordnen lassen -
 * eine Kulanzgutschrift, ein falsch abgerechneter Betrag. Der Steuersatz muss
 * dabei **angegeben werden**: ohne ihn waere die Umsatzsteuer der Gutschrift
 * nicht bestimmbar, und eine Kasse, die den Satz raet, produziert eine falsche
 * Voranmeldung. Der Bezug auf den Ursprungsbeleg gehoert in `note`.
 */
export function buildRefundCart(
  order: Pick<Order, "tenantId" | "serviceMode" | "receiptNumber">,
  amount: Cents,
  taxKey: TaxKey,
  options: { readonly id: Id; readonly reason: string },
): Cart {
  if (amount <= 0) throw new OrderError("Der Auszahlungsbetrag muss positiv angegeben werden");
  const reason = options.reason.trim();
  if (reason === "") throw new OrderError("Eine Auszahlung ohne Grund wird nicht gebucht");

  return {
    tenantId: order.tenantId,
    serviceMode: order.serviceMode,
    orderDiscount: 0,
    lines: [
      {
        id: options.id,
        productId: null,
        name: `Auszahlung: ${reason}`,
        quantity: ONE,
        unitPrice: -amount,
        taxKey,
        taxKeyDineIn: null,
        modifiers: [],
        discount: 0,
        businessCaseType: "Umsatz",
        note: `Bezug: Beleg ${order.receiptNumber}`,
        waiveDeposit: true,
      },
    ],
  };
}
