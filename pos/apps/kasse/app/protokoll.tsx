/**
 * Pruefprotokoll.
 *
 * Die Antwort auf die Frage, die am Monatsende gestellt wird: nicht "was wurde
 * verkauft" - das steht in den Belegen -, sondern "wer hat was an der Kasse
 * getan". Storniert, Geld entnommen, Preise geaendert, Rechte vergeben.
 *
 * Die Liste ist absichtlich vorgefiltert auf die Ereignisse, die eine Pruefung
 * zuerst ansieht. Anmeldungen sind so haeufig, dass sie alles andere
 * ueberdecken - wer sie braucht, schaltet auf "alle" um.
 *
 * Nichts auf diesem Bildschirm kann etwas aendern oder loeschen: die Datenbank
 * verhindert es per Trigger. Ein Protokoll, das sich bearbeiten laesst, beweist
 * nichts - und gebraucht wird es genau dann, wenn jemand einen Grund haette,
 * es zu aendern.
 */

import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  AUDIT_LABELS,
  CRITICAL_EVENTS,
  formatEuro,
  summarizeAudit,
  type AuditEntry,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { Card, ListRow, Muted, Notice, Row, Screen, Segmented, Title } from "../src/components/ui.tsx";
import { listAudit } from "../src/db/repositories.ts";
import { colors, font, space } from "../src/theme.ts";

type Filter = "critical" | "all";

export default function ProtokollScreen() {
  const kasse = useKasse();
  const allowed = kasse.can("VIEW_REPORTS");
  const [filter, setFilter] = useState<Filter>("critical");
  const [entries, setEntries] = useState<readonly AuditEntry[]>([]);

  const load = useCallback(async () => {
    if (!kasse.ready || !allowed) return;
    setEntries(
      await listAudit(kasse.db(), filter === "critical" ? { events: CRITICAL_EVENTS, limit: 300 } : { limit: 300 }),
    );
  }, [allowed, filter, kasse]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const summary = useMemo(() => summarizeAudit(entries), [entries]);

  if (!allowed) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>Pruefprotokoll</Title>
          <Notice tone="warning">Berichte anzusehen ist fuer Ihren Zugang nicht freigegeben.</Notice>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Pruefprotokoll</Title>

        <Segmented
          onChange={setFilter}
          options={[
            { value: "critical", label: "Wesentliches" },
            { value: "all", label: "Alle Ereignisse" },
          ]}
          value={filter}
        />

        <Card style={styles.card}>
          <Title>Uebersicht</Title>
          <Row label="Eintraege im Ausschnitt" value={String(summary.totalEntries)} />
          <Row
            label="Fehlgeschlagene Anmeldungen"
            tone={summary.failedLogins > 0 ? "warning" : "normal"}
            value={String(summary.failedLogins)}
          />
          <Row label="Zugangssperren" tone={summary.lockouts > 0 ? "danger" : "normal"} value={String(summary.lockouts)} />
          <Row label="TSE-Ausfaelle" tone={summary.tseFailures > 0 ? "danger" : "normal"} value={String(summary.tseFailures)} />
          <Row
            label="Verweigerte Zugriffe"
            tone={summary.deniedAccess > 0 ? "danger" : "normal"}
            value={String(summary.deniedAccess)}
          />
        </Card>

        {summary.voidsByUser.length > 0 ? (
          <Card style={styles.card}>
            <Title>Storni je Bediener</Title>
            <Muted>
              Nach Betrag sortiert. Die Kasse bewertet das nicht - ob dreissig Storni am Tag normal sind, weiss nur
              der Betrieb.
            </Muted>
            {summary.voidsByUser.map((item) => (
              <Row
                key={item.userName}
                label={`${item.userName} (${item.count}x)`}
                value={formatEuro(item.amount)}
              />
            ))}
          </Card>
        ) : null}

        <Card>
          <Title>Ereignisse</Title>
          {entries.length === 0 ? <Muted>Noch keine Eintraege.</Muted> : null}
          {entries.map((entry) => (
            <View key={entry.id}>
              <ListRow
                subtitle={[
                  entry.createdAt.replace("T", " ").slice(0, 19),
                  entry.userName ?? "unbekannt",
                  entry.subject,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                title={AUDIT_LABELS[entry.event]}
                value={entry.amount == null ? null : formatEuro(entry.amount)}
                tone={entry.amount != null && entry.amount < 0 ? "danger" : "normal"}
              />
              {entry.detail ? <Text style={styles.detail}>{entry.detail}</Text> : null}
            </View>
          ))}
        </Card>

        <Muted>
          Das Protokoll kann nicht geaendert oder geloescht werden - auch nicht von dieser App. Es wird mit den
          Belegen aufbewahrt.
        </Muted>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.md, padding: space.md },
  card: { gap: space.xs },
  detail: { color: colors.textMuted, fontSize: font.small, paddingBottom: space.xs },
});
