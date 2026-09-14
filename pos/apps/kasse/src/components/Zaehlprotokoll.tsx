/**
 * Zaehlprotokoll: Stueckzahlen je Nennwert.
 *
 * An einer Stelle, weil es zweimal gebraucht wird - bei der Tageseroeffnung und
 * beim Kassenabschluss - und weil zwei Fassungen desselben Rasters sicher
 * auseinanderlaufen. Genau das ist schon passiert: der Abschluss hatte sein
 * eigenes Raster, das Kassenbuch beinahe ein zweites mit einer anderen
 * Stueckelung.
 *
 * Die Stueckelung kommt aus dem Kern (`DENOMINATIONS`). Sie dort zu halten ist
 * kein Selbstzweck: `countCash` lehnt einen Nennwert ab, den es nicht kennt -
 * eine Oberflaeche mit eigener Liste wuerde dann Eingaben annehmen, die beim
 * Speichern scheitern.
 */

import React from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { DENOMINATIONS, formatAmount, type CashCountEntry } from "@kp/core";
import { Muted } from "./ui.tsx";
import { colors, font, radius, space } from "../theme.ts";

/** Eingegebene Stueckzahlen, Nennwert in Cent -> Text aus dem Feld. */
export type CashCounts = Record<number, string>;

/**
 * Stueckzahlen in ein Zaehlprotokoll umrechnen.
 *
 * Nennwerte ohne Eingabe fallen heraus: "nicht gezaehlt" und "null Stueck
 * gezaehlt" sind dasselbe Ergebnis, aber eine Liste mit fuenfzehn Nullzeilen
 * liest niemand.
 */
export function toCashCount(counts: CashCounts): CashCountEntry[] {
  return DENOMINATIONS.map((denomination) => ({
    denomination,
    count: Number.parseInt(counts[denomination] ?? "", 10) || 0,
  })).filter((entry) => entry.count > 0);
}

export function Zaehlprotokoll({
  counts,
  onChange,
  hint,
}: {
  counts: CashCounts;
  onChange: (counts: CashCounts) => void;
  hint?: string;
}) {
  return (
    <View style={styles.wrapper}>
      <Muted>{hint ?? "Stueckzahlen eintragen. Leer lassen heisst: nicht gezaehlt."}</Muted>
      <View style={styles.grid}>
        {DENOMINATIONS.map((denomination) => {
          const text = counts[denomination] ?? "";
          const count = Number.parseInt(text, 10) || 0;
          return (
            <View key={denomination} style={styles.cell}>
              <Text style={styles.denomination}>{formatAmount(denomination)}</Text>
              <TextInput
                accessibilityLabel={`Anzahl ${formatAmount(denomination)}`}
                keyboardType="number-pad"
                // Vier Stellen genuegen: 9999 Scheine eines Nennwerts hat keine
                // Kasse, und eine offene Laenge laedt zum verrutschten Finger ein.
                onChangeText={(value) => onChange({ ...counts, [denomination]: value.replace(/\D/g, "").slice(0, 4) })}
                placeholder="0"
                placeholderTextColor={colors.textMuted}
                style={styles.input}
                value={text}
              />
              <Text style={styles.lineTotal}>{count > 0 ? formatAmount(denomination * count) : " "}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: space.sm },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  cell: { gap: space.xs, width: 84 },
  denomination: { color: colors.textMuted, fontSize: font.small, textAlign: "center" },
  input: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.sm,
    borderWidth: 1,
    color: colors.text,
    fontSize: font.label,
    minHeight: 48,
    textAlign: "center",
  },
  lineTotal: { color: colors.textMuted, fontSize: font.small, textAlign: "center" },
});
