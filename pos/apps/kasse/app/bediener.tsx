/**
 * Bediener und Rechte.
 *
 * Das Bild, das ein Betrieb wirklich braucht: eine Rolle als Voreinstellung
 * und einzelne Ausnahmen davon. "Lena darf Artikel pflegen, aber nicht
 * stornieren" ist der haeufigste Wunsch - und mit Rollen allein nicht
 * abbildbar, ohne fuer jeden Sonderfall eine neue Rolle zu erfinden.
 *
 * Was dieser Bildschirm bewusst **nicht** kann:
 *
 *   - **Loeschen.** Alte Belege verweisen auf den Bediener; ein geloeschter
 *     Bediener macht sie unlesbar. Es gibt nur Deaktivieren, und das nimmt
 *     sofort alle Rechte - auch das Kassieren.
 *   - **Rechte erteilen, die man selbst nicht hat.** Sonst reicht ein
 *     Schichtleiter mit Bedienerverwaltung, um sich in zwei Schritten zum
 *     Inhaber zu machen. Die Pruefung dafuer steht im Kern (`canSetCapability`),
 *     nicht hier.
 *   - **Eine PIN anzeigen.** Gespeichert ist nur ihr Pruefwert. Wer seine PIN
 *     vergisst, bekommt eine neue.
 */

import React, { useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  ALL_CAPABILITIES,
  CAPABILITY_LABELS,
  CAPABILITY_NOTES,
  ROLE_LABELS,
  ROLE_ORDER,
  checkDisplayName,
  checkPin,
  canAssignRole,
  canDeactivateUser,
  canSetCapability,
  defaultRoleForNewUser,
  effectiveCapabilities,
  isOverridden,
  roleCan,
  userCan,
  withCapability,
  type Capability,
  type User,
  type UserRole,
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
  Screen,
  Segmented,
  Sheet,
  Title,
  Toggle,
} from "../src/components/ui.tsx";
import { colors, font, space } from "../src/theme.ts";

export default function BedienerScreen() {
  const kasse = useKasse();
  const me = kasse.user;
  const allowed = kasse.can("MANAGE_USERS");

  const [edited, setEdited] = useState<User | null>(null);
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<User | null>(null);
  const [pin, setPin] = useState("");
  const [pinRepeat, setPinRepeat] = useState("");
  const [pinProblem, setPinProblem] = useState<string | null>(null);

  const operators = useMemo(
    () => [...kasse.users].sort((a, b) => ROLE_ORDER.indexOf(b.role) - ROLE_ORDER.indexOf(a.role) || a.name.localeCompare(b.name)),
    [kasse.users],
  );

  if (!allowed) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={styles.content}>
          <Title>Bediener und Rechte</Title>
          <Notice tone="warning">
            Bediener zu verwalten ist fuer Ihren Zugang nicht freigegeben. Der Inhaber kann das Recht erteilen.
          </Notice>
        </ScrollView>
      </Screen>
    );
  }

  const startNew = (): void => {
    if (!kasse.tenant) return;
    setNameProblem(null);
    setEdited({
      id: "",
      tenantId: kasse.tenant.id,
      name: "",
      role: defaultRoleForNewUser(),
      permissionOverrides: null,
      pinHash: null,
      active: true,
    });
  };

  const save = (): void => {
    if (!edited) return;
    const checked = checkDisplayName(edited.name, "Der Name des Bedieners");
    if (!checked.ok) {
      setNameProblem(checked.reason);
      return;
    }
    void (async () => {
      try {
        await kasse.saveOperator({ ...edited, name: checked.value });
        setEdited(null);
      } catch (issue) {
        Alert.alert("Nicht gespeichert", (issue as Error).message);
      }
    })();
  };

  const setRole = (role: UserRole): void => {
    if (!edited || !me) return;
    // Neue Bediener haben noch keine Id - fuer die Pruefung zaehlt dann nur,
    // welche Rechte der Rolle der Anmelder selbst hat.
    const check = canAssignRole(me, { id: edited.id || "neu", role: edited.role }, role, kasse.users);
    if (!check.ok) {
      Alert.alert("Rolle nicht moeglich", check.reason);
      return;
    }
    setEdited({ ...edited, role });
  };

  const toggleCapability = (capability: Capability, granted: boolean): void => {
    if (!edited || !me) return;
    const check = canSetCapability(me, { id: edited.id || "neu", role: edited.role }, capability, granted, kasse.users);
    if (!check.ok) {
      Alert.alert("Recht nicht aenderbar", check.reason);
      return;
    }
    setEdited({ ...edited, permissionOverrides: withCapability(edited, capability, granted) });
  };

  const deactivate = (operator: User): void => {
    if (!me) return;
    const check = canDeactivateUser(me, operator, kasse.users);
    if (!check.ok) {
      Alert.alert("Nicht moeglich", check.reason);
      return;
    }
    Alert.alert(
      "Zugang deaktivieren",
      `${operator.name} kann danach nicht mehr kassieren. Alte Belege bleiben unveraendert lesbar.`,
      [
        { text: "Abbrechen", style: "cancel" },
        {
          text: "Deaktivieren",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await kasse.saveOperator({ ...operator, active: false });
                setEdited(null);
              } catch (issue) {
                Alert.alert("Nicht gespeichert", (issue as Error).message);
              }
            })();
          },
        },
      ],
    );
  };

  const savePin = (): void => {
    if (!pinFor) return;
    const checked = checkPin(pin);
    if (!checked.ok) {
      setPinProblem(checked.reason);
      return;
    }
    if (pin !== pinRepeat) {
      // Zweimal eingeben, weil eine falsch getippte PIN erst beim naechsten
      // Anmelden auffaellt - und dann steht jemand vor einer Kasse, in die er
      // nicht hineinkommt.
      setPinProblem("Die beiden Eingaben stimmen nicht ueberein.");
      return;
    }
    void (async () => {
      try {
        await kasse.setPin(pinFor.id, checked.value);
        setPinFor(null);
        setPin("");
        setPinRepeat("");
        setPinProblem(null);
      } catch (issue) {
        setPinProblem((issue as Error).message);
      }
    })();
  };

  const removePin = (): void => {
    if (!pinFor) return;
    void (async () => {
      try {
        await kasse.setPin(pinFor.id, null);
        setPinFor(null);
        setPin("");
        setPinRepeat("");
      } catch (issue) {
        setPinProblem((issue as Error).message);
      }
    })();
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Bediener und Rechte</Title>
        {kasse.users.every((operator) => !operator.pinHash) ? (
          <Notice tone="warning">
            Kein Bediener hat eine PIN. Die Kasse fragt deshalb beim Start nicht nach - jeder, der das Geraet in die
            Hand nimmt, kann kassieren, stornieren und Geld entnehmen.
          </Notice>
        ) : null}

        <Card>
          {operators.map((operator) => (
            <ListRow
              key={operator.id}
              onPress={() => {
                setNameProblem(null);
                setEdited(operator);
              }}
              subtitle={`${ROLE_LABELS[operator.role]}${
                operator.permissionOverrides && Object.keys(operator.permissionOverrides).length > 0
                  ? ` · ${Object.keys(operator.permissionOverrides).length} Ausnahme(n)`
                  : ""
              }`}
              title={operator.name}
              value={operator.pinHash ? "PIN gesetzt" : "ohne PIN"}
              tone={operator.pinHash ? "normal" : "danger"}
            />
          ))}
        </Card>

        <Button label="Bediener anlegen" onPress={startNew} tone="accent" />

        <Muted>
          Deaktivierte Bediener werden hier nicht mehr angezeigt. Sie bleiben in der Datenbank, weil alte Belege auf
          sie verweisen.
        </Muted>
      </ScrollView>

      {/* --- Bediener bearbeiten --------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Abbrechen" onPress={() => setEdited(null)} style={styles.flex} />
            <Button label="Speichern" onPress={save} style={styles.flex} tone="accent" />
          </View>
        }
        onClose={() => setEdited(null)}
        open={edited !== null}
        title={edited?.id ? edited.name || "Bediener" : "Neuer Bediener"}
        wide
      >
        {edited ? (
          <>
            <Field
              label="Name"
              onChangeText={(value) => {
                setNameProblem(null);
                setEdited({ ...edited, name: value });
              }}
              placeholder="Vorname und Nachname"
              problem={nameProblem}
              value={edited.name}
            />

            <Text style={styles.sectionTitle}>Rolle</Text>
            <Segmented
              onChange={setRole}
              options={ROLE_ORDER.map((role) => ({ value: role, label: ROLE_LABELS[role] }))}
              value={edited.role}
            />
            <Muted>Die Rolle setzt die Voreinstellung. Darunter lassen sich einzelne Rechte abweichend setzen.</Muted>

            <Text style={styles.sectionTitle}>Rechte</Text>
            {ALL_CAPABILITIES.map((capability) => {
              const active = userCan({ ...edited, active: true }, capability);
              const deviates = isOverridden(edited, capability);
              return (
                <View key={capability} style={styles.capability}>
                  <Toggle
                    hint={
                      CAPABILITY_NOTES[capability] ??
                      (deviates
                        ? `Abweichung von der Rolle (${ROLE_LABELS[edited.role]}: ${roleCan(edited.role, capability) ? "erlaubt" : "nicht erlaubt"})`
                        : undefined)
                    }
                    label={CAPABILITY_LABELS[capability]}
                    onValueChange={(value) => toggleCapability(capability, value)}
                    value={active}
                  />
                  {deviates ? <Badge label="Ausnahme" tone="warning" /> : null}
                </View>
              );
            })}

            <Text style={styles.sectionTitle}>Anmeldung</Text>
            {edited.id ? (
              <>
                <Button
                  label={edited.pinHash ? "PIN aendern" : "PIN vergeben"}
                  onPress={() => {
                    setPin("");
                    setPinRepeat("");
                    setPinProblem(null);
                    setPinFor(edited);
                  }}
                />
                <Button label="Zugang deaktivieren" onPress={() => deactivate(edited)} tone="danger" />
              </>
            ) : (
              <Muted>Die PIN wird vergeben, sobald der Bediener gespeichert ist.</Muted>
            )}

            <Text style={styles.sectionTitle}>Wirksame Rechte</Text>
            <Muted>
              {effectiveCapabilities({ ...edited, active: true })
                .map((capability) => CAPABILITY_LABELS[capability])
                .join(", ") || "keine"}
            </Muted>
          </>
        ) : null}
      </Sheet>

      {/* --- PIN vergeben ---------------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Abbrechen" onPress={() => setPinFor(null)} style={styles.flex} />
            <Button label="PIN setzen" onPress={savePin} style={styles.flex} tone="accent" />
          </View>
        }
        onClose={() => setPinFor(null)}
        open={pinFor !== null}
        title={`PIN fuer ${pinFor?.name ?? ""}`}
      >
        <Field
          keyboardType="numeric"
          label="Neue PIN"
          onChangeText={(value) => {
            setPinProblem(null);
            setPin(value.replace(/\D/g, "").slice(0, 8));
          }}
          placeholder="vier bis acht Ziffern"
          secure
          value={pin}
        />
        <Field
          keyboardType="numeric"
          label="PIN wiederholen"
          onChangeText={(value) => {
            setPinProblem(null);
            setPinRepeat(value.replace(/\D/g, "").slice(0, 8));
          }}
          problem={pinProblem}
          secure
          value={pinRepeat}
        />
        <Muted>
          Die PIN wird nur als Pruefwert gespeichert und kann nicht wieder angezeigt werden. Nach fuenf Fehlversuchen
          wird der Zugang zeitweise gesperrt.
        </Muted>
        {pinFor?.pinHash ? (
          <Button
            label="PIN entfernen"
            onPress={removePin}
            subtitle="Der Bediener kann sich dann nicht mehr anmelden"
            tone="danger"
          />
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: space.md, padding: space.md },
  actions: { flexDirection: "row", gap: space.sm },
  sectionTitle: { color: colors.text, fontSize: font.label, fontWeight: "700", marginTop: space.sm },
  capability: { gap: space.xs },
});
