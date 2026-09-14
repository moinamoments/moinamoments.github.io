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

import React, { useCallback, useEffect, useState } from "react";
import { Linking, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import {
  DEFAULT_PRINTER_CONFIG,
  DELIVERY_LABELS,
  SMALL_INVOICE_LIMIT,
  type DeliveryChannel,
  type DeliveryRecord,
  type Order,
  type PrinterConfig,
  type ReceiptView,
  buildReceiptCommands,
  buildReceiptView,
  checkEmail,
  checkPhone,
  createQrCode,
  formatAmount,
  formatEuro,
  needsCustomerAddress,
  qrRuns,
  renderReceiptText,
  transportFor,
} from "@kp/core";
import { useKasse } from "../../src/state/KasseProvider.tsx";
import { getDeviceConfig, getOrder, listDeliveries } from "../../src/db/repositories.ts";
import { socketFactoryFor } from "../../src/printing/socket.ts";
import { Button, Card, Field, Muted, Notice, Row as InfoRow, Screen, Sheet, Title } from "../../src/components/ui.tsx";
import { colors, font, space } from "../../src/theme.ts";

export default function BonScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const kasse = useKasse();
  const [order, setOrder] = useState<Order | null>(null);
  const [view, setView] = useState<ReceiptView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reprint, setReprint] = useState(false);
  const [deliveries, setDeliveries] = useState<readonly DeliveryRecord[]>([]);
  const [sending, setSending] = useState<DeliveryChannel | null>(null);
  const [recipient, setRecipient] = useState("");
  const [sendProblem, setSendProblem] = useState<string | null>(null);
  const [printer, setPrinter] = useState<PrinterConfig>(DEFAULT_PRINTER_CONFIG);
  const [printing, setPrinting] = useState(false);
  const [printNote, setPrintNote] = useState<string | null>(null);
  const [printProblem, setPrintProblem] = useState<string | null>(null);

  const loadDeliveries = useCallback(async () => {
    if (!kasse.ready || !id) return;
    setDeliveries(await listDeliveries(kasse.db(), id));
  }, [id, kasse]);

  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);

  useEffect(() => {
    if (!kasse.ready || !kasse.device) return;
    void getDeviceConfig(kasse.db(), kasse.device.id).then((config) => setPrinter(config.printer));
  }, [kasse]);

  /**
   * Bon drucken.
   *
   * Ein fehlgeschlagener Druck verliert nichts: der Beleg steht schon in der
   * Datenbank, und diese Seite kann ihn jederzeit erneut ausgeben. Deshalb gibt
   * es keine Warteschlange - sie waere ein zweiter Ort, an dem Belege liegen.
   */
  const print = (): void => {
    if (!view) return;
    setPrintProblem(null);
    setPrintNote(null);

    const { transport, reason } = transportFor(printer, socketFactoryFor(printer.kind));
    if (reason) {
      setPrintProblem(reason);
      return;
    }

    setPrinting(true);
    void (async () => {
      try {
        // Ein erneut ausgegebener Beleg ist ein Nachdruck und wird so
        // gekennzeichnet - er darf nicht als Erstbeleg durchgehen.
        const commands = buildReceiptCommands(view, {
          width: printer.paperWidth,
          openDrawer: printer.openDrawerOnCash && order?.payments.some((payment) => payment.method === "CASH") === true,
        });
        await transport.send(commands);
        setPrintNote(`Gedruckt auf ${transport.label}.`);
        setReprint(true);
      } catch (issue) {
        setPrintProblem((issue as Error).message);
      } finally {
        setPrinting(false);
      }
    })();
  };

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
          {view.customerName ? <Row left="Kunde" right={view.customerName} /> : null}
          {/* Bei einem Storno steht hier, welcher Beleg berichtigt wird. */}
          {view.note ? <Text style={styles.noteLine}>{view.note}</Text> : null}
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
              <QrView payload={view.qrPayload} />
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

        {printProblem ? <Notice tone="danger">{printProblem}</Notice> : null}
        {printNote ? <Notice tone="info">{printNote}</Notice> : null}

        <Button
          disabled={printing || printer.kind === "none"}
          label="Bon drucken"
          loading={printing}
          onPress={print}
          subtitle={
            printer.kind === "none"
              ? "Kein Drucker eingerichtet - unter Einstellungen › Kassen"
              : printer.kind === "network"
                ? `${printer.host ?? "?"}:${printer.port ?? 9100}`
                : "Bluetooth"
          }
          tone={printer.kind === "none" ? "neutral" : "accent"}
        />

        <Button
          label="Per E-Mail senden"
          onPress={() => {
            setRecipient("");
            setSendProblem(null);
            setSending("EMAIL");
          }}
        />
        <Button
          label="Per SMS senden"
          onPress={() => {
            setRecipient("");
            setSendProblem(null);
            setSending("SMS");
          }}
        />
        <Button
          label="Bon als Text teilen"
          onPress={() => {
            setReprint(true);
            void Share.share({ message: renderReceiptText(view, 42) });
          }}
        />

        {deliveries.length > 0 ? (
          <Card style={styles.receipt}>
            <Title>Herausgegeben</Title>
            {deliveries.map((record, index) => (
              <InfoRow
                key={`${record.sentAt}-${index}`}
                label={`${DELIVERY_LABELS[record.channel]} an ${record.recipient}`}
                tone={record.ok ? "success" : "danger"}
                value={record.ok ? record.sentAt.replace("T", " ").slice(0, 16) : "nicht zugestellt"}
              />
            ))}
            <Muted>
              Gespeichert ist nur der verkuerzte Empfaenger. Nachweisbar bleiben muss, dass ein Beleg
              herausgegeben wurde - nicht an welche Adresse.
            </Muted>
          </Card>
        ) : null}

        {needsCustomerAddress(order.total, true) ? (
          <Notice tone="warning">
            Ueber {formatEuro(SMALL_INVOICE_LIMIT)} genuegt die Kleinbetragsrechnung nicht mehr. Soll dieser Beleg als
            Rechnung dienen, braucht er nach § 14 Abs. 4 UStG Name und Adresse des Kunden - sonst kann der Kunde keine
            Vorsteuer ziehen.
          </Notice>
        ) : null}

        <Muted>
          Ein erneut ausgegebener Beleg wird als Nachdruck gekennzeichnet. Fuer einen Bondrucker wird
          derselbe Text verwendet; die Druckereinstellungen stehen unter Einstellungen › Kassen.
        </Muted>
      </ScrollView>

      {/* --- Versand ---------------------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Abbrechen" onPress={() => setSending(null)} style={styles.flex} />
            <Button
              label="Senden"
              onPress={() => {
                if (!sending || !order) return;
                // Erst pruefen, dann oeffnen: eine Mail-App, die sich mit einer
                // unbrauchbaren Adresse oeffnet, hinterlaesst einen Bediener,
                // der nicht weiss, was schiefging.
                const checked =
                  sending === "EMAIL"
                    ? checkEmail(recipient, { required: true })
                    : checkPhone(recipient, { required: true });
                if (!checked.ok) {
                  setSendProblem(checked.reason);
                  return;
                }
                void (async () => {
                  try {
                    await kasse.sendReceipt(
                      order,
                      sending,
                      sending === "EMAIL" ? { email: checked.value } : { phone: checked.value },
                      // `openURL` wirft, wenn keine App den Aufruf annimmt -
                      // deshalb wird vorher gefragt.
                      async (url) => {
                        if (!(await Linking.canOpenURL(url))) return false;
                        await Linking.openURL(url);
                        return true;
                      },
                    );
                    setSending(null);
                    setRecipient("");
                    setSendProblem(null);
                    await loadDeliveries();
                  } catch (issue) {
                    setSendProblem((issue as Error).message);
                    await loadDeliveries();
                  }
                })();
              }}
              style={styles.flex}
              tone="accent"
            />
          </View>
        }
        onClose={() => setSending(null)}
        open={sending !== null}
        title={sending === "SMS" ? "Beleg per SMS" : "Beleg per E-Mail"}
      >
        <Field
          autoCapitalize="none"
          keyboardType={sending === "SMS" ? "phone-pad" : "email-address"}
          label={sending === "SMS" ? "Mobilnummer" : "E-Mail-Adresse"}
          onChangeText={(value) => {
            setSendProblem(null);
            setRecipient(value);
          }}
          placeholder={sending === "SMS" ? "0170 1234567" : "name@beispiel.de"}
          problem={sendProblem}
          value={recipient}
        />
        <Muted>
          {sending === "SMS"
            ? "Die SMS enthaelt Betrieb, Belegnummer, Betrag und Zeitpunkt - mehr passt nicht in eine Nachricht."
            : "Die E-Mail enthaelt den vollstaendigen Beleg als Text. So bleibt er lesbar, durchsuchbar und ausdruckbar."}
        </Muted>
        <Muted>
          Gesendet wird ueber die Mail- oder SMS-App des Geraets. Die Adresse wird nur fuer diesen Beleg verwendet und
          nicht gespeichert - im Nachweis steht sie verkuerzt.
        </Muted>
      </Sheet>
    </Screen>
  );
}

/**
 * QR-Code zeichnen.
 *
 * Ohne Zeichenbibliothek: der Encoder im Kern liefert die Modulmatrix, und
 * `qrRuns` fasst zusammenhaengende dunkle Module zu waagerechten Balken
 * zusammen. Ein Balken ist eine absolut gesetzte Flaeche - das halbiert die
 * Zahl der Elemente gegenueber einem Quadrat je Modul.
 *
 * Die stille Zone von vier Modulen ist Teil der Norm und nicht bloss Rahmen:
 * ohne sie findet ein Lesegeraet die Suchmuster nicht zuverlaessig.
 */
function QrView({ payload, size = 220 }: { payload: string; size?: number }) {
  const code = React.useMemo(() => {
    try {
      return createQrCode(payload);
    } catch {
      // Ein nicht darstellbarer Inhalt darf den Beleg nicht unsichtbar
      // machen - die TSE-Angaben stehen darunter ohnehin im Klartext.
      return null;
    }
  }, [payload]);

  if (!code) return <Muted>QR-Code konnte nicht erzeugt werden.</Muted>;

  const quiet = 4;
  const total = code.size + quiet * 2;
  const module = size / total;
  const runs = React.useMemo(() => qrRuns(code), [code]);

  return (
    <View style={[styles.qrCanvas, { width: size, height: size }]}>
      {runs.map((run) => (
        <View
          key={`${run.y}-${run.x}`}
          style={{
            position: "absolute",
            left: (run.x + quiet) * module,
            top: (run.y + quiet) * module,
            width: run.length * module,
            // Ein Haar Ueberlappung, damit zwischen den Zeilen keine helle
            // Linie entsteht, wenn die Modulbreite kein ganzes Pixel ist.
            height: module + 0.5,
            backgroundColor: "#000000",
          }}
        />
      ))}
    </View>
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
  flex: { flex: 1 },
  actions: { flexDirection: "row", gap: space.sm },
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
  noteLine: { color: colors.text, fontSize: font.small, fontWeight: "600" },
  tseLine: { color: colors.textMuted, fontSize: font.small },
  footerLine: { color: colors.text, fontSize: font.small, marginTop: space.sm },
  qr: { alignItems: "center", gap: space.sm, marginVertical: space.md },
  qrCanvas: { backgroundColor: "#FFFFFF", position: "relative" },
});
