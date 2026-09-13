/**
 * Artikelverwaltung.
 *
 * Der Betrieb pflegt Warengruppen, Artikel, Pfand und Bestand selbst am
 * Geraet - kein Zugang zu einem Rechner noetig. Am Marktstand aendert sich ein
 * Preis manchmal am gleichen Tag.
 *
 * Drei Dinge, die ein Kassensystem hier richtig machen muss:
 *
 *   1. **Kein Loeschen.** Alte Belege verweisen auf den Artikel; wird er
 *      entfernt, ist der Beleg nicht mehr nachvollziehbar. Artikel und
 *      Warengruppen werden ausgeblendet, nicht geloescht.
 *   2. **Preisaenderung ohne Rueckwirkung.** Der Beleg speichert Name und
 *      Preis als Kopie. Eine Preisrunde heute aendert keinen Beleg von
 *      gestern.
 *   3. **Grenzen erklaeren, nicht nur durchsetzen.** Wer an eine Obergrenze
 *      laeuft, bekommt gesagt, warum es sie gibt und was stattdessen geht.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Image, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import {
  type Category,
  type CategoryNode,
  type ImageCandidate,
  type Product,
  type ProductImage,
  MAX_CATEGORY_DEPTH,
  MAX_DEPOSITS_PER_PRODUCT,
  ONE,
  STANDARD_TAX_RATES,
  TAX_RATES,
  buildCategoryTree,
  canAddCategory,
  canAddProduct,
  flattenCategoryTree,
  formatAttribution,
  formatCategoryPath,
  formatEuro,
  formatStock,
  isoWithOffset,
  openverseSource,
  parseAmount,
  stockState,
  toProductImage,
  validateCategories,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { countProductsInCategory, deactivateCategory, deactivateProduct, saveCategory, saveProduct } from "../src/db/repositories.ts";
import { Button, Card, Field, Label, Muted, Notice, Screen, Segmented, Title } from "../src/components/ui.tsx";
import { colors, font, radius, space } from "../src/theme.ts";

// --- Formularzustand ------------------------------------------------------

type Draft = {
  id: string | null;
  name: string;
  categoryId: string;
  price: string;
  openPrice: boolean;
  taxKey: number;
  differentDineIn: boolean;
  taxKeyDineIn: number;
  unit: Product["unit"];
  isDeposit: boolean;
  depositProductIds: string[];
  trackStock: boolean;
  lowStockThreshold: string;
  image: ProductImage | null;
};

function newDraft(categoryId: string): Draft {
  return {
    id: null,
    name: "",
    categoryId,
    price: "",
    openPrice: false,
    taxKey: TAX_RATES.NORMAL.key,
    differentDineIn: false,
    taxKeyDineIn: TAX_RATES.NORMAL.key,
    unit: "PIECE",
    isDeposit: false,
    depositProductIds: [],
    trackStock: false,
    lowStockThreshold: "",
    image: null,
  };
}

function toDraft(product: Product): Draft {
  return {
    id: product.id,
    name: product.name,
    categoryId: product.categoryId,
    price: product.price == null ? "" : (product.price / 100).toFixed(2).replace(".", ","),
    openPrice: product.price == null,
    taxKey: product.taxKey,
    differentDineIn: product.taxKeyDineIn != null,
    taxKeyDineIn: product.taxKeyDineIn ?? TAX_RATES.NORMAL.key,
    unit: product.unit,
    isDeposit: product.isDeposit === true,
    depositProductIds: [...(product.depositProductIds ?? [])],
    trackStock: product.trackStock === true,
    lowStockThreshold: product.lowStockThreshold == null ? "" : String(product.lowStockThreshold / ONE),
    image: product.image ?? null,
  };
}

// --- Bildschirm -----------------------------------------------------------

export default function ArtikelScreen() {
  const kasse = useKasse();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [categoryDraft, setCategoryDraft] = useState<{ name: string; parentId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageSearchFor, setImageSearchFor] = useState<string | null>(null);

  const depositProducts = useMemo(() => kasse.products.filter((product) => product.isDeposit), [kasse.products]);
  const sellable = useMemo(() => kasse.products.filter((product) => !product.isDeposit), [kasse.products]);

  const tree = useMemo(() => buildCategoryTree(kasse.categories, sellable), [kasse.categories, sellable]);
  const flat = useMemo(() => flattenCategoryTree(tree), [tree]);
  const issues = useMemo(() => validateCategories(kasse.categories), [kasse.categories]);

  const byCategory = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const product of kasse.products) {
      const list = map.get(product.categoryId);
      if (list) list.push(product);
      else map.set(product.categoryId, [product]);
    }
    return map;
  }, [kasse.products]);

  const save = async () => {
    if (!draft || !kasse.tenant) return;
    setError(null);

    const name = draft.name.trim();
    if (name === "") return setError("Der Artikel braucht einen Namen.");

    const price = draft.openPrice ? null : parseAmount(draft.price);
    if (!draft.openPrice && (price == null || price < 0)) {
      return setError("Der Preis ist nicht lesbar. Beispiel: 4,50");
    }
    if (draft.isDeposit && (price == null || price <= 0)) {
      return setError("Ein Pfandartikel braucht einen festen Betrag groesser als null.");
    }
    if (draft.depositProductIds.length > MAX_DEPOSITS_PER_PRODUCT) {
      return setError(`Hoechstens ${MAX_DEPOSITS_PER_PRODUCT} Pfandartikel je Artikel - mehr wird der Bon unleserlich.`);
    }

    // Die Grenze gilt nur fuer neue Artikel: einen bestehenden zu speichern
    // darf nicht daran scheitern, dass der Stamm voll ist.
    if (draft.id === null && !draft.isDeposit) {
      const allowed = canAddProduct(kasse.products, draft.categoryId);
      if (!allowed.ok) return setError(allowed.reason);
    }

    const threshold = draft.lowStockThreshold.trim();
    const thresholdUnits = threshold === "" ? null : Number(threshold.replace(",", "."));
    if (thresholdUnits != null && (!Number.isFinite(thresholdUnits) || thresholdUnits < 0)) {
      return setError("Der Mindestbestand ist keine Zahl.");
    }

    const existing = draft.id ? kasse.products.find((p) => p.id === draft.id) : null;
    const product: Product = {
      id: draft.id ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId: kasse.tenant.id,
      categoryId: draft.categoryId,
      name,
      description: null,
      price,
      taxKey: draft.taxKey,
      taxKeyDineIn: draft.differentDineIn ? draft.taxKeyDineIn : null,
      sku: null,
      unit: draft.unit,
      // Ein Pfandartikel bringt selbst kein Pfand mit - das lehnt der Kern ab.
      depositProductIds: draft.isDeposit ? null : draft.depositProductIds,
      isDeposit: draft.isDeposit,
      color: null,
      image: draft.image,
      // Pfandartikel fuehren keinen Bestand: Becher sind Gebinde, kein Umsatz.
      trackStock: draft.isDeposit ? false : draft.trackStock,
      // Der Bestand selbst wird hier nicht angefasst - er aendert sich nur
      // ueber Bestandsbewegungen (Bildschirm "Bestand").
      stock: existing?.stock ?? 0,
      lowStockThreshold: thresholdUnits == null ? null : Math.round(thresholdUnits * ONE),
      sortOrder: existing?.sortOrder ?? 0,
      active: true,
      updatedAt: isoWithOffset(new Date(), kasse.tenant.timeZone),
    };

    try {
      await saveProduct(kasse.db(), product);
      await kasse.reload();
      setDraft(null);
    } catch (issue) {
      setError((issue as Error).message);
    }
  };

  const archive = (product: Product) => {
    Alert.alert(
      "Artikel ausblenden",
      `"${product.name}" wird nicht mehr angeboten. Alte Belege bleiben unveraendert lesbar.`,
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Ausblenden",
          onPress: () => {
            void (async () => {
              await deactivateProduct(kasse.db(), product.id);
              await kasse.reload();
            })();
          },
        },
      ],
    );
  };

  const addCategory = async () => {
    if (!categoryDraft || !kasse.tenant) return;
    const name = categoryDraft.name.trim();
    if (name === "") return setError("Die Warengruppe braucht einen Namen.");

    const allowed = canAddCategory(kasse.categories, categoryDraft.parentId);
    if (!allowed.ok) return setError(allowed.reason);

    const siblings = kasse.categories.filter((c) => (c.parentId ?? null) === categoryDraft.parentId);
    const category: Category = {
      id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      tenantId: kasse.tenant.id,
      parentId: categoryDraft.parentId,
      name,
      color: null,
      sortOrder: siblings.length + 1,
      active: true,
    };
    await saveCategory(kasse.db(), category);
    await kasse.reload();
    setCategoryDraft(null);
    setError(null);
  };

  const archiveCategory = async (node: CategoryNode) => {
    const count = await countProductsInCategory(kasse.db(), node.category.id);
    if (count > 0) {
      Alert.alert(
        "Warengruppe nicht leer",
        `In "${node.category.name}" liegen noch ${count} Artikel. Sie muessen zuerst in eine andere Gruppe umsortiert oder ausgeblendet werden - sonst waeren sie am Kassenbildschirm nicht mehr erreichbar.`,
      );
      return;
    }
    Alert.alert(
      "Warengruppe ausblenden",
      node.children.length > 0
        ? `"${node.category.name}" wird ausgeblendet. Die ${node.children.length} Untergruppen wandern eine Ebene nach oben.`
        : `"${node.category.name}" wird ausgeblendet.`,
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Ausblenden",
          onPress: () => {
            void (async () => {
              await deactivateCategory(kasse.db(), node.category.id);
              await kasse.reload();
            })();
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Artikel und Warengruppen</Title>
        {error ? <Notice tone="danger">{error}</Notice> : null}

        {issues.length > 0 ? (
          <Card style={styles.card}>
            <Label>Befunde an den Warengruppen</Label>
            <Muted>
              Diese Gruppen sind am Kassenbildschirm nicht oder nicht an der erwarteten Stelle zu
              sehen. Der Verkauf laeuft weiter - der Baum wird notfalls abgeschnitten statt
              abzustuerzen.
            </Muted>
            {issues.map((issue) => (
              <Text key={`${issue.kind}-${issue.categoryId ?? ""}`} style={styles.issue}>
                {issue.message}
              </Text>
            ))}
          </Card>
        ) : null}

        <View style={styles.headActions}>
          <Button
            label="Neuer Artikel"
            onPress={() => setDraft(newDraft(kasse.categories[0]?.id ?? ""))}
            tone="accent"
            style={styles.flex}
            disabled={kasse.categories.length === 0}
          />
          <Button label="Neue Warengruppe" onPress={() => setCategoryDraft({ name: "", parentId: null })} style={styles.flex} />
        </View>

        {kasse.categories.length === 0 ? <Notice tone="warning">Zuerst eine Warengruppe anlegen.</Notice> : null}

        {flat.map((node) => (
          <View key={node.category.id} style={[styles.group, { marginLeft: node.depth * space.lg }]}>
            <View style={styles.groupHead}>
              <View style={styles.flex}>
                <Label>{node.category.name}</Label>
                <Muted>
                  {node.productCount} Artikel
                  {node.children.length > 0 ? ` · ${node.children.length} Untergruppen` : ""}
                  {node.truncated ? " · tiefere Gruppen nicht angezeigt" : ""}
                </Muted>
              </View>
              {node.depth + 1 < MAX_CATEGORY_DEPTH ? (
                <Button
                  label="+ Untergruppe"
                  onPress={() => setCategoryDraft({ name: "", parentId: node.category.id })}
                  style={styles.smallButton}
                />
              ) : null}
              <Button label="Ausblenden" onPress={() => void archiveCategory(node)} style={styles.smallButton} />
            </View>

            {(byCategory.get(node.category.id) ?? []).map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                categories={kasse.categories}
                depositNames={(product.depositProductIds ?? []).map(
                  (id) => kasse.products.find((p) => p.id === id)?.name ?? id,
                )}
                onEdit={() => setDraft(toDraft(product))}
                onArchive={() => archive(product)}
              />
            ))}
          </View>
        ))}

        {/* Pfandartikel liegen ausserhalb des Verkaufsbaums. */}
        {depositProducts.length > 0 ? (
          <View style={styles.group}>
            <Label>Pfandartikel</Label>
            <Muted>Werden nicht als Kachel angeboten, sondern ueber den Artikel gebucht, an dem sie haengen.</Muted>
            {depositProducts.map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                categories={kasse.categories}
                depositNames={[]}
                onEdit={() => setDraft(toDraft(product))}
                onArchive={() => archive(product)}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>

      <CategoryDialog
        draft={categoryDraft}
        categories={kasse.categories}
        onChange={setCategoryDraft}
        onCancel={() => {
          setCategoryDraft(null);
          setError(null);
        }}
        onSave={() => void addCategory()}
      />

      <ProductDialog
        draft={draft}
        categories={kasse.categories}
        depositProducts={depositProducts}
        error={error}
        onChange={setDraft}
        onCancel={() => {
          setDraft(null);
          setError(null);
        }}
        onSave={() => void save()}
        onSearchImage={() => setImageSearchFor(draft?.name.trim() || "")}
      />

      <ImageSearchDialog
        query={imageSearchFor}
        onClose={() => setImageSearchFor(null)}
        onPick={(image) => {
          setDraft((current) => (current ? { ...current, image } : current));
          setImageSearchFor(null);
        }}
      />
    </Screen>
  );
}

// --- Zeile in der Liste ---------------------------------------------------

function ProductRow({
  product,
  categories,
  depositNames,
  onEdit,
  onArchive,
}: {
  product: Product;
  categories: readonly Category[];
  depositNames: readonly string[];
  onEdit: () => void;
  onArchive: () => void;
}) {
  const state = stockState(product);
  const stockText = formatStock(product);

  return (
    <Card style={styles.row}>
      <Pressable accessibilityRole="button" onPress={onEdit} style={styles.rowMain}>
        {product.image ? <Image source={{ uri: product.image.url }} style={styles.thumb} resizeMode="cover" /> : null}
        <View style={styles.flex}>
          <Text style={styles.name}>{product.name}</Text>
          <Muted>
            {product.price == null ? "offener Preis" : formatEuro(product.price)}
            {product.unit === "KILOGRAM" ? " / kg" : product.unit === "LITRE" ? " / l" : ""}
            {" · "}
            {taxLabel(product.taxKey)}
            {product.taxKeyDineIn != null ? ` / vor Ort ${taxLabel(product.taxKeyDineIn)}` : ""}
          </Muted>
          {product.isDeposit ? <Text style={styles.depositTag}>Pfandartikel</Text> : null}
          {depositNames.length > 0 ? <Text style={styles.depositTag}>mit Pfand: {depositNames.join(", ")}</Text> : null}
          {stockText ? (
            <Text style={[styles.stock, state === "OK" ? styles.stockOk : state === "LOW" ? styles.stockLow : styles.stockBad]}>
              Bestand {stockText}
              {state === "LOW" ? " · knapp" : state === "EMPTY" ? " · leer" : state === "NEGATIVE" ? " · negativ" : ""}
            </Text>
          ) : null}
          {product.image ? <Muted>Bild: {formatAttribution(product.image)}</Muted> : null}
          {!product.isDeposit ? <Muted>{formatCategoryPath(categories, product.categoryId)}</Muted> : null}
        </View>
      </Pressable>
      <Button label="Ausblenden" onPress={onArchive} />
    </Card>
  );
}

// --- Warengruppe anlegen -------------------------------------------------

function CategoryDialog({
  draft,
  categories,
  onChange,
  onCancel,
  onSave,
}: {
  draft: { name: string; parentId: string | null } | null;
  categories: readonly Category[];
  onChange: (draft: { name: string; parentId: string | null }) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  // Nur Gruppen anbieten, unter die tatsaechlich noch etwas passt - eine
  // Auswahl, die anschliessend abgelehnt wird, ist eine Falle.
  const possibleParents = useMemo(
    () => categories.filter((category) => canAddCategory(categories, category.id).ok),
    [categories],
  );

  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible={draft !== null}>
      <View style={styles.backdrop}>
        <Card style={styles.modal}>
          <ScrollView>
            <Title>Neue Warengruppe</Title>
            <Field
              label="Name"
              onChangeText={(value) => draft && onChange({ ...draft, name: value })}
              placeholder="z. B. Kaltgetraenke"
              value={draft?.name ?? ""}
            />
            <Label>Untergruppe von</Label>
            <Muted>
              Hoechstens {MAX_CATEGORY_DEPTH} Ebenen. Was tiefer unterschieden werden soll, gehoert
              als Zusatz an den Artikel.
            </Muted>
            <Segmented
              options={[
                { value: "", label: "Oberste Ebene" },
                ...possibleParents.map((category) => ({
                  value: category.id,
                  label: formatCategoryPath(categories, category.id),
                })),
              ]}
              value={draft?.parentId ?? ""}
              onChange={(value) => draft && onChange({ ...draft, parentId: value === "" ? null : value })}
            />
            <View style={styles.headActions}>
              <Button label="Abbrechen" onPress={onCancel} style={styles.flex} />
              <Button label="Anlegen" onPress={onSave} tone="accent" style={styles.flex} />
            </View>
          </ScrollView>
        </Card>
      </View>
    </Modal>
  );
}

// --- Artikel anlegen oder aendern ----------------------------------------

function ProductDialog({
  draft,
  categories,
  depositProducts,
  error,
  onChange,
  onCancel,
  onSave,
  onSearchImage,
}: {
  draft: Draft | null;
  categories: readonly Category[];
  depositProducts: readonly Product[];
  error: string | null;
  onChange: React.Dispatch<React.SetStateAction<Draft | null>>;
  onCancel: () => void;
  onSave: () => void;
  onSearchImage: () => void;
}) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange((current) => (current ? { ...current, [key]: value } : current));

  return (
    <Modal animationType="slide" onRequestClose={onCancel} transparent visible={draft !== null}>
      <View style={styles.backdrop}>
        <Card style={styles.modal}>
          <ScrollView>
            <Title>{draft?.id ? "Artikel aendern" : "Neuer Artikel"}</Title>
            {error ? <Notice tone="danger">{error}</Notice> : null}

            <Field label="Name" onChangeText={(value) => set("name", value)} placeholder="z. B. Kaffee" value={draft?.name ?? ""} />

            {!draft?.isDeposit ? (
              <>
                <Label>Warengruppe</Label>
                <Segmented
                  options={categories.map((category) => ({
                    value: category.id,
                    label: formatCategoryPath(categories, category.id),
                  }))}
                  value={draft?.categoryId ?? ""}
                  onChange={(value) => set("categoryId", value)}
                />
              </>
            ) : null}

            <Toggle label="Preis wird am Stand eingegeben" value={draft?.openPrice ?? false} onChange={(value) => set("openPrice", value)} />
            {!draft?.openPrice ? (
              <Field
                keyboardType="decimal-pad"
                label={draft?.unit === "KILOGRAM" ? "Preis je kg (brutto)" : "Preis (brutto)"}
                onChangeText={(value) => set("price", value)}
                placeholder="4,50"
                value={draft?.price ?? ""}
              />
            ) : null}

            <Label>Verkaufseinheit</Label>
            <Segmented
              options={[
                { value: "PIECE", label: "Stueck" },
                { value: "KILOGRAM", label: "Kilogramm" },
                { value: "LITRE", label: "Liter" },
              ]}
              value={draft?.unit ?? "PIECE"}
              onChange={(value) => set("unit", value as Product["unit"])}
            />

            <Label>Steuersatz (ausser Haus / Lieferung)</Label>
            <Segmented
              options={STANDARD_TAX_RATES.map((rate) => ({ value: String(rate.key), label: rate.label }))}
              value={String(draft?.taxKey ?? TAX_RATES.NORMAL.key)}
              onChange={(value) => set("taxKey", Number(value))}
            />

            <Toggle
              label="Bei Verzehr vor Ort anderer Steuersatz"
              value={draft?.differentDineIn ?? false}
              onChange={(value) => set("differentDineIn", value)}
            />
            {draft?.differentDineIn ? (
              <>
                <Muted>
                  Speisen sind ausser Haus eine Lieferung (7 %), vor Ort eine sonstige Leistung
                  (19 %). Getraenke bleiben in beiden Faellen bei 19 %.
                </Muted>
                <Segmented
                  options={STANDARD_TAX_RATES.map((rate) => ({ value: String(rate.key), label: rate.label }))}
                  value={String(draft.taxKeyDineIn)}
                  onChange={(value) => set("taxKeyDineIn", Number(value))}
                />
              </>
            ) : null}

            <View style={styles.divider} />

            {/* Bild */}
            <Label>Bild</Label>
            {draft?.image ? (
              <View style={styles.imagePreview}>
                <Image source={{ uri: draft.image.url }} style={styles.imageLarge} resizeMode="cover" />
                <Muted>{formatAttribution(draft.image)}</Muted>
                <Button label="Bild entfernen" onPress={() => set("image", null)} />
              </View>
            ) : (
              <Muted>Noch kein Bild.</Muted>
            )}
            <Button label="Bild suchen (freie Lizenz)" onPress={onSearchImage} />
            <Muted>
              Gesucht wird nur in Sammlungen, die die Lizenz mitliefern. Urheber, Lizenz und Quelle
              werden mitgespeichert - eine allgemeine Bildersuche waere ein Haftungsrisiko.
            </Muted>

            <View style={styles.divider} />

            <Toggle label="Dieser Artikel ist ein Pfandartikel" value={draft?.isDeposit ?? false} onChange={(value) => set("isDeposit", value)} />

            {draft?.isDeposit ? (
              <Muted>
                Pfandartikel erscheinen nicht als Kachel. Sie werden ueber den Artikel gebucht, an
                dem sie haengen, und ueber den Bildschirm "Pfand" zurueckgenommen. Betrag und
                Bezeichnung bestimmt der Betrieb - ebenso den Steuersatz, der oben steht. Welcher
                richtig ist, gehoert einmal mit dem Steuerberater geklaert (docs/RECHTLICHES.md).
              </Muted>
            ) : (
              <>
                <Label>Pfand, das mitverkauft wird</Label>
                <Muted>
                  Mehrfachauswahl, hoechstens {MAX_DEPOSITS_PER_PRODUCT}. Ein Kaffee zum Mitnehmen
                  bringt ueblicherweise Becher und Deckel mit.
                </Muted>
                {depositProducts.length === 0 ? (
                  <Muted>Noch kein Pfandartikel angelegt.</Muted>
                ) : (
                  depositProducts.map((item) => {
                    const selected = draft?.depositProductIds.includes(item.id) ?? false;
                    return (
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selected }}
                        key={item.id}
                        onPress={() =>
                          onChange((current) => {
                            if (!current) return current;
                            const ids = selected
                              ? current.depositProductIds.filter((id) => id !== item.id)
                              : [...current.depositProductIds, item.id];
                            return { ...current, depositProductIds: ids };
                          })
                        }
                        style={[styles.checkRow, selected && styles.checkRowActive]}
                      >
                        <Text style={styles.checkLabel}>
                          {selected ? "✓ " : "  "}
                          {item.name} {"·"} {item.price == null ? "-" : formatEuro(item.price)}
                        </Text>
                      </Pressable>
                    );
                  })
                )}

                <View style={styles.divider} />

                <Toggle label="Bestand fuehren" value={draft?.trackStock ?? false} onChange={(value) => set("trackStock", value)} />
                {draft?.trackStock ? (
                  <>
                    <Muted>
                      Sinnvoll fuer Gezaehltes - Flaschen, Dosen, Packungen. Fuer einen Crepe aus
                      Teig ist ein Stueckbestand sinnlos. Der Bestand selbst wird unter "Bestand"
                      gebucht, nicht hier.
                    </Muted>
                    <Field
                      keyboardType="decimal-pad"
                      label="Warnen ab Bestand (leer = keine Warnung)"
                      onChangeText={(value) => set("lowStockThreshold", value)}
                      placeholder="6"
                      value={draft.lowStockThreshold}
                    />
                  </>
                ) : null}
              </>
            )}

            <View style={styles.divider} />
            <View style={styles.headActions}>
              <Button label="Abbrechen" onPress={onCancel} style={styles.flex} />
              <Button label="Speichern" onPress={onSave} tone="accent" style={styles.flex} />
            </View>
          </ScrollView>
        </Card>
      </View>
    </Modal>
  );
}

// --- Bildsuche -----------------------------------------------------------

/**
 * Bildsuche in frei lizenzierten Sammlungen.
 *
 * Ohne Netz gibt es hier nichts - das ist kein Fehler, sondern der Normalfall
 * am Marktstand. Der Artikel laesst sich ohne Bild speichern; die Suche ist
 * eine Zutat, keine Voraussetzung.
 */
function ImageSearchDialog({
  query,
  onClose,
  onPick,
}: {
  query: string | null;
  onClose: () => void;
  onPick: (image: ProductImage) => void;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<ImageCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (query !== null) {
      setTerm(query);
      setResults([]);
      setMessage(null);
    }
  }, [query]);

  const search = useCallback(async () => {
    const text = term.trim();
    if (text === "") return;
    setBusy(true);
    setMessage(null);
    try {
      const source = openverseSource(globalThis.fetch as never);
      const found = await source.search(text, { limit: 12 });
      setResults(found);
      if (found.length === 0) setMessage("Keine frei lizenzierten Bilder zu diesem Begriff gefunden.");
    } catch (issue) {
      setMessage(`Suche nicht moeglich: ${(issue as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [term]);

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={query !== null}>
      <View style={styles.backdrop}>
        <Card style={styles.modal}>
          <ScrollView>
            <Title>Bild suchen</Title>
            <Field label="Suchbegriff" onChangeText={setTerm} placeholder="z. B. Kaffee Tasse" value={term} />
            <Button label="Suchen" loading={busy} onPress={() => void search()} tone="accent" />
            {message ? <Muted>{message}</Muted> : null}

            {results.map((candidate) => (
              <Pressable
                accessibilityRole="button"
                key={candidate.url}
                onPress={() => {
                  try {
                    onPick(toProductImage(candidate));
                  } catch (issue) {
                    setMessage((issue as Error).message);
                  }
                }}
                style={styles.candidate}
              >
                <Image source={{ uri: candidate.thumbnailUrl ?? candidate.url }} style={styles.thumb} resizeMode="cover" />
                <View style={styles.flex}>
                  <Text style={styles.candidateTitle} numberOfLines={2}>
                    {candidate.title}
                  </Text>
                  <Muted>{candidate.license}</Muted>
                  {candidate.creator ? <Muted>{candidate.creator}</Muted> : null}
                  {candidate.attributionRequired ? <Text style={styles.attribution}>Namensnennung erforderlich</Text> : null}
                </View>
              </Pressable>
            ))}

            <View style={styles.divider} />
            <Button label="Schliessen" onPress={onClose} />
          </ScrollView>
        </Card>
      </View>
    </Modal>
  );
}

// --- Kleinteile ----------------------------------------------------------

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        onValueChange={onChange}
        thumbColor={value ? colors.accent : colors.textMuted}
        trackColor={{ false: colors.border, true: colors.accentDeep }}
        value={value}
      />
    </View>
  );
}

function taxLabel(key: number): string {
  return STANDARD_TAX_RATES.find((rate) => rate.key === key)?.label ?? `Schluessel ${key}`;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: space.md, padding: space.md, paddingBottom: space.xxl },
  card: { gap: space.sm },
  headActions: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  smallButton: { paddingHorizontal: space.sm },
  group: { gap: space.sm, marginTop: space.sm },
  groupHead: { alignItems: "center", flexDirection: "row", gap: space.sm },
  row: { gap: space.sm },
  rowMain: { flexDirection: "row", gap: space.sm },
  name: { color: colors.text, fontSize: font.label, fontWeight: "700" },
  depositTag: { color: colors.deposit, fontSize: font.small },
  issue: { color: colors.warning, fontSize: font.small },
  stock: { fontSize: font.small, fontWeight: "700" },
  stockOk: { color: colors.success },
  stockLow: { color: colors.warning },
  stockBad: { color: colors.danger },
  thumb: { backgroundColor: colors.surfaceRaised, borderRadius: radius.sm, height: 56, width: 56 },
  imagePreview: { gap: space.sm },
  imageLarge: { backgroundColor: colors.surfaceRaised, borderRadius: radius.md, height: 160, width: "100%" },
  candidate: { alignItems: "center", borderBottomColor: colors.border, borderBottomWidth: 1, flexDirection: "row", gap: space.sm, paddingVertical: space.sm },
  candidateTitle: { color: colors.text, fontSize: font.body, fontWeight: "600" },
  attribution: { color: colors.warning, fontSize: font.small },
  backdrop: { backgroundColor: "rgba(8, 12, 22, 0.75)", flex: 1, justifyContent: "center", padding: space.md },
  modal: { gap: space.sm, maxHeight: "92%" },
  divider: { backgroundColor: colors.border, height: 1, marginVertical: space.md },
  toggleRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", paddingVertical: space.sm },
  toggleLabel: { color: colors.text, flex: 1, fontSize: font.body },
  checkRow: { borderColor: colors.border, borderRadius: 8, borderWidth: 1, marginBottom: space.xs, minHeight: 48, justifyContent: "center", paddingHorizontal: space.md },
  checkRowActive: { borderColor: colors.deposit },
  checkLabel: { color: colors.text, fontSize: font.body },
});
