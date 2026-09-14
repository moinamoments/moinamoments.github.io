/**
 * Belegliste, Storno und Teilstorno.
 *
 * Fuer den Nachdruck und die Korrektur. Beides braucht man haeufiger als man
 * denkt: der Kunde will den Bon doch, oder es wurde etwas falsch gebucht.
 *
 * Belege werden hier nie geaendert - ein Storno erzeugt einen neuen Beleg mit
 * eigener Nummer und eigener TSE-Transaktion (§ 146 Abs. 4 AO). Das ist kein
 * Umstand, den man umgehen sollte: der urspruengliche Beleg bleibt sichtbar, und
 * die Korrektur ist als solche erkennbar. Eine Kasse, die einen Beleg
 * verschwinden lassen kann, ist keine.
 *
 * Der **Teilstorno** ist der Fall, der wirklich vorkommt: von vier Positionen
 * war eine falsch. Dann wird auch nur diese zurueckgegeben - mit dem anteiligen
 * Betrag, den der Kern ausrechnet (`buildPartialVoidCart`). Pfand folgt seiner
 * Warenposition automatisch, damit Becher und Getraenk nicht auseinanderlaufen.
 *
 * Der Grund ist Pflicht. Ein Storno ohne Grund ist bei einer Kassennachschau
 * die erste Frage, und "weiss ich nicht mehr" ist dort keine Antwort.
 */

import React, { useCallback, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  ONE,
  buildPartialVoidCart,
  cartTotals,
  checkRequiredText,
  formatEuro,
  formatQuantity,
  isTseSecured,
  type Order,
  type VoidSelection,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { Button, Card, Field, Muted, Notice, Row, Screen, Sheet, Title } from "../src/components/ui.tsx";
import { listRecentOrders } from "../src/db/repositories.ts";
import { colors, font, space, touch } from "../src/theme.ts";

/** Was vom Beleg zurueckgegeben wird: Position -> Menge in Tausendsteln. */
type Selection = Record<string, number>;

export default function BelegeScreen() {
  const kasse = useKasse();
  const router = useRouter();
  const mayVoid = kasse.can("VOID_RECEIPT");

  const [orders, setOrders] = useState<Order[]>([]);
  const [voiding, setVoiding] = useState<Order | null>(null);
  const [full, setFull] = useState(true);
  const [selection, setSelection] = useState<Selection>({});
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!kasse.ready || !kasse.device) return;
    setOrders(await listRecentOrders(kasse.db(), kasse.device.id, 100));
  }, [kasse]);

  // Nach einem Verkauf oder Storno soll die Liste aktuell sein.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /**
   * Positionen, die zurueckgegeben werden koennen.
   *
   * Pfandpositionen stehen nicht zur Auswahl: sie folgen ihrer Warenposition.
   * Wer den Kaffee zurueckgibt, gibt den Becher mit zurueck - eine getrennte
   * Auswahl waere eine Fehlerquelle ohne Nutzen.
   */
  const voidableLines = useMemo(
    () => (voiding ? voiding.lines.filter((line) => line.depositForLineId == null && line.gross !== 0) : []),
    [voiding],
  );

  /** Auswahl in die Form bringen, die der Kern erwartet. */
  const selections = useMemo<VoidSelection[]>(
    () =>
      Object.entries(selection)
        .filter(([, quantity]) => quantity > 0)
        .map(([lineId, quantity]) => ({ lineId, quantity })),
    [selection],
  );

  /**
   * Betrag der Auswahl - vom Kern gerechnet, nicht ueberschlagen.
   *
   * Ein um einen Cent falscher Teilstorno ist eine Kassendifferenz, und die
   * faellt erst am Abend auf.
   */
  const partialAmount = useMemo(() => {
    if (!voiding || selections.length === 0) return null;
    try {
      const cart = buildPartialVoidCart(voiding, selections);
      return cartTotals(cart, { smallBusiness: kasse.tenant?.smallBusiness ?? false }).total;
    } catch {
      // Eine unzulaessige Auswahl (zu hohe Menge) wird beim Buchen gemeldet;
      // hier wird nur kein Betrag angezeigt.
      return null;
    }
  }, [kasse.tenant?.smallBusiness, selections, voiding]);

  const openVoid = (order: Order): void => {
    setVoiding(order);
    setFull(true);
    setSelection({});
    setReason("");
    setProblem(null);
  };

  const submit = (): void => {
    if (!voiding) return;
    const checkedReason = checkRequiredText(reason, { label: "Der Grund des Stornos", max: 160 });
    if (!checkedReason.ok) {
      setProblem(checkedReason.reason);
      return;
    }
    if (!full && selections.length === 0) {
      setProblem("Es ist keine Position ausgewaehlt.");
      return;
    }

    void (async () => {
      try {
        const created = full
          ? await kasse.voidOrder(voiding, checkedReason.value)
          : await kasse.partialVoid(voiding, selections, checkedReason.value);
        setVoiding(null);
        await load();
        router.push(`/bon/${created.id}`);
      } catch (issue) {
        setProblem((issue as Error).message);
      }
    })();
  };

  return (
    <Screen>
      <FlatList
        contentContainerStyle={styles.content}
        data={orders}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={
          <View style={styles.header}>
            <Title>Belege</Title>
            {!mayVoid ? <Muted>Stornieren ist fuer Ihren Zugang nicht freigegeben.</Muted> : null}
          </View>
        }
        ListEmptyComponent={<Muted>Noch keine Belege auf diesem Geraet.</Muted>}
        renderItem={({ item }) => (
          <Card style={styles.row}>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(`/bon/${item.id}`)}
              style={styles.rowMain}
            >
              <View style={styles.flex}>
                <Text style={styles.number}>{item.receiptNumber}</Text>
                <Muted>
                  {(item.paidAt ?? item.startedAt).replace("T", " ").slice(0, 19)}
                  {item.serviceMode === "DINE_IN" ? " · vor Ort" : ""}
                  {item.voidsOrderId ? " · Storno" : ""}
                </Muted>
                {item.customerName ? <Muted>{item.customerName}</Muted> : null}
                {!isTseSecured(item) ? <Text style={styles.unsecured}>ohne TSE-Signatur</Text> : null}
              </View>
              <Text style={styles.amount}>{formatEuro(item.total)}</Text>
            </Pressable>
            {item.voidsOrderId == null && item.total > 0 ? (
              <Button disabled={!mayVoid} label="Stornieren" onPress={() => openVoid(item)} tone="danger" />
            ) : null}
          </Card>
        )}
      />

      {/* --- Storno ----------------------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Abbrechen" onPress={() => setVoiding(null)} style={styles.flex} />
            <Button
              label={full ? "Ganz stornieren" : "Teilstorno buchen"}
              loading={kasse.busy}
              onPress={submit}
              style={styles.flex}
              tone="danger"
            />
          </View>
        }
        onClose={() => setVoiding(null)}
        open={voiding !== null}
        title={`Beleg ${voiding?.receiptNumber ?? ""} stornieren`}
        wide
      >
        {voiding ? (
          <>
            <Row bold label="Belegsumme" value={formatEuro(voiding.total)} />
            <Muted>
              Es entsteht ein neuer Beleg mit eigener Nummer. Der urspruengliche Beleg bleibt unveraendert bestehen -
              das verlangt § 146 Abs. 4 AO.
            </Muted>

            <View style={styles.modeRow}>
              <ModeButton active={full} label="Ganzer Beleg" onPress={() => setFull(true)} />
              <ModeButton active={!full} label="Einzelne Positionen" onPress={() => setFull(false)} />
            </View>

            {!full ? (
              <>
                <Muted>
                  Menge je Position waehlen. Pfand folgt seiner Warenposition und wird anteilig mit
                  zurueckgegeben.
                </Muted>
                <ScrollView style={styles.lines}>
                  {voidableLines.map((line) => {
                    const chosen = selection[line.id] ?? 0;
                    const step = line.quantity < 0 ? -ONE : ONE;
                    return (
                      <View key={line.id} style={styles.lineRow}>
                        <View style={styles.flex}>
                          <Text style={styles.lineName}>{line.name}</Text>
                          <Muted>
                            verkauft {formatQuantity(line.quantity)} · {formatEuro(line.gross)}
                          </Muted>
                        </View>
                        <View style={styles.stepper}>
                          <Pressable
                            accessibilityLabel={`Weniger ${line.name}`}
                            accessibilityRole="button"
                            onPress={() =>
                              setSelection((current) => {
                                const next = { ...current };
                                const value = (next[line.id] ?? 0) - step;
                                if (Math.abs(value) < Math.abs(step)) delete next[line.id];
                                else next[line.id] = value;
                                setProblem(null);
                                return next;
                              })
                            }
                            style={styles.stepButton}
                          >
                            <Text style={styles.stepLabel}>−</Text>
                          </Pressable>
                          <Text style={styles.chosen}>{chosen === 0 ? "–" : formatQuantity(chosen)}</Text>
                          <Pressable
                            accessibilityLabel={`Mehr ${line.name}`}
                            accessibilityRole="button"
                            onPress={() =>
                              setSelection((current) => {
                                const value = (current[line.id] ?? 0) + step;
                                // Nicht mehr zurueckgeben als verkauft wurde -
                                // der Kern lehnt das ab, aber der Bediener soll
                                // es schon beim Tippen merken.
                                if (Math.abs(value) > Math.abs(line.quantity)) return current;
                                setProblem(null);
                                return { ...current, [line.id]: value };
                              })
                            }
                            style={styles.stepButton}
                          >
                            <Text style={styles.stepLabel}>+</Text>
                          </Pressable>
                        </View>
                      </View>
                    );
                  })}
                </ScrollView>
                <Row
                  bold
                  label="Wird zurueckgegeben"
                  tone="danger"
                  value={partialAmount == null ? "–" : formatEuro(partialAmount)}
                />
              </>
            ) : null}

            <Field
              label="Grund"
              multiline
              onChangeText={(value) => {
                setProblem(null);
                setReason(value);
              }}
              placeholder="z. B. falsch gebucht, Kunde hat zurueckgegeben"
              problem={problem}
              value={reason}
            />

            {voiding.payments[0]?.method !== "CASH" ? (
              <Notice tone="warning">
                Der Beleg wurde nicht bar bezahlt. Die Rueckzahlung wird auf demselben Weg gebucht - ob das Geld
                tatsaechlich zurueckgeht, haengt am Terminal des Anbieters. Ohne Rueckbuchung am Terminal bitte bar
                auszahlen.
              </Notice>
            ) : null}
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}

function ModeButton({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.mode, active ? styles.modeActive : null]}
    >
      <Text style={[styles.modeLabel, active ? styles.modeLabelActive : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: space.sm, padding: space.md },
  header: { gap: space.xs },
  row: { gap: space.sm },
  rowMain: { alignItems: "center", flexDirection: "row", gap: space.sm, justifyContent: "space-between" },
  number: { color: colors.text, fontSize: font.label, fontWeight: "700" },
  amount: { color: colors.text, fontSize: font.amount, fontWeight: "800" },
  unsecured: { color: colors.danger, fontSize: font.small, fontWeight: "700" },
  actions: { flexDirection: "row", gap: space.sm },

  modeRow: { flexDirection: "row", gap: space.sm },
  mode: {
    alignItems: "center",
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 44,
  },
  modeActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  modeLabel: { color: colors.text, fontSize: font.body, fontWeight: "600" },
  modeLabelActive: { color: colors.textOnAccent },

  lines: { maxHeight: 260 },
  lineRow: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: space.sm,
    minHeight: touch.row,
  },
  lineName: { color: colors.text, fontSize: font.body, fontWeight: "600" },
  stepper: { alignItems: "center", flexDirection: "row", gap: space.xs },
  stepButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: 6,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  stepLabel: { color: colors.text, fontSize: font.title, fontWeight: "700" },
  chosen: { color: colors.text, fontSize: font.body, fontWeight: "700", minWidth: 48, textAlign: "center" },
});
