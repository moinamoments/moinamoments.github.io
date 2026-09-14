/**
 * Buchhaltung: Buchungsstapel fuer DATEV und Lexware.
 *
 * Was der Steuerberater bisher bekam, war der DSFinV-K-Export - und der ist fuer
 * eine Pruefung gedacht, nicht fuer die Buchfuehrung. Ein Buchungsstapel spart
 * im Monat eine Stunde Abtipperei.
 *
 * ## Drei Dinge, die dieser Bildschirm ernst nimmt
 *
 * 1. **Konten werden nicht erfunden.** Die Vorschlaege sind die ueblichen Konten
 *    von SKR03 und SKR04, damit niemand vor zwoelf leeren Feldern sitzt. Sie
 *    sind als *unbestaetigt* gekennzeichnet, bis der Betrieb sie mit seinem
 *    Steuerberater abgestimmt hat - und diese Kennzeichnung steht neben jedem
 *    Export.
 * 2. **Berater- und Mandantennummer sind Pflichtfelder ohne Voreinstellung.**
 *    Eine erfundene Mandantennummer bucht in die Buchhaltung eines anderen
 *    Betriebs. Das ist kein Formfehler, den man hinterher korrigiert.
 * 3. **Es wird geprueft, bevor geschrieben wird.** Geht das Verrechnungskonto
 *    nicht auf null auf, entsteht keine Datei. Ein unausgeglichener Stapel wird
 *    von der Buchhaltung zurueckgewiesen - besser, es faellt hier auf.
 *
 * Der Stapel wird **nicht festgeschrieben** (DATEV-Kopffeld 21 auf 0): die erste
 * Zuordnung eines Betriebs sitzt selten auf Anhieb, und ein festgeschriebener
 * Stapel laesst sich nicht mehr korrigieren. Die Unveraenderbarkeit der
 * Kassendaten haengt nicht daran - die liegt in der Kasse und in der TSE.
 */

import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import {
  CHART_LABELS,
  LEXWARE_IMPORT_HINT,
  PAYMENT_LABELS,
  STANDARD_TAX_RATES,
  type AccountMapping,
  type BookingEntry,
  type ChartOfAccounts,
  type ClosingReport,
  type DatevHeader,
  type Order,
  buildBookings,
  buildDatevFile,
  buildLexwareFile,
  checkAccountMapping,
  checkBookingBalance,
  checkDatevHeader,
  datevFileName,
  formatEuro,
  lexwareFileName,
  proposalFor,
  usedInBookings,
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
  Toggle,
} from "../src/components/ui.tsx";
import {
  getAccountingSettings,
  listClosingsForPeriod,
  saveAccountingSettings,
  type AccountingSettings,
} from "../src/db/repositories.ts";
import { colors, font, space } from "../src/theme.ts";

/** Erster und letzter Tag des Vormonats - der Zeitraum, der wirklich gebraucht wird. */
function lastMonth(today: string): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  const pad = (value: number): string => String(value).padStart(2, "0");
  // Der letzte Tag: Tag 0 des Folgemonats. Schaltjahre kommen damit von selbst
  // richtig heraus.
  const lastDay = new Date(Date.UTC(previous.year, previous.month, 0)).getUTCDate();
  return {
    from: `${previous.year}-${pad(previous.month)}-01`,
    to: `${previous.year}-${pad(previous.month)}-${pad(lastDay)}`,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export default function BuchhaltungScreen() {
  const kasse = useKasse();
  const mayExport = kasse.can("EXPORT_DATA");
  const maySettings = kasse.can("MANAGE_SETTINGS");

  const [settings, setSettings] = useState<AccountingSettings | null>(null);
  const [period, setPeriod] = useState(() => lastMonth(kasse.now().slice(0, 10)));
  const [granularity, setGranularity] = useState<"RECEIPT" | "CLOSING">("RECEIPT");
  const [closings, setClosings] = useState<readonly { report: ClosingReport; orders: Order[] }[]>([]);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!kasse.ready || !kasse.tenant || !kasse.device) return;
    const handle = kasse.db();
    setSettings(await getAccountingSettings(handle, kasse.tenant.id));
    if (ISO_DATE.test(period.from) && ISO_DATE.test(period.to)) {
      setClosings(await listClosingsForPeriod(handle, kasse.device.id, period.from, period.to));
    }
  }, [kasse, period.from, period.to]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /** Buchungssaetze aller Abschluesse des Zeitraums. */
  const bookings = useMemo<{ entries: readonly BookingEntry[]; error: string | null }>(() => {
    if (!settings || closings.length === 0) return { entries: [], error: null };
    try {
      const all: BookingEntry[] = [];
      for (const closing of closings) {
        all.push(...buildBookings({ ...closing, mapping: settings.mapping, granularity }));
      }
      return { entries: all, error: null };
    } catch (issue) {
      return { entries: [], error: (issue as Error).message };
    }
  }, [closings, granularity, settings]);

  const balance = useMemo(
    () => (settings ? checkBookingBalance(bookings.entries, settings.mapping.clearing) : null),
    [bookings.entries, settings],
  );

  /** Welche Konten der Zeitraum braucht - daran haengt die Pruefung. */
  const mappingCheck = useMemo(() => {
    if (!settings) return null;
    const taxKeys = new Set<number>();
    const methods = new Set<string>();
    const movements = new Set<string>();
    let hasDeposit = false;
    let hasCashDifference = false;
    for (const closing of closings) {
      const used = usedInBookings(closing.report, closing.orders);
      for (const key of used.taxKeys) taxKeys.add(key);
      for (const method of used.methods) methods.add(method);
      for (const movement of used.movements) movements.add(movement);
      if (used.hasDeposit) hasDeposit = true;
      if (used.hasCashDifference) hasCashDifference = true;
    }
    return checkAccountMapping(settings.mapping, {
      taxKeys: [...taxKeys],
      methods: [...methods] as never,
      movements: [...movements] as never,
      hasDeposit,
      hasCashDifference,
    });
  }, [closings, settings]);

  const header = useMemo<DatevHeader | null>(() => {
    if (!settings || settings.consultantNumber == null || settings.clientNumber == null) return null;
    return {
      consultantNumber: settings.consultantNumber,
      clientNumber: settings.clientNumber,
      // Ohne eingetragenen Beginn des Wirtschaftsjahres der 1. Januar des
      // Jahres, in dem der Zeitraum liegt - der Normalfall.
      fiscalYearStart: settings.fiscalYearStart ?? `${period.from.slice(0, 4)}-01-01`,
      from: period.from,
      to: period.to,
      label: `${kasse.device?.name ?? "Kasse"} ${period.from.slice(0, 7)}`,
      createdBy: "Kassensystem",
      createdAt: kasse.now(),
      ...(settings.initials ? { initials: settings.initials } : {}),
    };
  }, [kasse, period.from, period.to, settings]);

  const headerCheck = useMemo(() => (header ? checkDatevHeader(header) : null), [header]);

  const writeAndShare = useCallback(async (fileName: string, content: string, mimeType: string): Promise<string> => {
    const directory = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
    if (!directory) throw new Error("Auf diesem Geraet ist kein Speicherort verfuegbar.");
    const uri = `${directory}${fileName}`;
    await FileSystem.writeAsStringAsync(uri, content, { encoding: FileSystem.EncodingType.UTF8 });
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, { mimeType, dialogTitle: fileName });
      return `${fileName} erzeugt und zum Teilen angeboten.`;
    }
    return `Gespeichert unter ${uri}`;
  }, []);

  const exportFile = (format: "DATEV" | "LEXWARE"): void => {
    setProblem(null);
    setNote(null);
    if (!settings) return;
    if (bookings.error) {
      setProblem(bookings.error);
      return;
    }
    if (bookings.entries.length === 0) {
      setProblem("Im gewaehlten Zeitraum gibt es keinen Kassenabschluss. Der Buchungsstapel baut auf Abschluessen auf, nicht auf einzelnen Belegen.");
      return;
    }
    // Nicht schreiben, wenn der Stapel nicht aufgeht. Eine Datei, die die
    // Buchhaltung zurueckweist, kostet mehr Zeit als sie spart.
    if (balance && !balance.ok) {
      setProblem(`Der Buchungsstapel geht nicht auf: ${balance.problems.join(" ")}`);
      return;
    }

    setBusy(true);
    void (async () => {
      try {
        if (format === "DATEV") {
          if (!header) {
            setProblem("Beraternummer und Mandantennummer fehlen. Beide stehen auf jedem Schreiben des Steuerberaters.");
            return;
          }
          const content = buildDatevFile(bookings.entries, header, settings.mapping);
          setNote(await writeAndShare(datevFileName(header), content, "text/csv"));
        } else {
          const content = buildLexwareFile(bookings.entries);
          setNote(await writeAndShare(lexwareFileName(period.from, period.to), content, "text/csv"));
        }
        await kasse.audit("DATA_EXPORTED", {
          subject: format === "DATEV" ? "DATEV-Buchungsstapel" : "Lexware-Buchungen",
          detail: `${period.from} bis ${period.to}, ${bookings.entries.length} Buchungen${settings.mapping.confirmed ? "" : " (Konten nicht abgestimmt)"}`,
        });
      } catch (issue) {
        setProblem((issue as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  const saveSettings = (next: AccountingSettings): void => {
    if (!kasse.tenant) return;
    setSettings(next);
    void (async () => {
      try {
        await saveAccountingSettings(kasse.db(), kasse.tenant!.id, next);
        await kasse.audit("SETTINGS_CHANGED", { subject: "Kontenzuordnung" });
      } catch (issue) {
        setProblem((issue as Error).message);
      }
    })();
  };

  if (!mayExport) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>Buchhaltung</Title>
          <Notice tone="warning">
            Daten auszugeben ist fuer Ihren Zugang nicht freigegeben. Der Buchungsstapel enthaelt alle Umsaetze des
            Zeitraums.
          </Notice>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Buchhaltung</Title>
        {problem ? <Notice tone="danger">{problem}</Notice> : null}
        {note ? <Notice tone="info">{note}</Notice> : null}

        {settings && !settings.mapping.confirmed ? (
          <Notice tone="warning">
            Die Kontenzuordnung ist nicht mit dem Steuerberater abgestimmt. Die Vorschlaege sind die ueblichen Konten
            des Kontenrahmens - ob sie fuer diesen Betrieb stimmen, entscheidet er. Bis dahin ist der Stapel ein
            Vorschlag, keine Buchung.
          </Notice>
        ) : null}

        {/* --- Zeitraum ------------------------------------------------- */}
        <Card style={styles.card}>
          <Title>Zeitraum</Title>
          <Muted>
            Gebucht werden Kassenabschluesse, nicht einzelne Tage: ein Abschluss ist die Bezugsgroesse, und ein
            angeschnittener waere in der Buchhaltung nicht nachvollziehbar.
          </Muted>
          <View style={styles.dateRow}>
            <View style={styles.flex}>
              <Field
                keyboardType="numeric"
                label="von"
                onChangeText={(value) => setPeriod((current) => ({ ...current, from: value }))}
                placeholder="2026-09-01"
                problem={ISO_DATE.test(period.from) ? null : "Form JJJJ-MM-TT"}
                value={period.from}
              />
            </View>
            <View style={styles.flex}>
              <Field
                keyboardType="numeric"
                label="bis"
                onChangeText={(value) => setPeriod((current) => ({ ...current, to: value }))}
                placeholder="2026-09-30"
                problem={ISO_DATE.test(period.to) ? null : "Form JJJJ-MM-TT"}
                value={period.to}
              />
            </View>
          </View>
          <Button label="Vormonat" onPress={() => setPeriod(lastMonth(kasse.now().slice(0, 10)))} />
          <Row label="Abschluesse im Zeitraum" value={String(closings.length)} />
          <Row label="Belege" value={String(closings.reduce((sum, closing) => sum + closing.orders.length, 0))} />
        </Card>

        {/* --- Stapel --------------------------------------------------- */}
        <Card style={styles.card}>
          <Title>Buchungsstapel</Title>
          <Segmented
            onChange={setGranularity}
            options={[
              { value: "RECEIPT" as const, label: "je Beleg" },
              { value: "CLOSING" as const, label: "je Abschluss" },
            ]}
            value={granularity}
          />
          <Muted>
            {granularity === "RECEIPT"
              ? "Jede Buchung traegt ihre Belegnummer. Genauer, aber mehr Zeilen - fuer einen Markttag mit dreihundert Belegen leicht neunhundert."
              : "Je Abschluss, Steuersatz und Zahlart zusammengefasst. Wenige Zeilen, aber der Bezug auf den einzelnen Beleg fehlt. Was er lieber hat, sagt der Steuerberater."}
          </Muted>

          {bookings.error ? <Notice tone="danger">{bookings.error}</Notice> : null}
          <Row label="Buchungen" value={String(bookings.entries.length)} />
          {balance ? (
            <>
              <Row label="Summe der Buchungsbetraege" value={formatEuro(balance.total)} />
              <Row
                label="Verrechnungskonto"
                tone={balance.openClearing === 0 ? "success" : "danger"}
                value={balance.openClearing === 0 ? "geht auf null auf" : formatEuro(balance.openClearing)}
              />
              {balance.problems.map((entry) => (
                <Text key={entry} style={styles.problem}>
                  • {entry}
                </Text>
              ))}
            </>
          ) : null}

          {balance && balance.ok && Object.keys(balance.byAccount).length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>Salden je Konto</Text>
              <Muted>Soll positiv, Haben negativ - so liest sie der Steuerberater.</Muted>
              {Object.entries(balance.byAccount)
                .filter(([, value]) => value !== 0)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([account, value]) => (
                  <Row key={account} label={account} tone={value < 0 ? "muted" : "normal"} value={formatEuro(value)} />
                ))}
            </>
          ) : null}
        </Card>

        {/* --- Kontenzuordnung ----------------------------------------- */}
        <Card style={styles.card}>
          <Title>Kontenzuordnung</Title>
          {settings ? (
            <>
              <Row label="Kontenrahmen" value={CHART_LABELS[settings.mapping.chart]} />
              <Row label="Sachkontenlaenge" value={String(settings.mapping.accountLength)} />
              <Row
                label="Mit dem Steuerberater abgestimmt"
                tone={settings.mapping.confirmed ? "success" : "warning"}
                value={settings.mapping.confirmed ? "ja" : "nein"}
              />
              <Row
                label="Beraternummer"
                tone={settings.consultantNumber == null ? "danger" : "normal"}
                value={settings.consultantNumber == null ? "fehlt" : String(settings.consultantNumber)}
              />
              <Row
                label="Mandantennummer"
                tone={settings.clientNumber == null ? "danger" : "normal"}
                value={settings.clientNumber == null ? "fehlt" : String(settings.clientNumber)}
              />
              {mappingCheck?.problems.map((entry) => (
                <Text key={entry} style={styles.problem}>
                  • {entry}
                </Text>
              ))}
              {headerCheck?.problems.map((entry) => (
                <Text key={entry} style={styles.problem}>
                  • {entry}
                </Text>
              ))}
              <Button
                disabled={!maySettings}
                label="Konten einstellen"
                onPress={() => setAccountsOpen(true)}
                tone={settings.mapping.confirmed ? "neutral" : "accent"}
              />
              {!maySettings ? <Muted>Einstellungen zu aendern ist fuer Ihren Zugang nicht freigegeben.</Muted> : null}
            </>
          ) : (
            <Muted>Einstellungen werden geladen …</Muted>
          )}
        </Card>

        {/* --- Ausgeben ------------------------------------------------- */}
        <Card style={styles.card}>
          <Title>Ausgeben</Title>
          <Button
            disabled={busy || bookings.entries.length === 0}
            label="DATEV-Buchungsstapel"
            loading={busy}
            onPress={() => exportFile("DATEV")}
            subtitle="Format EXTF, Version 700"
            tone="accent"
          />
          <Muted>
            Der Stapel wird nicht festgeschrieben - er bleibt in DATEV korrigierbar. Die Unveraenderbarkeit der
            Kassendaten haengt nicht daran; die liegt in der Kasse und in der TSE.
          </Muted>

          <Button
            disabled={busy || bookings.entries.length === 0}
            label="Lexware-Buchungen"
            onPress={() => exportFile("LEXWARE")}
            subtitle="CSV mit Soll- und Habenkonto"
          />
          {LEXWARE_IMPORT_HINT.map((line) => (
            <Muted key={line}>• {line}</Muted>
          ))}
        </Card>

        <Card style={styles.card}>
          <Title>Abschluesse im Zeitraum</Title>
          {closings.length === 0 ? <Muted>Keiner. Der Buchungsstapel braucht mindestens einen.</Muted> : null}
          {closings.map((closing) => (
            <ListRow
              key={closing.report.closing.id}
              subtitle={`${closing.report.closing.to.slice(0, 10)} · ${closing.orders.length} Belege${
                closing.report.unsecuredOrderCount > 0 ? ` · ${closing.report.unsecuredOrderCount} ohne TSE` : ""
              }`}
              title={`Abschluss Nr. ${closing.report.closing.number}`}
              tone={closing.report.unsecuredOrderCount > 0 ? "warning" : "normal"}
              value={formatEuro(closing.report.grossTotal)}
            />
          ))}
        </Card>

        <Muted>
          Der Buchungsstapel ersetzt den DSFinV-K-Export nicht: der eine ist fuer die Buchfuehrung, der andere fuer
          eine Kassennachschau. Der DSFinV-K-Export steht im Kassenabschluss.
        </Muted>
      </ScrollView>

      {settings ? (
        <AccountsSheet
          onClose={() => setAccountsOpen(false)}
          onSave={saveSettings}
          open={accountsOpen}
          settings={settings}
        />
      ) : null}
    </Screen>
  );
}

/**
 * Konten einstellen.
 *
 * Ein langes Formular, und das ist unvermeidlich: es sind die Konten, die ein
 * Buchungsstapel braucht. Die Kopfangaben stehen oben, weil ohne sie gar nichts
 * geht.
 */
function AccountsSheet({
  settings,
  open,
  onClose,
  onSave,
}: {
  settings: AccountingSettings;
  open: boolean;
  onClose: () => void;
  onSave: (settings: AccountingSettings) => void;
}) {
  const [draft, setDraft] = useState<AccountingSettings>(settings);

  // Beim Oeffnen den gespeicherten Stand uebernehmen.
  React.useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  const setMapping = (patch: Partial<AccountMapping>): void =>
    setDraft((current) => ({ ...current, mapping: { ...current.mapping, ...patch } }));

  const setRevenue = (taxKey: number, account: string): void =>
    setMapping({ revenue: { ...draft.mapping.revenue, [String(taxKey)]: account.replace(/\D/g, "") } });

  const setPayment = (method: string, account: string): void =>
    setMapping({ payment: { ...draft.mapping.payment, [method]: account.replace(/\D/g, "") } });

  const setMovement = (type: string, account: string): void =>
    setMapping({ cashMovement: { ...draft.mapping.cashMovement, [type]: account.replace(/\D/g, "") } });

  const takeProposal = (chart: ChartOfAccounts): void => {
    // Den Vorschlag uebernehmen heisst: wieder unbestaetigt. Wer die Konten
    // ersetzt, hat sie noch nicht abgestimmt.
    setDraft((current) => ({ ...current, mapping: { ...proposalFor(chart), chart, confirmed: false } }));
  };

  return (
    <Sheet
      footer={
        <View style={styles.actions}>
          <Button label="Abbrechen" onPress={onClose} style={styles.flex} />
          <Button
            label="Speichern"
            onPress={() => {
              onSave(draft);
              onClose();
            }}
            style={styles.flex}
            tone="accent"
          />
        </View>
      }
      onClose={onClose}
      open={open}
      title="Konten und Kopfangaben"
      wide
    >
      <Text style={styles.sectionTitle}>Beim Steuerberater erfragen</Text>
      <Muted>
        Ohne diese Angaben nimmt DATEV den Stapel nicht an. Raten kann man sie nicht: eine falsche Mandantennummer
        bucht in die Buchhaltung eines anderen Betriebs.
      </Muted>
      <Field
        keyboardType="numeric"
        label="Beraternummer"
        onChangeText={(value) =>
          setDraft((current) => ({ ...current, consultantNumber: value.trim() === "" ? null : Number(value.replace(/\D/g, "")) }))
        }
        placeholder="1001 bis 9999999"
        value={draft.consultantNumber == null ? "" : String(draft.consultantNumber)}
      />
      <Field
        keyboardType="numeric"
        label="Mandantennummer"
        onChangeText={(value) =>
          setDraft((current) => ({ ...current, clientNumber: value.trim() === "" ? null : Number(value.replace(/\D/g, "")) }))
        }
        placeholder="1 bis 99999"
        value={draft.clientNumber == null ? "" : String(draft.clientNumber)}
      />
      <Field
        hint="Meist der 1. Januar. Abweichend nur bei einem vom Kalenderjahr abweichenden Wirtschaftsjahr."
        keyboardType="numeric"
        label="Beginn des Wirtschaftsjahres"
        onChangeText={(value) => setDraft((current) => ({ ...current, fiscalYearStart: value.trim() === "" ? null : value.trim() }))}
        placeholder="2026-01-01"
        value={draft.fiscalYearStart ?? ""}
      />
      <Field
        autoCapitalize="characters"
        hint="Zwei Buchstaben, optional. Erscheint in DATEV als Diktatkuerzel."
        label="Diktatkuerzel"
        onChangeText={(value) => setDraft((current) => ({ ...current, initials: value.trim() === "" ? null : value.trim().slice(0, 2) }))}
        placeholder="PB"
        value={draft.initials ?? ""}
      />

      <Text style={styles.sectionTitle}>Kontenrahmen</Text>
      <Segmented
        onChange={takeProposal}
        options={[
          { value: "SKR03" as const, label: "SKR03" },
          { value: "SKR04" as const, label: "SKR04" },
          { value: "CUSTOM" as const, label: "eigene" },
        ]}
        value={draft.mapping.chart}
      />
      <Muted>
        Ein Wechsel setzt alle Konten auf den Vorschlag des Kontenrahmens zurueck und die Abstimmung auf "nicht
        bestaetigt".
      </Muted>
      <Field
        hint="Muss zur Einstellung des Steuerberaters passen. Stimmt sie nicht, liest DATEV aus 8400 die 84000."
        keyboardType="numeric"
        label="Sachkontenlaenge"
        onChangeText={(value) => setMapping({ accountLength: Number(value.replace(/\D/g, "")) || 4 })}
        placeholder="4"
        value={String(draft.mapping.accountLength)}
      />

      <Text style={styles.sectionTitle}>Erloeskonten je Steuersatz</Text>
      {STANDARD_TAX_RATES.map((rate) => (
        <Field
          key={rate.key}
          keyboardType="numeric"
          label={`Erloese ${rate.label}`}
          onChangeText={(value) => setRevenue(rate.key, value)}
          placeholder="8400"
          value={draft.mapping.revenue[String(rate.key)] ?? ""}
        />
      ))}
      <Field
        hint="Pfand ist beim Verkauf umsatzsteuerpflichtig wie die Ware. Ein eigenes Konto macht es im Bericht sichtbar."
        keyboardType="numeric"
        label="Pfand"
        onChangeText={(value) => setMapping({ deposit: value.replace(/\D/g, "") })}
        placeholder="8400"
        value={draft.mapping.deposit}
      />

      <Text style={styles.sectionTitle}>Geldkonten je Zahlart</Text>
      {(Object.keys(PAYMENT_LABELS) as (keyof typeof PAYMENT_LABELS)[]).map((method) => (
        <Field
          key={method}
          keyboardType="numeric"
          label={PAYMENT_LABELS[method]}
          onChangeText={(value) => setPayment(method, value)}
          placeholder="1000"
          value={draft.mapping.payment[method] ?? ""}
        />
      ))}

      <Text style={styles.sectionTitle}>Verrechnung und Kasse</Text>
      <Field
        hint="Durchlaufende Posten. Erloese und Zahlungen jedes Belegs treffen hier aufeinander; das Konto geht je Beleg auf null auf."
        keyboardType="numeric"
        label="Verrechnungskonto"
        onChangeText={(value) => setMapping({ clearing: value.replace(/\D/g, "") })}
        placeholder="1590"
        value={draft.mapping.clearing}
      />
      <Field
        keyboardType="numeric"
        label="Kassendifferenz"
        onChangeText={(value) => setMapping({ cashDifference: value.replace(/\D/g, "") })}
        placeholder="4970"
        value={draft.mapping.cashDifference}
      />
      {[
        ["DEPOSIT", "Einlage"],
        ["WITHDRAWAL", "Privatentnahme"],
        ["TRANSIT", "Geldtransit"],
        ["TIP_OUT", "Trinkgeld an Arbeitnehmer"],
      ].map(([type, label]) => (
        <Field
          key={type}
          keyboardType="numeric"
          label={label as string}
          onChangeText={(value) => setMovement(type as string, value)}
          placeholder="1800"
          value={draft.mapping.cashMovement[type as string] ?? ""}
        />
      ))}

      <Text style={styles.sectionTitle}>Umsatzsteuer</Text>
      <Muted>
        Bei Automatikkonten bleiben die BU-Schluessel leer - die Konten tragen ihren Steuersatz selbst, und ein
        gesetzter Schluessel waere dort ein Fehler. Nur bei neutralen Erloeskonten werden sie gebraucht, und welche,
        sagt der Steuerberater.
      </Muted>
      {STANDARD_TAX_RATES.filter((rate) => rate.rate > 0).map((rate) => (
        <Field
          key={rate.key}
          keyboardType="numeric"
          label={`BU-Schluessel ${rate.label}`}
          onChangeText={(value) =>
            setMapping({ taxCode: { ...(draft.mapping.taxCode ?? {}), [String(rate.key)]: value.replace(/\D/g, "") } })
          }
          placeholder="leer bei Automatikkonten"
          value={draft.mapping.taxCode?.[String(rate.key)] ?? ""}
        />
      ))}

      <Text style={styles.sectionTitle}>Abstimmung</Text>
      <Toggle
        hint="Erst wenn der Steuerberater die Konten bestaetigt hat. Bis dahin steht neben jedem Export, dass der Stapel ein Vorschlag ist."
        label="Mit dem Steuerberater abgestimmt"
        onValueChange={(value) => setMapping({ confirmed: value })}
        value={draft.mapping.confirmed}
      />
      {!draft.mapping.confirmed ? <Badge label="Vorschlag, nicht abgestimmt" tone="warning" /> : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: space.md, padding: space.md, paddingBottom: space.xxl },
  card: { gap: space.xs },
  actions: { flexDirection: "row", gap: space.sm },
  dateRow: { flexDirection: "row", gap: space.sm },
  sectionTitle: { color: colors.text, fontSize: font.label, fontWeight: "700", marginTop: space.sm },
  problem: { color: colors.danger, fontSize: font.small },
});
