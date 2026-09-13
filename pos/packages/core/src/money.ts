/**
 * Geldrechnen.
 *
 * Grundregel des ganzen Projekts: Betraege sind *immer* ganzzahlige Cent.
 * Gleitkommazahlen tauchen nur in Zwischenschritten der Rundung auf und
 * werden sofort wieder auf Cent gerundet. Ein `number` mit Nachkommastellen
 * als Betrag ist in diesem Code ein Fehler.
 *
 * Mengen sind ganzzahlige Tausendstel (`Quantity`), damit sowohl Stueckzahlen
 * (1 Stueck = 1000) als auch Gewichte (0,350 kg = 350) ohne Bruchrechnung
 * darstellbar sind.
 */

/** Betrag in ganzen Cent. Negativ bedeutet Gutschrift/Auszahlung. */
export type Cents = number;

/** Menge in Tausendstel der Verkaufseinheit. 1000 = eine Einheit. */
export type Quantity = number;

/** Eine ganze Verkaufseinheit als `Quantity`. */
export const ONE: Quantity = 1000;

/** Hundertstel Prozent. 1900 = 19,00 %. Vermeidet 0,19-Gleitkommaeffekte. */
export type BasisPoints = number;

export class MoneyError extends Error {}

function assertFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) throw new MoneyError(`${what} ist keine endliche Zahl: ${value}`);
}

/**
 * Kaufmaennische Rundung: exakt 0,5 wird vom Nullpunkt weg gerundet.
 *
 * `Math.round` rundet -0,5 auf -0 (also Richtung +unendlich) und ist damit
 * fuer Gutschriften und Rabatte unsymmetrisch. Bei Storni fuehrt das dazu,
 * dass Beleg und Stornobeleg sich nicht exakt aufheben - genau das darf in
 * einer Kasse nicht passieren.
 */
export function roundHalfUp(value: number): number {
  assertFinite(value, "Rundungswert");
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Ganzzahligen Cent-Betrag pruefen und zurueckgeben. */
export function cents(value: number): Cents {
  assertFinite(value, "Betrag");
  if (!Number.isInteger(value)) throw new MoneyError(`Betrag muss ganzzahlig in Cent sein: ${value}`);
  return value;
}

/** Summe mehrerer Betraege. */
export function sumCents(values: readonly Cents[]): Cents {
  let total = 0;
  for (const v of values) total += cents(v);
  return total;
}

/**
 * Positionswert: Einzelpreis mal Menge.
 *
 * Gerundet wird genau hier, auf Positionsebene - nicht erst in der Summe.
 * So entspricht die Belegsumme immer der Summe der gedruckten Zeilen, was
 * bei einer Pruefung durch das Finanzamt nachvollziehbar sein muss.
 */
export function lineTotal(unitPrice: Cents, quantity: Quantity): Cents {
  cents(unitPrice);
  assertFinite(quantity, "Menge");
  if (!Number.isInteger(quantity)) throw new MoneyError(`Menge muss ganzzahlig in Tausendstel sein: ${quantity}`);
  return roundHalfUp((unitPrice * quantity) / ONE);
}

/** Anteil eines Betrags in Hundertstel Prozent, kaufmaennisch gerundet. */
export function applyBasisPoints(amount: Cents, bp: BasisPoints): Cents {
  cents(amount);
  assertFinite(bp, "Prozentsatz");
  return roundHalfUp((amount * bp) / 10_000);
}

/**
 * Betrag proportional auf Gewichte verteilen, ohne Cent zu verlieren.
 *
 * Gebraucht fuer Belegrabatte, die auf die Positionen umgelegt werden
 * muessen, weil die Umsatzsteuer je Steuersatz auszuweisen ist. Der
 * Rundungsrest wandert nach dem "largest remainder"-Verfahren an die
 * Positionen mit dem groessten Restanteil; bei Gleichstand an die
 * vorderste. Das Ergebnis ist deterministisch und summiert exakt.
 */
export function distribute(amount: Cents, weights: readonly number[]): Cents[] {
  cents(amount);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (totalWeight === 0) {
    // Ohne Gewichte gibt es keine sinnvolle Aufteilung: alles auf die erste Position.
    const out = new Array<Cents>(weights.length).fill(0);
    out[0] = amount;
    return out;
  }

  const exact = weights.map((w) => (amount * w) / totalWeight);
  const floors = exact.map((v) => (v < 0 ? Math.ceil(v) : Math.floor(v)));
  let rest = amount - floors.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: Math.abs(v - (floors[i] as number)) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const step = rest < 0 ? -1 : 1;
  for (let k = 0; rest !== 0 && k < order.length * 2; k++) {
    const target = order[k % order.length] as { i: number };
    floors[target.i] = (floors[target.i] as number) + step;
    rest -= step;
  }
  if (rest !== 0) throw new MoneyError(`Verteilung ging nicht auf, Rest ${rest}`);
  return floors;
}

/** Betrag als deutscher Text ohne Waehrungszeichen, z. B. `4,50`. */
export function formatAmount(value: Cents): string {
  cents(value);
  const negative = value < 0;
  const abs = Math.abs(value);
  const euro = Math.floor(abs / 100);
  const rest = abs % 100;
  const grouped = String(euro).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${grouped},${String(rest).padStart(2, "0")}`;
}

/** Betrag als deutscher Text mit Euro-Zeichen, z. B. `4,50 EUR` -> `4,50 €`. */
export function formatEuro(value: Cents): string {
  return `${formatAmount(value)} €`;
}

/** Betrag im Punkt-Format der TSE und der DSFinV-K, z. B. `4.50`. */
export function formatDecimal(value: Cents): string {
  cents(value);
  const negative = value < 0;
  const abs = Math.abs(value);
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Menge als Text mit bis zu drei Nachkommastellen, Nullen abgeschnitten. */
export function formatQuantity(value: Quantity): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / ONE);
  const frac = String(abs % ONE).padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `,${frac}` : ""}`;
}

/** Menge im Punkt-Format der DSFinV-K, immer drei Nachkommastellen. */
export function formatQuantityDecimal(value: Quantity): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  return `${negative ? "-" : ""}${Math.floor(abs / ONE)}.${String(abs % ONE).padStart(3, "0")}`;
}

/**
 * Benutzereingabe als Cent lesen. Akzeptiert `4,50`, `4.50`, `4`, `450`?
 * Nein - bewusst *nicht* `450` als 4,50: Eingaben ohne Trennzeichen sind
 * ganze Euro. Alles andere fuehrt am Kassenstand zu falschen Betraegen.
 * Gibt `null` zurueck, wenn die Eingabe kein Betrag ist.
 */
export function parseAmount(input: string): Cents | null {
  const text = input.trim().replace(/\s|€|EUR/gi, "");
  if (text === "") return null;
  if (!/^-?\d{1,12}([.,]\d{0,2})?$/.test(text)) return null;
  const negative = text.startsWith("-");
  const [whole, frac = ""] = text.replace("-", "").split(/[.,]/) as [string, string?];
  const value = Number(whole) * 100 + Number(frac.padEnd(2, "0") || "0");
  return negative ? -value : value;
}
