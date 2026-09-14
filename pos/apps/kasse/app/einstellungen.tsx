/**
 * Einstellungen.
 *
 * Betriebsdaten und der Zugang zu allem, was nicht am Verkauf haengt:
 * Bediener, Kassen, Bestand, Kassenbuch, Pruefprotokoll.
 *
 * Die Angaben des Betriebs landen unveraendert auf jedem Bon (§ 6 Nr. 1
 * KassenSichV) - solange sie fehlen, ist kein Beleg gueltig. Deshalb steht der
 * Hinweis darauf auch auf dem Kassenbildschirm und nicht nur hier.
 *
 * Geprueft wird mit `checkTenantData` aus dem Kern, und zwar **alles auf
 * einmal**: wer ein Formular mit acht Feldern ausfuellt, will nicht achtmal auf
 * "Speichern" tippen, um acht Meldungen zu sehen.
 *
 * Die Kassendaten stehen nicht mehr hier, sondern unter "Kassen": ein Betrieb
 * hat oft mehrere, und ein Formular fuer genau eine war die falsche Form.
 */

import React, { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { checkTenantData, isoWithOffset, type Tenant } from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { listTseIncidents, saveTenant } from "../src/db/repositories.ts";
import {
  Button,
  Card,
  Field,
  Label,
  ListRow,
  Muted,
  Notice,
  Row,
  Screen,
  Title,
  Toggle,
} from "../src/components/ui.tsx";
import { colors, font, space } from "../src/theme.ts";

export default function EinstellungenScreen() {
  const kasse = useKasse();
  const router = useRouter();
  const [tenant, setTenant] = useState<Tenant | null>(kasse.tenant);
  const [saved, setSaved] = useState(false);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [incidents, setIncidents] = useState<{ occurredAt: string; reason: string }[]>([]);

  const maySettings = kasse.can("MANAGE_SETTINGS");

  useEffect(() => {
    setTenant(kasse.tenant);
  }, [kasse.tenant]);

  useEffect(() => {
    if (!kasse.ready) return;
    void listTseIncidents(kasse.db(), 20).then(setIncidents);
  }, [kasse]);

  /** Bereiche, die von hier aus erreichbar sind - mit ihrem Recht. */
  const areas = useMemo(
    () => [
      {
        title: "Bediener und Rechte",
        subtitle: "PIN vergeben, Rollen und einzelne Rechte setzen",
        route: "/bediener",
        allowed: kasse.can("MANAGE_USERS"),
      },
      {
        title: "Kassen",
        subtitle: "Mehrere POS, Bondrucker (LAN/WLAN, Bluetooth), Kartenzahlung und Tap to Pay",
        route: "/kassen",
        allowed: kasse.can("MANAGE_DEVICES"),
      },
      {
        title: "Bestand",
        subtitle: "Wareneingang, Zaehlung, Schwund und das Bestandsjournal",
        route: "/bestand",
        allowed: kasse.can("MANAGE_STOCK") || kasse.can("VIEW_REPORTS"),
      },
      {
        title: "Kassenbuch",
        subtitle: "Tageseroeffnung, Einlage, Entnahme, Geldtransit",
        route: "/kassenbuch",
        allowed: kasse.can("CASH_MOVEMENT") || kasse.can("OPEN_DAY"),
      },
      {
        title: "Artikel sichern und ausgeben",
        subtitle: "Als Tabelle bearbeiten, Sicherung anlegen und einspielen",
        route: "/sicherung",
        allowed: kasse.can("EXPORT_DATA") || kasse.can("MANAGE_PRODUCTS"),
      },
      {
        title: "Pruefprotokoll",
        subtitle: "Wer hat was am System getan - Storni, Entnahmen, Rechte",
        route: "/protokoll",
        allowed: kasse.can("VIEW_REPORTS"),
      },
    ],
    [kasse],
  );

  const save = (): void => {
    if (!tenant) return;
    const checked = checkTenantData({
      name: tenant.name,
      legalName: tenant.legalName,
      street: tenant.street,
      postalCode: tenant.postalCode,
      city: tenant.city,
      taxNumber: tenant.taxNumber ?? "",
      vatId: tenant.vatId ?? "",
      email: tenant.email ?? "",
    });
    if (!checked.ok) {
      setProblems(checked.problems);
      setSaved(false);
      return;
    }
    void (async () => {
      try {
        await saveTenant(kasse.db(), tenant);
        await kasse.audit("SETTINGS_CHANGED", { subject: "Betriebsdaten" });
        await kasse.reload();
        setProblems([]);
        setSaved(true);
      } catch (issue) {
        setProblems([(issue as Error).message]);
      }
    })();
  };

  if (!tenant) {
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
        <Title>Verwaltung</Title>
        <Card>
          {areas.map((area) => (
            <ListRow
              key={area.route}
              disabled={!area.allowed}
              onPress={() => router.push(area.route as never)}
              subtitle={area.allowed ? area.subtitle : "fuer Ihren Zugang nicht freigegeben"}
              title={area.title}
              value="›"
            />
          ))}
        </Card>

        <Title>Betrieb</Title>
        {kasse.needsSetup ? (
          <Notice tone="warning">
            Diese Angaben stehen auf jedem Beleg und sind Pflicht. Solange sie fehlen, sind die erstellten Belege
            nicht gueltig.
          </Notice>
        ) : null}
        {!maySettings ? (
          <Notice tone="warning">
            Einstellungen zu aendern ist fuer Ihren Zugang nicht freigegeben. Die Angaben sind hier nur zu sehen.
          </Notice>
        ) : null}

        <Card style={styles.card}>
          <Field label="Name (wie auf dem Bon)" onChangeText={(v) => setTenant({ ...tenant, name: v })} value={tenant.name} />
          <Field label="Rechtlicher Name / Inhaber" onChangeText={(v) => setTenant({ ...tenant, legalName: v })} value={tenant.legalName} />
          <Field label="Strasse und Hausnummer" onChangeText={(v) => setTenant({ ...tenant, street: v })} value={tenant.street} />
          <Field keyboardType="numeric" label="Postleitzahl" onChangeText={(v) => setTenant({ ...tenant, postalCode: v })} value={tenant.postalCode} />
          <Field label="Ort" onChangeText={(v) => setTenant({ ...tenant, city: v })} value={tenant.city} />
          <Field
            hint="Steuernummer oder USt-IdNr. - mindestens eine von beiden gehoert auf den Bon."
            label="Steuernummer"
            onChangeText={(v) => setTenant({ ...tenant, taxNumber: v })}
            value={tenant.taxNumber ?? ""}
          />
          <Field autoCapitalize="characters" label="USt-IdNr. (optional)" onChangeText={(v) => setTenant({ ...tenant, vatId: v })} value={tenant.vatId ?? ""} />
          <Field autoCapitalize="none" keyboardType="email-address" label="E-Mail" onChangeText={(v) => setTenant({ ...tenant, email: v })} value={tenant.email ?? ""} />

          <Toggle
            hint="Eingeschaltet weist die Kasse keine Umsatzsteuer aus und setzt den vorgeschriebenen Hinweis auf jeden Bon."
            label="Kleinunternehmer nach § 19 UStG"
            onValueChange={(value) => setTenant({ ...tenant, smallBusiness: value })}
            value={tenant.smallBusiness}
          />

          <Field label="Schlusszeile auf dem Bon" onChangeText={(v) => setTenant({ ...tenant, receiptFooter: v })} value={tenant.receiptFooter ?? ""} />
        </Card>

        {problems.length > 0 ? (
          <Card style={styles.card}>
            <Label>Bitte noch berichtigen</Label>
            {problems.map((problem) => (
              <Text key={problem} style={styles.problem}>
                • {problem}
              </Text>
            ))}
          </Card>
        ) : null}

        {saved ? <Notice tone="info">Gespeichert.</Notice> : null}
        <Button disabled={!maySettings} label="Speichern" onPress={save} tone="accent" />

        <Title>Technische Sicherheitseinrichtung</Title>
        <Card style={styles.card}>
          {kasse.device?.tseClientId ? (
            <Row
              label="Zustand"
              tone={kasse.tseOnline ? "success" : "danger"}
              value={kasse.tseOnline ? "erreichbar" : "nicht erreichbar"}
            />
          ) : (
            <Notice tone="danger">
              Keine TSE eingerichtet. Belege werden ohne Signatur erstellt und entsprechend gekennzeichnet. Die
              Client-Id wird unter "Kassen" eingetragen; vor dem Produktivbetrieb muss ein TSE-Anbieter angebunden
              werden - siehe docs/RECHTLICHES.md.
            </Notice>
          )}
          <Row label="Unuebertragene Belege" value={String(kasse.outboxPending)} />

          {incidents.length > 0 ? (
            <>
              <Label>Ausfallprotokoll</Label>
              <Muted>Ausfaelle sind nach § 146a AO zu dokumentieren. Diese Liste ist der Nachweis.</Muted>
              {incidents.map((incident) => (
                <Text key={`${incident.occurredAt}-${incident.reason}`} style={styles.incident}>
                  {incident.occurredAt.replace("T", " ").slice(0, 19)} · {incident.reason}
                </Text>
              ))}
            </>
          ) : null}
        </Card>

        <Title>Anmeldung</Title>
        <Card style={styles.card}>
          <Row label="Angemeldet als" value={kasse.user?.name ?? "niemand"} />
          {kasse.loginRequired ? (
            <>
              <Button label="Abmelden" onPress={() => void kasse.logout()} />
              <Muted>
                Nach fuenf Minuten ohne Bedienung und beim Wechsel in den Hintergrund wird die Kasse gesperrt. Ein
                offener Warenkorb haelt die Sperre auf, damit ein Vorgang nicht mitten im Kassieren abbricht.
              </Muted>
            </>
          ) : (
            <Muted>
              Es hat noch kein Bediener eine PIN. Die Kasse fragt deshalb beim Start nicht nach - jeder, der das
              Geraet in die Hand nimmt, kann kassieren, stornieren und Geld entnehmen. PIN vergeben unter "Bediener
              und Rechte".
            </Muted>
          )}
        </Card>

        <Muted>
          Kasse angelegt am {isoWithOffset(new Date(tenant.createdAt), tenant.timeZone).slice(0, 10)}. Die Kasse ist
          dem Finanzamt nach § 146a Abs. 4 AO zu melden.
        </Muted>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.md, paddingBottom: space.xxl },
  card: { gap: space.xs },
  problem: { color: colors.danger, fontSize: font.body },
  incident: { color: colors.warning, fontSize: font.small },
});
