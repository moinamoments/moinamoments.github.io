/**
 * Bonanzeige.
 *
 * Die Belegausgabepflicht (§ 146a Abs. 2 AO) verlangt, dass dem Kunden ein
 * Beleg *angeboten* wird - nicht, dass er gedruckt wird. Ein Bon auf dem
 * Bildschirm, den der Kunde ansehen oder abfotografieren kann, erfuellt das.
 * Deshalb ist diese Seite der Regelfall und der Druck die Ergaenzung.
 *
 * Der QR-Code enthaelt genau die Angaben, die das Finanzamt zur Pruefung
 * braucht. Ist er da, sind die einzelnen TSE-Zeilen entbehrlich - sie stehen
 * hier trotzdem, weil ein Kunde ohne Lesegeraet sonst nichts davon sieht.
 */

import React, { useEffect, useState } from "react";
import { ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import QRCode from "react-native-qrcode-svg";
import {
  type Order,
  type ReceiptView,
  buildReceiptView,
  formatAmount,
  renderReceiptText,
} from "@kp/core";
import { useKasse } from "../../src/state/KasseProvider.tsx";
import { getOrder } from "../../src/db/repositories.ts";
import { Button, Card, Muted, Notice, Screen, Title } from "../../src/components/ui.tsx";
import { colors, font, space } from "../../src/theme.ts";

export default function BonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const kasse = useKasse();
  const [order, setOrder] = useState<Order | null>(null);
  const [view, setView] = useState<ReceiptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reprint, setReprint] = useState(false);

  useEffect(() => {
    if (!kasse.ready || !id || !kasse.tenant || !kasse.store || !kasse.device) return;
    void (async () => {
      try {
        const loaded = await getOrder(kasse.db(), id);
        if (!loaded) {
          setError(`Beleg ${id} nicht gefunden.`);
          return;
        }
        setOrder(loaded);
        setView(
          buildReceiptView(loaded, {
            tenant: kasse.tenant!,
            store: kasse.store!,
            device: kasse.device!,
            reprint,
          }),
        );
      } catch (issue) {
        setError((issue as Error).message);
      }
    })();
  }, [id, kasse, reprint]);

  if (error) {
    return (
      <Screen>
        <View style={styles.content}>
          <Notice tone="danger">{error}</Notice>
        </View>
      </Screen>
    );
  }
  if (!view || !order) {
    return (
      <Screen>
        <View style={styles.content}>
          <Muted>Beleg wird geladen...</Muted>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Card style={styles.receipt}>
          {view.header.map((line, index) => (
            <Text key={`${line}-${index}`} style={styles.headerLine}>
              {line}
            </Text>
          ))}

          <View style={styles.divider} />
          <Row left={`Beleg ${view.receiptNumber}`} right={view.serviceMode} />
          <Row left="Ausgestellt" right={view.issuedAt} />
          <View style={styles.divider} />

          {view.lines.map((line, index) => (
            <View key={`${line.name}-${index}`} style={line.isDeposit ? styles.lineDeposit : undefined}>
              <Row
                left={`${line.quantity} x ${line.name}`}
                right={line.total}
                tone={line.isDeposit ? "deposit" : "normal"}
              />
              {line.notes.map((note) => (
                <Text key={note} style={styles.note}>
                  {note}
                </Text>
              ))}
            </View>
          ))}

          <View style={styles.divider} />
          <Row bold left="SUMME" right={`${view.total} €`} />
          {view.depositBalance != null ? (
            <Row left="darin Pfand" right={formatAmount(view.depositBalance)} tone="deposit" />
          ) : null}

          {view.taxGroups.length > 0 ? (
            <>
              <View style={styles.divider} />
              {view.taxGroups.map((group) => (
                <Row
                  key={group.key}
                  left={`${group.label} · netto ${formatAmount(group.net)}`}
                  right={`USt ${formatAmount(group.tax)}`}
                />
              ))}
            </>
          ) : null}

          <View style={styles.divider} />
          {view.payments.map((payment) => (
            <Row key={payment.label} left={payment.label} right={payment.amount} />
          ))}
          {view.change !== 0 ? <Row left="Rueckgeld" right={formatAmount(view.change)} /> : null}

          <View style={styles.divider} />
          <Row left="Beginn" right={view.startedAt} />
          <Row left="Ende" right={view.finishedAt} />

          {view.qrPayload ? (
            <View style={styles.qr}>
              {/* Der QR-Code ist der schnellste Weg fuer eine Kassennachschau. */}
              <QRCode backgroundColor="#FFFFFF" color="#000000" size={196} value={view.qrPayload} />
              <Muted>Belegpruefung: QR-Code scannen</Muted>
            </View>
          ) : (
            <Notice tone="danger">
              Dieser Beleg wurde ohne technische Sicherheitseinrichtung erstellt und ist nicht signiert.
            </Notice>
          )}

          {view.tseLines.map((line) => (
            <Text key={line} style={styles.tseLine}>
              {line}
            </Text>
          ))}

          {view.footer.map((line) => (
            <Text key={line} style={styles.footerLine}>
              {line}
            </Text>
          ))}
        </Card>

        <Button
          label="Bon als Text teilen"
          onPress={() => {
            setReprint(true);
            void Share.share({ message: renderReceiptText(view, 42) });
          }}
        />
        <Muted>
          Ein erneut ausgegebener Beleg wird als Nachdruck gekennzeichnet. Fuer einen Bondrucker wird
          derselbe Text verwendet - die Anbindung an ESC/POS-Drucker ist vorgesehen (docs/ROADMAP.md).
        </Muted>
      </ScrollView>
    </Screen>
  );
}

function Row({
  left,
  right,
  bold,
  tone = "normal",
}: {
  left: string;
  right: string;
  bold?: boolean;
  tone?: "normal" | "deposit";
}) {
  const color = tone === "deposit" ? colors.deposit : colors.text;
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLeft, { color }, bold && styles.bold]} numberOfLines={2}>
        {left}
      </Text>
      <Text style={[styles.rowRight, { color }, bold && styles.bold]}>{right}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.md },
  receipt: { gap: space.xs },
  headerLine: { color: colors.text, fontSize: font.body, fontWeight: "600", textAlign: "center" },
  divider: { backgroundColor: colors.border, height: 1, marginVertical: space.sm },
  row: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  rowLeft: { flex: 1, fontSize: font.body },
  rowRight: { fontSize: font.body, fontVariant: ["tabular-nums"] },
  bold: { fontSize: font.label, fontWeight: "800" },
  lineDeposit: { paddingLeft: space.md },
  note: { color: colors.textMuted, fontSize: font.small, paddingLeft: space.md },
  tseLine: { color: colors.textMuted, fontSize: font.small },
  footerLine: { color: colors.text, fontSize: font.small, marginTop: space.sm },
  qr: { alignItems: "center", gap: space.sm, marginVertical: space.md },
});
