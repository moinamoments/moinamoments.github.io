/**
 * Warengruppenbaum.
 *
 * Warengruppen sind beliebig tief verschachtelbar. Der Grund ist nicht
 * Vollstaendigkeit, sondern Bedienbarkeit: ein Kassenbildschirm mit 200
 * Artikeln in einer flachen Liste ist am Verkaufsstand unbenutzbar, und eine
 * fest auf zwei Ebenen begrenzte Struktur zwingt jeden Betrieb, der eine
 * dritte braucht, zu Behelfsnamen wie "Kaffee - Milch - Hafer".
 *
 * Die Gefahr eines Baums in einer Datenbank ohne Fremdschluesselpruefung auf
 * sich selbst sind Zyklen und verwaiste Knoten. Beides wird hier erkannt und
 * gemeldet, statt die Oberflaeche in eine Endlosschleife laufen zu lassen.
 */

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
}

/**
 * Baum aus einer flachen Liste bauen.
 *
 * Gruppen, deren Elterngruppe fehlt oder nicht aktiv ist, werden auf die
 * oberste Ebene gehoben, statt zu verschwinden. Eine Warengruppe, die nach
 * einem Fehler in der Synchronisation unsichtbar wird, nimmt dem Betrieb
 * seine Artikel - ein sichtbarer, falsch einsortierter Knoten ist deutlich
 * harmloser.
 */
export function buildCategoryTree(
  categories: readonly Category[],
  products: readonly Product[] = [],
): CategoryNode[] {
  const byId = new Map<Id, Category>();
  for (const category of categories) byId.set(category.id, category);

  const directProducts = new Map<Id, number>();
  for (const product of products) {
    if (product.isDeposit) continue; // Pfandartikel sind keine Verkaufsartikel
    directProducts.set(product.categoryId, (directProducts.get(product.categoryId) ?? 0) + 1);
  }

  const childrenOf = new Map<Id | null, Category[]>();
  for (const category of categories) {
    const parent = category.parentId != null && byId.has(category.parentId) ? category.parentId : null;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(category);
    else childrenOf.set(parent, [category]);
  }
  for (const bucket of childrenOf.values()) {
    bucket.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "de"));
  }

  const visiting = new Set<Id>();
  const build = (category: Category, depth: number): CategoryNode => {
    if (visiting.has(category.id)) {
      throw new CatalogError(`Warengruppe "${category.name}" ist ihr eigener Vorfahr - der Baum hat einen Zyklus`);
    }
    visiting.add(category.id);
    const children = (childrenOf.get(category.id) ?? []).map((child) => build(child, depth + 1));
    visiting.delete(category.id);

    const own = directProducts.get(category.id) ?? 0;
    return {
      category,
      children,
      depth,
      productCount: own,
      totalProductCount: own + children.reduce((sum, child) => sum + child.totalProductCount, 0),
    };
  };

  return (childrenOf.get(null) ?? []).map((category) => build(category, 0));
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

/** Pfad von der obersten Ebene bis zur Gruppe, z. B. Getraenke > Kaffee. */
export function categoryPath(categories: readonly Category[], categoryId: Id): Category[] {
  const byId = new Map<Id, Category>();
  for (const category of categories) byId.set(category.id, category);

  const path: Category[] = [];
  const seen = new Set<Id>();
  let current = byId.get(categoryId);
  while (current) {
    if (seen.has(current.id)) {
      throw new CatalogError(`Warengruppe "${current.name}" liegt in einem Zyklus`);
    }
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

/** Ids einer Gruppe und aller ihrer Untergruppen. */
export function categoryWithDescendants(categories: readonly Category[], categoryId: Id): Id[] {
  const childrenOf = new Map<Id, Id[]>();
  for (const category of categories) {
    if (category.parentId == null) continue;
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

/**
 * Darf `categoryId` unter `newParentId` gehaengt werden?
 *
 * Verhindert, dass eine Gruppe unter sich selbst oder unter eine ihrer
 * Untergruppen wandert. Ohne diese Pruefung waere ein Zyklus nur ein
 * Fingerwisch entfernt, und danach zeigt der Kassenbildschirm nichts mehr an.
 */
export function canReparent(
  categories: readonly Category[],
  categoryId: Id,
  newParentId: Id | null,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (newParentId === null) return { ok: true };
  if (newParentId === categoryId) {
    return { ok: false, reason: "Eine Warengruppe kann nicht ihre eigene Untergruppe sein." };
  }
  if (!categories.some((category) => category.id === newParentId)) {
    return { ok: false, reason: "Die gewaehlte uebergeordnete Warengruppe gibt es nicht." };
  }
  if (categoryWithDescendants(categories, categoryId).includes(newParentId)) {
    return { ok: false, reason: "Eine Warengruppe kann nicht unter eine ihrer eigenen Untergruppen wandern." };
  }
  return { ok: true };
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
