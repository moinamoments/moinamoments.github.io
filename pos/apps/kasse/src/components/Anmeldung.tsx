/**
 * Anmeldung am Geraet.
 *
 * Liegt vor allem anderen: solange gesperrt ist, ist kein Bildschirm der App
 * erreichbar - auch nicht ueber einen Verweis, den jemand noch offen hat. Das
 * ist der Unterschied zwischen einer Sperre und einem Hinweis.
 *
 * Die Eingabe ist ein Ziffernblock, kein Textfeld. Gruende:
 *
 *   - Am Verkaufsstand wird mit einem Finger getippt, oft im Stehen. Ein
 *     Zahlenfeld mit 72-px-Tasten trifft man, eine Systemtastatur nicht.
 *   - Die Systemtastatur verdeckt auf kleinen Geraeten genau die Stelle, an der
 *     die Meldung steht.
 *
 * Die PIN wird nie angezeigt, auch nicht kurz: es stehen nur Punkte. Wer neben
 * der Kasse steht, sieht die Laenge - und die ist kein Geheimnis.
 */

import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ROLE_LABELS, type User } from "@kp/core";
import { useKasse } from "../state/KasseProvider.tsx";
import { Badge, Button, Card, Muted, Notice, Screen, Title } from "./ui.tsx";
import { colors, font, radius, space, touch } from "../theme.ts";

/**
 * Laengen, die der Ziffernblock zulaesst.
 *
 * Dieselben Grenzen wie `checkPin` beim Vergeben - aber **nur** die Laenge.
 * Die Regeln gegen zu leichte PINs gelten beim Setzen, nicht beim Eingeben:
 * eine bestehende PIN muss sich eingeben lassen, auch wenn sie nach heutigen
 * Regeln nicht mehr vergeben wuerde. Ob sie stimmt, entscheidet `verifyPin`.
 */
const MIN_PIN_LENGTH = 4;
const MAX_PIN_LENGTH = 8;

export function Anmeldung() {
  const kasse = useKasse();
  const [selected, setSelected] = useState<User | null>(null);
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Bediener mit PIN stehen oben.
   *
   * Wer keine PIN hat, kann sich nicht anmelden, solange die Kasse gesperrt
   * ist - er wird trotzdem angezeigt, weil sonst niemand versteht, warum sein
   * Name fehlt. Der Inhaber vergibt ihm dann eine PIN.
   */
  const operators = useMemo(
    () => [...kasse.users].sort((a, b) => Number(!!b.pinHash) - Number(!!a.pinHash) || a.name.localeCompare(b.name)),
    [kasse.users],
  );

  const submit = (): void => {
    if (!selected) return;
    if (pin.length < MIN_PIN_LENGTH) {
      setMessage(`Die PIN hat mindestens ${MIN_PIN_LENGTH} Stellen.`);
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const result = await kasse.login(selected.id, pin);
        if (!result.ok) {
          setMessage(result.message);
          setPin("");
          return;
        }
        // Gelungen: der Bildschirm verschwindet, weil `locked` false wird.
        setPin("");
        setMessage(null);
        setSelected(null);
      } catch (issue) {
        setMessage((issue as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  if (!selected) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>{kasse.tenant?.name ?? "Kasse"}</Title>
          <Muted>{kasse.device ? `${kasse.device.name} · ${kasse.store?.name ?? ""}` : ""}</Muted>
          {kasse.lockNotice ? <Notice tone="info">{kasse.lockNotice}</Notice> : null}

          <Card style={styles.list}>
            <Title>Wer arbeitet?</Title>
            {operators.map((operator) => (
              <Pressable
                accessibilityRole="button"
                disabled={!operator.pinHash}
                key={operator.id}
                onPress={() => {
                  setSelected(operator);
                  setPin("");
                  setMessage(null);
                }}
                style={({ pressed }) => [
                  styles.operator,
                  { opacity: !operator.pinHash ? 0.4 : pressed ? 0.7 : 1 },
                ]}
              >
                <View style={styles.flex}>
                  <Text style={styles.operatorName}>{operator.name}</Text>
                  <Muted>{ROLE_LABELS[operator.role]}</Muted>
                </View>
                {operator.pinHash ? <Text style={styles.chevron}>›</Text> : <Badge label="ohne PIN" tone="warning" />}
              </Pressable>
            ))}
            {operators.length === 0 ? <Muted>Es ist kein Bediener angelegt.</Muted> : null}
          </Card>

          <Muted>
            Eine PIN wird in den Einstellungen unter "Bediener und Rechte" vergeben. Wer keine hat, kann sich an
            dieser Kasse nicht anmelden.
          </Muted>
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>{selected.name}</Title>
        <Muted>{ROLE_LABELS[selected.role]}</Muted>

        <Card style={styles.padCard}>
          <View accessibilityLabel={`PIN, ${pin.length} Stellen eingegeben`} style={styles.dots}>
            {Array.from({ length: Math.max(4, pin.length) }, (_, index) => (
              <View key={index} style={[styles.dot, index < pin.length ? styles.dotFilled : null]} />
            ))}
          </View>
          {message ? <Text style={styles.message}>{message}</Text> : <Muted>PIN eingeben</Muted>}

          <View style={styles.pad}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
              <PadKey
                key={digit}
                label={digit}
                onPress={() => {
                  setMessage(null);
                  setPin((current) => (current.length >= MAX_PIN_LENGTH ? current : current + digit));
                }}
              />
            ))}
            <PadKey label="←" onPress={() => setPin((current) => current.slice(0, -1))} />
            <PadKey
              label="0"
              onPress={() => {
                setMessage(null);
                setPin((current) => (current.length >= MAX_PIN_LENGTH ? current : `${current}0`));
              }}
            />
            <PadKey label="✓" onPress={submit} tone="accent" />
          </View>
        </Card>

        <Button
          label="Anderer Bediener"
          onPress={() => {
            setSelected(null);
            setPin("");
            setMessage(null);
          }}
        />
        {busy ? <Muted>Anmeldung laeuft …</Muted> : null}
      </ScrollView>
    </Screen>
  );
}

function PadKey({ label, onPress, tone }: { label: string; onPress: () => void; tone?: "accent" }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.key,
        tone === "accent" ? styles.keyAccent : null,
        { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={[styles.keyLabel, tone === "accent" ? styles.keyLabelAccent : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: space.md, padding: space.lg },
  list: { gap: space.sm },
  operator: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: space.md,
    minHeight: touch.row,
  },
  operatorName: { color: colors.text, fontSize: font.label, fontWeight: "700" },
  chevron: { color: colors.accent, fontSize: font.title, fontWeight: "700" },

  padCard: { alignItems: "center", gap: space.md },
  dots: { flexDirection: "row", gap: space.sm, minHeight: 24 },
  dot: { borderColor: colors.border, borderRadius: 8, borderWidth: 2, height: 16, width: 16 },
  dotFilled: { backgroundColor: colors.accent, borderColor: colors.accent },
  message: { color: colors.danger, fontSize: font.body, fontWeight: "600", textAlign: "center" },

  pad: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, justifyContent: "center", maxWidth: 300 },
  key: {
    alignItems: "center",
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    height: 72,
    justifyContent: "center",
    width: 88,
  },
  keyAccent: { backgroundColor: colors.accent },
  keyLabel: { color: colors.text, fontSize: font.title, fontWeight: "700" },
  keyLabelAccent: { color: colors.textOnAccent },
});
