/**
 * Wareneingang aus einer Lieferantenrechnung.
 *
 * Der Weg: Datei waehlen - ZUGFeRD/Factur-X als PDF, XRechnung als XML, oder
 * eine Tabelle als CSV - ansehen, zuordnen, buchen.
 *
 * ## Warum immer eine Vorschau
 *
 * Ein falsch gebuchter Wareneingang ist **doppelt** falsch: der eine Artikel
 * hat zu viel, der andere zu wenig. Beides faellt erst bei der Inventur auf,
 * und dann weiss niemand mehr, welche Lieferung schuld war. Deshalb bucht
 * dieser Bildschirm nichts von allein. Er zeigt Zeile fuer Zeile, was er
 * vorschlaegt und wie sicher er sich ist - und der Bediener hakt ab.
 *
 * Vorbelegt ist nur, was sicher ist: ein Treffer ueber GTIN oder Artikelnummer
 * bei einem Artikel, der einen Bestand fuehrt. Ein aehnlicher Name ist ein
 * Vorschlag und kommt unangehakt.
 *
 * ## Was hier nicht passiert
 *
 * **Keine Texterkennung auf einem Rechnungsfoto.** Eine PDF ohne eingebettete
 * Rechnungsdaten ist eine gedruckte Rechnung; daraus Mengen zu lesen hiesse
 * raten. Eine falsch erkannte Menge ist schlimmer als gar keine, weil sie
 * richtig aussieht. Die App sagt das und bietet den CSV-Weg an.
 *
 * **Keine Buchhaltung.** Aus der Rechnung entsteht ein Wareneingang im
 * Bestand, nicht eine Verbindlichkeit. Was der Betrieb dem Lieferanten
 * schuldet, gehoert in die Buchhaltung - siehe Bildschirm "Buchhaltung" und
 * docs/ROADMAP.md.
 */

import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  type GoodsReceiptPlan,
  type MatchKind,
  type MatchedLine,
  type Product,
  type SupplierInvoice,
  assignProduct,
  base64ToBytes,
  bookGoodsReceipt,
  checkInvoice,
  checkOptionalText,
  csvTemplate,
  extractInvoiceXml,
  formatAmount,
  formatQuantityDecimal,
  looksLikePdf,
  parseInvoiceCsv,
  parseInvoiceXml,
  planGoodsReceipt,
  tracksStock,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { Badge, Button, Card, Field, ListRow, Muted, Notice, Row, Screen, Sheet, Title } from "../src/components/ui.tsx";
import { applyStockMovement } from "../src/db/repositories.ts";
import { colors, font, space } from "../src/theme.ts";

/** Wie sicher die Zuordnung war - in Worten, nicht in Fachbegriffen. */
const MATCH_LABELS: Record<MatchKind, string> = {
  GTIN: "über EAN erkannt",
  SKU: "über Artikelnummer",
  NAME_EXACT: "Name stimmt überein",
  NAME_SIMILAR: "ähnlicher Name – bitte prüfen",
  AMBIGUOUS: "mehrere Artikel passen",
  NONE: "kein Artikel gefunden",
};

function matchTone(match: MatchKind): "neutral" | "warning" | "danger" | "success" {
  if (match === "GTIN" || match === "SKU" || match === "NAME_EXACT") return "success";
  if (match === "NAME_SIMILAR") return "warning";
  return "danger";
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function WareneingangScreen() {
  const kasse = useKasse();
  // Wareneingang ist eine Bestandsbuchung - dasselbe Recht wie der Bildschirm
  // "Bestand". Wer zaehlen darf, darf auch eine Lieferung einbuchen.
  const mayBook = kasse.can("MANAGE_STOCK");

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [plan, setPlan] = useState<GoodsReceiptPlan | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [picking, setPicking] = useState<MatchedLine | null>(null);
  const [search, setSearch] = useState("");

  /** Kopfdaten fuer den CSV-Weg: eine Tabelle nennt sie nicht. */
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvNumber, setCsvNumber] = useState("");
  const [csvDate, setCsvDate] = useState("");
  const [csvSupplier, setCsvSupplier] = useState("");

  const warnings = useMemo(() => (plan ? checkInvoice(plan.invoice) : []), [plan]);

  // Die Pruefung liefert entweder einen Wert oder einen Grund; das Feld zeigt
  // den Grund unter sich an, nicht in einem Fenster daneben.
  const supplierCheck = checkOptionalText(csvSupplier, { label: "Der Lieferant" });
  const supplierProblem = supplierCheck.ok ? null : supplierCheck.reason;

  const reset = useCallback(() => {
    setPlan(null);
    setSourceName(null);
    setProblem(null);
    setNote(null);
  }, []);

  /** Den Plan mit einer geaenderten Zeile neu zusammensetzen. */
  const replaceLine = useCallback((index: number, next: MatchedLine) => {
    setPlan((current) => {
      if (!current) return current;
      const lines = current.lines.map((entry, position) => (position === index ? next : entry));
      return {
        ...current,
        lines,
        readyCount: lines.filter((entry) => entry.selected).length,
        openCount: lines.filter((entry) => !entry.selected).length,
      };
    });
  }, []);

  const toggleLine = (index: number, entry: MatchedLine): void => {
    if (!entry.product || !tracksStock(entry.product) || entry.quantity === 0) return;
    replaceLine(index, { ...entry, selected: !entry.selected });
  };

  /**
   * Datei waehlen und einlesen.
   *
   * Eine PDF muss als Base64 gelesen werden - sie ist binaer, und eine
   * Zeichenkette ist der einzige Weg ueber die Bruecke zum Betriebssystem.
   * Welcher Weg gilt, entscheidet der **Inhalt**: die ersten Bytes sagen, ob
   * es eine PDF ist. Der Dateiname entscheidet das nicht - wie eine Datei
   * heisst, bestimmt der, der sie verschickt hat.
   */
  const pickInvoice = (asCsv: boolean): void => {
    setProblem(null);
    setNote(null);
    setBusy(true);
    void (async () => {
      try {
        const picked = await DocumentPicker.getDocumentAsync({
          // Android-Dateimanager melden XML und CSV gern als text/plain oder
          // application/octet-stream. Eine zu enge Auswahl liesse den Bediener
          // vor einer leeren Liste stehen.
          type: asCsv
            ? ["text/csv", "text/comma-separated-values", "text/plain", "application/vnd.ms-excel", "*/*"]
            : ["application/pdf", "text/xml", "application/xml", "text/plain", "*/*"],
          copyToCacheDirectory: true,
        });
        if (picked.canceled) return;
        const asset = picked.assets[0];
        if (!asset) return;

        let invoice: SupplierInvoice;
        if (asCsv) {
          const text = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
          invoice = parseInvoiceCsv(text, {
            invoiceNumber: csvNumber.trim() || null,
            issuedOn: csvDate.trim() || null,
            supplierName: csvSupplier.trim() || null,
          });
        } else {
          const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 });
          const bytes = base64ToBytes(base64);
          const xml = looksLikePdf(bytes)
            ? extractInvoiceXml(bytes).content
            : new TextDecoder().decode(bytes);
          invoice = parseInvoiceXml(xml);
        }

        setPlan(planGoodsReceipt(invoice, [...kasse.products]));
        setSourceName(asset.name ?? null);
        setCsvOpen(false);
      } catch (issue) {
        setProblem((issue as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  /**
   * Buchen.
   *
   * Der Kern bildet die Bewegungen, die Datenhaltung schreibt sie - jede in
   * einer eigenen unteilbaren Einheit zusammen mit dem neuen Bestand. Danach
   * wird der Artikelstamm neu geladen, damit die Kacheln den neuen Bestand
   * zeigen und nicht den von vorhin.
   */
  const book = (): void => {
    if (!plan || !kasse.store || !kasse.user) return;
    setProblem(null);
    setBusy(true);
    void (async () => {
      try {
        const { movements } = bookGoodsReceipt(plan, {
          newId,
          storeId: kasse.store!.id,
          userId: kasse.user!.id,
          createdAt: kasse.now(),
        });
        if (movements.length === 0) {
          setProblem("Es ist keine Position zum Buchen angehakt.");
          return;
        }

        const handle = kasse.db();
        for (const movement of movements) await applyStockMovement(handle, movement);
        await kasse.reload();
        await kasse.audit("STOCK_ADJUSTED", {
          subject: `Wareneingang ${plan.invoice.invoiceNumber ?? "ohne Nummer"}`,
          detail: `${movements.length} Positionen, Lieferant ${plan.invoice.supplierName ?? "unbekannt"}, Quelle ${plan.invoice.format}`,
        });

        setNote(`${movements.length} Positionen gebucht.`);
        setPlan(null);
        setSourceName(null);
      } catch (issue) {
        setProblem((issue as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  const shareTemplate = (): void => {
    setBusy(true);
    void (async () => {
      try {
        const directory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
        if (!directory) throw new Error("Auf diesem Geraet ist kein Speicherort verfuegbar.");
        const uri = `${directory}wareneingang-vorlage.csv`;
        await FileSystem.writeAsStringAsync(uri, csvTemplate(), { encoding: FileSystem.EncodingType.UTF8 });
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(uri, { mimeType: "text/csv", dialogTitle: "Vorlage für den Wareneingang" });
          setNote("Vorlage zum Teilen angeboten.");
        } else {
          setNote(`Vorlage gespeichert unter ${uri}`);
        }
      } catch (issue) {
        setProblem((issue as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  const candidates = useMemo(() => {
    const term = search.trim().toLowerCase();
    const all = kasse.products.filter((product) => product.active && tracksStock(product));
    if (term.length === 0) return all.slice(0, 40);
    return all.filter((product) => product.name.toLowerCase().includes(term) || (product.sku ?? "").toLowerCase().includes(term)).slice(0, 40);
  }, [kasse.products, search]);

  const pickingIndex = picking ? plan?.lines.indexOf(picking) ?? -1 : -1;

  if (!mayBook) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.body}>
          <Title>Wareneingang</Title>
          <Notice tone="info">
            Für das Buchen von Wareneingängen fehlt die Berechtigung. Ein Administrator kann sie unter „Bediener" vergeben.
          </Notice>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Title>Wareneingang</Title>

        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        {note ? <Notice tone="info">{note}</Notice> : null}

        {!plan ? (
          <>
            <Card>
              <Text style={styles.heading}>Rechnung einlesen</Text>
              <Muted>
                ZUGFeRD und Factur-X als PDF, XRechnung als XML. In diesen Dateien stecken die Positionen maschinenlesbar –
                gelesen wird, was drinsteht, nicht was auf dem Papier zu sehen ist.
              </Muted>
              <Button label="PDF oder XML wählen" onPress={() => pickInvoice(false)} tone="accent" disabled={busy} loading={busy} />
            </Card>

            <Card>
              <Text style={styles.heading}>Tabelle einlesen</Text>
              <Muted>
                Für Lieferanten ohne strukturiertes Format – oder für die Positionen vom Lieferschein. Nötig sind nur zwei
                Spalten: Bezeichnung und Menge. Hilfreich sind EAN oder Artikelnummer, dann findet die Kasse den Artikel von
                allein.
              </Muted>
              <Button label="Rechnungsdaten und CSV wählen" onPress={() => setCsvOpen(true)} disabled={busy} />
              <Button label="Vorlage herunterladen" onPress={shareTemplate} disabled={busy} />
            </Card>

            <Card>
              <Text style={styles.heading}>Was nicht geht</Text>
              <Muted>
                Aus einer PDF ohne eingebettete Rechnungsdaten liest die Kasse nichts. Texterkennung auf einem Foto wäre
                geraten, und eine falsch erkannte Menge ist schlimmer als gar keine – sie sieht richtig aus. In dem Fall hilft
                die Tabelle oder das Buchen von Hand unter „Bestand".
              </Muted>
            </Card>
          </>
        ) : (
          <>
            <Card>
              <Text style={styles.heading}>{plan.invoice.supplierName ?? "Lieferant unbekannt"}</Text>
              <Row label="Rechnung" value={plan.invoice.invoiceNumber ?? "ohne Nummer"} />
              <Row label="Datum" value={plan.invoice.issuedOn ?? "ohne Datum"} />
              <Row label="Format" value={plan.invoice.format === "CSV" ? "Tabelle" : plan.invoice.format === "CII" ? "ZUGFeRD / CII" : "XRechnung / UBL"} />
              {sourceName ? <Row label="Datei" value={sourceName} tone="muted" /> : null}
              {plan.invoice.netTotal != null ? <Row label="Rechnung netto" value={formatAmount(plan.invoice.netTotal)} /> : null}
              {plan.invoice.grossTotal != null ? <Row label="Rechnung brutto" value={formatAmount(plan.invoice.grossTotal)} bold /> : null}
              <Row label="Zum Buchen angehakt" value={`${plan.readyCount} von ${plan.lines.length}`} tone={plan.readyCount > 0 ? "success" : "warning"} />
            </Card>

            {warnings.map((warning) => (
              <Notice key={warning.kind} tone="warning">
                {warning.message}
              </Notice>
            ))}

            <Card>
              <Text style={styles.heading}>Positionen</Text>
              <Muted>Antippen ordnet einen Artikel zu. Das Kästchen entscheidet, ob gebucht wird.</Muted>
              {plan.lines.map((entry, index) => (
                <View key={`${entry.line.lineId ?? index}-${index}`} style={styles.line}>
                  <ListRow
                    title={entry.line.name}
                    subtitle={`${formatQuantityDecimal(entry.quantity)}${entry.line.unitCode ? ` ${entry.line.unitCode}` : ""}${
                      entry.netUnitPrice != null ? ` · EK ${formatAmount(entry.netUnitPrice)} netto` : ""
                    }`}
                    value={entry.selected ? "wird gebucht" : "nicht buchen"}
                    tone={entry.selected ? "success" : entry.product ? "warning" : "danger"}
                    onPress={() => toggleLine(index, entry)}
                    disabled={!entry.product || !tracksStock(entry.product) || entry.quantity === 0}
                  />
                  <View style={styles.lineMeta}>
                    <Badge label={MATCH_LABELS[entry.match]} tone={matchTone(entry.match)} />
                    <Button
                      label={entry.product ? `Artikel: ${entry.product.name}` : "Artikel zuordnen"}
                      onPress={() => {
                        setSearch("");
                        setPicking(entry);
                      }}
                    />
                  </View>
                  {entry.notes.map((hint) => (
                    <Text key={hint.kind} style={styles.hint}>
                      {hint.message}
                    </Text>
                  ))}
                </View>
              ))}
            </Card>

            <Button
              label={`${plan.readyCount} Positionen buchen`}
              onPress={book}
              tone="accent"
              disabled={busy || plan.readyCount === 0}
              loading={busy}
              subtitle="Bucht einen Wareneingang je angehakter Zeile, mit Rechnungsnummer im Journal"
            />
            <Button label="Verwerfen" onPress={reset} disabled={busy} />
          </>
        )}
      </ScrollView>

      <Sheet
        open={csvOpen}
        title="Rechnungsdaten"
        onClose={() => setCsvOpen(false)}
        footer={
          <>
            <Button label="Datei wählen" onPress={() => pickInvoice(true)} tone="accent" disabled={busy} loading={busy} />
            <Button label="Abbrechen" onPress={() => setCsvOpen(false)} />
          </>
        }
      >
        <Muted>
          In einer Tabelle stehen Rechnungsnummer und Datum selten. Sie gehören ins Bestandsjournal – dort steht später, woher
          die Ware kam.
        </Muted>
        <Field label="Rechnungsnummer" value={csvNumber} onChangeText={setCsvNumber} placeholder="RE-2026-0815" autoCapitalize="characters" />
        <Field
          label="Rechnungsdatum"
          value={csvDate}
          onChangeText={setCsvDate}
          placeholder="2026-09-14"
          keyboardType="numeric"
          hint="Jahr-Monat-Tag"
        />
        <Field
          label="Lieferant"
          value={csvSupplier}
          onChangeText={setCsvSupplier}
          placeholder="Metro"
          problem={supplierProblem}
        />
      </Sheet>

      <Sheet open={picking != null} title="Artikel zuordnen" onClose={() => setPicking(null)} wide>
        {picking ? (
          <>
            <Muted>
              Rechnung: „{picking.line.name}"
              {picking.line.gtin ? ` · EAN ${picking.line.gtin}` : ""}
              {picking.line.sellerItemId ? ` · Nr. ${picking.line.sellerItemId}` : ""}
            </Muted>
            {picking.candidates.length > 0 ? (
              <Notice tone="warning">
                Mehrere Artikel tragen dieselbe Nummer oder denselben Namen. Deshalb gibt es keinen Vorschlag – bitte den
                richtigen wählen.
              </Notice>
            ) : null}
            <Field label="Suchen" value={search} onChangeText={setSearch} placeholder="Name oder Artikelnummer" autoCapitalize="none" />
            {picking.product ? (
              <Button
                label="Zuordnung aufheben"
                tone="danger"
                onPress={() => {
                  if (pickingIndex >= 0) replaceLine(pickingIndex, assignProduct(picking, null));
                  setPicking(null);
                }}
              />
            ) : null}
            {candidates.length === 0 ? (
              <Muted>Kein Artikel mit Bestandsführung gefunden. Artikel ohne Bestandsführung können keinen Wareneingang aufnehmen.</Muted>
            ) : null}
            {candidates.map((product: Product) => (
              <ListRow
                key={product.id}
                title={product.name}
                subtitle={product.sku ? `Nr. ${product.sku}` : undefined}
                value={formatQuantityDecimal(product.stock ?? 0)}
                onPress={() => {
                  if (pickingIndex >= 0) replaceLine(pickingIndex, assignProduct(picking, product));
                  setPicking(null);
                }}
              />
            ))}
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.md, gap: space.md },
  heading: { color: colors.text, fontSize: font.label, fontWeight: "700", marginBottom: space.xs },
  line: { gap: space.xs, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: space.sm },
  lineMeta: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  hint: { color: colors.warning, fontSize: font.small },
});
