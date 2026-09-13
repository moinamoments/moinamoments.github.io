/**
 * Bausteine der Oberflaeche.
 *
 * Klein gehalten und ohne Bibliothek: eine Kasse braucht wenige, dafuer
 * verlaesslich grosse Elemente. Jede Schaltflaeche ist mindestens 56 px hoch,
 * damit sie am Verkaufsstand mit dem Daumen zu treffen ist.
 */

import React from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { colors, font, radius, space, touch } from "../theme.ts";

export function Screen({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function Title({ children }: { children: React.ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Label({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.label, style]}>{children}</Text>;
}

export function Muted({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export type ButtonTone = "accent" | "neutral" | "danger" | "success";

export function Button({
  label,
  onPress,
  tone = "neutral",
  disabled,
  loading,
  style,
  subtitle,
}: {
  label: string;
  onPress: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  subtitle?: string;
}) {
  const background = {
    accent: colors.accent,
    neutral: colors.surfaceRaised,
    danger: colors.danger,
    success: colors.success,
  }[tone];
  const textColor = tone === "neutral" ? colors.text : colors.textOnAccent;
  const inactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, opacity: inactive ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <View>
          <Text style={[styles.buttonLabel, { color: textColor }]}>{label}</Text>
          {subtitle ? <Text style={[styles.buttonSubtitle, { color: textColor }]}>{subtitle}</Text> : null}
        </View>
      )}
    </Pressable>
  );
}

/**
 * Artikelkachel des Kassenbildschirms.
 *
 * Das Bild ist Beiwerk, nicht Hauptsache: der Name muss lesbar bleiben, auch
 * wenn das Bild nicht laedt oder das Netz weg ist. Deshalb steht es hinter dem
 * Text und nicht an seiner Stelle.
 */
export function Tile({
  name,
  price,
  hint,
  badge,
  badgeTone,
  color,
  imageUrl,
  onPress,
  onLongPress,
}: {
  name: string;
  price: string;
  hint?: string;
  /** Kurze Zusatzangabe oben rechts, z. B. der Bestand. */
  badge?: string | null;
  badgeTone?: "normal" | "warning" | "danger";
  color?: string | null;
  imageUrl?: string | null;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const badgeColor =
    badgeTone === "danger" ? colors.danger : badgeTone === "warning" ? colors.warning : colors.textMuted;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[name, price, badge].filter(Boolean).join(", ")}
      onPress={onPress}
      {...(onLongPress ? { onLongPress } : {})}
      style={({ pressed }) => [
        styles.tile,
        { borderColor: color ?? colors.border, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      {imageUrl ? (
        <Image source={{ uri: imageUrl }} style={styles.tileImage} resizeMode="cover" />
      ) : null}
      <View style={styles.tileHeader}>
        <Text numberOfLines={3} style={styles.tileName}>
          {name}
        </Text>
        {badge ? <Text style={[styles.tileBadge, { color: badgeColor }]}>{badge}</Text> : null}
      </View>
      <View>
        {hint ? <Text style={styles.tileHint}>{hint}</Text> : null}
        <Text style={styles.tilePrice}>{price}</Text>
      </View>
    </Pressable>
  );
}

/**
 * Kachel fuer eine Untergruppe.
 *
 * Sieht bewusst anders aus als eine Artikelkachel - ein Fehlgriff zwischen
 * "Warengruppe oeffnen" und "Artikel buchen" kostet am Stand Zeit und muss
 * storniert werden.
 */
export function CategoryTile({
  name,
  count,
  color,
  onPress,
}: {
  name: string;
  count: number;
  color?: string | null;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Warengruppe ${name}, ${count} Artikel`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.categoryTile,
        { borderColor: color ?? colors.accent, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <Text numberOfLines={3} style={styles.tileName}>
        {name}
      </Text>
      <Text style={styles.categoryTileHint}>{count} Artikel ›</Text>
    </Pressable>
  );
}

/** Auswahlreiter, z. B. fuer Warengruppen. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.segmented}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.segmentLabel, active && styles.segmentLabelActive]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType = "default",
  autoCapitalize = "sentences",
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "numeric" | "decimal-pad" | "email-address";
  autoCapitalize?: "none" | "sentences" | "words";
}) {
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize={autoCapitalize}
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        style={styles.input}
        value={value}
      />
    </View>
  );
}

/** Hinweisstreifen fuer Zustaende, die der Bediener kennen muss. */
export function Notice({ tone, children }: { tone: "warning" | "danger" | "info"; children: React.ReactNode }) {
  const background = { warning: colors.warning, danger: colors.danger, info: colors.accent }[tone];
  return (
    <View style={[styles.notice, { backgroundColor: background }]}>
      <Text style={styles.noticeText}>{children}</Text>
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  title: { color: colors.text, fontSize: font.title, fontWeight: "700", marginBottom: space.sm },
  label: { color: colors.text, fontSize: font.label, fontWeight: "600" },
  muted: { color: colors.textMuted, fontSize: font.small },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: space.lg,
  },
  button: {
    alignItems: "center",
    borderRadius: radius.md,
    justifyContent: "center",
    minHeight: touch.button,
    paddingHorizontal: space.lg,
  },
  buttonLabel: { fontSize: font.label, fontWeight: "700", textAlign: "center" },
  buttonSubtitle: { fontSize: font.small, opacity: 0.8, textAlign: "center" },
  tile: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 2,
    justifyContent: "space-between",
    minHeight: touch.tile,
    padding: space.md,
  },
  tileImage: { ...StyleSheet.absoluteFillObject, borderRadius: radius.lg - 2, opacity: 0.3 },
  tileHeader: { flexDirection: "row", gap: space.xs, justifyContent: "space-between" },
  tileName: { color: colors.text, flex: 1, fontSize: font.body, fontWeight: "600" },
  tileBadge: { fontSize: font.small, fontWeight: "700" },
  tileHint: { color: colors.deposit, fontSize: font.small },
  tilePrice: { color: colors.textMuted, fontSize: font.label, fontWeight: "700" },
  categoryTile: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.lg,
    borderStyle: "dashed",
    borderWidth: 2,
    justifyContent: "space-between",
    minHeight: touch.tile,
    padding: space.md,
  },
  categoryTileHint: { color: colors.accent, fontSize: font.small, fontWeight: "700" },
  segmented: { gap: space.sm, paddingVertical: space.sm },
  segment: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: space.lg,
  },
  segmentActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  segmentLabel: { color: colors.text, fontSize: font.body, fontWeight: "600" },
  segmentLabelActive: { color: colors.textOnAccent },
  field: { gap: space.xs, marginBottom: space.md },
  input: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderRadius: radius.md,
    borderWidth: 1,
    color: colors.text,
    fontSize: font.label,
    minHeight: touch.button,
    paddingHorizontal: space.md,
  },
  notice: { borderRadius: radius.md, padding: space.md },
  noticeText: { color: colors.textOnAccent, fontSize: font.body, fontWeight: "600" },
});
