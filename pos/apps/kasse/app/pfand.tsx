/**
 * Pfandruecknahme.
 *
 * Eigener Bildschirm, weil die Ruecknahme ohne Kauf ein eigener Vorgang ist:
 * der Kunde bringt Becher zurueck und bekommt Geld. Das ist kein Storno eines
 * alten Belegs - die Ware bleibt verkauft, nur das Pfand wandert zurueck.
 *
 * Die Rueckgabe landet als Position im laufenden Warenkorb. Damit kann sie im
 * gleichen Vorgang gegen einen neuen Kauf gerechnet werden ("zwei Becher
 * zurueck, dafuer zwei neue Kaffee") - genau so passiert es am Stand.
 */

import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ONE, type DepositItem, formatAmount, formatEuro, isDeposit } from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { Button, Card, Muted, Notice, Screen, Title } from "../src/components/ui.tsx";
import { colors, font, space } from "../src/theme.ts";

export default function PfandScreen() {
  const kasse = useKasse();
  const router = useRouter();
  const items = kasse.deposits.all();
  const returns = kasse.totals.lines.filter((line) => line.businessCaseType === "PfandRueckzahlung");

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Pfand zuruecknehmen</Title>

        {!kasse.can("REFUND_DEPOSIT") ? (
          <Notice tone="warning">
            Pfand zurueckzunehmen ist fuer Ihren Zugang nicht freigegeben - dabei wird Geld ausgezahlt. Der Inhaber
            kann das Recht erteilen.
          </Notice>
        ) : null}

        {items.length === 0 ? (
          <Notice tone="warning">
            Es ist kein Pfandartikel angelegt. Unter Artikel einen Artikel anlegen und dort
            "Dieser Artikel ist ein Pfandartikel" einschalten - Betrag und Bezeichnung bestimmt der
            Betrieb selbst.
          </Notice>
        ) : null}

        {items.map((item) => (
          <DepositRow item={item} key={item.productId} />
        ))}

        {returns.length > 0 ? (
          <Card style={styles.summary}>
            <Title>Im laufenden Vorgang</Title>
            {returns.map((line) => (
              <View key={line.lineId} style={styles.summaryRow}>
                <Text style={styles.summaryName}>{line.name}</Text>
                <Text style={styles.summaryAmount}>{formatAmount(line.gross)}</Text>
              </View>
            ))}
            <View style={styles.summaryRow}>
              <Text style={styles.summaryName}>Summe des Vorgangs</Text>
              <Text style={styles.summaryTotal}>{formatEuro(kasse.totals.total)}</Text>
            </View>
            <Muted>
              {kasse.totals.total < 0
                ? "Negative Summe: es wird Geld ausgezahlt. Der Beleg wird trotzdem erstellt und von der TSE abgesichert."
                : "Die Rueckgabe wird mit dem Einkauf verrechnet."}
            </Muted>
            <Button label="Zur Kasse" onPress={() => router.push("/")} tone="accent" />
          </Card>
        ) : null}

        <Muted>
          Jede Ruecknahme ist ein Geschaeftsvorfall und wird als solcher
          aufgezeichnet (Art "PfandRueckzahlung"). Sie erscheint getrennt vom
          Warenumsatz im Kassenabschluss.
        </Muted>
      </ScrollView>
    </Screen>
  );
}

function DepositRow({ item }: { item: DepositItem }) {
  const kasse = useKasse();
  const allowed = kasse.can("REFUND_DEPOSIT");
  const taken = kasse.totals.lines
    .filter((line) => isDeposit(line) && line.businessCaseType === "PfandRueckzahlung" && line.productId === item.productId)
    .reduce((sum, line) => sum - line.quantity, 0);

  return (
    <Card style={styles.row}>
      <View style={styles.rowHead}>
        <View>
          <Text style={styles.name}>{item.name}</Text>
          <Muted>{formatEuro(item.price)} je Stueck</Muted>
        </View>
        {taken > 0 ? <Text style={styles.counter}>{taken / ONE} zurueck</Text> : null}
      </View>
      <View style={styles.buttons}>
        {[1, 2, 5, 10].map((count) => (
          <Button
            disabled={!allowed}
            key={count}
            label={`+${count}`}
            onPress={() => kasse.returnDeposit(item, count * ONE)}
            style={styles.button}
            subtitle={formatAmount(item.price * count)}
          />
        ))}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.md },
  row: { gap: space.md },
  rowHead: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  name: { color: colors.text, fontSize: font.label, fontWeight: "700" },
  counter: { color: colors.deposit, fontSize: font.body, fontWeight: "700" },
  buttons: { flexDirection: "row", gap: space.sm },
  button: { flex: 1 },
  summary: { gap: space.sm },
  summaryRow: { flexDirection: "row", justifyContent: "space-between" },
  summaryName: { color: colors.text, fontSize: font.body },
  summaryAmount: { color: colors.deposit, fontSize: font.body, fontWeight: "700" },
  summaryTotal: { color: colors.text, fontSize: font.label, fontWeight: "800" },
});
