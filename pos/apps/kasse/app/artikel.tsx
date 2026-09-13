/**
 * Artikelverwaltung.
 *
 * Der Betrieb pflegt seine Artikel selbst am Geraet - kein Zugang zu einem
 * Rechner noetig, kein Warten auf den Anbieter. Am Marktstand aendert sich ein
 * Preis manchmal am gleichen Tag.
 *
 * Zwei Dinge, die ein Kassensystem hier richtig machen muss:
 *
 *   1. **Kein Loeschen.** Alte Belege verweisen auf den Artikel; wird er
 *      entfernt, ist der Beleg nicht mehr nachvollziehbar. Artikel werden
 *      ausgeblendet ("archiviert"), nicht geloescht.
 *   2. **Preisaenderung ohne Rueckwirkung.** Der Beleg speichert Name und
 *      Preis als Kopie. Eine Preisrunde heute aendert keinen Beleg von
 *      gestern.
 */

import React, { useMemo, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import {
  type Category,
  type Product,
  STANDARD_TAX_RATES,
  TAX_RATES,
  formatEuro,
  isoWithOffset,
  parseAmount,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { deactivateProduct, saveCategory, saveProduct } from "../src/db/repositories.ts";
import { Button, Card, Field, Label, Muted, Notice, Screen, Segmented, Title } from "../src/components/ui.tsx";
import { colors, font, space } from "../src/theme.ts";

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
  depositKind: "REUSABLE" | "ONE_WAY";
  depositRefundable: boolean;
  depositProductIds: string[];
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
    depositKind: "REUSABLE",
    depositRefundable: true,
    depositProductIds: [],
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
    isDeposit: product.deposit != null,
    depositKind: product.deposit?.kind ?? "REUSABLE",
    depositRefundable: product.deposit?.refundable ?? true,
    depositProductIds: [...(product.depositProductIds ?? [])],
  };
}

export default function ArtikelScreen() {
  const kasse = useKasse();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [categoryDraft, setCategoryDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const depositProducts = useMemo(() => kasse.products.filter((product) => product.deposit), [kasse.products]);

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
    if (name === "") {
      setError("Der Artikel braucht einen Namen.");
      return;
    }
    const price = draft.openPrice ? null : parseAmount(draft.price);
    if (!draft.openPrice && (price == null || price < 0)) {
      setError("Der Preis ist nicht lesbar. Beispiel: 4,50");
      return;
    }
    if (draft.isDeposit && (price == null || price <= 0)) {
      setError("Ein Pfandartikel braucht einen festen Betrag groesser als null.");
      return;
    }

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
      deposit: draft.isDeposit ? { kind: draft.depositKind, refundable: draft.depositRefundable } : null,
      color: null,
      sortOrder: 0,
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
      `"${product.name}" wird nicht mehr auf dem Kassenbildschirm angeboten. Alte Belege bleiben unveraendert lesbar.`,
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
    const name = (categoryDraft ?? "").trim();
    if (name === "" || !kasse.tenant) return;
    const category: Category = {
      id: `c-${Date.now().toString(36)}`,
      tenantId: kasse.tenant.id,
      name,
      color: null,
      sortOrder: kasse.categories.length + 1,
      active: true,
    };
    await saveCategory(kasse.db(), category);
    await kasse.reload();
    setCategoryDraft(null);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Artikel</Title>

        <View style={styles.headActions}>
          <Button
            label="Neuer Artikel"
            onPress={() => setDraft(newDraft(kasse.categories[0]?.id ?? ""))}
            tone="accent"
            style={styles.flex}
            disabled={kasse.categories.length === 0}
          />
          <Button label="Warengruppe" onPress={() => setCategoryDraft("")} style={styles.flex} />
        </View>

        {kasse.categories.length === 0 ? (
          <Notice tone="warning">Zuerst eine Warengruppe anlegen.</Notice>
        ) : null}

        {kasse.categories.map((category) => (
          <View key={category.id} style={styles.group}>
            <Label>{category.name}</Label>
            {(byCategory.get(category.id) ?? []).map((product) => (
              <Card key={product.id} style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setDraft(toDraft(product))}
                  style={styles.rowMain}
                >
                  <View style={styles.flex}>
                    <Text style={styles.name}>{product.name}</Text>
                    <Muted>
                      {product.price == null ? "offener Preis" : formatEuro(product.price)}
                      {product.unit === "KILOGRAM" ? " / kg" : ""}
                      {" · "}
                      {taxLabel(product.taxKey)}
                      {product.taxKeyDineIn != null ? ` / vor Ort ${taxLabel(product.taxKeyDineIn)}` : ""}
                    </Muted>
                    {product.deposit ? (
                      <Text style={styles.depositTag}>
                        Pfandartikel {product.deposit.kind === "REUSABLE" ? "Mehrweg" : "Einweg"}
                        {product.deposit.refundable ? ", Ruecknahme" : ", keine Ruecknahme"}
                      </Text>
                    ) : null}
                    {product.depositProductIds && product.depositProductIds.length > 0 ? (
                      <Text style={styles.depositTag}>
                        mit Pfand:{" "}
                        {product.depositProductIds
                          .map((id) => kasse.products.find((p) => p.id === id)?.name ?? id)
                          .join(", ")}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
                <Button label="Ausblenden" onPress={() => archive(product)} />
              </Card>
            ))}
            {(byCategory.get(category.id) ?? []).length === 0 ? <Muted>Keine Artikel.</Muted> : null}
          </View>
        ))}
      </ScrollView>

      {/* Warengruppe anlegen */}
      <Modal animationType="fade" onRequestClose={() => setCategoryDraft(null)} transparent visible={categoryDraft !== null}>
        <View style={styles.backdrop}>
          <Card style={styles.modal}>
            <Title>Neue Warengruppe</Title>
            <Field label="Name" onChangeText={setCategoryDraft} value={categoryDraft ?? ""} placeholder="z. B. Getraenke" />
            <View style={styles.headActions}>
              <Button label="Abbrechen" onPress={() => setCategoryDraft(null)} style={styles.flex} />
              <Button label="Anlegen" onPress={() => void addCategory()} tone="accent" style={styles.flex} />
            </View>
          </Card>
        </View>
      </Modal>

      {/* Artikel anlegen oder aendern */}
      <Modal animationType="slide" onRequestClose={() => setDraft(null)} transparent visible={draft !== null}>
        <View style={styles.backdrop}>
          <Card style={styles.modal}>
            <ScrollView>
              <Title>{draft?.id ? "Artikel aendern" : "Neuer Artikel"}</Title>
              {error ? <Notice tone="danger">{error}</Notice> : null}

              <Field
                label="Name"
                onChangeText={(value) => setDraft((current) => (current ? { ...current, name: value } : current))}
                placeholder="z. B. Kaffee"
                value={draft?.name ?? ""}
              />

              <Label>Warengruppe</Label>
              <Segmented
                options={kasse.categories.map((category) => ({ value: category.id, label: category.name }))}
                value={draft?.categoryId ?? ""}
                onChange={(value) => setDraft((current) => (current ? { ...current, categoryId: value } : current))}
              />

              <Toggle
                label="Preis wird am Stand eingegeben"
                value={draft?.openPrice ?? false}
                onChange={(value) => setDraft((current) => (current ? { ...current, openPrice: value } : current))}
              />
              {!draft?.openPrice ? (
                <Field
                  keyboardType="decimal-pad"
                  label={draft?.unit === "KILOGRAM" ? "Preis je kg (brutto)" : "Preis (brutto)"}
                  onChangeText={(value) => setDraft((current) => (current ? { ...current, price: value } : current))}
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
                onChange={(value) => setDraft((current) => (current ? { ...current, unit: value } : current))}
              />

              <Label>Steuersatz (ausser Haus / Lieferung)</Label>
              <Segmented
                options={STANDARD_TAX_RATES.map((rate) => ({ value: String(rate.key), label: rate.label }))}
                value={String(draft?.taxKey ?? TAX_RATES.NORMAL.key)}
                onChange={(value) => setDraft((current) => (current ? { ...current, taxKey: Number(value) } : current))}
              />

              <Toggle
                label="Bei Verzehr vor Ort anderer Steuersatz"
                value={draft?.differentDineIn ?? false}
                onChange={(value) => setDraft((current) => (current ? { ...current, differentDineIn: value } : current))}
              />
              {draft?.differentDineIn ? (
                <>
                  <Muted>
                    Speisen sind ausser Haus eine Lieferung (7 %), vor Ort eine sonstige Leistung (19 %).
                    Getraenke bleiben in beiden Faellen bei 19 %.
                  </Muted>
                  <Segmented
                    options={STANDARD_TAX_RATES.map((rate) => ({ value: String(rate.key), label: rate.label }))}
                    value={String(draft.taxKeyDineIn)}
                    onChange={(value) => setDraft((current) => (current ? { ...current, taxKeyDineIn: Number(value) } : current))}
                  />
                </>
              ) : null}

              <View style={styles.divider} />

              <Toggle
                label="Dieser Artikel ist selbst ein Pfandartikel"
                value={draft?.isDeposit ?? false}
                onChange={(value) => setDraft((current) => (current ? { ...current, isDeposit: value } : current))}
              />

              {draft?.isDeposit ? (
                <>
                  <Label>Pfandart</Label>
                  <Segmented
                    options={[
                      { value: "REUSABLE", label: "Mehrweg" },
                      { value: "ONE_WAY", label: "Einweg" },
                    ]}
                    value={draft.depositKind}
                    onChange={(value) => setDraft((current) => (current ? { ...current, depositKind: value } : current))}
                  />
                  <Toggle
                    label="Wird zurueckgenommen"
                    value={draft.depositRefundable}
                    onChange={(value) => setDraft((current) => (current ? { ...current, depositRefundable: value } : current))}
                  />
                  <Muted>
                    Der Steuersatz des Pfands ist der oben gewaehlte. Welcher Satz richtig ist, gehoert
                    einmal mit dem Steuerberater geklaert - siehe docs/RECHTLICHES.md.
                  </Muted>
                </>
              ) : (
                <>
                  <Label>Pfand, das mitverkauft wird</Label>
                  <Muted>
                    Mehrfachauswahl. Ein Kaffee zum Mitnehmen bringt ueblicherweise Becher und Deckel mit.
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
                            setDraft((current) => {
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
                            {item.name} · {item.price == null ? "-" : formatEuro(item.price)}
                          </Text>
                        </Pressable>
                      );
                    })
                  )}
                </>
              )}

              <View style={styles.divider} />
              <View style={styles.headActions}>
                <Button label="Abbrechen" onPress={() => setDraft(null)} style={styles.flex} />
                <Button label="Speichern" onPress={() => void save()} tone="accent" style={styles.flex} />
              </View>
            </ScrollView>
          </Card>
        </View>
      </Modal>
    </Screen>
  );
}

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
  content: { gap: space.md, padding: space.md },
  headActions: { flexDirection: "row", gap: space.sm },
  group: { gap: space.sm },
  row: { gap: space.sm },
  rowMain: { flexDirection: "row" },
  name: { color: colors.text, fontSize: font.label, fontWeight: "700" },
  depositTag: { color: colors.deposit, fontSize: font.small },
  backdrop: { backgroundColor: "rgba(8, 12, 22, 0.75)", flex: 1, justifyContent: "center", padding: space.md },
  modal: { gap: space.sm, maxHeight: "92%" },
  divider: { backgroundColor: colors.border, height: 1, marginVertical: space.md },
  toggleRow: { alignItems: "center", flexDirection: "row", gap: space.md, justifyContent: "space-between", paddingVertical: space.sm },
  toggleLabel: { color: colors.text, flex: 1, fontSize: font.body },
  checkRow: { borderColor: colors.border, borderRadius: 8, borderWidth: 1, marginBottom: space.xs, minHeight: 48, justifyContent: "center", paddingHorizontal: space.md },
  checkRowActive: { borderColor: colors.deposit },
  checkLabel: { color: colors.text, fontSize: font.body },
});
