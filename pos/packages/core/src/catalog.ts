/**
 * Warengruppen.
 *
 * Warengruppen sind verschachtelbar, aber nicht beliebig tief: die Grenze
 * steht in limits.ts und ist dort begruendet. Vier Ebenen decken jeden
 * Verkaufsbetrieb ab, und ohne Grenze waere der rekursive Aufbau des Baums ein
 * Absturzrisiko - ausgeloest von einem Datenfehler, den niemand bemerkt hat.
 *
 * Zentrale Entscheidung dieses Moduls: **Der Aufbau des Baums wirft nie.**
 * Diese Funktion versorgt den Kassenbildschirm. Stuerzt sie ab, kann der
 * Betrieb nicht mehr kassieren - und zwar wegen eines Zyklus in den Stammdaten,
 * der den Verkauf inhaltlich gar nicht beruehrt. Also werden fehlerhafte Aeste
 * abgeschnitten und der Rest gezeichnet. Was dabei auffiel, meldet
 * `validateCategories()` getrennt - dort, wo Stammdaten gepflegt werden und wo
 * ein Hinweis auch hingehoert.
 */

import {
  ALLOWED,
  type Allowed,
  MAX_CATEGORIES,
  MAX_CATEGORY_DEPTH,
  MAX_CHILDREN_PER_CATEGORY,
  MAX_PRODUCTS,
  MAX_PRODUCTS_PER_CATEGORY,
  checkName,
  denied,
} from "./limits.ts";
import type { Category, Id, Product } from "./model.ts";

export class CatalogError extends Error {}

export interface CategoryNode {
  readonly category: Category;
  readonly children: readonly CategoryNode[];
  /** 0 fuer die oberste Ebene. */
  readonly depth: number;
  /** Artikel, die unmittelbar in dieser Gruppe liegen. */
  readonly productCount: number;
  /** Artikel in dieser Gruppe und allen Untergruppen. */
  readonly totalProductCount: number;
  /**
   * Gesetzt, wenn unter dieser Gruppe weitere Gruppen liegen, die wegen der
   * Tiefengrenze nicht mehr aufgenommen wurden. Die Oberflaeche kann darauf
   * hinweisen, statt Artikel stillschweigend zu verschlucken.
   */
  readonly truncated: boolean;
}

/**
 * Baum aus einer flachen Liste bauen. Wirft nicht.
 *
 * Gruppen, deren Elterngruppe fehlt, werden auf die oberste Ebene gehoben,
 * statt zu verschwinden: eine Warengruppe, die nach einem Fehler in der
 * Synchronisation unsichtbar wird, nimmt dem Betrieb seine Artikel. Ein
 * sichtbarer, falsch einsortierter Knoten ist deutlich harmloser.
 *
 * Gruppen jenseits der Tiefengrenze und Gruppen in einem Zyklus werden nicht
 * aufgenommen; ihr Elternknoten wird als `truncated` gekennzeichnet.
 */
export function buildCategoryTree(
  categories: readonly Category[],
  products: readonly Product[] = [],
  options: { readonly maxDepth?: number } = {},
): CategoryNode[] {
  const maxDepth = options.maxDepth ?? MAX_CATEGORY_DEPTH;
  const byId = new Map<Id, Category>();
  for (const category of categories) byId.set(category.id, category);

  const directProducts = new Map<Id, number>();
  for (const product of products) {
    if (product.isDeposit) continue; // Pfandartikel sind keine Verkaufsartikel
    directProducts.set(product.categoryId, (directProducts.get(product.categoryId) ?? 0) + 1);
  }

  const childrenOf = new Map<Id | null, Category[]>();
  for (const category of categories) {
    // Eine Gruppe, die auf sich selbst zeigt, oder eine fehlende
    // Elterngruppe: beides landet auf der obersten Ebene statt im Nichts.
    const parent =
      category.parentId != null && category.parentId !== category.id && byId.has(category.parentId)
        ? category.parentId
        : null;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(category);
    else childrenOf.set(parent, [category]);
  }
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "de"));
  }

  // Ein Zyklus tiefer im Baum wuerde die Rekursion nicht beenden. Der Pfad
  // haelt fest, welche Gruppen auf dem Weg hierher schon besucht wurden.
  const build = (category: Category, depth: number, path: ReadonlySet<Id>): CategoryNode => {
    const nextPath = new Set(path);
    nextPath.add(category.id);

    const candidates = childrenOf.get(category.id) ?? [];
    const usable = depth + 1 < maxDepth ? candidates.filter((child) => !nextPath.has(child.id)) : [];
    const children = usable.map((child) => build(child, depth + 1, nextPath));

    const own = directProducts.get(category.id) ?? 0;
    return {
      category,
      children,
      depth,
      productCount: own,
      totalProductCount: own + children.reduce((sum, child) => sum + child.totalProductCount, 0),
      truncated: candidates.length > usable.length,
    };
  };

  return (childrenOf.get(null) ?? []).map((category) => build(category, 0, new Set()));
}

/** Flache Liste des Baums in Anzeigereihenfolge, mit Tiefe. */
export function flattenCategoryTree(nodes: readonly CategoryNode[]): CategoryNode[] {
  const out: CategoryNode[] = [];
  const walk = (list: readonly CategoryNode[]): void => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Pfad von der obersten Ebene bis zur Gruppe, z. B. Getraenke > Kaffee.
 *
 * Bricht bei einem Zyklus ab, statt endlos zu laufen: der Pfad endet dann an
 * der Stelle, an der er sich wiederholt.
 */
export function categoryPath(categories: readonly Category[], categoryId: Id): Category[] {
  const byId = new Map<Id, Category>();
  for (const category of categories) byId.set(category.id, category);

  const path: Category[] = [];
  const seen = new Set<Id>();
  let current = byId.get(categoryId);
  while (current && !seen.has(current.id) && path.length < MAX_CATEGORY_DEPTH + 1) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId != null ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/** Pfad als Text, wie er in der Artikelliste steht. */
export function formatCategoryPath(categories: readonly Category[], categoryId: Id, separator = " › "): string {
  return categoryPath(categories, categoryId)
    .map((category) => category.name)
    .join(separator);
}

/** Tiefe einer Gruppe: 0 fuer die oberste Ebene. */
export function categoryDepth(categories: readonly Category[], categoryId: Id): number {
  return Math.max(0, categoryPath(categories, categoryId).length - 1);
}

/** Ids einer Gruppe und aller ihrer Untergruppen. */
export function categoryWithDescendants(categories: readonly Category[], categoryId: Id): Id[] {
  const childrenOf = new Map<Id, Id[]>();
  for (const category of categories) {
    if (category.parentId == null || category.parentId === category.id) continue;
    const bucket = childrenOf.get(category.parentId);
    if (bucket) bucket.push(category.id);
    else childrenOf.set(category.parentId, [category.id]);
  }

  const out: Id[] = [];
  const seen = new Set<Id>();
  const walk = (id: Id): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) walk(child);
  };
  walk(categoryId);
  return out;
}

/** Hoehe des Astes unter einer Gruppe: 1, wenn sie keine Untergruppen hat. */
export function subtreeHeight(categories: readonly Category[], categoryId: Id): number {
  const childrenOf = new Map<Id, Category[]>();
  for (const category of categories) {
    if (category.parentId == null || category.parentId === category.id) continue;
    const bucket = childrenOf.get(category.parentId);
    if (bucket) bucket.push(category);
    else childrenOf.set(category.parentId, [category]);
  }

  const measure = (id: Id, seen: ReadonlySet<Id>): number => {
    if (seen.has(id)) return 0;
    const next = new Set(seen);
    next.add(id);
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) return 1;
    return 1 + Math.max(...children.map((child) => measure(child.id, next)));
  };
  return measure(categoryId, new Set());
}

/**
 * Darf unter `parentId` eine neue Warengruppe angelegt werden?
 *
 * Geprueft werden die Gesamtzahl, die Zahl der Untergruppen und die Tiefe.
 * Die Meldungen sind fuer den Bediener gedacht, nicht fuer ein Protokoll -
 * sie sagen, was das Problem ist und was stattdessen geht.
 */
export function canAddCategory(categories: readonly Category[], parentId: Id | null): Allowed {
  if (categories.length >= MAX_CATEGORIES) {
    return denied(`Es sind hoechstens ${MAX_CATEGORIES} Warengruppen moeglich. Nicht genutzte Gruppen ausblenden.`);
  }
  if (parentId === null) return ALLOWED;

  const parent = categories.find((category) => category.id === parentId);
  if (!parent) return denied("Die gewaehlte uebergeordnete Warengruppe gibt es nicht.");

  const depth = categoryDepth(categories, parentId);
  if (depth + 1 >= MAX_CATEGORY_DEPTH) {
    return denied(
      `Tiefer als ${MAX_CATEGORY_DEPTH} Ebenen geht es nicht. Was hier noch unterschieden werden soll, gehoert als Zusatz an den Artikel.`,
    );
  }

  const siblings = categories.filter((category) => category.parentId === parentId).length;
  if (siblings >= MAX_CHILDREN_PER_CATEGORY) {
    return denied(`"${parent.name}" hat bereits ${MAX_CHILDREN_PER_CATEGORY} Untergruppen - mehr werden unuebersichtlich.`);
  }
  return ALLOWED;
}

/**
 * Darf `categoryId` unter `newParentId` gehaengt werden?
 *
 * Verhindert Zyklen (eine Gruppe unter sich selbst oder unter eine ihrer
 * Untergruppen) und das Ueberschreiten der Tiefengrenze durch einen ganzen
 * Ast: verschiebt man einen drei Ebenen hohen Ast unter eine Gruppe der
 * zweiten Ebene, waere das Ergebnis fuenf Ebenen tief.
 */
export function canReparent(categories: readonly Category[], categoryId: Id, newParentId: Id | null): Allowed {
  if (newParentId === categoryId) {
    return denied("Eine Warengruppe kann nicht ihre eigene Untergruppe sein.");
  }
  const height = subtreeHeight(categories, categoryId);

  if (newParentId === null) {
    return height > MAX_CATEGORY_DEPTH
      ? denied(`Dieser Ast ist ${height} Ebenen hoch und passt nicht in ${MAX_CATEGORY_DEPTH} Ebenen.`)
      : ALLOWED;
  }

  if (!categories.some((category) => category.id === newParentId)) {
    return denied("Die gewaehlte uebergeordnete Warengruppe gibt es nicht.");
  }
  if (categoryWithDescendants(categories, categoryId).includes(newParentId)) {
    return denied("Eine Warengruppe kann nicht unter eine ihrer eigenen Untergruppen wandern.");
  }

  const parentDepth = categoryDepth(categories, newParentId);
  if (parentDepth + 1 + height > MAX_CATEGORY_DEPTH) {
    return denied(
      `Der Ast ist ${height} Ebenen hoch und wuerde hier auf Ebene ${parentDepth + 2} beginnen - erlaubt sind ${MAX_CATEGORY_DEPTH} Ebenen.`,
    );
  }

  const siblings = categories.filter((category) => category.parentId === newParentId && category.id !== categoryId).length;
  if (siblings >= MAX_CHILDREN_PER_CATEGORY) {
    return denied(`Diese Warengruppe hat bereits ${MAX_CHILDREN_PER_CATEGORY} Untergruppen.`);
  }
  return ALLOWED;
}

/** Darf ein Artikel in dieser Warengruppe angelegt werden? */
export function canAddProduct(products: readonly Product[], categoryId: Id): Allowed {
  const sellable = products.filter((product) => !product.isDeposit);
  if (sellable.length >= MAX_PRODUCTS) {
    return denied(
      `Es sind hoechstens ${MAX_PRODUCTS} Artikel moeglich. Nicht mehr verkaufte Artikel ausblenden - sie bleiben auf alten Belegen lesbar.`,
    );
  }
  const inCategory = sellable.filter((product) => product.categoryId === categoryId).length;
  if (inCategory >= MAX_PRODUCTS_PER_CATEGORY) {
    return denied(
      `In dieser Warengruppe sind ${MAX_PRODUCTS_PER_CATEGORY} Artikel - mehr findet am Kassenstand niemand. Untergruppen anlegen.`,
    );
  }
  return ALLOWED;
}

/** Befund an den Stammdaten, fuer die Artikelverwaltung. */
export interface CatalogIssue {
  readonly kind: "CYCLE" | "MISSING_PARENT" | "TOO_DEEP" | "TOO_MANY" | "EMPTY_NAME" | "SELF_PARENT";
  readonly categoryId?: Id;
  readonly message: string;
}

/**
 * Stammdaten pruefen.
 *
 * Getrennt vom Aufbau des Baums: der Kassenbildschirm soll nicht mit Meldungen
 * behaengt werden, aber in der Artikelverwaltung muss sichtbar sein, dass etwas
 * nicht stimmt. Sonst bleibt ein abgeschnittener Ast fuer immer unentdeckt.
 */
export function validateCategories(categories: readonly Category[]): CatalogIssue[] {
  const issues: CatalogIssue[] = [];
  const byId = new Map<Id, Category>();
  for (const category of categories) byId.set(category.id, category);

  if (categories.length > MAX_CATEGORIES) {
    issues.push({
      kind: "TOO_MANY",
      message: `${categories.length} Warengruppen - erlaubt sind ${MAX_CATEGORIES}.`,
    });
  }

  for (const category of categories) {
    if (checkName(category.name).ok === false) {
      issues.push({ kind: "EMPTY_NAME", categoryId: category.id, message: `Eine Warengruppe hat keinen brauchbaren Namen.` });
    }
    if (category.parentId === category.id) {
      issues.push({
        kind: "SELF_PARENT",
        categoryId: category.id,
        message: `"${category.name}" zeigt auf sich selbst und wurde auf die oberste Ebene gehoben.`,
      });
      continue;
    }
    if (category.parentId != null && !byId.has(category.parentId)) {
      issues.push({
        kind: "MISSING_PARENT",
        categoryId: category.id,
        message: `Die uebergeordnete Warengruppe von "${category.name}" fehlt - sie steht jetzt auf der obersten Ebene.`,
      });
      continue;
    }

    // Zyklus und Tiefe am Pfad nach oben pruefen.
    const seen = new Set<Id>([category.id]);
    let depth = 0;
    let current = category.parentId != null ? byId.get(category.parentId) : undefined;
    while (current) {
      if (seen.has(current.id)) {
        issues.push({
          kind: "CYCLE",
          categoryId: category.id,
          message: `"${category.name}" liegt in einem Ring von Warengruppen und wird am Kassenbildschirm nicht angezeigt.`,
        });
        break;
      }
      seen.add(current.id);
      depth++;
      if (depth >= MAX_CATEGORY_DEPTH) {
        issues.push({
          kind: "TOO_DEEP",
          categoryId: category.id,
          message: `"${category.name}" liegt tiefer als ${MAX_CATEGORY_DEPTH} Ebenen und wird am Kassenbildschirm nicht angezeigt.`,
        });
        break;
      }
      current = current.parentId != null ? byId.get(current.parentId) : undefined;
    }
  }
  return issues;
}

/** Artikel einer Gruppe, wahlweise samt Untergruppen. */
export function productsInCategory(
  products: readonly Product[],
  categories: readonly Category[],
  categoryId: Id,
  options: { readonly includeSubcategories?: boolean } = {},
): Product[] {
  const ids = options.includeSubcategories
    ? new Set(categoryWithDescendants(categories, categoryId))
    : new Set([categoryId]);
  return products
    .filter((product) => !product.isDeposit && ids.has(product.categoryId))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "de"));
}
