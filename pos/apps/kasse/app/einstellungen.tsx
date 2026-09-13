/**
 * Einstellungen.
 *
 * Betriebsdaten, Kasse und TSE. Die Angaben hier landen unveraendert auf jedem
 * Bon (§ 6 Nr. 1 KassenSichV) - solange sie fehlen, ist kein Beleg gueltig.
 * Deshalb steht der Hinweis darauf auch auf dem Kassenbildschirm und nicht nur
 * hier.
 */

import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { type Device, type Tenant, isoWithOffset } from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { listTseIncidents, saveDevice, saveTenant } from "../src/db/repositories.ts";
import { Button, Card, Field, Label, Muted, Notice, Screen, Title } from "../src/components/ui.tsx";
import { colors, font, space } from "../src/theme.ts";

export default function EinstellungenScreen() {
  const kasse = useKasse();
  const [tenant, setTenant] = useState<Tenant | null>(kasse.tenant);
  const [device, setDevice] = useState<Device | null>(kasse.device);
  const [saved, setSaved] = useState(false);
  const [incidents, setIncidents] = useState<{ occurredAt: string; reason: string }[]>([]);

  useEffect(() => {
    setTenant(kasse.tenant);
    setDevice(kasse.device);
  }, [kasse.tenant, kasse.device]);

  useEffect(() => {
    if (!kasse.ready) return;
    void listTseIncidents(kasse.db(), 20).then(setIncidents);
  }, [kasse]);

  const save = async () => {
    if (!tenant || !device) return;
    await saveTenant(kasse.db(), tenant);
    await saveDevice(kasse.db(), device);
    await kasse.reload();
    setSaved(true);
  };

  if (!tenant || !device) {
    return (
      <Screen>
        <View style={styles.content}>
          <Muted>Einstellungen werden geladen...</Muted>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Betrieb</Title>
        {kasse.needsSetup ? (
          <Notice tone="warning">
            Diese Angaben stehen auf jedem Beleg und sind Pflicht. Solange sie fehlen, sind die
            erstellten Belege nicht gueltig.
          </Notice>
        ) : null}

        <Card style={styles.card}>
          <Field label="Name (wie auf dem Bon)" onChangeText={(v) => setTenant({ ...tenant, name: v })} value={tenant.name} />
          <Field label="Rechtlicher Name / Inhaber" onChangeText={(v) => setTenant({ ...tenant, legalName: v })} value={tenant.legalName} />
          <Field label="Strasse und Hausnummer" onChangeText={(v) => setTenant({ ...tenant, street: v })} value={tenant.street} />
          <Field keyboardType="numeric" label="Postleitzahl" onChangeText={(v) => setTenant({ ...tenant, postalCode: v })} value={tenant.postalCode} />
          <Field label="Ort" onChangeText={(v) => setTenant({ ...tenant, city: v })} value={tenant.city} />
          <Field label="Steuernummer" onChangeText={(v) => setTenant({ ...tenant, taxNumber: v })} value={tenant.taxNumber ?? ""} />
          <Field autoCapitalize="none" label="USt-IdNr. (optional)" onChangeText={(v) => setTenant({ ...tenant, vatId: v })} value={tenant.vatId ?? ""} />
          <Field autoCapitalize="none" keyboardType="email-address" label="E-Mail" onChangeText={(v) => setTenant({ ...tenant, email: v })} value={tenant.email ?? ""} />

          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Kleinunternehmer nach § 19 UStG</Text>
            <Switch
              onValueChange={(value) => setTenant({ ...tenant, smallBusiness: value })}
              thumbColor={tenant.smallBusiness ? colors.accent : colors.textMuted}
              trackColor={{ false: colors.border, true: colors.accentDeep }}
              value={tenant.smallBusiness}
            />
          </View>
          <Muted>
            Eingeschaltet weist die Kasse keine Umsatzsteuer aus und setzt den vorgeschriebenen Hinweis
            auf jeden Bon.
          </Muted>

          <Field label="Schlusszeile auf dem Bon" onChangeText={(v) => setTenant({ ...tenant, receiptFooter: v })} value={tenant.receiptFooter ?? ""} />
        </Card>

        <Title>Kasse</Title>
        <Card style={styles.card}>
          <Field label="Bezeichnung" onChangeText={(v) => setDevice({ ...device, name: v })} value={device.name} />
          <Field autoCapitalize="none" label="Kassen-Seriennummer (steht auf dem Bon)" onChangeText={(v) => setDevice({ ...device, serialNumber: v })} value={device.serialNumber} />
          <Field autoCapitalize="none" label="Belegnummern-Prefix" onChangeText={(v) => setDevice({ ...device, receiptPrefix: v })} value={device.receiptPrefix} />
          <Muted>
            Das Prefix trennt die Nummernkreise mehrerer Kassen. Zwei Kassen mit demselben Prefix
            erzeugen doppelte Belegnummern - das faellt bei einer Kassennachschau auf.
          </Muted>
          <Field autoCapitalize="none" label="TSE-Client-Id" onChangeText={(v) => setDevice({ ...device, tseClientId: v })} value={device.tseClientId ?? ""} />
        </Card>

        <Title>Technische Sicherheitseinrichtung</Title>
        <Card style={styles.card}>
          {device.tseClientId ? (
            <Row label="Zustand" value={kasse.tseOnline ? "erreichbar" : "nicht erreichbar"} />
          ) : (
            <Notice tone="danger">
              Keine TSE eingerichtet. Belege werden ohne Signatur erstellt und entsprechend
              gekennzeichnet. Vor dem Produktivbetrieb muss ein TSE-Anbieter angebunden werden -
              siehe docs/RECHTLICHES.md.
            </Notice>
          )}
          <Row label="Unuebertragene Belege" value={String(kasse.outboxPending)} />

          {incidents.length > 0 ? (
            <>
              <Label>Ausfallprotokoll</Label>
              <Muted>
                Ausfaelle sind nach § 146a AO zu dokumentieren. Diese Liste ist der Nachweis.
              </Muted>
              {incidents.map((incident) => (
                <Text key={`${incident.occurredAt}-${incident.reason}`} style={styles.incident}>
                  {incident.occurredAt.replace("T", " ").slice(0, 19)} · {incident.reason}
                </Text>
              ))}
            </>
          ) : null}
        </Card>

        {saved ? <Notice tone="info">Gespeichert.</Notice> : null}
        <Button label="Speichern" onPress={() => void save()} tone="accent" />

        <Muted>
          Kasse angelegt am {isoWithOffset(new Date(tenant.createdAt), tenant.timeZone).slice(0, 10)}.
          Die Kasse ist dem Finanzamt nach § 146a Abs. 4 AO zu melden.
        </Muted>
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.md, paddingBottom: space.xxl },
  card: { gap: space.xs },
  row: { flexDirection: "row", justifyContent: "space-between" },
  rowLabel: { color: colors.text, fontSize: font.body },
  rowValue: { color: colors.text, fontSize: font.body, fontWeight: "700" },
  toggleRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", paddingVertical: space.sm },
  toggleLabel: { color: colors.text, flex: 1, fontSize: font.body },
  incident: { color: colors.warning, fontSize: font.small },
});
