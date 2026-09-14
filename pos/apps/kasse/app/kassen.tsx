/**
 * Kassen verwalten.
 *
 * Ein Betrieb hat oft mehr als eine Kasse: der Anhaenger vorne, der Stand
 * hinten, das Telefon der Schichtleitung. Jede ist in der DSFinV-K ein eigener
 * "Client" mit eigener Seriennummer und **eigenem Belegnummernkreis**.
 *
 * Deshalb die Kennzeichnung "diese Kasse". Sie ist nicht Beiwerk: zwei Geraete,
 * die aus demselben Nummernkreis ziehen, erzeugen zwei verschiedene Belege mit
 * derselben Nummer - und das ist bei einer Kassennachschau nicht mehr zu
 * erklaeren. Die Kennzeichnung liegt auf dem Geraet, nicht beim Mandanten, und
 * genau ein Eintrag traegt sie.
 *
 * Drucker und Terminal gehoeren zur Kasse und nicht zum Betrieb: der Bondrucker
 * am Anhaenger ist ein anderer als der im Laden, und ein Bluetooth-Kartenleser
 * ist mit genau einem Telefon gekoppelt.
 */

import React, { useCallback, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  DEFAULT_PRINTER_CONFIG,
  DEFAULT_TERMINAL_CONFIG,
  TERMINAL_LABELS,
  checkDisplayName,
  checkLocalPrinterUrl,
  checkPort,
  checkPrinterHost,
  checkRequiredText,
  terminalRequirements,
  validatePrinterConfig,
  validateTerminalConfig,
  type Device,
  type PaperWidth,
  type PrinterConfig,
  type TerminalConfig,
  type TerminalKind,
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
  getDeviceConfig,
  listDevices,
  markThisDevice,
  savePrinterConfig,
  saveDevice,
  saveTerminalConfig,
} from "../src/db/repositories.ts";
import { colors, font, space } from "../src/theme.ts";

const TERMINAL_KINDS: readonly TerminalKind[] = ["MANUAL", "TAP_TO_PAY", "BLUETOOTH_READER", "NETWORK_READER"];

export default function KassenScreen() {
  const kasse = useKasse();
  const allowed = kasse.can("MANAGE_DEVICES");

  const [devices, setDevices] = useState<readonly { device: Device; isThisDevice: boolean }[]>([]);
  const [edited, setEdited] = useState<Device | null>(null);
  const [problems, setProblems] = useState<{ name?: string; serial?: string; prefix?: string }>({});

  const [printerOpen, setPrinterOpen] = useState(false);
  const [printer, setPrinter] = useState<PrinterConfig>(DEFAULT_PRINTER_CONFIG);
  const [printerHost, setPrinterHost] = useState("");
  const [printerPort, setPrinterPort] = useState("");
  const [printerProblem, setPrinterProblem] = useState<string | null>(null);

  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminal, setTerminal] = useState<TerminalConfig>(DEFAULT_TERMINAL_CONFIG);
  const [terminalProblem, setTerminalProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!kasse.ready || !kasse.device) return;
    const handle = kasse.db();
    setDevices(await listDevices(handle));
    const config = await getDeviceConfig(handle, kasse.device.id);
    setPrinter(config.printer);
    setPrinterHost(config.printer.host ?? "");
    setPrinterPort(String(config.printer.port ?? 9100));
    setTerminal(config.terminal);
  }, [kasse]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const printerState = useMemo(() => validatePrinterConfig(printer), [printer]);
  const terminalState = useMemo(() => validateTerminalConfig(terminal), [terminal]);

  if (!allowed) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>Kassen</Title>
          <Notice tone="warning">Kassen zu verwalten ist fuer Ihren Zugang nicht freigegeben.</Notice>
        </ScrollView>
      </Screen>
    );
  }

  const startNew = (): void => {
    if (!kasse.tenant || !kasse.store) return;
    setProblems({});
    setEdited({
      id: "",
      tenantId: kasse.tenant.id,
      storeId: kasse.store.id,
      name: "",
      serialNumber: "",
      tseClientId: null,
      receiptPrefix: "",
      active: true,
    });
  };

  const saveEdited = (): void => {
    if (!edited) return;
    const name = checkDisplayName(edited.name, "Der Name der Kasse");
    const serial = checkRequiredText(edited.serialNumber, { label: "Die Seriennummer", max: 40 });
    const prefix = checkRequiredText(edited.receiptPrefix, { label: "Das Belegnummern-Kuerzel", max: 8 });
    const next: typeof problems = {};
    if (!name.ok) next.name = name.reason;
    if (!serial.ok) next.serial = serial.reason;
    if (!prefix.ok) next.prefix = prefix.reason;
    if (Object.keys(next).length > 0) {
      setProblems(next);
      return;
    }
    // Das Kuerzel muss je Betrieb eindeutig sein: es steht vor der Belegnummer
    // und ist genau das, was zwei Kassen auseinanderhaelt.
    const clash = devices.find(
      (item) =>
        item.device.id !== edited.id &&
        item.device.receiptPrefix.toLowerCase() === (prefix.ok ? prefix.value.toLowerCase() : ""),
    );
    if (clash) {
      setProblems({ prefix: `"${clash.device.receiptPrefix}" ist schon fuer "${clash.device.name}" vergeben.` });
      return;
    }

    void (async () => {
      try {
        const handle = kasse.db();
        const isNew = edited.id === "";
        await saveDevice(handle, {
          ...edited,
          id: isNew ? `kasse-${Date.now().toString(36)}` : edited.id,
          name: name.ok ? name.value : edited.name,
          serialNumber: serial.ok ? serial.value : edited.serialNumber,
          receiptPrefix: prefix.ok ? prefix.value.toUpperCase() : edited.receiptPrefix,
        });
        await kasse.audit("SETTINGS_CHANGED", {
          subject: name.ok ? name.value : edited.name,
          detail: isNew ? "Kasse angelegt" : "Kasse geaendert",
        });
        setEdited(null);
        await kasse.reload();
        await load();
      } catch (issue) {
        Alert.alert("Nicht gespeichert", (issue as Error).message);
      }
    })();
  };

  const useAsThisDevice = (device: Device): void => {
    Alert.alert(
      "Diese Kasse sein",
      `Dieses Geraet arbeitet danach als "${device.name}" und zieht Belegnummern aus deren Nummernkreis. ` +
        "Das ist nur richtig, wenn kein anderes Geraet gleichzeitig diese Kasse ist.",
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Uebernehmen",
          onPress: () => {
            void (async () => {
              try {
                await markThisDevice(kasse.db(), device.id);
                await kasse.audit("SETTINGS_CHANGED", { subject: device.name, detail: "als diese Kasse gesetzt" });
                await kasse.reload();
                await load();
              } catch (issue) {
                Alert.alert("Nicht moeglich", (issue as Error).message);
              }
            })();
          },
        },
      ],
    );
  };

  const savePrinter = (): void => {
    if (!kasse.device) return;
    let next: PrinterConfig = printer;

    if (printer.kind === "network") {
      const host = checkPrinterHost(printerHost);
      if (!host.ok) {
        setPrinterProblem(host.reason);
        return;
      }
      const port = checkPort(printerPort);
      if (!port.ok) {
        setPrinterProblem(port.reason);
        return;
      }
      // Ein Bondrucker spricht kein TLS. Deshalb darf er nur im eigenen Netz
      // stehen: ein "Drucker" im Internet bekaeme den ganzen Tagesumsatz
      // unverschluesselt zugeschickt.
      const local = checkLocalPrinterUrl(host.value);
      if (!local.ok) {
        setPrinterProblem(local.reason);
        return;
      }
      next = { ...printer, host: host.value, port: port.value };
    }

    const state = printer.kind === "none" ? { ok: true as const } : validatePrinterConfig(next);
    if (!state.ok) {
      setPrinterProblem(state.reason);
      return;
    }

    void (async () => {
      try {
        await savePrinterConfig(kasse.db(), kasse.device!.id, next);
        await kasse.audit("SETTINGS_CHANGED", { subject: "Drucker", detail: next.kind });
        setPrinter(next);
        setPrinterProblem(null);
        setPrinterOpen(false);
      } catch (issue) {
        setPrinterProblem((issue as Error).message);
      }
    })();
  };

  const saveTerminal = (): void => {
    if (!kasse.device) return;
    const state = validateTerminalConfig(terminal);
    if (!state.ok && terminal.kind !== "MANUAL") {
      // Kein Abbruch: eine halb eingerichtete Kartenzahlung darf gespeichert
      // werden, damit der Betrieb sie fertigstellen kann. Der Hinweis bleibt
      // aber stehen, damit niemand glaubt, es funktioniere schon.
      setTerminalProblem(state.reason);
    } else {
      setTerminalProblem(null);
    }
    void (async () => {
      try {
        await saveTerminalConfig(kasse.db(), kasse.device!.id, terminal);
        await kasse.audit("SETTINGS_CHANGED", { subject: "Kartenzahlung", detail: terminal.kind });
        if (state.ok) setTerminalOpen(false);
      } catch (issue) {
        setTerminalProblem((issue as Error).message);
      }
    })();
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Kassen</Title>

        <Card>
          {devices.map(({ device, isThisDevice }) => (
            <View key={device.id}>
              <ListRow
                onPress={() => {
                  setProblems({});
                  setEdited(device);
                }}
                subtitle={`Seriennummer ${device.serialNumber} · Belege ${device.receiptPrefix}-…`}
                title={device.name}
                value={device.tseClientId ? "TSE eingerichtet" : "ohne TSE"}
                tone={device.tseClientId ? "normal" : "danger"}
              />
              <View style={styles.badgeRow}>
                {isThisDevice ? (
                  <Badge label="diese Kasse" tone="success" />
                ) : (
                  <Button label="Diese Kasse sein" onPress={() => useAsThisDevice(device)} />
                )}
              </View>
            </View>
          ))}
        </Card>

        <Button label="Kasse anlegen" onPress={startNew} tone="accent" />

        <Card style={styles.card}>
          <Title>Drucker dieser Kasse</Title>
          <Row
            label="Einrichtung"
            tone={printerState.ok ? "success" : "muted"}
            value={
              printer.kind === "none"
                ? "kein Drucker"
                : printer.kind === "network"
                  ? `Netzwerk ${printer.host ?? "?"}:${printer.port ?? 9100}`
                  : "Bluetooth"
            }
          />
          <Row label="Papierbreite" value={`${printer.paperWidth} Zeichen`} />
          {!printerState.ok ? <Muted>{printerState.reason}</Muted> : null}
          <Button label="Drucker einrichten" onPress={() => setPrinterOpen(true)} />
        </Card>

        <Card style={styles.card}>
          <Title>Kartenzahlung</Title>
          <Row label="Art" value={TERMINAL_LABELS[terminal.kind]} />
          <Row label="Anbieter" value={terminal.provider ?? "nicht eingerichtet"} />
          <Row
            label="Zustand"
            tone={terminalState.ok ? "success" : "warning"}
            value={terminalState.ok ? "einsatzbereit" : "unvollstaendig"}
          />
          <Button label="Kartenzahlung einrichten" onPress={() => setTerminalOpen(true)} />
        </Card>

        <Muted>
          Eine Kasse wird nicht geloescht, sondern deaktiviert - ihre Belege bleiben zehn Jahre lesbar (§ 147 AO).
        </Muted>
      </ScrollView>

      {/* --- Kasse bearbeiten ------------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Abbrechen" onPress={() => setEdited(null)} style={styles.flex} />
            <Button label="Speichern" onPress={saveEdited} style={styles.flex} tone="accent" />
          </View>
        }
        onClose={() => setEdited(null)}
        open={edited !== null}
        title={edited?.id ? edited.name || "Kasse" : "Neue Kasse"}
        wide
      >
        {edited ? (
          <>
            <Field
              label="Name"
              onChangeText={(value) => setEdited({ ...edited, name: value })}
              placeholder="z. B. Anhaenger vorne"
              problem={problems.name ?? null}
              value={edited.name}
            />
            <Field
              autoCapitalize="characters"
              hint="Steht auf jedem Bon und muss das Geraet eindeutig bezeichnen."
              label="Seriennummer der Kasse"
              onChangeText={(value) => setEdited({ ...edited, serialNumber: value })}
              placeholder="z. B. KASSE-0001"
              problem={problems.serial ?? null}
              value={edited.serialNumber}
            />
            <Field
              autoCapitalize="characters"
              hint="Vor der Belegnummer, z. B. K1 fuer K1-000123. Je Betrieb eindeutig."
              label="Belegnummern-Kuerzel"
              onChangeText={(value) => setEdited({ ...edited, receiptPrefix: value })}
              placeholder="K1"
              problem={problems.prefix ?? null}
              value={edited.receiptPrefix}
            />
            <Field
              autoCapitalize="none"
              hint="Die dieser Kasse beim TSE-Anbieter zugeordnete Client-Id. Leer heisst: noch keine TSE."
              label="TSE-Client-Id"
              onChangeText={(value) => setEdited({ ...edited, tseClientId: value.trim() === "" ? null : value.trim() })}
              placeholder="z. B. client-1"
              value={edited.tseClientId ?? ""}
            />
            {edited.id ? (
              <Toggle
                hint="Eine deaktivierte Kasse kann nicht mehr kassieren. Ihre Belege bleiben lesbar."
                label="Kasse aktiv"
                onValueChange={(value) => setEdited({ ...edited, active: value })}
                value={edited.active}
              />
            ) : null}
          </>
        ) : null}
      </Sheet>

      {/* --- Drucker --------------------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Abbrechen" onPress={() => setPrinterOpen(false)} style={styles.flex} />
            <Button label="Speichern" onPress={savePrinter} style={styles.flex} tone="accent" />
          </View>
        }
        onClose={() => setPrinterOpen(false)}
        open={printerOpen}
        title="Bondrucker"
        wide
      >
        <Segmented
          onChange={(kind) => {
            setPrinterProblem(null);
            setPrinter({ ...printer, kind });
          }}
          options={[
            { value: "none" as const, label: "kein Drucker" },
            { value: "network" as const, label: "Netzwerk (LAN/WLAN)" },
            { value: "bluetooth" as const, label: "Bluetooth" },
          ]}
          value={printer.kind}
        />

        {printer.kind === "network" ? (
          <>
            <Field
              autoCapitalize="none"
              hint="IP-Adresse oder Rechnername des Druckers im eigenen Netz."
              label="Adresse"
              onChangeText={(value) => {
                setPrinterProblem(null);
                setPrinterHost(value);
              }}
              placeholder="192.168.1.50"
              value={printerHost}
            />
            <Field
              hint="Bondrucker nehmen ueblicherweise 9100."
              keyboardType="numeric"
              label="Port"
              onChangeText={(value) => {
                setPrinterProblem(null);
                setPrinterPort(value.replace(/\D/g, "").slice(0, 5));
              }}
              placeholder="9100"
              value={printerPort}
            />
            <Muted>
              Der Drucker muss im eigenen Netz stehen. Bondrucker verschluesseln nicht - ein Drucker im Internet
              bekaeme den Tagesumsatz im Klartext zugeschickt, deshalb werden oeffentliche Adressen abgelehnt.
            </Muted>
          </>
        ) : null}

        {printer.kind === "bluetooth" ? (
          <>
            <Field
              autoCapitalize="characters"
              hint="Geraeteadresse aus der Kopplung des Betriebssystems."
              label="Bluetooth-Adresse"
              onChangeText={(value) => {
                setPrinterProblem(null);
                setPrinter({ ...printer, bluetoothAddress: value.trim() === "" ? null : value.trim() });
              }}
              placeholder="00:11:22:33:44:55"
              value={printer.bluetoothAddress ?? ""}
            />
            <Muted>
              Die Kopplung selbst geschieht in den Einstellungen des Geraets. Der Druck ueber Bluetooth braucht einen
              Entwicklungs-Build - in Expo Go ist der Zugriff nicht moeglich.
            </Muted>
          </>
        ) : null}

        <Text style={styles.sectionTitle}>Papier</Text>
        <Segmented
          onChange={(width) => setPrinter({ ...printer, paperWidth: Number(width) as PaperWidth })}
          options={[
            { value: "32", label: "58 mm (32 Zeichen)" },
            { value: "42", label: "80 mm (42 Zeichen)" },
          ]}
          value={String(printer.paperWidth)}
        />
        <Toggle
          hint="Beim Barverkauf oeffnet der Drucker die Schublade."
          label="Geldschublade oeffnen"
          onValueChange={(value) => setPrinter({ ...printer, openDrawerOnCash: value })}
          value={printer.openDrawerOnCash}
        />
        {printerProblem ? <Text style={styles.problem}>{printerProblem}</Text> : null}
        <Muted>
          Ohne Drucker bleibt der Bon nicht aus: er wird angezeigt und kann per Mail oder SMS herausgegeben werden.
          Die Belegausgabepflicht nach § 146a AO ist damit erfuellt.
        </Muted>
      </Sheet>

      {/* --- Kartenzahlung --------------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Abbrechen" onPress={() => setTerminalOpen(false)} style={styles.flex} />
            <Button label="Speichern" onPress={saveTerminal} style={styles.flex} tone="accent" />
          </View>
        }
        onClose={() => setTerminalOpen(false)}
        open={terminalOpen}
        title="Kartenzahlung und Tap to Pay"
        wide
      >
        <Segmented
          onChange={(kind) => {
            setTerminalProblem(null);
            setTerminal({ ...terminal, kind });
          }}
          options={TERMINAL_KINDS.map((kind) => ({ value: kind, label: TERMINAL_LABELS[kind] }))}
          value={terminal.kind}
        />

        <Text style={styles.sectionTitle}>Was dafuer noetig ist</Text>
        {terminalRequirements(terminal.kind).map((line) => (
          <Muted key={line}>• {line}</Muted>
        ))}

        {terminal.kind !== "MANUAL" ? (
          <>
            <Field
              autoCapitalize="none"
              hint="Der Dienst, mit dem der Betrieb abrechnet."
              label="Zahlungsdienstleister"
              onChangeText={(value) => {
                setTerminalProblem(null);
                setTerminal({ ...terminal, provider: value.trim() === "" ? null : value.trim() });
              }}
              placeholder="z. B. stripe, adyen, sumup"
              value={terminal.provider ?? ""}
            />
            {terminal.kind === "NETWORK_READER" ? (
              <Field
                autoCapitalize="none"
                label="Adresse des Kartenlesers"
                onChangeText={(value) => setTerminal({ ...terminal, host: value.trim() === "" ? null : value.trim() })}
                placeholder="192.168.1.60"
                value={terminal.host ?? ""}
              />
            ) : null}
            {terminal.kind === "BLUETOOTH_READER" ? (
              <Field
                autoCapitalize="characters"
                label="Bluetooth-Adresse des Lesers"
                onChangeText={(value) =>
                  setTerminal({ ...terminal, bluetoothAddress: value.trim() === "" ? null : value.trim() })
                }
                placeholder="00:11:22:33:44:55"
                value={terminal.bluetoothAddress ?? ""}
              />
            ) : null}
            <Toggle
              hint="Der Kunde wird am Terminal nach Trinkgeld gefragt. Es kommt als eigene Position auf den Beleg."
              label="Trinkgeld abfragen"
              onValueChange={(value) => setTerminal({ ...terminal, askForTip: value })}
              value={terminal.askForTip}
            />
          </>
        ) : null}

        {terminalProblem ? <Text style={styles.problem}>{terminalProblem}</Text> : null}
        <Muted>
          Solange kein Anbieter angebunden ist, wird eine Kartenzahlung auf dem Beleg gebucht, aber nicht von der
          Kasse abgewickelt - das Geld kommt ueber ein separates Terminal. Der Beleg ist dabei vollstaendig und
          richtig; es fehlt nur die Referenz des Anbieters.
        </Muted>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: space.md, padding: space.md },
  card: { gap: space.xs },
  actions: { flexDirection: "row", gap: space.sm },
  badgeRow: { alignItems: "flex-start", paddingBottom: space.sm },
  sectionTitle: { color: colors.text, fontSize: font.label, fontWeight: "700", marginTop: space.sm },
  problem: { color: colors.danger, fontSize: font.body, fontWeight: "600" },
});
