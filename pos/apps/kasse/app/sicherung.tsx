/**
 * Artikelstamm ausgeben, einlesen und sichern.
 *
 * Drei Wege, die verschiedene Zwecke haben:
 *
 *   - **Artikel als CSV ausgeben**, in einer Tabelle bearbeiten, wieder
 *     einlesen. Der Weg fuer eine Preisrunde: dreissig Preise auf dem Rechner
 *     aendern ist schneller als dreissig Formulare am Telefon.
 *   - **Sicherung anlegen** - vollstaendig, mit Ids und Bildlizenzen, mit
 *     Pruefsumme. Der Weg fuer den Geraetewechsel und fuer den Fall, dass das
 *     Tablet in den Fritteusenbereich faellt.
 *   - **Sicherung einspielen** - nur nach ausdruecklicher Bestaetigung, weil es
 *     den vorhandenen Stamm ueberschreibt.
 *
 * Der Hinweis, der auf diesen Bildschirm gehoert und dort auch steht: **eine
 * Sicherung des Artikelstamms erfuellt die Aufbewahrungspflicht nach § 147 AO
 * nicht.** Aufzubewahren sind Belege, Abschluesse und TSE-Daten, zehn Jahre.
 * Dafuer ist der DSFinV-K-Export im Kassenabschluss da. Wer das verwechselt,
 * steht bei einer Kassennachschau ohne Aufzeichnungen da - und das ist kein
 * Formfehler, sondern ein Grund fuer eine Schaetzung.
 *
 * Das Einlesen zeigt **immer zuerst eine Vorschau**. Eine Tabelle ist eine
 * unzuverlaessige Quelle: eine Spalte verrutscht, das Dezimalkomma wird zum
 * Punkt, eine Zeile fehlt, weil der Filter noch aktiv war. Was die Kasse
 * aendern wuerde, steht vorher da - Zeile fuer Zeile.
 */

import React, { useCallback, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import {
  type ImportPlan,
  MAX_PRODUCTS,
  backupFileName,
  buildBackup,
  buildProductCsv,
  canAddProduct,
  describeBackup,
  planCatalogImport,
  readBackup,
  serializeBackup,
  type Category,
  type Product,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { Badge, Button, Card, ListRow, Muted, Notice, Row, Screen, Sheet, Title } from "../src/components/ui.tsx";
import { saveCategory, saveProduct, saveStore, saveTenant } from "../src/db/repositories.ts";
import { colors, font, space } from "../src/theme.ts";

/** Neue Id fuer Artikel und Warengruppen, die beim Einlesen entstehen. */
function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function SicherungScreen() {
  const kasse = useKasse();
  const mayExport = kasse.can("EXPORT_DATA");
  const mayImport = kasse.can("MANAGE_PRODUCTS");

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);

  /**
   * Datei schreiben und zum Teilen anbieten.
   *
   * Erst in den Ordner der App, dann ueber die Freigabe des Systems - so landet
   * sie dort, wo der Betrieb sie haben will: in der Cloud, per Mail an den
   * Steuerberater, auf einem Stick. Die App selbst schreibt bewusst nicht in
   * fremde Ordner; dafuer braucht sie Rechte, die sie nicht braucht.
   */
  const writeAndShare = useCallback(async (fileName: string, content: string, mimeType: string) => {
    const directory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
    if (!directory) throw new Error("Auf diesem Geraet ist kein Speicherort verfuegbar.");
    const uri = `${directory}${fileName}`;
    await FileSystem.writeAsStringAsync(uri, content, { encoding: FileSystem.EncodingType.UTF8 });

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType, dialogTitle: fileName, UTI: mimeType === "text/csv" ? "public.comma-separated-values-text" : "public.json" });
      return `Gespeichert und zum Teilen angeboten: ${fileName}`;
    }
    // Ohne Freigabe (z. B. im Emulator) bleibt die Datei im Ordner der App.
    return `Gespeichert unter ${uri}`;
  }, []);

  const exportCsv = (): void => {
    setProblem(null);
    setBusy(true);
    void (async () => {
      try {
        const name = backupFileName(kasse.tenant?.name ?? "", kasse.now(), "csv");
        const content = buildProductCsv([...kasse.products], [...kasse.categories]);
        setNote(await writeAndShare(name, content, "text/csv"));
        await kasse.audit("DATA_EXPORTED", { subject: "Artikelstamm (CSV)", detail: `${kasse.products.length} Artikel` });
      } catch (issue) {
        setProblem((issue as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  const exportBackup = (): void => {
    setProblem(null);
    if (!kasse.tenant || !kasse.store) return;
    setBusy(true);
    void (async () => {
      try {
        const createdAt = kasse.now();
        const file = buildBackup({
          tenant: kasse.tenant!,
          stores: [kasse.store!],
          categories: [...kasse.categories],
          products: [...kasse.products],
          createdAt,
        });
        const name = backupFileName(kasse.tenant!.name, createdAt, "json");
        setNote(await writeAndShare(name, serializeBackup(file), "application/json"));
        await kasse.audit("DATA_EXPORTED", {
          subject: "Sicherung des Artikelstamms",
          detail: `${file.payload.products.length} Artikel, Pruefsumme ${file.checksum.slice(0, 12)}…`,
        });
      } catch (issue) {
        setProblem((issue as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  /** Datei waehlen und ihren Inhalt lesen. */
  const pickText = async (types: readonly string[]): Promise<string | null> => {
    const picked = await DocumentPicker.getDocumentAsync({ type: [...types], copyToCacheDirectory: true });
    if (picked.canceled) return null;
    const asset = picked.assets[0];
    if (!asset) return null;
    return FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
  };

  const startImport = (): void => {
    setProblem(null);
    setNote(null);
    setBusy(true);
    void (async () => {
      try {
        // Auf Android melden Dateimanager CSV gelegentlich als text/plain oder
        // application/octet-stream. Eine zu enge Auswahl liesse den Bediener vor
        // einer leeren Liste stehen.
        const text = await pickText(["text/csv", "text/comma-separated-values", "text/plain", "application/vnd.ms-excel", "*/*"]);
        if (text == null) return;
        setPlan(
          planCatalogImport(text, {
            tenantId: kasse.tenant?.id ?? "",
            categories: [...kasse.categories],
            products: [...kasse.products],
            newId,
            now: kasse.now(),
          }),
        );
      } catch (issue) {
        setProblem((issue as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  /**
   * Vorschau uebernehmen.
   *
   * Neue Warengruppen zuerst, weil die Artikel darauf verweisen. Die Pfade
   * werden Ebene fuer Ebene angelegt - "Getraenke > Kaltgetraenke" kann eine
   * neue Untergruppe unter einer bestehenden Gruppe sein.
   */
  const applyPlan = (): void => {
    if (!plan || !kasse.tenant) return;
    setBusy(true);
    void (async () => {
      try {
        const handle = kasse.db();
        const tenantId = kasse.tenant!.id;
        const categories = [...kasse.categories];
        const idByPath = new Map<string, string>();
        const pathOf = (category: Category): string => {
          const names: string[] = [];
          let current: Category | undefined = category;
          let guard = 0;
          while (current && guard++ < 16) {
            names.unshift(current.name);
            const parentId: string | null | undefined = current.parentId;
            current = parentId ? categories.find((item) => item.id === parentId) : undefined;
          }
          return names.join(" > ");
        };
        for (const category of categories) idByPath.set(pathOf(category).toLowerCase(), category.id);

        for (const path of plan.newCategoryPaths) {
          const parts = path.split(">").map((part) => part.trim()).filter((part) => part !== "");
          let parentId: string | null = null;
          let walked = "";
          for (const part of parts) {
            walked = walked === "" ? part : `${walked} > ${part}`;
            const existing = idByPath.get(walked.toLowerCase());
            if (existing) {
              parentId = existing;
              continue;
            }
            const created: Category = {
              id: newId(),
              tenantId,
              name: part,
              parentId,
              color: null,
              sortOrder: categories.length + 1,
              active: true,
            };
            await saveCategory(handle, created);
            categories.push(created);
            idByPath.set(walked.toLowerCase(), created.id);
            parentId = created.id;
          }
        }

        // Obergrenze pruefen, bevor geschrieben wird: eine Datei mit
        // dreitausend Zeilen wuerde die App sonst zur Haelfte fuellen und dann
        // abbrechen.
        const creating = plan.rows.filter((row) => row.action === "CREATE").length;
        if (kasse.products.length + creating > MAX_PRODUCTS) {
          throw new Error(
            `Die Datei wuerde ${creating} Artikel anlegen; damit waeren es ${kasse.products.length + creating} - erlaubt sind ${MAX_PRODUCTS}.`,
          );
        }

        let written = 0;
        for (const row of plan.rows) {
          if (!row.product || row.action === "REJECTED" || row.action === "UNCHANGED") continue;
          const categoryId = row.newCategoryPath
            ? idByPath.get(row.newCategoryPath.toLowerCase()) ?? row.product.categoryId
            : row.product.categoryId;
          if (!categoryId) continue;

          const product: Product = { ...row.product, categoryId };
          if (row.action === "CREATE" && !product.isDeposit) {
            const allowed = canAddProduct([...kasse.products], categoryId);
            if (!allowed.ok) throw new Error(`Zeile ${row.line}: ${allowed.reason}`);
          }
          await saveProduct(handle, product);
          written++;
        }

        await kasse.audit("SETTINGS_CHANGED", {
          subject: "Artikelstamm eingelesen",
          detail: `${plan.created} angelegt, ${plan.updated} geaendert, ${plan.rejected} abgewiesen`,
        });
        setPlan(null);
        setNote(`${written} Artikel gespeichert, ${plan.unchanged} unveraendert, ${plan.rejected} abgewiesen.`);
        await kasse.reload();
      } catch (issue) {
        setProblem((issue as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  const restore = (): void => {
    setProblem(null);
    setNote(null);
    setBusy(true);
    void (async () => {
      try {
        const text = await pickText(["application/json", "text/plain", "*/*"]);
        if (text == null) return;
        const file = readBackup(text);

        Alert.alert(
          "Sicherung einspielen",
          `${describeBackup(file)}\n\nDer vorhandene Artikelstamm wird damit ueberschrieben. Belege, Abschluesse und Kassenbuch bleiben unberuehrt.`,
          [
            { text: "Abbrechen", style: "cancel" },
            {
              text: "Einspielen",
              style: "destructive",
              onPress: () => {
                void (async () => {
                  setBusy(true);
                  try {
                    const handle = kasse.db();
                    // Reihenfolge: Betrieb, Betriebsstaetten, Warengruppen,
                    // dann Artikel. Umgekehrt wuerde ein Fremdschluessel
                    // scheitern.
                    await saveTenant(handle, file.payload.tenant);
                    for (const store of file.payload.stores) await saveStore(handle, store);
                    // Erst die Gruppen ohne Elternteil, dann die uebrigen -
                    // sonst verweist eine Untergruppe auf eine noch nicht
                    // vorhandene Gruppe.
                    const sorted = [...file.payload.categories].sort(
                      (a, b) => Number(a.parentId != null) - Number(b.parentId != null),
                    );
                    for (const category of sorted) await saveCategory(handle, category);
                    // Pfandartikel zuerst: die Warenartikel verweisen darauf.
                    const products = [...file.payload.products].sort(
                      (a, b) => Number(b.isDeposit === true) - Number(a.isDeposit === true),
                    );
                    for (const product of products) await saveProduct(handle, product);

                    await kasse.audit("SETTINGS_CHANGED", {
                      subject: "Sicherung eingespielt",
                      detail: `vom ${file.payload.createdAt.slice(0, 10)}, ${products.length} Artikel`,
                    });
                    setNote(`Sicherung vom ${file.payload.createdAt.slice(0, 10)} eingespielt.`);
                    await kasse.reload();
                  } catch (issue) {
                    setProblem((issue as Error).message);
                  } finally {
                    setBusy(false);
                  }
                })();
              },
            },
          ],
        );
      } catch (issue) {
        setProblem((issue as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Artikel sichern und ausgeben</Title>

        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        {note ? <Notice tone="info">{note}</Notice> : null}

        <Notice tone="warning">
          Eine Sicherung des Artikelstamms erfuellt die Aufbewahrungspflicht nach § 147 AO nicht. Aufzubewahren sind
          Belege, Kassenabschluesse und TSE-Daten - zehn Jahre. Dafuer ist der DSFinV-K-Export im Kassenabschluss da.
        </Notice>

        <Card style={styles.card}>
          <Title>Bearbeiten</Title>
          <Muted>
            Artikel als Tabelle ausgeben, am Rechner aendern und wieder einlesen. Preise, Steuersaetze, Einheiten,
            Pfandzuordnung und Mindestbestaende. Bilder und Bestaende stehen nicht in der Tabelle - Bestaende aendern
            sich nur ueber Bestandsbewegungen.
          </Muted>
          <Row label="Artikel im Stamm" value={String(kasse.products.length)} />
          <Row label="Warengruppen" value={String(kasse.categories.length)} />
          <Button disabled={!mayExport || busy} label="Artikel als CSV ausgeben" loading={busy} onPress={exportCsv} tone="accent" />
          <Button disabled={!mayImport || busy} label="CSV einlesen (mit Vorschau)" onPress={startImport} />
          {!mayExport ? <Muted>Daten auszugeben ist fuer Ihren Zugang nicht freigegeben.</Muted> : null}
        </Card>

        <Card style={styles.card}>
          <Title>Sichern und wiederherstellen</Title>
          <Muted>
            Die Sicherung enthaelt alles: Betriebsdaten, Warengruppen, Artikel, Pfandzuordnungen und die Lizenzangaben
            der Bilder - mit Pruefsumme, damit eine halb kopierte Datei nicht eingespielt wird. Sie ist nicht zum
            Bearbeiten gedacht.
          </Muted>
          <Button disabled={!mayExport || busy} label="Sicherung anlegen" onPress={exportBackup} />
          <Button disabled={!mayImport || busy} label="Sicherung einspielen" onPress={restore} tone="danger" />
          <Muted>
            Beim Einspielen wird der vorhandene Artikelstamm ueberschrieben. Belege, Kassenabschluesse und Kassenbuch
            bleiben unberuehrt - sie werden nie ueberschrieben.
          </Muted>
        </Card>

        <Muted>
          Bilder werden als Adresse gesichert, nicht als Datei: eine Sicherung mit dreihundert Bildern waere um
          Groessenordnungen groesser, und die Lizenz verlangt ohnehin die Nennung der Quelle. Verschwindet ein Bild im
          Netz, fehlt es nach dem Einspielen - sichtbar und behebbar.
        </Muted>
      </ScrollView>

      {/* --- Vorschau des Einlesens ------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Verwerfen" onPress={() => setPlan(null)} style={styles.flex} />
            <Button
              disabled={plan != null && plan.created + plan.updated === 0}
              label="Uebernehmen"
              loading={busy}
              onPress={applyPlan}
              style={styles.flex}
              tone="accent"
            />
          </View>
        }
        onClose={() => setPlan(null)}
        open={plan !== null}
        title="Vorschau"
        wide
      >
        {plan ? (
          <>
            <Row label="Neu angelegt" tone="success" value={String(plan.created)} />
            <Row label="Geaendert" value={String(plan.updated)} />
            <Row label="Unveraendert" tone="muted" value={String(plan.unchanged)} />
            <Row label="Abgewiesen" tone={plan.rejected > 0 ? "danger" : "muted"} value={String(plan.rejected)} />

            {plan.newCategoryPaths.length > 0 ? (
              <>
                <Text style={styles.sectionTitle}>Neue Warengruppen</Text>
                {plan.newCategoryPaths.map((path) => (
                  <Muted key={path}>• {path}</Muted>
                ))}
              </>
            ) : null}

            {plan.missingFromFile.length > 0 ? (
              <Notice tone="warning">
                {plan.missingFromFile.length} Artikel des Stamms stehen nicht in der Datei. Sie bleiben unveraendert -
                nichts wird geloescht. Wenn das nicht gewollt war, war beim Speichern der Tabelle vermutlich noch ein
                Filter aktiv.
              </Notice>
            ) : null}

            <Text style={styles.sectionTitle}>Zeilen</Text>
            {plan.rows.map((row) => (
              <View key={row.line}>
                <ListRow
                  subtitle={
                    row.action === "REJECTED"
                      ? row.problems.join(" ")
                      : row.changes.length > 0
                        ? row.changes.join(" · ")
                        : row.action === "CREATE"
                          ? `wird angelegt${row.newCategoryPath ? ` in ${row.newCategoryPath}` : ""}`
                          : "keine Aenderung"
                  }
                  title={`Zeile ${row.line}: ${row.product?.name ?? "-"}`}
                  tone={row.action === "REJECTED" ? "danger" : row.action === "CREATE" ? "success" : "normal"}
                  value={
                    { CREATE: "neu", UPDATE: "aendern", UNCHANGED: "gleich", REJECTED: "abgewiesen" }[row.action]
                  }
                />
                {row.action !== "REJECTED" && row.problems.length > 0 ? (
                  <View style={styles.hintRow}>
                    <Badge label="Hinweis" tone="warning" />
                    <Text style={styles.hint}>{row.problems.join(" ")}</Text>
                  </View>
                ) : null}
              </View>
            ))}
          </>
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: space.md, padding: space.md, paddingBottom: space.xxl },
  card: { gap: space.sm },
  actions: { flexDirection: "row", gap: space.sm },
  sectionTitle: { color: colors.text, fontSize: font.label, fontWeight: "700", marginTop: space.sm },
  hintRow: { alignItems: "center", flexDirection: "row", gap: space.sm, paddingBottom: space.xs },
  hint: { color: colors.warning, flex: 1, fontSize: font.small },
});
