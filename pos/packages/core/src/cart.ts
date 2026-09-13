/**
 * Warenkorb.
 *
 * Der Warenkorb ist ein reiner Datenwert: jede Aenderung erzeugt einen neuen
 * Warenkorb, nichts wird an Ort und Stelle veraendert. Am Kassenstand heisst
 * das: "Rueckgaengig" ist ein Verweis auf den vorherigen Wert, kein
 * Ruecksetzen von Feldern - und der Bildschirm kann nie einen halb
 * aktualisierten Zustand zeigen.
 */

import {
  type BasisPoints,
  type Cents,
  ONE,
  type Quantity,
  applyBasisPoints,
  cents,
  distribute,
  lineTotal,
  sumCents,
} from "./money.ts";
import type { BusinessCaseType, Id, Modifier, OrderLine, Product } from "./model.ts";
import { type ServiceMode, type TaxGroupTotal, type TaxKey, type TaxRegistry, createTaxRegistry, resolveTaxKey, summarizeTax } from "./tax.ts";

export class CartError extends Error {}

export interface CartLineModifier {
  readonly name: string;
  readonly priceDelta: Cents;
}

export interface CartLine {
  readonly id: Id;
  readonly productId: Id | null;
  readonly name: string;
  readonly quantity: Quantity;
  /** Bruttoeinzelpreis ohne Zusaetze. */
  readonly unitPrice: Cents;
  readonly taxKey: TaxKey;
  readonly taxKeyDineIn: TaxKey | null;
  readonly modifiers: readonly CartLineModifier[];
  /** Positionsrabatt in Cent, positiv angegeben. */
  readonly discount: Cents;
  readonly businessCaseType: BusinessCaseType;
  readonly note: string | null;
}

export interface Cart {
  readonly tenantId: Id;
  readonly serviceMode: ServiceMode;
  readonly lines: readonly CartLine[];
  /** Belegrabatt in Cent, positiv angegeben. */
  readonly orderDiscount: Cents;
}

export interface CartOptions {
  /** Kleinunternehmer nach § 19 UStG - zieht alle Positionen auf steuerfrei. */
  readonly smallBusiness?: boolean;
  readonly taxRegistry?: TaxRegistry;
}

export function emptyCart(tenantId: Id, serviceMode: ServiceMode = "TAKEAWAY"): Cart {
  return { tenantId, serviceMode, lines: [], orderDiscount: 0 };
}

/** Effektiver Einzelpreis einer Position: Artikelpreis plus Zusaetze. */
export function effectiveUnitPrice(line: CartLine): Cents {
  return line.unitPrice + sumCents(line.modifiers.map((m) => m.priceDelta));
}

/**
 * Eine Position in den Warenkorb legen.
 *
 * Gleiche Artikel mit gleichen Zusaetzen, gleichem Preis und ohne Notiz
 * werden zusammengefasst - am Imbiss tippt man denselben Crepe fuenfmal und
 * will nicht fuenf Zeilen sehen. Sobald ein Positionsrabatt, eine Notiz oder
 * ein abweichender Preis im Spiel ist, bleibt die Zeile eigenstaendig, weil
 * das Zusammenfassen sonst Information vom Beleg loescht.
 */
export function addProduct(
  cart: Cart,
  product: Product,
  options: {
    readonly id: Id;
    readonly quantity?: Quantity;
    /** Ueberschreibt den Artikelpreis; Pflicht bei offenem Preis. */
    readonly price?: Cents;
    readonly modifiers?: readonly Modifier[];
    readonly note?: string | null;
  },
): Cart {
  if (product.tenantId !== cart.tenantId) {
    throw new CartError(`Artikel ${product.id} gehoert zu einem anderen Mandanten`);
  }
  const quantity = options.quantity ?? ONE;
  if (quantity === 0) throw new CartError("Menge 0 ist keine Position");

  const price = options.price ?? product.price;
  if (price == null) {
    throw new CartError(`Artikel "${product.name}" hat einen offenen Preis - Betrag muss eingegeben werden`);
  }
  cents(price);

  const modifiers: CartLineModifier[] = [];
  for (const modifier of options.modifiers ?? []) {
    if (modifier.taxKey != null && modifier.taxKey !== product.taxKey) {
      // Ein Zusatz mit eigenem Steuersatz muesste eine eigene Belegposition
      // werden, damit die Steuer je Satz stimmt. Das ist bewusst noch nicht
      // umgesetzt - lieber ein klarer Fehler als ein falscher Bon.
      throw new CartError(
        `Zusatz "${modifier.name}" hat einen eigenen Steuersatz. Das ist noch nicht unterstuetzt (siehe docs/ROADMAP.md).`,
      );
    }
    modifiers.push({ name: modifier.name, priceDelta: modifier.priceDelta });
  }

  const note = options.note ?? null;
  const candidate: CartLine = {
    id: options.id,
    productId: product.id,
    name: product.name,
    quantity,
    unitPrice: price,
    taxKey: product.taxKey,
    taxKeyDineIn: product.taxKeyDineIn ?? null,
    modifiers,
    discount: 0,
    businessCaseType: "Umsatz",
    note,
  };

  const mergeIndex = note === null
    ? cart.lines.findIndex(
        (line) =>
          line.productId === product.id &&
          line.unitPrice === price &&
          line.discount === 0 &&
          line.note === null &&
          line.businessCaseType === "Umsatz" &&
          sameModifiers(line.modifiers, modifiers),
      )
    : -1;

  if (mergeIndex >= 0) {
    const existing = cart.lines[mergeIndex] as CartLine;
    return replaceLine(cart, mergeIndex, { ...existing, quantity: existing.quantity + quantity });
  }
  return { ...cart, lines: [...cart.lines, candidate] };
}

/** Freie Position ohne Artikelstamm, z. B. ein Sonderverkauf. */
export function addFreeLine(
  cart: Cart,
  line: {
    readonly id: Id;
    readonly name: string;
    readonly price: Cents;
    readonly taxKey: TaxKey;
    readonly quantity?: Quantity;
    readonly businessCaseType?: BusinessCaseType;
    readonly note?: string | null;
  },
): Cart {
  const newLine: CartLine = {
    id: line.id,
    productId: null,
    name: line.name,
    quantity: line.quantity ?? ONE,
    unitPrice: cents(line.price),
    taxKey: line.taxKey,
    taxKeyDineIn: null,
    modifiers: [],
    discount: 0,
    businessCaseType: line.businessCaseType ?? "Umsatz",
    note: line.note ?? null,
  };
  return { ...cart, lines: [...cart.lines, newLine] };
}

function sameModifiers(a: readonly CartLineModifier[], b: readonly CartLineModifier[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.name === b[i]?.name && m.priceDelta === b[i]?.priceDelta);
}

function replaceLine(cart: Cart, index: number, line: CartLine): Cart {
  const lines = [...cart.lines];
  lines[index] = line;
  return { ...cart, lines };
}

function indexOfLine(cart: Cart, lineId: Id): number {
  const index = cart.lines.findIndex((line) => line.id === lineId);
  if (index < 0) throw new CartError(`Position ${lineId} ist nicht im Warenkorb`);
  return index;
}

/** Menge einer Position setzen. Menge 0 entfernt die Position. */
export function setQuantity(cart: Cart, lineId: Id, quantity: Quantity): Cart {
  const index = indexOfLine(cart, lineId);
  if (quantity === 0) return removeLine(cart, lineId);
  return replaceLine(cart, index, { ...(cart.lines[index] as CartLine), quantity });
}

/** Menge um eine Einheit erhoehen oder senken; auf 0 wird die Position entfernt. */
export function changeQuantity(cart: Cart, lineId: Id, delta: Quantity): Cart {
  const index = indexOfLine(cart, lineId);
  const line = cart.lines[index] as CartLine;
  return setQuantity(cart, lineId, line.quantity + delta);
}

export function removeLine(cart: Cart, lineId: Id): Cart {
  indexOfLine(cart, lineId);
  return { ...cart, lines: cart.lines.filter((line) => line.id !== lineId) };
}

export function clearLines(cart: Cart): Cart {
  return { ...cart, lines: [], orderDiscount: 0 };
}

/** Bewirtungsform umschalten. Aendert bei Speisen den Steuersatz. */
export function setServiceMode(cart: Cart, serviceMode: ServiceMode): Cart {
  return { ...cart, serviceMode };
}

/** Positionsrabatt als Betrag. Mehr als der Positionswert ist nicht moeglich. */
export function setLineDiscount(cart: Cart, lineId: Id, discount: Cents): Cart {
  const index = indexOfLine(cart, lineId);
  const line = cart.lines[index] as CartLine;
  const base = lineTotal(effectiveUnitPrice(line), line.quantity);
  if (cents(discount) < 0) throw new CartError("Rabatt muss positiv angegeben werden");
  if (discount > Math.abs(base)) {
    throw new CartError(`Rabatt ${discount} ist groesser als der Positionswert ${Math.abs(base)}`);
  }
  return replaceLine(cart, index, { ...line, discount });
}

/** Positionsrabatt als Prozentsatz in Hundertstel Prozent (1000 = 10 %). */
export function setLineDiscountPercent(cart: Cart, lineId: Id, bp: BasisPoints): Cart {
  const index = indexOfLine(cart, lineId);
  const line = cart.lines[index] as CartLine;
  const base = Math.abs(lineTotal(effectiveUnitPrice(line), line.quantity));
  return setLineDiscount(cart, lineId, applyBasisPoints(base, bp));
}

/** Belegrabatt als Betrag. Wird bei der Summenbildung auf die Positionen umgelegt. */
export function setOrderDiscount(cart: Cart, discount: Cents): Cart {
  if (cents(discount) < 0) throw new CartError("Rabatt muss positiv angegeben werden");
  const base = Math.abs(subtotalAfterLineDiscounts(cart));
  if (discount > base) throw new CartError(`Belegrabatt ${discount} ist groesser als die Summe ${base}`);
  return { ...cart, orderDiscount: discount };
}

/** Belegrabatt als Prozentsatz in Hundertstel Prozent. */
export function setOrderDiscountPercent(cart: Cart, bp: BasisPoints): Cart {
  return setOrderDiscount(cart, applyBasisPoints(Math.abs(subtotalAfterLineDiscounts(cart)), bp));
}

function subtotalAfterLineDiscounts(cart: Cart): Cents {
  return sumCents(
    cart.lines.map((line) => {
      const base = lineTotal(effectiveUnitPrice(line), line.quantity);
      return base >= 0 ? base - line.discount : base + line.discount;
    }),
  );
}

/** Eine Position mit berechneten Betraegen, wie sie auf den Beleg kommt. */
export interface ComputedLine extends Omit<OrderLine, "id" | "position"> {
  readonly lineId: Id;
  readonly position: number;
}

export interface CartTotals {
  readonly lines: readonly ComputedLine[];
  /** Summe der Positionen vor allen Rabatten. */
  readonly subtotal: Cents;
  /** Summe aller Positionsrabatte. */
  readonly lineDiscountTotal: Cents;
  /** Belegrabatt. */
  readonly orderDiscount: Cents;
  /** Zu zahlender Bruttobetrag. */
  readonly total: Cents;
  readonly taxGroups: readonly TaxGroupTotal[];
  /** Enthaltene Umsatzsteuer ueber alle Saetze. */
  readonly taxTotal: Cents;
  readonly itemCount: Quantity;
}

/**
 * Summen des Warenkorbs berechnen.
 *
 * Reihenfolge, und die ist nicht beliebig:
 * 1. Positionswert = Einzelpreis inkl. Zusaetze mal Menge, auf Cent gerundet
 * 2. minus Positionsrabatt
 * 3. Belegrabatt anteilig auf die Positionen umlegen (ohne Cent-Verlust)
 * 4. Steuer je Steuersatz auf der Summe der so entstandenen Positionsbrutti
 *
 * Schritt 3 muss vor Schritt 4 kommen: ein Belegrabatt mindert die
 * Umsatzsteuer, und zwar in dem Verhaeltnis, in dem die Steuersaetze am
 * Beleg beteiligt sind.
 */
export function cartTotals(cart: Cart, options: CartOptions = {}): CartTotals {
  const registry = options.taxRegistry ?? createTaxRegistry();
  const smallBusiness = options.smallBusiness ?? false;

  const base = cart.lines.map((line) => {
    const raw = lineTotal(effectiveUnitPrice(line), line.quantity);
    const afterDiscount = raw >= 0 ? raw - line.discount : raw + line.discount;
    return { line, raw, afterDiscount };
  });

  const subtotal = sumCents(base.map((b) => b.raw));
  const lineDiscountTotal = sumCents(cart.lines.map((l) => l.discount));

  const allocation = distribute(
    cart.orderDiscount,
    base.map((b) => Math.abs(b.afterDiscount)),
  );

  const lines: ComputedLine[] = base.map((b, index) => {
    const allocated = allocation[index] ?? 0;
    const gross = b.afterDiscount >= 0 ? b.afterDiscount - allocated : b.afterDiscount + allocated;
    return {
      lineId: b.line.id,
      position: index + 1,
      productId: b.line.productId,
      name: b.line.name,
      quantity: b.line.quantity,
      unitPrice: b.line.unitPrice,
      gross,
      taxKey: resolveTaxKey(
        { taxKey: b.line.taxKey, taxKeyDineIn: b.line.taxKeyDineIn },
        cart.serviceMode,
        smallBusiness,
      ),
      businessCaseType: b.line.businessCaseType,
      modifiers: b.line.modifiers,
      discount: b.line.discount,
      allocatedDiscount: allocated,
      note: b.line.note,
    };
  });

  const taxGroups = summarizeTax(
    lines.map((line) => ({ taxKey: line.taxKey, gross: line.gross })),
    registry,
  );

  return {
    lines,
    subtotal,
    lineDiscountTotal,
    orderDiscount: cart.orderDiscount,
    total: sumCents(lines.map((l) => l.gross)),
    taxGroups,
    taxTotal: sumCents(taxGroups.map((g) => g.tax)),
    itemCount: cart.lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}
