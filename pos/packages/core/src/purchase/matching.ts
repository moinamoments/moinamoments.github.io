/**
 * Rechnungspositionen den Artikeln zuordnen - und daraus Wareneingaenge machen.
 *
 * ## Der Grundsatz: vorschlagen, nicht buchen
 *
 * Diese Datei **bucht nichts**. Sie schlaegt vor, und jeder Vorschlag traegt
 * mit, wie sicher er ist und woran er haengt. Gebucht wird erst, was ein Mensch
 * bestaetigt hat.
 *
 * Das ist keine Vorsicht um der Vorsicht willen. Ein falsch zugeordneter
 * Wareneingang ist besonders unangenehm, weil er **doppelt** falsch ist: der
 * eine Artikel hat zu viel, der andere zu wenig. Beides faellt erst bei der
 * Inventur auf, und dann weiss niemand mehr, welche Lieferung schuld war.
 *
 * ## Wie zugeordnet wird, in dieser Reihenfolge
 *
 *   1. **GTIN/EAN** - eindeutig, weltweit vergeben. Ein Treffer hier ist sicher.
 *   2. **Artikelnummer des Lieferanten** gegen die eigene Artikelnummer. Gut,
 *      solange der Betrieb die Nummern des Lieferanten uebernommen hat.
 *   3. **Name, genau gleich** (ohne Gross- und Kleinschreibung).
 *   4. **Name, aehnlich.** Nur ein Vorschlag - hier irrt sich ein Automat, und
 *      deshalb ist dieser Fall als unsicher gekennzeichnet.
 *
 * Ist ein Treffer **mehrdeutig** - zwei Artikel mit derselben Nummer, zwei mit
 * demselben Namen - dann gibt es keinen Vorschlag. Zu raten waere hier
 * schlimmer als nicht zu wissen.
 *
 * ## Warum die Einheit geprueft wird
 *
 * Ein Lieferant liefert "1 Karton", die Kasse fuehrt "Dosen". Beides mit `1` zu
 * buchen ergibt einen Bestand von einer Dose statt vierundzwanzig. Wo sich die
 * Einheiten unterscheiden, wird gewarnt statt umgerechnet: wie viele Dosen in
 * einen Karton gehen, steht nirgends in der Datei.
 */

import { MAX_NAME_LENGTH } from "../limits.ts";
import type { Id, Product, StockMovement, Timestamp } from "../model.ts";
import { ONE, type Cents, type Quantity, roundHalfUp } from "../money.ts";
import { buildMovement, tracksStock } from "../stock.ts";
import { type SupplierInvoice, type SupplierInvoiceLine, quantityInBaseUnit, unitFromCode } from "./invoice.ts";

export class GoodsReceiptError extends Error {}

/** Wie sicher die Zuordnung ist. */
export type MatchKind =
  /** Ueber GTIN/EAN - eindeutig. */
  | "GTIN"
  /** Ueber die Artikelnummer. */
  | "SKU"
  /** Name genau gleich. */
  | "NAME_EXACT"
  /** Name aehnlich - ein Vorschlag, den ein Mensch bestaetigen muss. */
  | "NAME_SIMILAR"
  /** Mehrere Artikel passen gleich gut - keine Zuordnung. */
  | "AMBIGUOUS"
  /** Nichts passt. */
  | "NONE";

/** Ein Hinweis an einer Position - kein Fehler, aber etwas zum Hinsehen. */
export interface MatchNote {
  readonly kind: "UNIT" | "NO_STOCK" | "DEPOSIT" | "PRICE_JUMP" | "NEGATIVE";
  readonly message: string;
}

export interface MatchedLine {
  readonly line: SupplierInvoiceLine;
  readonly match: MatchKind;
  /** Der vorgeschlagene Artikel, sofern es genau einen gibt. */
  readonly product: Product | null;
  /** Bei `AMBIGUOUS`: die Artikel, die alle passen wuerden. */
  readonly candidates: readonly Product[];
  /**
   * Menge in der Einheit des Artikels, in Tausendsteln - das, was gebucht
   * wuerde. Bereits umgerechnet, wo die Einheit bekannt ist (Gramm -> Kilo).
   */
  readonly quantity: Quantity;
  /** Nettoeinkaufspreis je Einheit, soweit die Rechnung ihn hergibt. */
  readonly netUnitPrice: Cents | null;
  readonly notes: readonly MatchNote[];
  /**
   * Soll diese Position gebucht werden? Vorbelegt mit "ja", wo die Zuordnung
   * sicher ist. Die Oberflaeche darf das aendern - es ist ein Vorschlag.
   */
  readonly selected: boolean;
}

export interface GoodsReceiptPlan {
  readonly invoice: SupplierInvoice;
  readonly lines: readonly MatchedLine[];
  /** Zeilen, die ohne weiteres gebucht werden koennen. */
  readonly readyCount: number;
  /** Zeilen, die ein Mensch ansehen muss. */
  readonly openCount: number;
}

/* ------------------------------------------------------------------ *
 * Namen vergleichen
 * ------------------------------------------------------------------ */

/**
 * Einen Namen auf das Vergleichbare reduzieren.
 *
 * "Cola 0,33l Dose" und "COLA 0,33 L DOSE" sind derselbe Artikel. Wegfallen
 * Gross- und Kleinschreibung, mehrfacher Leerraum und Satzzeichen; Umlaute
 * werden ausgeschrieben, weil Lieferantendateien beides enthalten.
 */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Aehnlichkeit zweier Namen zwischen 0 und 1.
 *
 * Verglichen werden die **Woerter**, nicht die Zeichen: ein Lieferant schreibt
 * "Coca Cola Dose 0,33", die Kasse "Cola 0,33 Dose". Zeichenweise sind das
 * zwei sehr verschiedene Zeichenketten, als Wortmengen sind sie fast gleich -
 * und fuer Artikelbezeichnungen ist die Wortsicht die richtige, weil
 * Lieferanten dieselben Woerter in anderer Reihenfolge schreiben.
 *
 * Kurze Woerter (ein Zeichen) zaehlen nicht mit; sie treffen sonst zufaellig.
 */
export function nameSimilarity(left: string, right: string): number {
  const a = new Set(normalizeName(left).split(" ").filter((word) => word.length > 1));
  const b = new Set(normalizeName(right).split(" ").filter((word) => word.length > 1));
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  // Jaccard: gemeinsame Woerter geteilt durch alle vorkommenden.
  return shared / (a.size + b.size - shared);
}

/**
 * Ab hier gilt ein Name als aehnlich genug fuer einen Vorschlag.
 *
 * 0,5 heisst grob: die Haelfte der Woerter ist gemeinsam. Darunter entstehen
 * Vorschlaege, die mehr verwirren als helfen - und jeder Vorschlag, den ein
 * Bediener wegklicken muss, macht den naechsten unglaubwuerdiger.
 */
export const NAME_SIMILARITY_THRESHOLD = 0.5;

/* ------------------------------------------------------------------ *
 * Zuordnen
 * ------------------------------------------------------------------ */

function normalizeCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/\s/g, "");
  return trimmed.length === 0 ? null : trimmed.toUpperCase();
}

interface Candidates {
  readonly kind: MatchKind;
  readonly products: readonly Product[];
}

function findCandidates(line: SupplierInvoiceLine, products: readonly Product[]): Candidates {
  const gtin = normalizeCode(line.gtin);
  if (gtin) {
    const hits = products.filter((product) => normalizeCode(product.sku) === gtin);
    if (hits.length > 0) return { kind: hits.length === 1 ? "GTIN" : "AMBIGUOUS", products: hits };
  }

  const sellerId = normalizeCode(line.sellerItemId);
  if (sellerId) {
    const hits = products.filter((product) => normalizeCode(product.sku) === sellerId);
    if (hits.length > 0) return { kind: hits.length === 1 ? "SKU" : "AMBIGUOUS", products: hits };
  }

  const name = normalizeName(line.name);
  if (name.length > 0) {
    const exact = products.filter((product) => normalizeName(product.name) === name);
    if (exact.length > 0) return { kind: exact.length === 1 ? "NAME_EXACT" : "AMBIGUOUS", products: exact };

    const scored = products
      .map((product) => ({ product, score: nameSimilarity(line.name, product.name) }))
      .filter((entry) => entry.score >= NAME_SIMILARITY_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0]!;
      // Zwei gleich gute Treffer sind kein Treffer. Den einen zu waehlen,
      // weil er in der Liste weiter oben steht, waere Zufall mit Anschein
      // von Absicht.
      const tied = scored.filter((entry) => Math.abs(entry.score - best.score) < 0.0001);
      if (tied.length > 1) return { kind: "AMBIGUOUS", products: tied.map((entry) => entry.product) };
      return { kind: "NAME_SIMILAR", products: [best.product] };
    }
  }

  return { kind: "NONE", products: [] };
}

/**
 * Ab dieser Abweichung gilt ein Einkaufspreis als auffaellig.
 *
 * Ein Einkaufspreis ueber dem Verkaufspreis ist entweder ein Tippfehler, eine
 * verrutschte Spalte oder ein Geschaeft, das Geld kostet. In allen drei Faellen
 * will der Betrieb es sehen, bevor er bucht.
 */
function priceNote(line: SupplierInvoiceLine, product: Product, netUnitPrice: Cents | null): MatchNote | null {
  if (netUnitPrice == null || netUnitPrice <= 0) return null;
  const sellingPrice = product.price;
  if (sellingPrice == null || sellingPrice <= 0) return null;
  if (netUnitPrice <= sellingPrice) return null;
  return {
    kind: "PRICE_JUMP",
    message: `Der Einkaufspreis (${(netUnitPrice / 100).toFixed(2)} EUR netto) liegt ueber dem Verkaufspreis (${(sellingPrice / 100).toFixed(2)} EUR brutto). Bitte die Spalte und den Preis pruefen.`,
  };
}

function unitNote(line: SupplierInvoiceLine, product: Product): MatchNote | null {
  const mapping = unitFromCode(line.unitCode);
  if (!mapping) {
    if (!line.unitCode) return null;
    return {
      kind: "UNIT",
      message: `Die Einheit "${line.unitCode}" der Rechnung ist unbekannt - moeglicherweise ein Gebinde. Die Menge wird unveraendert uebernommen; bitte pruefen, wie viele Einheiten darin sind.`,
    };
  }
  if (mapping.unit !== product.unit) {
    return {
      kind: "UNIT",
      message: `Die Rechnung liefert in einer anderen Einheit als der Artikel gefuehrt wird. Die Menge wird nicht umgerechnet.`,
    };
  }
  return null;
}

function lineNotes(line: SupplierInvoiceLine, product: Product | null, quantity: Quantity, netUnitPrice: Cents | null): MatchNote[] {
  const notes: MatchNote[] = [];
  if (quantity < 0) {
    notes.push({
      kind: "NEGATIVE",
      message: "Die Menge ist negativ - eine Ruecklieferung oder Gutschrift. Gebucht wird ein Abgang.",
    });
  }
  if (!product) return notes;

  if (product.isDeposit) {
    notes.push({
      kind: "DEPOSIT",
      message: `"${product.name}" ist ein Pfandartikel. Pfand fuehrt keinen Bestand - Becher und Kisten sind Gebinde, kein Umsatz.`,
    });
  } else if (!tracksStock(product)) {
    notes.push({
      kind: "NO_STOCK",
      message: `Fuer "${product.name}" ist keine Bestandsfuehrung eingeschaltet. Die Position kann erst gebucht werden, wenn sie im Artikel eingeschaltet wird.`,
    });
  }

  const unit = unitNote(line, product);
  if (unit) notes.push(unit);

  const price = priceNote(line, product, netUnitPrice);
  if (price) notes.push(price);

  return notes;
}

/**
 * Den Einkaufspreis je Einheit bestimmen.
 *
 * Bevorzugt der ausgewiesene Einzelpreis. Fehlt er, wird er aus Betrag und
 * Menge gerechnet - das ist genauer als nichts und bei Rechnungen ohne
 * Preisspalte der einzige Weg.
 */
export function unitPriceOf(line: SupplierInvoiceLine): Cents | null {
  if (line.netUnitPrice != null) return line.netUnitPrice;
  if (line.netAmount != null && line.quantity !== 0) {
    return roundHalfUp((line.netAmount * ONE) / line.quantity);
  }
  return null;
}

/**
 * Eine Rechnung gegen den Artikelstamm halten.
 *
 * Vorbelegt zum Buchen wird nur, was **sicher** ist: eine eindeutige Zuordnung
 * ueber Nummer oder genauen Namen, bei einem Artikel mit Bestandsfuehrung, mit
 * einer Menge ungleich null. Alles andere kommt unangehakt und mit Hinweis -
 * der Bediener sieht, was zu tun ist, und muss nicht suchen.
 */
export function planGoodsReceipt(invoice: SupplierInvoice, products: readonly Product[]): GoodsReceiptPlan {
  const lines: MatchedLine[] = [];

  for (const line of invoice.lines) {
    const { kind, products: candidates } = findCandidates(line, products);
    const product = kind === "AMBIGUOUS" || kind === "NONE" ? null : (candidates[0] ?? null);

    const quantity = quantityInBaseUnit(line.quantity, line.unitCode);
    const netUnitPrice = unitPriceOf(line);
    const notes = lineNotes(line, product, quantity, netUnitPrice);

    const bookable = product != null && tracksStock(product) && quantity !== 0;
    const certain = kind === "GTIN" || kind === "SKU" || kind === "NAME_EXACT";

    lines.push({
      line,
      match: kind,
      product,
      candidates: kind === "AMBIGUOUS" ? candidates : [],
      quantity,
      netUnitPrice,
      notes,
      selected: bookable && certain,
    });
  }

  return {
    invoice,
    lines,
    readyCount: lines.filter((entry) => entry.selected).length,
    openCount: lines.filter((entry) => !entry.selected).length,
  };
}

/**
 * Eine Position von Hand einem Artikel zuordnen.
 *
 * Der Fall, der taeglich vorkommt: der Lieferant schreibt es anders, der
 * Bediener weiss es besser. Die Zuordnung wird dadurch sicher - also wird die
 * Zeile auch zum Buchen vorbelegt, sofern der Artikel einen Bestand fuehrt.
 */
export function assignProduct(entry: MatchedLine, product: Product | null): MatchedLine {
  if (!product) {
    return { ...entry, product: null, candidates: [], match: "NONE", notes: [], selected: false };
  }
  const notes = lineNotes(entry.line, product, entry.quantity, entry.netUnitPrice);
  return {
    ...entry,
    product,
    candidates: [],
    // Von Hand zugeordnet ist so sicher wie ein Nummerntreffer: ein Mensch hat
    // hingesehen.
    match: "SKU",
    notes,
    selected: tracksStock(product) && entry.quantity !== 0,
  };
}

/* ------------------------------------------------------------------ *
 * Buchen
 * ------------------------------------------------------------------ */

export interface BookingOptions {
  readonly newId: () => Id;
  readonly storeId: Id;
  readonly userId: Id;
  readonly createdAt: Timestamp;
}

export interface GoodsReceiptResult {
  readonly movements: readonly StockMovement[];
  /** Neuer Bestand je Artikel, zum Fortschreiben am Artikel. */
  readonly stockByProduct: ReadonlyMap<Id, Quantity>;
}

/**
 * Der Vermerk, der im Bestandsjournal landet.
 *
 * Rechnungsnummer und Lieferant gehoeren dort hinein, nicht in ein Feld
 * daneben: wer in einem halben Jahr fragt, woher zwanzig Dosen kamen, liest
 * das Journal - und findet dort die Rechnung, mit der er zum Ordner gehen kann.
 */
export function receiptNote(invoice: SupplierInvoice, line: SupplierInvoiceLine): string {
  const parts: string[] = [];
  if (invoice.supplierName) parts.push(invoice.supplierName);
  if (invoice.invoiceNumber) parts.push(`Rg. ${invoice.invoiceNumber}`);
  if (invoice.issuedOn) parts.push(invoice.issuedOn);
  if (line.lineId) parts.push(`Pos. ${line.lineId}`);
  const note = parts.join(", ");
  return note.length > MAX_NAME_LENGTH ? `${note.slice(0, MAX_NAME_LENGTH - 1)}…` : note;
}

/**
 * Aus den bestaetigten Positionen Bestandsbewegungen machen.
 *
 * Gebucht werden **nur** angehakte Zeilen mit Artikel und Menge. Kommt derselbe
 * Artikel mehrfach vor - bei Sammelrechnungen die Regel -, wird der Bestand
 * fortlaufend weitergerechnet und nicht zweimal vom Ausgangswert: sonst
 * ueberschreibt die zweite Bewegung die erste, und die Haelfte der Lieferung
 * ist weg.
 */
export function bookGoodsReceipt(plan: GoodsReceiptPlan, options: BookingOptions): GoodsReceiptResult {
  const movements: StockMovement[] = [];
  const running = new Map<Id, Quantity>();

  for (const entry of plan.lines) {
    if (!entry.selected) continue;
    const product = entry.product;
    if (!product) throw new GoodsReceiptError("Eine bestaetigte Position hat keinen Artikel.");
    if (!tracksStock(product)) {
      throw new GoodsReceiptError(`Fuer "${product.name}" ist keine Bestandsfuehrung eingeschaltet; die Position kann nicht gebucht werden.`);
    }
    if (entry.quantity === 0) continue;

    const current = running.get(product.id) ?? product.stock ?? 0;
    const result = buildMovement({
      id: options.newId(),
      product: { ...product, stock: current },
      storeId: options.storeId,
      userId: options.userId,
      quantity: entry.quantity,
      reason: "PURCHASE",
      note: receiptNote(plan.invoice, entry.line),
      createdAt: options.createdAt,
    });
    running.set(product.id, result.stock);
    movements.push(result.movement);
  }

  return { movements, stockByProduct: running };
}

/**
 * Die Positionen, zu denen es keinen Artikel gibt.
 *
 * Daraus entsteht der naechste sinnvolle Schritt: einen Artikel anlegen. Die
 * Rechnung bringt Name, Nummer und Einkaufspreis schon mit - der Betrieb muss
 * nur noch Warengruppe, Verkaufspreis und Steuersatz setzen.
 */
export function unmatchedLines(plan: GoodsReceiptPlan): MatchedLine[] {
  return plan.lines.filter((entry) => entry.product == null);
}
