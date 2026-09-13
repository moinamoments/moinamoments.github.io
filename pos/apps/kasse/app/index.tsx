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
  type ComputedLine,
  type PaymentIntent,
  type PaymentMethod,
  type Product,
  formatAmount,
  formatEuro,
  formatQuantity,
  isDeposit,
  parseAmount,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { Button, Card, Field, Label, Muted, Notice, Screen, Segmented, Tile, Title } from "../src/components/ui.tsx";
import { colors, font, radius, space, touch } from "../src/theme.ts";

export default function KasseScreen() {
  const kasse = useKasse();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const wide = width >= 820;

  const [categoryId, setCategoryId] = useState<string>("");
  const [openAmount, setOpenAmount] = useState<{ product: Product | null; text: string } | null>(null);
  const [weight, setWeight] = useState<{ product: Product; text: string } | null>(null);
  const [paying, setPaying] = useState(false);

  /**
   * Kacheln: Pfandartikel gehoeren nicht dazu. Sie werden ueber den Artikel
   * gebucht, an dem sie haengen - eine Kachel "Becher" wuerde zu Belegen
   * fuehren, auf denen Pfand ohne Ware steht.
   */
  const sellable = useMemo(() => kasse.products.filter((product) => !product.deposit), [kasse.products]);

  const categories = useMemo(() => {
    const used = new Set(sellable.map((product) => product.categoryId));
    return kasse.categories.filter((category) => used.has(category.id));
  }, [kasse.categories, sellable]);

  const activeCategory = categoryId || categories[0]?.id || "";
  const visible = useMemo(
    () => sellable.filter((product) => product.categoryId === activeCategory),
    [activeCategory, sellable],
  );

  if (!kasse.ready) {
    return (
      <Screen style={styles.centered}>
        <Muted>Kasse wird gestartet...</Muted>
      </Screen>
    );
  }

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
            <Segmented
              options={categories.map((category) => ({ value: category.id, label: category.name }))}
              value={activeCategory}
              onChange={setCategoryId}
            />
            <FlatList
              contentContainerStyle={styles.grid}
              data={visible}
              keyExtractor={(item) => item.id}
              numColumns={wide ? 4 : 2}
              key={wide ? "wide" : "narrow"}
              columnWrapperStyle={styles.gridRow}
              renderItem={({ item }) => (
                <View style={styles.gridItem}>
                  <Tile
                    color={kasse.categories.find((c) => c.id === item.categoryId)?.color ?? null}
                    hint={depositHint(kasse, item)}
                    name={item.name}
                    onPress={() => onTile(item)}
                    price={item.price == null ? "Betrag eingeben" : formatEuro(item.price)}
                  />
                </View>
              )}
              ListEmptyComponent={<Muted>In dieser Warengruppe sind keine Artikel angelegt.</Muted>}
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
