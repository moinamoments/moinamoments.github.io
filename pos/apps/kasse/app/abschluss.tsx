/**
 * Kassenabschluss.
 *
 * Am Ende des Tages: zaehlen, abschliessen, Bericht ansehen. Der Abschluss ist
 * die Bezugsgroesse der DSFinV-K - jeder Beleg gehoert zu genau einem, und ein
 * abgeschlossener Zeitraum wird nicht wieder geoeffnet.
 *
 * Das Zaehlprotokoll ist freiwillig, aber sinnvoll: erst dadurch entsteht die
 * Differenz zwischen gerechnetem und tatsaechlichem Bestand. Ein Fehlbetrag
 * wird angezeigt, nicht versteckt - genau dafuer zaehlt man.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  type CashCountEntry,
  type ClosingReport,
  DENOMINATIONS,
  type Order,
  buildClosing,
  buildExport,
  countCash,
  formatAmount,
  formatEuro,
  isoWithOffset,
  outboxKey,
  renderClosingText,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import {
  lastCountedCash,
  listOpenForClosing,
  nextSequence,
  peekSequence,
  saveClosing,
  upsertOutboxEntry,
} from "../src/db/repositories.ts";
import { Button, Card, Label, Muted, Notice, Screen, Title } from "../src/components/ui.tsx";
import { colors, font, radius, space } from "../src/theme.ts";

export default function AbschlussScreen() {
  const kasse = useKasse();
  const [orders, setOrders] = useState<Order[]>([]);
  const [openingCash, setOpeningCash] = useState(0);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [report, setReport] = useState<ClosingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextNumber, setNextNumber] = useState(1);

  const load = useCallback(async () => {
    if (!kasse.ready || !kasse.device) return;
    const handle = kasse.db();
    const [pending, opening, closings] = await Promise.all([
      listOpenForClosing(handle, kasse.device.id),
      lastCountedCash(handle, kasse.device.id),
      peekSequence(handle, kasse.device.id, "closing"),
    ]);
    setOrders(pending);
    setOpeningCash(opening);
    setNextNumber(closings + 1);
  }, [kasse]);

  useEffect(() => {
    void load();
  }, [load]);
  useFocusEffect(
    useCallback(() => {
      void load();
      // Ein frueher erzeugter Bericht gilt fuer einen Zeitraum, der nun
      // vorbei ist - er wird beim Betreten des Bildschirms verworfen.
      setReport(null);
    }, [load]),
  );

  const cashCount: CashCountEntry[] = useMemo(
    () =>
      DENOMINATIONS.map((denomination) => ({
        denomination,
        count: Number.parseInt(counts[denomination] ?? "", 10) || 0,
      })).filter((entry) => entry.count > 0),
    [counts],
  );

  const counted = cashCount.length > 0 ? countCash(cashCount) : null;
  const cashSales = useMemo(
    () =>
      orders
        .flatMap((order) => order.payments)
        .filter((payment) => payment.method === "CASH")
        .reduce((sum, payment) => sum + payment.amount, 0),
    [orders],
  );
  const expected = openingCash + cashSales;

  const close = async () => {
    if (!kasse.tenant || !kasse.store || !kasse.device || !kasse.user) return;
    if (orders.length === 0) {
      setError("Es gibt keine Belege, die noch nicht abgeschlossen sind.");
      return;
    }
    setError(null);

    try {
      const handle = kasse.db();
      const now = isoWithOffset(new Date(), kasse.tenant.timeZone);
      const number = await nextSequence(handle, kasse.device.id, "closing");
      const built = buildClosing({
        tenant: kasse.tenant,
        store: kasse.store,
        device: kasse.device,
        userId: kasse.user.id,
        closingId: `z-${kasse.device.id}-${number}`,
        number,
        from: orders[0]?.startedAt ?? now,
        to: now,
        createdAt: now,
        orders,
        openingCash,
        cashCount,
      });

      await saveClosing(handle, built.closing, JSON.stringify(built));
      await upsertOutboxEntry(handle, {
        key: outboxKey("closing", built.closing.id),
        kind: "closing",
        entityId: built.closing.id,
        tenantId: built.closing.tenantId,
        payload: JSON.stringify(built),
        createdAt: now,
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
      });

      setReport(built);
      setCounts({});
      await kasse.reload();
      await load();
    } catch (issue) {
      setError((issue as Error).message);
    }
  };

  /**
   * DSFinV-K-Export ansehen.
   *
   * Noch ohne Datei-Ausgabe: der Export wird erzeugt und seine Dateigroessen
   * angezeigt, damit pruefbar ist, dass er entsteht. Das Schreiben auf ein
   * Speichermedium und das Packen als ZIP sind der naechste Schritt
   * (docs/ROADMAP.md).
   */
  const showExport = () => {
    if (!report || !kasse.tenant || !kasse.store || !kasse.device) return;
    try {
      const files = buildExport({
        tenant: kasse.tenant,
        store: kasse.store,
        device: kasse.device,
        closings: [{ report, orders }],
      });
      Alert.alert(
        "DSFinV-K-Export erzeugt",
        files.map((file) => `${file.name}: ${file.content.length} Zeichen`).join("\n"),
      );
    } catch (issue) {
      Alert.alert("Export nicht moeglich", (issue as Error).message);
    }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Kassenabschluss</Title>
        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Card style={styles.card}>
          <Row label={`Abschluss Nr.`} value={String(nextNumber)} />
          <Row label="Offene Belege" value={String(orders.length)} />
          <Row label="Barumsatz" value={formatAmount(cashSales)} />
          <Row label="Anfangsbestand" value={formatAmount(openingCash)} />
          <Row bold label="Soll-Kassenbestand" value={formatAmount(expected)} />
          {orders.length === 0 ? <Muted>Alle Belege sind abgeschlossen.</Muted> : null}
        </Card>

        <Card style={styles.card}>
          <Label>Zaehlprotokoll</Label>
          <Muted>Stueckzahlen eintragen. Leer lassen heisst: nicht gezaehlt.</Muted>
          <View style={styles.denominations}>
            {DENOMINATIONS.map((denomination) => (
              <View key={denomination} style={styles.denomination}>
                <Text style={styles.denominationLabel}>{formatAmount(denomination)}</Text>
                <TextInput
                  accessibilityLabel={`Anzahl ${formatAmount(denomination)}`}
                  keyboardType="number-pad"
                  onChangeText={(value) =>
                    setCounts((current) => ({ ...current, [denomination]: value.replace(/\D/g, "") }))
                  }
                  placeholder="0"
                  placeholderTextColor={colors.textMuted}
                  style={styles.denominationInput}
                  value={counts[denomination] ?? ""}
                />
              </View>
            ))}
          </View>

          {counted != null ? (
            <>
              <Row label="Gezaehlt" value={formatAmount(counted)} />
              <Row
                bold
                label={counted - expected === 0 ? "Differenz" : counted - expected > 0 ? "Ueberschuss" : "Fehlbetrag"}
                value={formatAmount(counted - expected)}
                tone={counted - expected === 0 ? "normal" : counted - expected > 0 ? "warning" : "danger"}
              />
            </>
          ) : null}
        </Card>

        <Button
          label="Abschluss erstellen"
          onPress={() => void close()}
          tone="accent"
          disabled={orders.length === 0}
        />

        {report ? (
          <Card style={styles.card}>
            <Title>Z-Bericht Nr. {report.closing.number}</Title>
            {report.unsecuredOrderCount > 0 ? (
              <Notice tone="danger">
                {report.unsecuredOrderCount} Beleg(e) ohne TSE-Signatur. Der Ausfall ist zu dokumentieren.
              </Notice>
            ) : null}
            <Text style={styles.mono}>{renderClosingText(report, 38)}</Text>
            <Button label="DSFinV-K-Export erzeugen" onPress={showExport} />
          </Card>
        ) : null}

        <Muted>
          Ein erstellter Abschluss laesst sich nicht zuruecknehmen. Die enthaltenen Belege sind danach
          fest zugeordnet - das verlangt die DSFinV-K.
        </Muted>
      </ScrollView>
    </Screen>
  );
}

function Row({
  label,
  value,
  bold,
  tone = "normal",
}: {
  label: string;
  value: string;
  bold?: boolean;
  tone?: "normal" | "warning" | "danger";
}) {
  const color = tone === "danger" ? colors.danger : tone === "warning" ? colors.warning : colors.text;
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, bold && styles.bold]}>{label}</Text>
      <Text style={[styles.rowValue, { color }, bold && styles.bold]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.md },
  card: { gap: space.sm },
  row: { flexDirection: "row", justifyContent: "space-between" },
  rowLabel: { color: colors.text, fontSize: font.body },
  rowValue: { fontSize: font.body, fontVariant: ["tabular-nums"], fontWeight: "600" },
  bold: { fontSize: font.label, fontWeight: "800" },
  denominations: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  denomination: { gap: space.xs, width: 84 },
  denominationLabel: { color: colors.textMuted, fontSize: font.small, textAlign: "center" },
  denominationInput: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.text,
    fontSize: font.label,
    minHeight: 48,
    textAlign: "center",
  },
  mono: { color: colors.text, fontFamily: "monospace", fontSize: 12 },
});
