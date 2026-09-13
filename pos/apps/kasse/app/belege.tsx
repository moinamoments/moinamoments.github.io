/**
 * Belegliste.
 *
 * Fuer den Nachdruck und den Storno. Beides braucht man haeufiger als man
 * denkt: der Kunde will den Bon doch, oder es wurde etwas falsch gebucht.
 *
 * Belege werden hier nie geaendert - ein Storno erzeugt einen neuen Beleg mit
 * eigener Nummer und eigener TSE-Transaktion (§ 146 Abs. 4 AO).
 */

import React, { useCallback, useEffect, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { type Order, formatEuro, isTseSecured } from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import { Button, Card, Muted, Screen, Title } from "../src/components/ui.tsx";
import { listRecentOrders } from "../src/db/repositories.ts";
import { colors, font, space } from "../src/theme.ts";

export default function BelegeScreen() {
  const kasse = useKasse();
  const router = useRouter();
  const [orders, setOrders] = useState<Order[]>([]);

  const load = useCallback(async () => {
    if (!kasse.ready || !kasse.device) return;
    setOrders(await listRecentOrders(kasse.db(), kasse.device.id, 100));
  }, [kasse]);

  useEffect(() => {
    void load();
  }, [load]);

  // Nach einem Verkauf oder Storno soll die Liste aktuell sein.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onVoid = (order: Order) => {
    Alert.alert(
      "Beleg stornieren",
      `Beleg ${order.receiptNumber} ueber ${formatEuro(order.total)} stornieren? Es entsteht ein neuer Stornobeleg.`,
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Stornieren",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                const voided = await kasse.voidOrder(order);
                await load();
                router.push(`/bon/${voided.id}`);
              } catch (issue) {
                Alert.alert("Storno nicht moeglich", (issue as Error).message);
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <FlatList
        contentContainerStyle={styles.content}
        data={orders}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={<Title>Belege</Title>}
        ListEmptyComponent={<Muted>Noch keine Belege auf diesem Geraet.</Muted>}
        renderItem={({ item }) => (
          <Card style={styles.row}>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(`/bon/${item.id}`)}
              style={styles.rowMain}
            >
              <View>
                <Text style={styles.number}>{item.receiptNumber}</Text>
                <Muted>
                  {(item.paidAt ?? item.startedAt).replace("T", " ").slice(0, 19)}
                  {item.serviceMode === "DINE_IN" ? " · vor Ort" : ""}
                  {item.voidsOrderId ? " · Storno" : ""}
                </Muted>
                {!isTseSecured(item) ? <Text style={styles.unsecured}>ohne TSE-Signatur</Text> : null}
              </View>
              <Text style={styles.amount}>{formatEuro(item.total)}</Text>
            </Pressable>
            {item.voidsOrderId == null && item.total > 0 ? (
              <Button label="Stornieren" onPress={() => onVoid(item)} tone="danger" />
            ) : null}
          </Card>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: space.sm, padding: space.md },
  row: { gap: space.sm },
  rowMain: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  number: { color: colors.text, fontSize: font.label, fontWeight: "700" },
  amount: { color: colors.text, fontSize: font.amount, fontWeight: "800" },
  unsecured: { color: colors.danger, fontSize: font.small, fontWeight: "700" },
});
