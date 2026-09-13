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
import { Text } from "react-native";
import { KasseProvider } from "../src/state/KasseProvider.tsx";
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
        </Tabs>
      </KasseProvider>
    </SafeAreaProvider>
  );
}
