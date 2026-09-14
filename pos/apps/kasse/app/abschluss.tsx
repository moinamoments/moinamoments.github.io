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
 *
 * Der Anfangsbestand kommt aus dem **Kassenbuch** dieser Schicht, nicht aus dem
 * letzten Abschluss. Der Unterschied ist kein Feinschliff: wer morgens
 * Wechselgeld einlegt und es nicht als Eroeffnung buchen kann, hat abends einen
 * Ueberschuss in der Hoehe des Wechselgelds - und sucht einen Fehler, den es
 * nicht gibt. Ebenso gehen Entnahmen und Einlagen der Schicht in den
 * Soll-Bestand ein.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  CASH_MOVEMENT_LABELS,
  type ClosingReport,
  type Order,
  buildClosing,
  buildExport,
  countCash,
  formatAmount,
  formatEuro,
  isoWithOffset,
  openingCashFrom,
  outboxKey,
  parkedSalesBlockingClosing,
  renderClosingText,
  summarizeCashbook,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import {
  listOpenForClosing,
  nextSequence,
  peekSequence,
  saveClosing,
  upsertOutboxEntry,
} from "../src/db/repositories.ts";
import { Button, Card, Label, Muted, Notice, Row, Screen, Title } from "../src/components/ui.tsx";
import { Zaehlprotokoll, toCashCount, type CashCounts } from "../src/components/Zaehlprotokoll.tsx";
import { colors, font, space } from "../src/theme.ts";

export default function AbschlussScreen() {
  const kasse = useKasse();
  const [orders, setOrders] = useState<Order[]>([]);
  const [counts, setCounts] = useState<CashCounts>({});
  const [report, setReport] = useState<ClosingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextNumber, setNextNumber] = useState(1);

  const load = useCallback(async () => {
    if (!kasse.ready || !kasse.device) return;
    const handle = kasse.db();
    const [pending, closings] = await Promise.all([
      listOpenForClosing(handle, kasse.device.id),
      peekSequence(handle, kasse.device.id, "closing"),
    ]);
    setOrders(pending);
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

  const cashCount = useMemo(() => toCashCount(counts), [counts]);

  const counted = cashCount.length > 0 ? countCash(cashCount) : null;
  const cashSales = useMemo(
    () =>
      orders
        .flatMap((order) => order.payments)
        .filter((payment) => payment.method === "CASH")
        .reduce((sum, payment) => sum + payment.amount, 0),
    [orders],
  );

  // Anfangsbestand und Bewegungen kommen aus dem Kassenbuch der Schicht.
  const openingCash = useMemo(() => openingCashFrom(kasse.cashMovements), [kasse.cashMovements]);
  const cashbook = useMemo(() => summarizeCashbook(kasse.cashMovements), [kasse.cashMovements]);
  const expected = openingCash + cashSales + cashbook.netMovements;

  /**
   * Geparkte Vorgaenge blockieren den Abschluss nicht, muessen aber genannt
   * werden: ein geparkter Vorgang ist noch kein Beleg und taucht im Z-Bericht
   * nicht auf - er wuerde stillschweigend in den naechsten Tag rutschen.
   */
  const parkedWarning = useMemo(() => parkedSalesBlockingClosing(kasse.parked), [kasse.parked]);

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
        cashMovements: [...kasse.cashMovements],
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
        {parkedWarning ? <Notice tone="warning">{parkedWarning}</Notice> : null}
        {openingCash === 0 ? (
          <Notice tone="warning">
            Fuer diese Schicht ist keine Tageseroeffnung gebucht. Der Soll-Bestand rechnet dann ohne Wechselgeld, und
            ein Ueberschuss in dessen Hoehe ist kein Fehler, sondern die fehlende Eroeffnung. Zu buchen unter
            Einstellungen › Kassenbuch.
          </Notice>
        ) : null}

        <Card style={styles.card}>
          <Row label="Abschluss Nr." value={String(nextNumber)} />
          <Row label="Offene Belege" value={String(orders.length)} />
          <Row label="Barumsatz" value={formatAmount(cashSales)} />
          <Row label="Anfangsbestand" value={formatAmount(openingCash)} />
          {kasse.cashMovements
            .filter((movement) => movement.type !== "OPENING")
            .map((movement) => (
              <Row
                key={movement.id}
                label={`${CASH_MOVEMENT_LABELS[movement.type]}: ${movement.reason}`}
                tone={movement.amount < 0 ? "danger" : "normal"}
                value={formatAmount(movement.amount)}
              />
            ))}
          <Row bold label="Soll-Kassenbestand" value={formatAmount(expected)} />
          {orders.length === 0 ? <Muted>Alle Belege sind abgeschlossen.</Muted> : null}
        </Card>

        <Card style={styles.card}>
          <Label>Zaehlprotokoll</Label>
          <Zaehlprotokoll counts={counts} onChange={setCounts} />

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
          disabled={orders.length === 0 || !kasse.can("CLOSE_DAY")}
        />
        {!kasse.can("CLOSE_DAY") ? <Muted>Den Kassenabschluss darf Ihr Zugang nicht erstellen.</Muted> : null}

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

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.md },
  card: { gap: space.sm },
  mono: { color: colors.text, fontFamily: "monospace", fontSize: 12 },
});
