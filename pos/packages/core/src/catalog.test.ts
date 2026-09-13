import { test } from "node:test";
import assert from "node:assert/strict";
import type { Category, Product } from "./model.ts";
import {
  MAX_CATEGORIES,
  MAX_CATEGORY_DEPTH,
  MAX_CHILDREN_PER_CATEGORY,
  MAX_PRODUCTS,
  MAX_PRODUCTS_PER_CATEGORY,
  checkName,
} from "./limits.ts";
import {
  buildCategoryTree,
  canAddCategory,
  canAddProduct,
  canReparent,
  categoryDepth,
  categoryPath,
  categoryWithDescendants,
  flattenCategoryTree,
  formatCategoryPath,
  productsInCategory,
  subtreeHeight,
  validateCategories,
} from "./catalog.ts";

const TENANT = "t1";

function cat(id: string, name: string, parentId: string | null = null, sortOrder = 0): Category {
  return { id, tenantId: TENANT, name, parentId, color: null, sortOrder, active: true };
}

function prod(id: string, categoryId: string, over: Partial<Product> = {}): Product {
  return {
    id, tenantId: TENANT, categoryId, name: id, price: 100, taxKey: 1, unit: "PIECE",
    sortOrder: 0, active: true, updatedAt: "2026-09-01T00:00:00+02:00", ...over,
  };
}

/** Getraenke > Heissgetraenke > Kaffee, dazu Speisen. */
const tree: Category[] = [
  cat("getraenke", "Getraenke", null, 1),
  cat("heiss", "Heissgetraenke", "getraenke", 1),
  cat("kaffee", "Kaffee", "heiss", 1),
  cat("kalt", "Kaltgetraenke", "getraenke", 2),
  cat("speisen", "Speisen", null, 2),
];

test("Baum entsteht in Sortierreihenfolge mit richtiger Tiefe", () => {
  const roots = buildCategoryTree(tree);
  assert.deepEqual(roots.map((node) => node.category.id), ["getraenke", "speisen"]);
  assert.deepEqual(roots[0]?.children.map((node) => node.category.id), ["heiss", "kalt"]);
  assert.equal(roots[0]?.depth, 0);
  assert.equal(roots[0]?.children[0]?.depth, 1);
  assert.equal(roots[0]?.children[0]?.children[0]?.category.id, "kaffee");
  assert.equal(roots[0]?.children[0]?.children[0]?.depth, 2);
});

test("Artikel werden je Gruppe und aufsummiert gezaehlt", () => {
  const products = [
    prod("p1", "kaffee"), prod("p2", "kaffee"), prod("p3", "kalt"),
    prod("p4", "getraenke"),
    // Pfandartikel zaehlen nicht als Verkaufsartikel.
    prod("pfand", "getraenke", { isDeposit: true }),
  ];
  const roots = buildCategoryTree(tree, products);
  const getraenke = roots[0]!;
  assert.equal(getraenke.productCount, 1, "nur der direkt einsortierte Artikel");
  assert.equal(getraenke.totalProductCount, 4, "mit Untergruppen, ohne Pfand");
  assert.equal(getraenke.children[0]?.children[0]?.productCount, 2);
});

test("flattenCategoryTree liefert die Anzeigereihenfolge", () => {
  assert.deepEqual(
    flattenCategoryTree(buildCategoryTree(tree)).map((node) => `${" ".repeat(node.depth)}${node.category.id}`),
    ["getraenke", " heiss", "  kaffee", " kalt", "speisen"],
  );
});

test("Pfad und Tiefe einer Gruppe", () => {
  assert.deepEqual(categoryPath(tree, "kaffee").map((c) => c.id), ["getraenke", "heiss", "kaffee"]);
  assert.equal(formatCategoryPath(tree, "kaffee"), "Getraenke › Heissgetraenke › Kaffee");
  assert.equal(categoryDepth(tree, "getraenke"), 0);
  assert.equal(categoryDepth(tree, "kaffee"), 2);
  assert.deepEqual(categoryPath(tree, "gibtsnicht"), []);
});

test("Nachkommen und Asthoehe", () => {
  assert.deepEqual(categoryWithDescendants(tree, "getraenke").sort(), ["getraenke", "heiss", "kaffee", "kalt"]);
  assert.deepEqual(categoryWithDescendants(tree, "kaffee"), ["kaffee"]);
  assert.equal(subtreeHeight(tree, "getraenke"), 3);
  assert.equal(subtreeHeight(tree, "heiss"), 2);
  assert.equal(subtreeHeight(tree, "kaffee"), 1);
});

test("fehlende Elterngruppe hebt die Gruppe nach oben, statt sie zu verstecken", () => {
  // Genau der Fall, der bei einem Fehler in der Synchronisation entsteht.
  const broken = [cat("a", "Alleinstehend", "gibtsnicht"), cat("b", "Normal")];
  const roots = buildCategoryTree(broken, [prod("p1", "a")]);
  assert.deepEqual(roots.map((node) => node.category.id).sort(), ["a", "b"]);
  assert.equal(roots.find((node) => node.category.id === "a")?.productCount, 1, "der Artikel bleibt erreichbar");
});

test("Ring von Warengruppen laesst den Baum nicht abstuerzen", () => {
  // a -> b -> a. Ohne Schutz laeuft der Aufbau endlos.
  const cyclic = [cat("a", "A", "b"), cat("b", "B", "a"), cat("c", "C")];
  let roots: ReturnType<typeof buildCategoryTree> = [];
  assert.doesNotThrow(() => {
    roots = buildCategoryTree(cyclic);
  });
  // "c" bleibt in jedem Fall sichtbar - der Verkauf laeuft weiter.
  assert.ok(roots.some((node) => node.category.id === "c"));
  assert.ok(flattenCategoryTree(roots).length <= cyclic.length + 1);
});

test("Gruppe, die auf sich selbst zeigt, landet oben", () => {
  const roots = buildCategoryTree([cat("a", "A", "a")]);
  assert.deepEqual(roots.map((n) => n.category.id), ["a"]);
  assert.equal(categoryPath([cat("a", "A", "a")], "a").length, 1);
});

test("zu tiefe Gruppen werden abgeschnitten und der Elternknoten gekennzeichnet", () => {
  const deep: Category[] = [];
  for (let level = 0; level < 8; level++) {
    deep.push(cat(`c${level}`, `Ebene ${level}`, level === 0 ? null : `c${level - 1}`));
  }
  const flat = flattenCategoryTree(buildCategoryTree(deep));
  assert.equal(flat.length, MAX_CATEGORY_DEPTH, `nur ${MAX_CATEGORY_DEPTH} Ebenen`);
  assert.equal(flat[flat.length - 1]?.truncated, true, "der letzte Knoten meldet den abgeschnittenen Ast");
  assert.equal(flat[0]?.truncated, false);
});

test("canAddCategory begrenzt Tiefe, Untergruppen und Gesamtzahl", () => {
  assert.equal(canAddCategory(tree, null).ok, true);
  assert.equal(canAddCategory(tree, "getraenke").ok, true);
  // "kaffee" liegt auf Ebene 3 von 4 (Tiefe 2). Eine Untergruppe darunter ist
  // die vierte Ebene und damit noch erlaubt.
  assert.equal(categoryDepth(tree, "kaffee"), 2);
  assert.equal(canAddCategory(tree, "kaffee").ok, true);

  // Erst unter der vierten Ebene ist Schluss.
  const withSirup = [...tree, cat("sirup", "Sirup", "kaffee")];
  assert.equal(categoryDepth(withSirup, "sirup"), 3);
  const tooDeep = canAddCategory(withSirup, "sirup");
  assert.equal(tooDeep.ok, false);
  assert.ok(tooDeep.ok === false && tooDeep.reason.includes(String(MAX_CATEGORY_DEPTH)));

  assert.equal(canAddCategory(tree, "gibtsnicht").ok, false);

  const many = Array.from({ length: MAX_CATEGORIES }, (_, i) => cat(`c${i}`, `C${i}`));
  assert.equal(canAddCategory(many, null).ok, false);

  const wide = [cat("p", "Eltern"), ...Array.from({ length: MAX_CHILDREN_PER_CATEGORY }, (_, i) => cat(`k${i}`, `K${i}`, "p"))];
  assert.equal(canAddCategory(wide, "p").ok, false);
});

test("canReparent verhindert Ringe und zu tiefe Aeste", () => {
  assert.equal(canReparent(tree, "kalt", "heiss").ok, true);
  assert.equal(canReparent(tree, "getraenke", "getraenke").ok, false);
  assert.equal(canReparent(tree, "getraenke", "kaffee").ok, false, "nicht unter die eigene Untergruppe");
  assert.equal(canReparent(tree, "getraenke", null).ok, true);
  assert.equal(canReparent(tree, "kalt", "gibtsnicht").ok, false);

  // Der Ast unter "getraenke" ist drei Ebenen hoch; unter "speisen" (Tiefe 0)
  // begaenne er auf Tiefe 1 und waere damit vier Ebenen tief - das passt.
  assert.equal(subtreeHeight(tree, "getraenke"), 3);
  assert.equal(canReparent(tree, "getraenke", "speisen").ok, true);

  // Unter einer Gruppe der zweiten Ebene waere derselbe Ast fuenf Ebenen tief.
  // "kalt" gehoert zum Ast selbst, deshalb eine Gruppe aus dem anderen Zweig.
  const withBeilagen = [...tree, cat("beilagen", "Beilagen", "speisen")];
  assert.equal(categoryDepth(withBeilagen, "beilagen"), 1);
  const deepMove = canReparent(withBeilagen, "getraenke", "beilagen");
  assert.equal(deepMove.ok, false);
  assert.ok(deepMove.ok === false && deepMove.reason.includes("Ebenen"), deepMove.ok === false ? deepMove.reason : "");

  // Ein Ring bleibt ein Ring, auch wenn die Tiefe passen wuerde.
  const intoOwnChild = canReparent(tree, "getraenke", "kalt");
  assert.equal(intoOwnChild.ok, false);
  assert.ok(intoOwnChild.ok === false && intoOwnChild.reason.includes("Untergruppen"));
});

test("canAddProduct begrenzt je Gruppe und insgesamt", () => {
  assert.equal(canAddProduct([], "kaffee").ok, true);

  const full = Array.from({ length: MAX_PRODUCTS_PER_CATEGORY }, (_, i) => prod(`p${i}`, "kaffee"));
  const perCategory = canAddProduct(full, "kaffee");
  assert.equal(perCategory.ok, false);
  assert.ok(perCategory.ok === false && perCategory.reason.includes("Untergruppen"));
  assert.equal(canAddProduct(full, "kalt").ok, true, "andere Gruppe ist frei");

  const all = Array.from({ length: MAX_PRODUCTS }, (_, i) => prod(`p${i}`, `c${i % 50}`));
  assert.equal(canAddProduct(all, "neu").ok, false);

  // Pfandartikel zaehlen nicht gegen die Artikelgrenze.
  const withDeposits = [...all.slice(0, MAX_PRODUCTS - 1), prod("d1", "pfand", { isDeposit: true })];
  assert.equal(canAddProduct(withDeposits, "neu").ok, true);
});

test("validateCategories meldet genau die Befunde, die der Baum verschweigt", () => {
  assert.deepEqual(validateCategories(tree), []);

  const selfParent = validateCategories([cat("a", "A", "a")]);
  assert.deepEqual(selfParent.map((i) => i.kind), ["SELF_PARENT"]);

  const missing = validateCategories([cat("a", "A", "fehlt")]);
  assert.deepEqual(missing.map((i) => i.kind), ["MISSING_PARENT"]);

  const cyclic = validateCategories([cat("a", "A", "b"), cat("b", "B", "a")]);
  assert.deepEqual(cyclic.map((i) => i.kind), ["CYCLE", "CYCLE"]);

  const deep: Category[] = [];
  for (let level = 0; level < 6; level++) {
    deep.push(cat(`c${level}`, `Ebene ${level}`, level === 0 ? null : `c${level - 1}`));
  }
  assert.ok(validateCategories(deep).some((i) => i.kind === "TOO_DEEP"));

  const nameless = validateCategories([cat("a", "   ")]);
  assert.ok(nameless.some((i) => i.kind === "EMPTY_NAME"));
});

test("productsInCategory wahlweise mit Untergruppen", () => {
  const products = [prod("p1", "kaffee"), prod("p2", "kalt"), prod("p3", "getraenke"), prod("d", "getraenke", { isDeposit: true })];
  assert.deepEqual(productsInCategory(products, tree, "getraenke").map((p) => p.id), ["p3"]);
  assert.deepEqual(
    productsInCategory(products, tree, "getraenke", { includeSubcategories: true }).map((p) => p.id).sort(),
    ["p1", "p2", "p3"],
  );
});

test("checkName weist Leeres und Ueberlanges ab", () => {
  assert.equal(checkName("Kaffee").ok, true);
  assert.equal(checkName("   ").ok, false);
  assert.equal(checkName("x".repeat(200)).ok, false);
});
