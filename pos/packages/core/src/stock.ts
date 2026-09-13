/**
 * Bestandsfuehrung.
 *
 * Grundsatz: der Bestand wird **fortgeschrieben, nicht gesetzt**. Jede
 * Aenderung ist eine Bewegung mit Grund, Zeitpunkt und Bediener; der
 * Zahlenstand am Artikel ist nur die Summe dieser Bewegungen. Wer stattdessen
 * eine Bestandszahl direkt ueberschreibt, kann hinterher nicht beantworten,
 * warum von zwanzig Flaschen zwoelf uebrig sind - und genau das ist die Frage,
 * die sich jeden Monat stellt.
 *
 * Bewusste Entscheidungen:
 *
 *   - Bestandsfuehrung ist **je Artikel** einschaltbar. Ein Crepe entsteht aus
 *     Teig; ein Stueckbestand darauf ist sinnlos. Eine Flasche Limonade zaehlt
 *     man. Beides gleich zu behandeln erzeugt entweder Unsinn oder nichts.
 *   - Ein Verkauf, der den Bestand ins Negative fuehrt, wird **gebucht, nicht
 *     verweigert**. Der Kunde steht am Stand, die Flasche ist in seiner Hand -
 *     die Kasse hat dann nicht recht zu haben, sondern zu kassieren. Der
 *     negative Bestand ist das Signal, dass ein Wareneingang fehlt.
 *   - Pfandartikel fuehren keinen Bestand: Becher sind Gebinde, kein Umsatz.
 */

import { ONE, type Quantity, formatQuantity } from "./money.ts";
import type { Id, Order, Product, StockMovement, StockMovementReason, Timestamp } from "./model.ts";

export class StockError extends Error {}

/** Klartext der Bewegungsgruende, fuer Journal und Auswertung. */
export const STOCK_REASON_LABELS: Record<StockMovementReason, string> = {
  SALE: "Verkauf",
  VOID: "Storno",
  PURCHASE: "Wareneingang",
  COUNT: "Zaehlung",
  LOSS: "Schwund",
  OWN_USE: "Eigenverbrauch",
};

/** Fuehrt dieser Artikel einen Bestand? */
export function tracksStock(product: Pick<Product, "trackStock" | "isDeposit">): boolean {
  return product.trackStock === true && product.isDeposit !== true;
}

export type StockState = "OK" | "LOW" | "EMPTY" | "NEGATIVE" | "UNTRACKED";

/** Zustand des Bestands, fuer Kachel und Artikelliste. */
export function stockState(product: Product): StockState {
  if (!tracksStock(product)) return "UNTRACKED";
  const stock = product.stock ?? 0;
  if (stock < 0) return "NEGATIVE";
  if (stock === 0) return "EMPTY";
  const threshold = product.lowStockThreshold;
  if (threshold != null && stock <= threshold) return "LOW";
  return "OK";
}

/** Bestand als Text, wie er auf der Kachel steht. */
export function formatStock(product: Product): string | null {
  if (!tracksStock(product)) return null;
  const stock = product.stock ?? 0;
  const unit = product.unit === "PIECE" ? "" : product.unit === "KILOGRAM" ? " kg" : product.unit === "LITRE" ? " l" : " h";
  return `${formatQuantity(stock)}${unit}`;
}

export interface MovementRequest {
  readonly id: Id;
  readonly product: Product;
  readonly storeId: Id;
  readonly userId: Id;
  /** Veraenderung in Tausendsteln; negativ bei Abgang. */
  readonly quantity: Quantity;
  readonly reason: StockMovementReason;
  readonly orderId?: Id | null;
  readonly note?: string | null;
  readonly createdAt: Timestamp;
}

export interface MovementResult {
  readonly movement: StockMovement;
  /** Bestand nach der Bewegung, zum Fortschreiben am Artikel. */
  readonly stock: Quantity;
}

/**
 * Eine Bestandsbewegung bilden.
 *
 * Bildet nur den Datensatz - das Speichern ist Sache der Datenhaltung, damit
 * Bewegung und neuer Bestand in einer unteilbaren Einheit landen.
 */
export function buildMovement(request: MovementRequest): MovementResult {
  if (!Number.isInteger(request.quantity)) {
    throw new StockError(`Bestandsmenge muss ganzzahlig in Tausendsteln sein, war ${request.quantity}`);
  }
  if (request.quantity === 0) throw new StockError("Eine Bewegung ohne Menge ist keine Bewegung");
  if (!tracksStock(request.product)) {
    throw new StockError(`Fuer "${request.product.name}" ist keine Bestandsfuehrung eingeschaltet`);
  }

  const stock = (request.product.stock ?? 0) + request.quantity;
  return {
    stock,
    movement: {
      id: request.id,
      tenantId: request.product.tenantId,
      storeId: request.storeId,
      productId: request.product.id,
      quantity: request.quantity,
      resultingStock: stock,
      reason: request.reason,
      orderId: request.orderId ?? null,
      userId: request.userId,
      note: request.note ?? null,
      createdAt: request.createdAt,
    },
  };
}

/**
 * Zaehlung: Bestand auf einen gezaehlten Wert bringen.
 *
 * Gebucht wird die *Differenz*, nicht der Zielwert - damit steht im Journal,
 * was gefehlt hat. Stimmt der gezaehlte Bestand mit dem gefuehrten ueberein,
 * entsteht keine Bewegung; eine Bewegung ueber null waere nur Rauschen.
 */
export function buildCountCorrection(
  request: Omit<MovementRequest, "quantity" | "reason"> & { readonly countedStock: Quantity },
): MovementResult | null {
  if (!Number.isInteger(request.countedStock)) {
    throw new StockError(`Gezaehlter Bestand muss ganzzahlig in Tausendsteln sein, war ${request.countedStock}`);
  }
  const difference = request.countedStock - (request.product.stock ?? 0);
  if (difference === 0) return null;
  return buildMovement({ ...request, quantity: difference, reason: "COUNT" });
}

/**
 * Bewegungen zu einem Beleg.
 *
 * Ein Verkauf mindert den Bestand, ein Storno hebt ihn wieder. Grundlage sind
 * die Belegpositionen, nicht der Warenkorb: der Beleg ist der Geschaeftsvorfall
 * und ueberlebt einen Neustart.
 *
 * Pfandpositionen und Positionen ohne Artikelbezug werden uebersprungen.
 */
export function movementsForOrder(
  order: Order,
  products: readonly Product[],
  options: {
    readonly newId: () => Id;
    readonly userId: Id;
    /** `true` bei einem Stornobeleg: die Mengen sind dort bereits negativ. */
    readonly reason?: Extract<StockMovementReason, "SALE" | "VOID">;
  },
): MovementResult[] {
  const byId = new Map<Id, Product>();
  for (const product of products) byId.set(product.id, product);

  const results: MovementResult[] = [];
  // Mehrere Positionen koennen denselben Artikel betreffen; der Bestand muss
  // dann fortlaufend weitergerechnet werden, nicht zweimal vom Ausgangswert.
  const running = new Map<Id, Quantity>();

  for (const line of order.lines) {
    if (line.productId == null) continue;
    if (line.businessCaseType === "Pfand" || line.businessCaseType === "PfandRueckzahlung") continue;
    const product = byId.get(line.productId);
    if (!product || !tracksStock(product)) continue;

    const current = running.get(product.id) ?? product.stock ?? 0;
    const result = buildMovement({
      id: options.newId(),
      product: { ...product, stock: current },
      storeId: order.storeId,
      userId: options.userId,
      // Verkauf mindert: die Belegmenge ist positiv, die Bewegung negativ.
      quantity: -line.quantity,
      reason: options.reason ?? (order.voidsOrderId != null ? "VOID" : "SALE"),
      orderId: order.id,
      createdAt: order.paidAt ?? order.startedAt,
    });
    running.set(product.id, result.stock);
    results.push(result);
  }
  return results;
}

/** Artikel, die nachbestellt werden sollten. */
export function lowStockProducts(products: readonly Product[]): Product[] {
  return products
    .filter((product) => {
      const state = stockState(product);
      return state === "LOW" || state === "EMPTY" || state === "NEGATIVE";
    })
    .sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0) || a.name.localeCompare(b.name, "de"));
}

/** Bestandswert zu Einkaufspreisen fehlt noch - siehe docs/ROADMAP.md. */
export interface StockSummary {
  readonly tracked: number;
  readonly low: number;
  readonly empty: number;
  readonly negative: number;
}

export function summarizeStock(products: readonly Product[]): StockSummary {
  let tracked = 0;
  let low = 0;
  let empty = 0;
  let negative = 0;
  for (const product of products) {
    switch (stockState(product)) {
      case "UNTRACKED":
        continue;
      case "LOW":
        low++;
        break;
      case "EMPTY":
        empty++;
        break;
      case "NEGATIVE":
        negative++;
        break;
      default:
        break;
    }
    tracked++;
  }
  return { tracked, low, empty, negative };
}

/** Eine ganze Verkaufseinheit, als Bequemlichkeit fuer die Oberflaeche. */
export const ONE_UNIT: Quantity = ONE;
