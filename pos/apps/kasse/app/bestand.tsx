/**
 * Bestand.
 *
 * Wareneingang buchen, zaehlen, Schwund und Eigenverbrauch erfassen - und
 * danach nachsehen, wohin die Ware gegangen ist.
 *
 * Der Bestand wird hier **nie gesetzt**, sondern immer fortgeschrieben: jede
 * Aenderung ist eine Zeile mit Grund, Menge, Zeitpunkt und Bediener. Auch die
 * Zaehlung ist eine solche Zeile - gebucht wird die Differenz, nicht der
 * Zielwert. Sonst steht am Monatsende eine Zahl da, die niemand erklaeren kann,
 * und die Frage "wo sind die acht Flaschen" ist nicht mehr zu beantworten.
 *
 * Bewusst zugelassen: ein Verkauf kann in den negativen Bestand laufen. Die
 * Kasse verweigert keinen Verkauf, weil eine Zahl nicht stimmt - der Kunde
 * steht davor und die Ware ist offensichtlich da. Ein negativer Bestand wird
 * angezeigt, damit er auffaellt.
 */

import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  STOCK_REASON_LABELS,
  buildCountCorrection,
  buildMovement,
  checkDecimalQuantity,
  checkOptionalText,
  checkPieces,
  formatQuantity,
  formatStock,
  lowStockProducts,
  stockState,
  summarizeStock,
  tracksStock,
  type Product,
  type StockMovement,
  type StockMovementReason,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import {
  Badge,
  Button,
  Card,
  Field,
  ListRow,
  Muted,
  Notice,
  Row,
  Screen,
  Segmented,
  Sheet,
  Title,
} from "../src/components/ui.tsx";
import { applyStockMovement, listStockMovements } from "../src/db/repositories.ts";
import { colors, font, space } from "../src/theme.ts";

/** Gruende, die von Hand gebucht werden. Verkauf und Storno kommen vom Beleg. */
const MANUAL_REASONS: readonly StockMovementReason[] = ["PURCHASE", "LOSS", "OWN_USE"];

type Mode = "MOVE" | "COUNT";

export default function BestandScreen() {
  const kasse = useKasse();
  const allowed = kasse.can("MANAGE_STOCK");

  const [movements, setMovements] = useState<readonly StockMovement[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);
  const [mode, setMode] = useState<Mode>("MOVE");
  const [reason, setReason] = useState<StockMovementReason>("PURCHASE");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const tracked = useMemo(() => kasse.products.filter(tracksStock), [kasse.products]);
  const summary = useMemo(() => summarizeStock([...kasse.products]), [kasse.products]);
  const low = useMemo(() => lowStockProducts([...kasse.products]), [kasse.products]);

  const load = useCallback(async () => {
    if (!kasse.ready) return;
    setMovements(await listStockMovements(kasse.db(), { limit: 150 }));
  }, [kasse]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const nameOf = useCallback(
    (productId: string): string => kasse.products.find((item) => item.id === productId)?.name ?? "unbekannter Artikel",
    [kasse.products],
  );

  const openFor = (product: Product): void => {
    setSelected(product);
    setMode("MOVE");
    setReason("PURCHASE");
    setQuantity("");
    setNote("");
    setProblem(null);
  };

  /**
   * Menge einlesen.
   *
   * Stueckartikel ganzzahlig, Gewichts- und Litermengen mit drei
   * Nachkommastellen - wie im Rest der App. 0,35 kg sind 350 Tausendstel.
   */
  const readQuantity = (product: Product): number | null => {
    const checked =
      product.unit === "PIECE"
        ? checkPieces(quantity, { label: "Die Stueckzahl" })
        : checkDecimalQuantity(quantity, { label: "Die Menge" });
    if (!checked.ok) {
      setProblem(checked.reason);
      return null;
    }
    return checked.value;
  };

  const save = (): void => {
    if (!selected || !kasse.store || !kasse.user) return;
    const value = readQuantity(selected);
    if (value == null) return;

    const checkedNote = checkOptionalText(note, { label: "Die Bemerkung", max: 160 });
    if (!checkedNote.ok) {
      setProblem(checkedNote.reason);
      return;
    }

    void (async () => {
      try {
        const handle = kasse.db();
        const base = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          product: selected,
          storeId: kasse.store!.id,
          userId: kasse.user!.id,
          note: checkedNote.value,
          createdAt: kasse.now(),
        };

        if (mode === "COUNT") {
          const result = buildCountCorrection({ ...base, countedStock: value });
          if (!result) {
            setProblem("Der gezaehlte Bestand stimmt mit dem gefuehrten ueberein - es gibt nichts zu buchen.");
            return;
          }
          await applyStockMovement(handle, result.movement);
          await kasse.audit("STOCK_ADJUSTED", {
            subject: selected.name,
            detail: `Zaehlung: ${formatQuantity(result.movement.quantity)} (gezaehlt ${formatQuantity(value)})`,
          });
        } else {
          // Schwund und Eigenverbrauch mindern, Wareneingang erhoeht. Das
          // Vorzeichen gehoert nicht in die Eingabe: wer bei "Schwund" eine
          // negative Zahl eintippt, meint trotzdem einen Abgang.
          const signed = reason === "PURCHASE" ? value : -value;
          const result = buildMovement({ ...base, quantity: signed, reason });
          await applyStockMovement(handle, result.movement);
          await kasse.audit("STOCK_ADJUSTED", {
            subject: selected.name,
            detail: `${STOCK_REASON_LABELS[reason]}: ${formatQuantity(signed)}`,
          });
        }

        setSelected(null);
        await kasse.reload();
        await load();
      } catch (issue) {
        setProblem((issue as Error).message);
      }
    })();
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Bestand</Title>

        {!allowed ? (
          <Notice tone="warning">
            Bestand zu buchen ist fuer Ihren Zugang nicht freigegeben. Die Bestaende sind hier nur zu sehen.
          </Notice>
        ) : null}

        <Card style={styles.card}>
          <Row label="Artikel mit Bestandsfuehrung" value={String(summary.tracked)} />
          <Row label="unter Meldebestand" tone={summary.low > 0 ? "warning" : "normal"} value={String(summary.low)} />
          <Row label="leer" tone={summary.empty > 0 ? "warning" : "normal"} value={String(summary.empty)} />
          <Row label="negativ" tone={summary.negative > 0 ? "danger" : "normal"} value={String(summary.negative)} />
        </Card>

        {low.length > 0 ? (
          <Card style={styles.card}>
            <Title>Nachbestellen</Title>
            {low.map((product) => (
              <ListRow
                key={product.id}
                onPress={allowed ? () => openFor(product) : undefined}
                subtitle={product.lowStockThreshold != null ? `Meldebestand ${formatQuantity(product.lowStockThreshold)}` : null}
                title={product.name}
                tone="warning"
                value={formatStock(product)}
              />
            ))}
          </Card>
        ) : null}

        <Card>
          <Title>Bestaende</Title>
          {tracked.length === 0 ? (
            <Muted>
              Fuer keinen Artikel ist die Bestandsfuehrung eingeschaltet. Das geschieht im Artikel selbst, unter
              "Bestand fuehren".
            </Muted>
          ) : null}
          {tracked.map((product) => {
            const state = stockState(product);
            return (
              <ListRow
                key={product.id}
                onPress={allowed ? () => openFor(product) : undefined}
                subtitle={product.sku ? `Artikelnummer ${product.sku}` : null}
                title={product.name}
                tone={state === "NEGATIVE" ? "danger" : state === "OK" ? "normal" : "danger"}
                value={formatStock(product)}
              />
            );
          })}
        </Card>

        <Card>
          <Title>Journal</Title>
          <Muted>
            Jede Veraenderung mit Grund und Bediener. Die Zeilen werden nie geaendert oder geloescht - auch nicht von
            dieser App.
          </Muted>
          {movements.length === 0 ? <Muted>Noch keine Bewegung.</Muted> : null}
          {movements.map((movement) => (
            <View key={movement.id}>
              <ListRow
                subtitle={`${movement.createdAt.replace("T", " ").slice(0, 16)} · ${STOCK_REASON_LABELS[movement.reason]} · Bestand danach ${formatQuantity(movement.resultingStock)}`}
                title={nameOf(movement.productId)}
                tone={movement.quantity < 0 ? "danger" : "success"}
                value={`${movement.quantity > 0 ? "+" : ""}${formatQuantity(movement.quantity)}`}
              />
              {movement.note ? <Text style={styles.note}>{movement.note}</Text> : null}
            </View>
          ))}
        </Card>
      </ScrollView>

      {/* --- Buchen ---------------------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Abbrechen" onPress={() => setSelected(null)} style={styles.flex} />
            <Button label="Buchen" onPress={save} style={styles.flex} tone="accent" />
          </View>
        }
        onClose={() => setSelected(null)}
        open={selected !== null}
        title={selected?.name ?? "Bestand buchen"}
        wide
      >
        {selected ? (
          <>
            <View style={styles.stateRow}>
              <Row bold label="Gefuehrter Bestand" value={formatStock(selected) ?? "-"} />
              {stockState(selected) === "NEGATIVE" ? <Badge label="negativ" tone="danger" /> : null}
            </View>

            <Segmented
              onChange={(value) => {
                setMode(value);
                setProblem(null);
                setQuantity("");
              }}
              options={[
                { value: "MOVE", label: "Bewegung buchen" },
                { value: "COUNT", label: "Zaehlung" },
              ]}
              value={mode}
            />

            {mode === "MOVE" ? (
              <>
                <Segmented
                  onChange={(value) => {
                    setReason(value);
                    setProblem(null);
                  }}
                  options={MANUAL_REASONS.map((item) => ({ value: item, label: STOCK_REASON_LABELS[item] }))}
                  value={reason}
                />
                <Muted>
                  {reason === "PURCHASE"
                    ? "Wareneingang erhoeht den Bestand - Menge ohne Vorzeichen eintragen."
                    : reason === "LOSS"
                      ? "Schwund, Bruch, Verderb. Mindert den Bestand."
                      : "Eigenverbrauch, Personalverzehr, Probe. Mindert den Bestand."}
                </Muted>
                <Field
                  keyboardType={selected.unit === "PIECE" ? "numeric" : "decimal-pad"}
                  label={selected.unit === "PIECE" ? "Stueckzahl" : "Menge"}
                  onChangeText={(value) => {
                    setProblem(null);
                    setQuantity(value);
                  }}
                  placeholder={selected.unit === "PIECE" ? "z. B. 24" : "z. B. 2,500"}
                  problem={problem}
                  value={quantity}
                />
              </>
            ) : (
              <>
                <Muted>
                  Gezaehlten Bestand eintragen. Gebucht wird die Differenz zum gefuehrten Bestand - so steht im
                  Journal, was gefehlt hat.
                </Muted>
                <Field
                  keyboardType={selected.unit === "PIECE" ? "numeric" : "decimal-pad"}
                  label="Gezaehlt"
                  onChangeText={(value) => {
                    setProblem(null);
                    setQuantity(value);
                  }}
                  placeholder={selected.unit === "PIECE" ? "z. B. 18" : "z. B. 1,750"}
                  problem={problem}
                  value={quantity}
                />
              </>
            )}

            <Field
              label="Bemerkung"
              multiline
              onChangeText={setNote}
              placeholder={
                mode === "COUNT" ? "z. B. Inventur Monatsende" : reason === "PURCHASE" ? "z. B. Lieferung Metro, Rechnung 4711" : "z. B. Kiste gefallen"
              }
              value={note}
            />
            <Muted>
              Freiwillig, aber hilfreich: die Bemerkung steht im Journal und erklaert in einem halben Jahr, was
              passiert ist.
            </Muted>
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: space.md, padding: space.md },
  card: { gap: space.xs },
  actions: { flexDirection: "row", gap: space.sm },
  stateRow: { alignItems: "center", flexDirection: "row", gap: space.sm },
  note: { color: colors.textMuted, fontSize: font.small, paddingBottom: space.xs },
});
