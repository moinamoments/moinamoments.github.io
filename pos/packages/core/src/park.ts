/**
 * Vorgaenge parken.
 *
 * Am Verkaufsstand steht nie nur ein Kunde. Einer ueberlegt noch, einer sucht
 * Kleingeld, an Tisch drei ist noch nicht alles da - und dahinter warten fuenf,
 * die zahlen wollen. Ein Kassensystem, das nur einen Vorgang gleichzeitig
 * kennt, zwingt den Bediener zum Stornieren und Neuerfassen. Das kostet Zeit
 * und erzeugt Stornobelege, die niemand braucht.
 *
 * ## Was beim Parken mit der TSE passiert
 *
 * Das ist der Punkt, an dem es darauf ankommt. Die TSE-Transaktion beginnt mit
 * der ersten erfassten Position - nicht beim Bezahlen. Wird der Vorgang
 * geparkt, bleibt sie **offen** und wird beim Fortsetzen mit derselben
 * Transaktionsnummer abgeschlossen. Nur so tragen Beleg und Signatur die
 * Startzeit, zu der der Kunde tatsaechlich bestellt hat.
 *
 * Beim Parken wird die Transaktion zusaetzlich *aktualisiert*
 * (`updateTransaction`) - dafuer ist der Vorgang in der technischen Richtlinie
 * vorgesehen: eine Bestellung, die erfasst, aber noch nicht bezahlt ist. Damit
 * ist in der TSE protokolliert, was zu welchem Zeitpunkt im Warenkorb lag.
 * Scheitert das (TSE nicht erreichbar), wird trotzdem geparkt und der Grund
 * festgehalten - ein Vorgang, der wegen einer Netzstoerung verloren geht,
 * waere der groessere Schaden.
 *
 * Der geparkte Warenkorb ist noch **kein Geschaeftsvorfall**: es ist nichts
 * verkauft, nichts bezahlt, keine Belegnummer vergeben. Deshalb wird er als
 * Warenkorb gespeichert und nicht als Beleg.
 */

import type { Cart } from "./cart.ts";
import type { Id, Timestamp } from "./model.ts";
import type { OpenTransaction } from "./order.ts";
import type { TseClient, TseResponse } from "./tse/types.ts";
import { checkRequiredText } from "./validation.ts";

export class ParkError extends Error {}

/**
 * Hoechstzahl gleichzeitig geparkter Vorgaenge.
 *
 * 50 ist mehr als jeder Verkaufsstand gleichzeitig offen hat. Die Grenze ist
 * da, damit die Liste bedienbar bleibt - eine Auswahl aus 200 geparkten
 * Vorgaengen findet niemand mehr, und dann wird doch neu erfasst.
 */
export const MAX_PARKED_SALES = 50;

export interface ParkedSale {
  readonly id: Id;
  readonly tenantId: Id;
  readonly storeId: Id;
  readonly deviceId: Id;
  /** Bediener, der den Vorgang begonnen hat. */
  readonly userId: Id;
  /**
   * Bezeichnung, unter der der Vorgang wiedergefunden wird - "Tisch 4",
   * "Herr mit Hund", "blaue Jacke". Pflicht: ein geparkter Vorgang ohne
   * Bezeichnung ist beim Fortsetzen nicht von den anderen zu unterscheiden.
   */
  readonly label: string;
  readonly cart: Cart;
  /** Beginn der Erfassung - wird zur Startzeit des spaeteren Belegs. */
  readonly startedAt: Timestamp;
  /** Zeitpunkt des Parkens, fuer die Sortierung der Liste. */
  readonly parkedAt: Timestamp;
  /** Transaktionsnummer der offenen TSE-Transaktion; `null` bei Ausfall. */
  readonly tseTransactionNumber: number | null;
  /** Grund, wenn die TSE beim Beginn oder Parken nicht erreichbar war. */
  readonly tseFailure: string | null;
  /** Belegsumme zum Zeitpunkt des Parkens - nur fuer die Anzeige der Liste. */
  readonly total: number;
  /** Zahl der Positionen, ebenfalls nur fuer die Anzeige. */
  readonly lineCount: number;
}

export interface ParkRequest {
  readonly id: Id;
  readonly tenantId: Id;
  readonly storeId: Id;
  readonly deviceId: Id;
  readonly userId: Id;
  readonly label: string;
  readonly cart: Cart;
  readonly open: OpenTransaction;
  readonly parkedAt: Timestamp;
  readonly total: number;
  /** Bereits geparkte Vorgaenge - fuer Obergrenze und eindeutige Bezeichnung. */
  readonly existing: readonly ParkedSale[];
  /** TSE und Prozessdaten, um die offene Transaktion zu aktualisieren. */
  readonly tse?: TseClient;
  readonly tseClientId?: string | null;
  readonly processData?: string;
}

/**
 * Vorgang parken.
 *
 * Prueft die Bezeichnung, die Obergrenze und dass der Warenkorb nicht leer ist.
 * Ein leerer geparkter Vorgang ist kein Vorgang, sondern eine Zeile in der
 * Liste, die niemand zuordnen kann.
 */
export async function parkSale(request: ParkRequest): Promise<ParkedSale> {
  if (request.cart.lines.length === 0) {
    throw new ParkError("Ein leerer Vorgang kann nicht geparkt werden - erst etwas erfassen.");
  }
  if (request.existing.length >= MAX_PARKED_SALES) {
    throw new ParkError(
      `Es sind schon ${MAX_PARKED_SALES} Vorgaenge geparkt. Bitte zuerst welche abschliessen oder verwerfen.`,
    );
  }

  const checked = checkRequiredText(request.label, { label: "Die Bezeichnung", max: 60 });
  if (!checked.ok) throw new ParkError(checked.reason);
  const label = checked.value;

  if (request.existing.some((sale) => sale.label.toLowerCase() === label.toLowerCase())) {
    throw new ParkError(`"${label}" ist schon vergeben. Bitte eine andere Bezeichnung waehlen.`);
  }

  // Die offene TSE-Transaktion aktualisieren, damit protokolliert ist, was zu
  // diesem Zeitpunkt erfasst war. Best effort: ein Fehler darf das Parken nicht
  // verhindern.
  let tseFailure = request.open.tseFailure;
  const transactionNumber = request.open.tseStart?.transactionNumber ?? null;

  if (request.tse && request.tseClientId && transactionNumber != null) {
    try {
      await request.tse.updateTransaction({
        clientId: request.tseClientId,
        transactionNumber,
        processData: request.processData ?? "",
        processType: "Bestellung-V1",
      });
    } catch (error) {
      tseFailure = `Beim Parken nicht erreichbar: ${(error as Error).message}`;
    }
  }

  return {
    id: request.id,
    tenantId: request.tenantId,
    storeId: request.storeId,
    deviceId: request.deviceId,
    userId: request.userId,
    label,
    cart: request.cart,
    startedAt: request.open.startedAt,
    parkedAt: request.parkedAt,
    tseTransactionNumber: transactionNumber,
    tseFailure,
    total: request.total,
    lineCount: request.cart.lines.length,
  };
}

/**
 * Geparkten Vorgang fortsetzen.
 *
 * Stellt den Zustand wieder her, mit dem der Vorgang begonnen hat - vor allem
 * die **Startzeit** und die **Transaktionsnummer** der TSE. Beides muss das des
 * Originals sein: sonst steht auf dem Bon die Uhrzeit des Bezahlens als
 * Beginn, und die Signatur gehoert zu einer anderen Transaktion.
 *
 * Die TSE-Antwort des Starts wird rekonstruiert, soweit sie fuer den Abschluss
 * gebraucht wird. Signaturzaehler und Signatur des Starts sind dabei nicht mehr
 * nachtraeglich zu beschaffen - sie werden fuer den Abschluss auch nicht
 * gebraucht, dort zaehlt die Antwort des Abschlusses.
 */
export function resumeSale(sale: ParkedSale): { readonly open: OpenTransaction; readonly cart: Cart } {
  const tseStart: TseResponse | null =
    sale.tseTransactionNumber == null
      ? null
      : {
          transactionNumber: sale.tseTransactionNumber,
          // Zaehler und Signatur des Starts sind nicht gespeichert; fuer den
          // Abschluss zaehlen die Werte, die die TSE dann liefert.
          signatureCounter: 0,
          startTime: sale.startedAt,
          logTime: sale.startedAt,
          signature: "",
        };

  return {
    open: {
      orderId: sale.id,
      startedAt: sale.startedAt,
      tseStart,
      tseFailure: sale.tseFailure,
    },
    cart: sale.cart,
  };
}

/**
 * Geparkte Vorgaenge fuer die Liste sortieren: aeltester zuerst.
 *
 * Wer am laengsten wartet, kommt zuerst. Und ein Vorgang, der seit drei Stunden
 * geparkt ist, faellt oben in der Liste auf - genau das soll er.
 */
export function sortParkedSales(sales: readonly ParkedSale[]): ParkedSale[] {
  return [...sales].sort((a, b) => {
    const left = Date.parse(a.parkedAt);
    const right = Date.parse(b.parkedAt);
    if (Number.isNaN(left) || Number.isNaN(right)) return a.label.localeCompare(b.label, "de");
    return left - right;
  });
}

/**
 * Wie lange ist der Vorgang schon geparkt, in Minuten?
 *
 * Fuer den Hinweis in der Liste. Ein Vorgang, der ueber den Tagesabschluss
 * hinaus geparkt bleibt, ist ein Problem: die begonnene TSE-Transaktion bleibt
 * offen, und der Abschluss kann ihn nicht enthalten.
 */
export function parkedMinutes(sale: ParkedSale, now: string): number {
  const parked = Date.parse(sale.parkedAt);
  const current = Date.parse(now);
  if (Number.isNaN(parked) || Number.isNaN(current)) return 0;
  return Math.max(0, Math.floor((current - parked) / 60_000));
}

/**
 * Stehen dem Kassenabschluss geparkte Vorgaenge im Weg?
 *
 * Ja - und das muss der Bediener vor dem Abschluss wissen. Ein geparkter
 * Vorgang ist eine offene TSE-Transaktion; bleibt sie ueber den Abschluss
 * hinaus offen, fehlt sie in der Aufzeichnung des Tages. Der Abschluss wird
 * deshalb nicht verhindert, aber die Warnung ist deutlich: entweder
 * abschliessen oder verwerfen.
 */
export function parkedSalesBlockingClosing(sales: readonly ParkedSale[]): string | null {
  if (sales.length === 0) return null;
  const names = sortParkedSales(sales)
    .slice(0, 5)
    .map((sale) => sale.label)
    .join(", ");
  const more = sales.length > 5 ? ` und ${sales.length - 5} weitere` : "";
  return (
    `Es sind noch ${sales.length} Vorgaenge geparkt (${names}${more}). ` +
    "Sie sind noch nicht verkauft und gehoeren nicht in diesen Abschluss. " +
    "Bitte vorher abschliessen oder verwerfen."
  );
}
