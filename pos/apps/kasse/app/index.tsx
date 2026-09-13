/**
 * Kassenbildschirm.
 *
 * Der Bildschirm, an dem der Betrieb sein Geld verdient - entsprechend ist er
 * auf Geschwindigkeit gebaut: Warengruppe, Kachel, bezahlen. Keine Dialoge im
 * Weg, keine Bestaetigung fuer das, was ein Tippen zurueckholt.
 *
 * Aufbau: links die Kacheln, rechts der Warenkorb. Auf schmalen Geraeten
 * (Telefon) untereinander, der Warenkorb als feste Leiste unten - dort steht
 * die Summe immer sichtbar.
 */

import React, { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ONE,
  type Category,
  type CategoryNode,
  type ComputedLine,
  type PaymentIntent,
  type PaymentMethod,
  type Product,
  buildCategoryTree,
  categoryPath,
  formatAmount,
  formatEuro,
  formatQuantity,
  formatStock,
  isDeposit,
  parseAmount,
  productsInCategory,
  stockState,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { Button, Card, CategoryTile, Field, Label, Muted, Notice, Screen, Segmented, Tile, Title } from "../src/components/ui.tsx";
import { colors, font, radius, space, touch } from "../src/theme.ts";

export default function KasseScreen() {
  const kasse = useKasse();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const wide = width >= 820;

  /**
   * Wo im Warengruppenbaum stehen wir?
   *
   * `null` ist die oberste Ebene. Der Bediener steigt hinein und ueber die
   * Pfadleiste wieder heraus - kein Zuruecktaste-Raten, weil am Verkaufsstand
   * jeder Fehlgriff Zeit kostet.
   */
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [openAmount, setOpenAmount] = useState<{ product: Product | null; text: string } | null>(null);
  const [weight, setWeight] = useState<{ product: Product; text: string } | null>(null);
  const [paying, setPaying] = useState(false);

  /**
   * Kacheln: Pfandartikel gehoeren nicht dazu. Sie werden ueber den Artikel
   * gebucht, an dem sie haengen - eine Kachel "Becher" wuerde zu Belegen
   * fuehren, auf denen Pfand ohne Ware steht.
   */
  const sellable = useMemo(() => kasse.products.filter((product) => !product.isDeposit), [kasse.products]);

  // Der Baum wirft nie - ein Datenfehler in den Warengruppen darf den Verkauf
  // nicht anhalten. Leere Gruppen werden ausgeblendet, damit der Bildschirm
  // nicht mit Sackgassen zugestellt ist.
  const tree = useMemo(
    () => buildCategoryTree(kasse.categories, sellable).filter((node) => node.totalProductCount > 0),
    [kasse.categories, sellable],
  );

  const path = useMemo<Category[]>(
    () => (categoryId ? categoryPath(kasse.categories, categoryId) : []),
    [categoryId, kasse.categories],
  );

  /** Untergruppen und Artikel der aktuellen Ebene. */
  const level = useMemo<{ subcategories: readonly CategoryNode[]; products: readonly Product[] }>(() => {
    if (categoryId === null) {
      // Oberste Ebene: die Wurzelgruppen, dazu Artikel ohne Gruppe im Baum.
      const rootIds = new Set(kasse.categories.filter((c) => c.parentId == null).map((c) => c.id));
      return {
        subcategories: tree,
        products: sellable.filter((product) => !rootIds.has(product.categoryId) &&
          !kasse.categories.some((c) => c.id === product.categoryId)),
      };
    }
    const node = findNode(tree, categoryId);
    return {
      subcategories: node?.children.filter((child) => child.totalProductCount > 0) ?? [],
      products: productsInCategory(sellable, kasse.categories, categoryId),
    };
  }, [categoryId, kasse.categories, sellable, tree]);

  const rootProducts = useMemo(
    () => (categoryId === null ? sellable.filter((product) => isRootCategory(kasse.categories, product.categoryId)) : []),
    [categoryId, kasse.categories, sellable],
  );

  if (!kasse.ready) {
    return (
      <Screen style={styles.centered}>
        <Muted>Kasse wird gestartet...</Muted>
      </Screen>
    );
  }

  /** Untergruppen zuerst, dann Artikel - so sucht man am Stand. */
  const entries = useMemo<TileEntry[]>(
    () => [
      ...level.subcategories.map((node) => ({ kind: "category" as const, node })),
      ...[...level.products, ...rootProducts].map((product) => ({ kind: "product" as const, product })),
    ],
    [level, rootProducts],
  );

  const onTile = (product: Product) => {
    if (product.price == null) {
      setOpenAmount({ product, text: "" });
      return;
    }
    if (product.unit === "KILOGRAM") {
      setWeight({ product, text: "" });
      return;
    }
    kasse.addProduct(product);
  };

  return (
    <Screen>
      <SafeAreaView edges={["bottom"]} style={styles.flex}>
        {kasse.error ? <Notice tone="danger">{kasse.error}</Notice> : null}
        <StatusBar />

        <View style={[styles.body, wide && styles.bodyWide]}>
          <View style={styles.flex}>
            <Breadcrumb path={path} onNavigate={setCategoryId} />
            <FlatList
              contentContainerStyle={styles.grid}
              data={entries}
              keyExtractor={(entry) => (entry.kind === "category" ? `c-${entry.node.category.id}` : `p-${entry.product.id}`)}
              numColumns={wide ? 4 : 2}
              key={wide ? "wide" : "narrow"}
              columnWrapperStyle={styles.gridRow}
              renderItem={({ item: entry }) => (
                <View style={styles.gridItem}>
                  {entry.kind === "category" ? (
                    <CategoryTile
                      color={entry.node.category.color}
                      count={entry.node.totalProductCount}
                      name={entry.node.category.name}
                      onPress={() => setCategoryId(entry.node.category.id)}
                    />
                  ) : (
                    <Tile
                      badge={formatStock(entry.product)}
                      badgeTone={stockTone(entry.product)}
                      color={kasse.categories.find((c) => c.id === entry.product.categoryId)?.color ?? null}
                      hint={depositHint(kasse, entry.product)}
                      imageUrl={entry.product.image?.url ?? null}
                      name={entry.product.name}
                      onPress={() => onTile(entry.product)}
                      price={entry.product.price == null ? "Betrag eingeben" : formatEuro(entry.product.price)}
                    />
                  )}
                </View>
              )}
              ListEmptyComponent={
                <Muted>
                  {kasse.products.length === 0
                    ? "Noch keine Artikel angelegt - unter Artikel anlegen."
                    : "Hier sind keine Artikel einsortiert."}
                </Muted>
              }
            />
          </View>

          <CartPanel onPay={() => setPaying(true)} wide={wide} />
        </View>
      </SafeAreaView>

      <AmountDialog
        title={openAmount?.product?.name ?? ""}
        label="Betrag"
        hint="Bruttobetrag, z. B. 3,50"
        open={openAmount !== null}
        value={openAmount?.text ?? ""}
        onChange={(text) => setOpenAmount((current) => (current ? { ...current, text } : current))}
        onCancel={() => setOpenAmount(null)}
        onConfirm={() => {
          const product = openAmount?.product;
          const cents = parseAmount(openAmount?.text ?? "");
          if (!product || cents == null || cents <= 0) return;
          kasse.addProduct(product, { price: cents });
          setOpenAmount(null);
        }}
      />

      <AmountDialog
        title={weight?.product.name ?? ""}
        label="Gewicht in kg"
        hint="z. B. 0,35 fuer 350 Gramm"
        open={weight !== null}
        value={weight?.text ?? ""}
        onChange={(text) => setWeight((current) => (current ? { ...current, text } : current))}
        onCancel={() => setWeight(null)}
        onConfirm={() => {
          const product = weight?.product;
          // Das Gewicht wird in Tausendsteln gefuehrt - dieselbe Einheit wie
          // Stueckzahlen, deshalb genuegt derselbe Parser.
          const grams = parseAmountThousandths(weight?.text ?? "");
          if (!product || grams == null || grams <= 0) return;
          kasse.addProduct(product, { quantity: grams });
          setWeight(null);
        }}
      />

      <PayDialog
        open={paying}
        onClose={() => setPaying(false)}
        onPaid={(orderId) => {
          setPaying(false);
          router.push(`/bon/${orderId}`);
        }}
      />
    </Screen>
  );
}

type TileEntry =
  | { readonly kind: "category"; readonly node: CategoryNode }
  | { readonly kind: "product"; readonly product: Product };

function findNode(nodes: readonly CategoryNode[], id: string): CategoryNode | null {
  for (const node of nodes) {
    if (node.category.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

function isRootCategory(categories: readonly Category[], categoryId: string): boolean {
  const category = categories.find((c) => c.id === categoryId);
  return category != null && category.parentId == null;
}

/** Farbe der Bestandsangabe auf der Kachel. */
function stockTone(product: Product): "normal" | "warning" | "danger" {
  switch (stockState(product)) {
    case "EMPTY":
    case "NEGATIVE":
      return "danger";
    case "LOW":
      return "warning";
    default:
      return "normal";
  }
}

/**
 * Pfadleiste.
 *
 * Zeigt, wo man ist, und bringt mit einem Griff zurueck - auch mehrere Ebenen
 * auf einmal. Eine Zuruecktaste, die immer nur eine Ebene nimmt, ist bei vier
 * Ebenen vier Tipper.
 */
function Breadcrumb({ path, onNavigate }: { path: readonly Category[]; onNavigate: (id: string | null) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.breadcrumb}>
      <Pressable accessibilityRole="button" onPress={() => onNavigate(null)} style={styles.crumb}>
        <Text style={[styles.crumbText, path.length === 0 && styles.crumbTextActive]}>Alle</Text>
      </Pressable>
      {path.map((category, index) => (
        <React.Fragment key={category.id}>
          <Text style={styles.crumbSeparator}>{"\u203a"}</Text>
          <Pressable accessibilityRole="button" onPress={() => onNavigate(category.id)} style={styles.crumb}>
            <Text style={[styles.crumbText, index === path.length - 1 && styles.crumbTextActive]}>{category.name}</Text>
          </Pressable>
        </React.Fragment>
      ))}
    </ScrollView>
  );
}

/** Hinweis auf der Kachel, wenn der Artikel Pfand mitbringt. */
function depositHint(kasse: ReturnType<typeof useKasse>, product: Product): string | undefined {
  const items = kasse.deposits.for(product.id);
  if (items.length === 0) return undefined;
  const sum = items.reduce((total, item) => total + item.price, 0);
  return `+ ${formatAmount(sum)} Pfand`;
}

/** Statusleiste: TSE, Einrichtung, unuebertragene Belege. */
function StatusBar() {
  const kasse = useKasse();
  const messages: { tone: "warning" | "danger" | "info"; text: string }[] = [];

  if (kasse.needsSetup) {
    messages.push({
      tone: "warning",
      text: "Betriebsdaten fehlen - Belege sind noch nicht gueltig. Unter Einstellungen ausfuellen.",
    });
  }
  if (!kasse.device?.tseClientId) {
    messages.push({ tone: "danger", text: "Keine TSE eingerichtet - Belege werden ohne Signatur erstellt." });
  } else if (!kasse.tseOnline) {
    messages.push({ tone: "danger", text: "TSE nicht erreichbar - Ausfall wird auf dem Beleg dokumentiert." });
  }
  if (kasse.outboxPending > 0) {
    messages.push({ tone: "info", text: `${kasse.outboxPending} Beleg(e) noch nicht uebertragen.` });
  }
  if (messages.length === 0) return null;

  return (
    <View style={styles.statusBar}>
      {messages.map((message) => (
        <Notice key={message.text} tone={message.tone}>
          {message.text}
        </Notice>
      ))}
    </View>
  );
}

function CartPanel({ onPay, wide }: { onPay: () => void; wide: boolean }) {
  const kasse = useKasse();
  const { totals, cart } = kasse;
  const empty = totals.lines.length === 0;

  return (
    <View style={[styles.cart, wide ? styles.cartWide : styles.cartNarrow]}>
      <View style={styles.serviceRow}>
        <Segmented
          options={[
            { value: "TAKEAWAY", label: "Ausser Haus" },
            { value: "DINE_IN", label: "Vor Ort" },
          ]}
          value={cart.serviceMode}
          onChange={(mode) => kasse.setServiceMode(mode)}
        />
      </View>

      <ScrollView style={wide ? styles.flex : styles.cartList}>
        {empty ? <Muted>Noch nichts erfasst.</Muted> : null}
        {totals.lines.map((line) => (
          <CartRow key={line.lineId} line={line} />
        ))}
      </ScrollView>

      {totals.deposits.balance !== 0 ? (
        <View style={styles.totalRow}>
          <Text style={styles.depositLabel}>darin Pfand</Text>
          <Text style={styles.depositAmount}>{formatAmount(totals.deposits.balance)}</Text>
        </View>
      ) : null}

      {totals.taxTotal !== 0 ? (
        <View style={styles.totalRow}>
          <Muted>enthaltene USt</Muted>
          <Muted>{formatAmount(totals.taxTotal)}</Muted>
        </View>
      ) : null}

      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Summe</Text>
        <Text style={styles.totalAmount}>{formatEuro(totals.total)}</Text>
      </View>

      <View style={styles.cartActions}>
        <Button label="Leeren" onPress={() => kasse.clear()} disabled={empty} style={styles.flex} />
        <Button label="Bezahlen" onPress={onPay} tone="accent" disabled={empty} style={styles.payButton} />
      </View>
    </View>
  );
}

function CartRow({ line }: { line: ComputedLine }) {
  const kasse = useKasse();
  const deposit = isDeposit(line);
  // Pfandzeilen sind abgeleitet: an ihnen selbst gibt es nichts zu aendern.
  // Geaendert wird die Warenposition, an der sie haengen.
  const parentId = line.depositForLineId;

  return (
    <View style={[styles.cartRow, deposit && styles.cartRowDeposit]}>
      <View style={styles.flex}>
        <Text style={[styles.cartName, deposit && styles.cartNameDeposit]} numberOfLines={2}>
          {formatQuantity(line.quantity)} x {line.name}
        </Text>
        {line.modifiers.map((modifier) => (
          <Muted key={modifier.name}>+ {modifier.name}</Muted>
        ))}
        {line.allocatedDiscount > 0 ? <Muted>Belegrabatt -{formatAmount(line.allocatedDiscount)}</Muted> : null}
        {line.discount > 0 ? <Muted>Rabatt -{formatAmount(line.discount)}</Muted> : null}
        {deposit && parentId ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => kasse.waiveDeposit(parentId, true)}
            style={styles.linkRow}
          >
            <Text style={styles.link}>Eigenes Gefaess - Pfand entfernen</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={[styles.cartAmount, deposit && styles.cartNameDeposit]}>{formatAmount(line.gross)}</Text>

      {deposit ? null : (
        <View style={styles.stepper}>
          <Pressable
            accessibilityLabel="Menge verringern"
            accessibilityRole="button"
            onPress={() => kasse.changeQuantity(line.lineId, -ONE)}
            style={styles.stepperButton}
          >
            <Text style={styles.stepperLabel}>-</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Menge erhoehen"
            accessibilityRole="button"
            onPress={() => kasse.changeQuantity(line.lineId, ONE)}
            style={styles.stepperButton}
          >
            <Text style={styles.stepperLabel}>+</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/** Zahlen: Bar mit Rueckgeld, Karte, oder geteilt. */
function PayDialog({
  open,
  onClose,
  onPaid,
}: {
  open: boolean;
  onClose: () => void;
  onPaid: (orderId: string) => void;
}) {
  const kasse = useKasse();
  const total = kasse.totals.total;
  const [tendered, setTendered] = useState("");
  const [error, setError] = useState<string | null>(null);

  const given = parseAmount(tendered);
  const change = given == null ? null : given - total;

  const submit = async (payments: readonly PaymentIntent[]) => {
    setError(null);
    try {
      const order = await kasse.pay(payments);
      setTendered("");
      onPaid(order.id);
    } catch (issue) {
      setError((issue as Error).message);
    }
  };

  /** Passende Scheine als Vorschlag - schneller als Tippen. */
  const suggestions = useMemo(() => {
    const steps = [total, Math.ceil(total / 500) * 500, Math.ceil(total / 1000) * 1000, Math.ceil(total / 2000) * 2000, Math.ceil(total / 5000) * 5000];
    return [...new Set(steps)].filter((value) => value >= total).slice(0, 4);
  }, [total]);

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent visible={open}>
      <View style={styles.modalBackdrop}>
        <Card style={styles.modalCard}>
          <Title>Bezahlen</Title>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Zu zahlen</Text>
            <Text style={styles.totalAmountLarge}>{formatEuro(total)}</Text>
          </View>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <Label>Bar</Label>
          <View style={styles.suggestionRow}>
            {suggestions.map((value) => (
              <Button
                key={value}
                label={formatAmount(value)}
                onPress={() => setTendered(formatAmount(value))}
                style={styles.suggestion}
              />
            ))}
          </View>
          <Field
            keyboardType="decimal-pad"
            label="Gegeben"
            onChangeText={setTendered}
            placeholder={formatAmount(total)}
            value={tendered}
          />
          {change != null && change >= 0 ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Rueckgeld</Text>
              <Text style={styles.totalAmount}>{formatAmount(change)}</Text>
            </View>
          ) : null}
          {change != null && change < 0 ? <Muted>Der gegebene Betrag ist zu niedrig.</Muted> : null}

          <Button
            label="Bar abschliessen"
            loading={kasse.busy}
            onPress={() =>
              void submit([{ method: "CASH", amount: total, tendered: given != null && given >= total ? given : total }])
            }
            tone="success"
          />

          <View style={styles.divider} />

          <Label>Unbar</Label>
          <View style={styles.suggestionRow}>
            {(["CARD_DEBIT", "CARD_CREDIT", "MOBILE"] as PaymentMethod[]).map((method) => (
              <Button
                key={method}
                label={{ CARD_DEBIT: "girocard", CARD_CREDIT: "Kreditkarte", MOBILE: "Mobil" }[method as "CARD_DEBIT"] ?? method}
                loading={kasse.busy}
                onPress={() => void submit([{ method, amount: total }])}
                style={styles.suggestion}
              />
            ))}
          </View>
          <Muted>
            Kartenzahlung wird derzeit nur gebucht, nicht an ein Terminal gesendet. Die Anbindung ist
            vorgesehen (siehe docs/ROADMAP.md).
          </Muted>

          <View style={styles.divider} />
          <Button label="Abbrechen" onPress={onClose} />
        </Card>
      </View>
    </Modal>
  );
}

/** Kleiner Eingabedialog fuer Betrag oder Gewicht. */
function AmountDialog({
  open,
  title,
  label,
  hint,
  value,
  onChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal animationType="fade" onRequestClose={onCancel} transparent visible={open}>
      <View style={styles.modalBackdrop}>
        <Card style={styles.modalCard}>
          <Title>{title}</Title>
          <Field keyboardType="decimal-pad" label={label} onChangeText={onChange} placeholder={hint} value={value} />
          <Muted>{hint}</Muted>
          <View style={styles.cartActions}>
            <Button label="Abbrechen" onPress={onCancel} style={styles.flex} />
            <Button label="Uebernehmen" onPress={onConfirm} tone="accent" style={styles.flex} />
          </View>
        </Card>
      </View>
    </Modal>
  );
}

/**
 * Gewichtseingabe in Tausendstel.
 *
 * `0,35` kg sind 350 Tausendstel. Bewusst nicht ueber `parseAmount`, weil der
 * nur zwei Nachkommastellen zulaesst - bei Gramm braucht es drei.
 */
export function parseAmountThousandths(input: string): number | null {
  const text = input.trim().replace(",", ".");
  if (!/^\d{0,6}(\.\d{0,3})?$/.test(text) || text === "" || text === ".") return null;
  const [whole = "0", frac = ""] = text.split(".");
  return Number(whole) * ONE + Number(frac.padEnd(3, "0") || "0");
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { alignItems: "center", justifyContent: "center" },
  statusBar: { gap: space.sm, padding: space.md },
  body: { flex: 1, padding: space.md },
  bodyWide: { flexDirection: "row", gap: space.lg },
  breadcrumb: { alignItems: "center", gap: space.xs, paddingVertical: space.sm },
  crumb: { justifyContent: "center", minHeight: 40, paddingHorizontal: space.sm },
  crumbText: { color: colors.textMuted, fontSize: font.body, fontWeight: "600" },
  crumbTextActive: { color: colors.text },
  crumbSeparator: { color: colors.textMuted, fontSize: font.body },
  grid: { gap: space.sm, paddingBottom: space.xl },
  gridRow: { gap: space.sm },
  gridItem: { flex: 1 },

  cart: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: radius.lg, borderWidth: 1, gap: space.sm, padding: space.md },
  cartWide: { width: 360 },
  cartNarrow: { maxHeight: "52%", marginTop: space.md },
  cartList: { maxHeight: 220 },
  serviceRow: { borderBottomColor: colors.border, borderBottomWidth: 1 },
  cartRow: { alignItems: "center", borderBottomColor: colors.border, borderBottomWidth: 1, flexDirection: "row", gap: space.sm, minHeight: touch.row, paddingVertical: space.sm },
  cartRowDeposit: { paddingLeft: space.lg },
  cartName: { color: colors.text, fontSize: font.body, fontWeight: "600" },
  cartNameDeposit: { color: colors.deposit },
  cartAmount: { color: colors.text, fontSize: font.label, fontWeight: "700", minWidth: 72, textAlign: "right" },
  linkRow: { paddingVertical: space.xs },
  link: { color: colors.accent, fontSize: font.small, fontWeight: "600" },

  stepper: { flexDirection: "row", gap: space.xs },
  stepperButton: { alignItems: "center", backgroundColor: colors.surfaceRaised, borderRadius: radius.sm, height: 44, justifyContent: "center", width: 44 },
  stepperLabel: { color: colors.text, fontSize: font.title, fontWeight: "700" },

  totalRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  totalLabel: { color: colors.text, fontSize: font.label, fontWeight: "600" },
  totalAmount: { color: colors.text, fontSize: font.amount, fontWeight: "800" },
  totalAmountLarge: { color: colors.text, fontSize: font.amountLarge, fontWeight: "800" },
  depositLabel: { color: colors.deposit, fontSize: font.body, fontWeight: "600" },
  depositAmount: { color: colors.deposit, fontSize: font.label, fontWeight: "700" },

  cartActions: { flexDirection: "row", gap: space.sm },
  payButton: { flex: 2 },

  modalBackdrop: { backgroundColor: "rgba(8, 12, 22, 0.75)", flex: 1, justifyContent: "center", padding: space.lg },
  modalCard: { gap: space.md, maxHeight: "90%" },
  suggestionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  suggestion: { flexGrow: 1, minWidth: 96 },
  divider: { backgroundColor: colors.border, height: 1 },
});
