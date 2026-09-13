/**
 * Pfand.
 *
 * Becher, Deckel, Kisten, Flaschen - was der Betrieb an Pfand fuehrt, legt er
 * selbst an: beliebig viele Pfandartikel mit beliebigem Betrag. Es gibt keine
 * eingebauten Pfandarten, weil kein Kassenhersteller wissen kann, welche
 * Gebinde ein Betrieb verwendet.
 *
 * Die zentrale Entscheidung dieses Moduls: **Pfandpositionen werden nicht
 * gespeichert, sondern abgeleitet.** Sie entstehen bei jeder Summenbildung neu
 * aus dem Artikel, an dem sie haengen.
 *
 * Der Grund ist Erfahrung mit dem Gegenteil: speichert man die Pfandzeile als
 * eigene Position, laeuft sie auseinander. Der Bediener aendert die Menge des
 * Kaffees von 1 auf 3 - und auf dem Bon steht ein Becherpfand. Er storniert
 * den Kaffee - das Pfand bleibt stehen. Abgeleitete Positionen koennen das
 * nicht: es gibt keinen Zustand, der abweichen koennte.
 *
 * Ausnahmen, die es trotzdem geben muss:
 *   - Der Kunde bringt seinen eigenen Becher mit. Dann wird das Pfand fuer
 *     diese Position abgewaehlt (`waiveDeposit`).
 *   - Der Kunde gibt Becher zurueck, ohne etwas zu kaufen. Das ist eine
 *     eigene, echte Position mit negativem Betrag (`addDepositReturn`).
 */

import type { Cents, Quantity } from "./money.ts";
import { ONE } from "./money.ts";
import type { Id, Product } from "./model.ts";
import type { TaxKey } from "./tax.ts";

export class DepositError extends Error {}

/** Ein Pfandartikel, wie er an einer Position haengt. */
export interface DepositItem {
  readonly productId: Id;
  readonly name: string;
  /** Pfandbetrag brutto in Cent, immer positiv. */
  readonly price: Cents;
  readonly taxKey: TaxKey;
}

/** Nachschlagewerk: welcher Artikel bringt welches Pfand mit? */
export interface DepositCatalog {
  /** Pfandartikel eines Artikels, in Bonreihenfolge. Leer, wenn keins. */
  for(productId: Id): readonly DepositItem[];
  /** Alle Pfandartikel des Mandanten, fuer den Ruecknahmebildschirm. */
  all(): readonly DepositItem[];
}

/**
 * Katalog aus dem Artikelstamm bauen.
 *
 * Verweist ein Artikel auf einen Pfandartikel, der nicht existiert oder kein
 * Pfandartikel ist, wird das sofort gemeldet. Ein stillschweigend ignoriertes
 * Becherpfand faellt sonst erst beim Kassenabschluss auf, wenn das Geld fehlt.
 */
export function createDepositCatalog(products: readonly Product[]): DepositCatalog {
  const byId = new Map<Id, Product>();
  for (const product of products) byId.set(product.id, product);

  const items = new Map<Id, DepositItem[]>();
  const allDeposits = new Map<Id, DepositItem>();

  const toItem = (product: Product): DepositItem => {
    if (!product.isDeposit) throw new DepositError(`Artikel "${product.name}" ist kein Pfandartikel`);
    if (product.price == null) throw new DepositError(`Pfandartikel "${product.name}" braucht einen festen Betrag`);
    if (product.price <= 0) throw new DepositError(`Pfandbetrag von "${product.name}" muss groesser als null sein`);
    return {
      productId: product.id,
      name: product.name,
      price: product.price,
      taxKey: product.taxKey,
    };
  };

  for (const product of products) {
    if (product.isDeposit) allDeposits.set(product.id, toItem(product));
  }

  for (const product of products) {
    const ids = product.depositProductIds;
    if (!ids || ids.length === 0) continue;
    if (product.isDeposit) {
      throw new DepositError(`Pfandartikel "${product.name}" darf nicht selbst Pfand mitbringen`);
    }
    const list: DepositItem[] = [];
    for (const id of ids) {
      const depositProduct = byId.get(id);
      if (!depositProduct) {
        throw new DepositError(`Artikel "${product.name}" verweist auf den unbekannten Pfandartikel ${id}`);
      }
      const item = allDeposits.get(id);
      if (!item) {
        throw new DepositError(`Artikel "${product.name}" verweist auf "${depositProduct.name}", das kein Pfandartikel ist`);
      }
      list.push(item);
    }
    items.set(product.id, list);
  }

  const allItems = [...allDeposits.values()];

  return {
    for(productId) {
      return items.get(productId) ?? [];
    },
    all() {
      return allItems;
    },
  };
}

/** Leerer Katalog, wenn ein Mandant kein Pfand fuehrt. */
export const NO_DEPOSITS: DepositCatalog = {
  for: () => [],
  all: () => [],
};

/**
 * Pfandmenge zu einer Warenmenge.
 *
 * Pfand wird immer in ganzen Stueck berechnet, auch wenn die Ware gewogen
 * wird: 0,350 kg Mutzen in der Mehrwegschale sind eine Schale, nicht 0,35.
 * Aufgerundet, weil eine angefangene Schale eine ganze ist.
 */
export function depositQuantity(goodsQuantity: Quantity): Quantity {
  if (goodsQuantity === 0) return 0;
  const units = Math.ceil(Math.abs(goodsQuantity) / ONE) * ONE;
  return goodsQuantity < 0 ? -units : units;
}
