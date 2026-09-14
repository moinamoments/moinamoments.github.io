/**
 * Navigationsgeruest.
 *
 * Reiter unten, weil die Kasse einhaendig bedient wird und der Daumen unten
 * ist. Der Kassenbildschirm ist der erste Reiter und bleibt immer erreichbar -
 * aus jedem anderen Bildschirm ist man mit einem Griff zurueck am Verkauf.
 */

import React from "react";
import { Tabs } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ActivityIndicator, Text, View } from "react-native";
import { KasseProvider, useKasse } from "../src/state/KasseProvider.tsx";
import { Anmeldung } from "../src/components/Anmeldung.tsx";
import { colors, font } from "../src/theme.ts";

/**
 * Reitersymbole als Textzeichen.
 *
 * Eine Symbolbibliothek waere ein zusaetzliches Paket und zusaetzliche
 * Startzeit fuer fuenf Symbole. Zeichen sind auf Android und iOS gleich
 * vorhanden.
 */
function TabIcon({ glyph, color }: { glyph: string; color: string }) {
  return <Text style={{ color, fontSize: 22 }}>{glyph}</Text>;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <KasseProvider>
        <Gate />
      </KasseProvider>
    </SafeAreaProvider>
  );
}

/**
 * Sperre vor der Navigation.
 *
 * Der Anmeldebildschirm ersetzt die Reiter, statt ueber ihnen zu liegen: ein
 * Fenster kann geschlossen werden, ein nicht gezeichneter Bildschirm nicht.
 * Damit ist auch ein noch offener Verweis auf `/artikel` wirkungslos, solange
 * gesperrt ist.
 */
function Gate() {
  const kasse = useKasse();

  if (!kasse.ready) {
    return (
      <View style={{ alignItems: "center", backgroundColor: colors.background, flex: 1, justifyContent: "center" }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }

  if (kasse.locked) return <Anmeldung />;

  return <AppTabs />;
}

function AppTabs() {
  return (
    <Tabs
      sceneContainerStyle={{ backgroundColor: colors.background }}
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.text, fontSize: font.label },
        headerTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, height: 64 },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: font.small, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Kasse",
          tabBarIcon: ({ color }) => <TabIcon color={color} glyph="■" />,
        }}
      />
      <Tabs.Screen
        name="pfand"
        options={{
          title: "Pfand",
          tabBarIcon: ({ color }) => <TabIcon color={color} glyph="↻" />,
        }}
      />
      <Tabs.Screen
        name="belege"
        options={{
          title: "Belege",
          tabBarIcon: ({ color }) => <TabIcon color={color} glyph="≡" />,
        }}
      />
      <Tabs.Screen
        name="artikel"
        options={{
          title: "Artikel",
          tabBarIcon: ({ color }) => <TabIcon color={color} glyph="▦" />,
        }}
      />
      <Tabs.Screen
        name="abschluss"
        options={{
          title: "Abschluss",
          tabBarIcon: ({ color }) => <TabIcon color={color} glyph="✓" />,
        }}
      />
      <Tabs.Screen
        name="einstellungen"
        options={{
          title: "Einstellungen",
          tabBarIcon: ({ color }) => <TabIcon color={color} glyph="⚙" />,
        }}
      />
      {/* Der Bon wird aus dem Verkauf heraus geoeffnet, nicht ueber einen Reiter. */}
      <Tabs.Screen name="bon/[id]" options={{ href: null, title: "Beleg" }} />
      {/* Aus der Artikelverwaltung und dem Abschluss heraus geoeffnet. */}
      <Tabs.Screen name="bestand" options={{ href: null, title: "Bestand" }} />
      <Tabs.Screen name="kassenbuch" options={{ href: null, title: "Kassenbuch" }} />
      <Tabs.Screen name="bediener" options={{ href: null, title: "Bediener und Rechte" }} />
      <Tabs.Screen name="kassen" options={{ href: null, title: "Kassen" }} />
      <Tabs.Screen name="protokoll" options={{ href: null, title: "Pruefprotokoll" }} />
      <Tabs.Screen name="sicherung" options={{ href: null, title: "Artikel sichern" }} />
      <Tabs.Screen name="buchhaltung" options={{ href: null, title: "Buchhaltung" }} />
    </Tabs>
  );
}
