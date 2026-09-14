/**
 * Kassenbuch.
 *
 * Alles, was am Bargeld passiert, ohne dass etwas verkauft wird:
 * Tageseroeffnung, Wechselgeld nachlegen, Privatentnahme, Geld zur Bank,
 * Trinkgeld auszahlen.
 *
 * Zwei Dinge, die hier nicht verhandelbar sind:
 *
 *   - **Die Tageseroeffnung wird gezaehlt, nicht geschaetzt.** Ohne
 *     Anfangsbestand ist die Differenz am Abend ohne Aussage: das Wechselgeld
 *     erscheint dann als Ueberschuss. Deshalb gibt es ein Zaehlprotokoll nach
 *     Stueckelung und keine Eingabe "ungefaehr 150 Euro".
 *   - **Jede Bewegung braucht einen Grund.** Eine Entnahme ohne Grund ist bei
 *     einer Kassennachschau nicht erklaerbar, und "war schon immer so" zaehlt
 *     dort nicht. Der Kern lehnt sie deshalb ab.
 *
 * Eine Korrektur gibt es nicht. Eine falsch gebuchte Entnahme wird durch eine
 * Einlage mit dem Grund "Korrektur der Entnahme von …" ausgeglichen - so bleibt
 * beides sichtbar. Genau das ist der Sinn eines Journals.
 */

import React, { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  CASH_MOVEMENT_LABELS,
  checkAmount,
  checkRequiredText,
  countCash,
  formatEuro,
  summarizeCashbook,
  type CashMovementType,
} from "@kp/core";
import { useKasse } from "../src/state/KasseProvider.tsx";
import {
  Button,
  Card,
  Field,
  ListRow,
  Muted,
  Notice,
  Row,
  Screen,
  Segmented,
  Sheet,
  Title,
} from "../src/components/ui.tsx";
import { Zaehlprotokoll, toCashCount, type CashCounts } from "../src/components/Zaehlprotokoll.tsx";
import { colors, font, space } from "../src/theme.ts";

/** Bewegungsarten, die von Hand gebucht werden - ohne OPENING. */
const MANUAL_TYPES: readonly CashMovementType[] = ["DEPOSIT", "WITHDRAWAL", "TRANSIT", "TIP_OUT"];

export default function KassenbuchScreen() {
  const kasse = useKasse();
  const mayMove = kasse.can("CASH_MOVEMENT");
  const mayOpen = kasse.can("OPEN_DAY");

  const [openingVisible, setOpeningVisible] = useState(false);
  const [counts, setCounts] = useState<CashCounts>({});
  const [openingProblem, setOpeningProblem] = useState<string | null>(null);

  const [movementVisible, setMovementVisible] = useState(false);
  const [type, setType] = useState<CashMovementType>("WITHDRAWAL");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [amountProblem, setAmountProblem] = useState<string | null>(null);
  const [reasonProblem, setReasonProblem] = useState<string | null>(null);

  const summary = useMemo(() => summarizeCashbook(kasse.cashMovements), [kasse.cashMovements]);
  const dayOpened = useMemo(() => kasse.cashMovements.some((item) => item.type === "OPENING"), [kasse.cashMovements]);

  /** Gezaehltes Bargeld aus den Eingabefeldern. */
  const countedEntries = useMemo(() => toCashCount(counts), [counts]);
  const countedTotal = useMemo(() => countCash(countedEntries), [countedEntries]);

  const saveOpening = (): void => {
    if (countedTotal === 0) {
      setOpeningProblem("Ohne gezaehltes Bargeld gibt es nichts zu eroeffnen - der Anfangsbestand ist dann 0,00 EUR.");
      return;
    }
    void (async () => {
      try {
        await kasse.openCashDay(countedEntries);
        setOpeningVisible(false);
        setCounts({});
        setOpeningProblem(null);
      } catch (issue) {
        setOpeningProblem((issue as Error).message);
      }
    })();
  };

  const saveMovement = (): void => {
    const checkedAmount = checkAmount(amount, { label: CASH_MOVEMENT_LABELS[type] });
    if (!checkedAmount.ok) {
      setAmountProblem(checkedAmount.reason);
      return;
    }
    const checkedReason = checkRequiredText(reason, { label: "Der Grund", max: 120 });
    if (!checkedReason.ok) {
      setReasonProblem(checkedReason.reason);
      return;
    }
    void (async () => {
      try {
        await kasse.addCashMovement(type, checkedAmount.value, checkedReason.value);
        setMovementVisible(false);
        setAmount("");
        setReason("");
        setAmountProblem(null);
        setReasonProblem(null);
      } catch (issue) {
        setAmountProblem((issue as Error).message);
      }
    })();
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <Title>Kassenbuch</Title>

        {!dayOpened ? (
          <Notice tone="warning">
            Der Tag ist nicht eroeffnet. Ohne gezaehlten Anfangsbestand ist die Kassendifferenz am Abend ohne
            Aussage - das Wechselgeld erscheint dann als Ueberschuss.
          </Notice>
        ) : null}

        <Card style={styles.card}>
          <Title>Laufende Schicht</Title>
          <Row label="Anfangsbestand" value={formatEuro(summary.opening)} />
          <Row label="Einlagen" value={formatEuro(summary.deposits)} />
          <Row label="Entnahmen" tone={summary.withdrawals < 0 ? "danger" : "normal"} value={formatEuro(summary.withdrawals)} />
          <Row label="Geldtransit" value={formatEuro(summary.transits)} />
          <Row label="Trinkgeld ausgezahlt" value={formatEuro(summary.tipOuts)} />
          <Row bold label="Bar ohne Verkaeufe" value={formatEuro(summary.opening + summary.netMovements)} />
          <Muted>
            Der Barumsatz kommt aus den Belegen und steht im Kassenabschluss. Hier stehen nur die Bewegungen, zu
            denen es keinen Beleg gibt.
          </Muted>
        </Card>

        <Button
          disabled={!mayOpen || dayOpened}
          label={dayOpened ? "Tag ist eroeffnet" : "Tag eroeffnen"}
          onPress={() => {
            setOpeningProblem(null);
            setOpeningVisible(true);
          }}
          subtitle={dayOpened ? undefined : "Anfangsbestand zaehlen"}
          tone="accent"
        />
        <Button
          disabled={!mayMove}
          label="Geld einlegen oder entnehmen"
          onPress={() => {
            setAmountProblem(null);
            setReasonProblem(null);
            setMovementVisible(true);
          }}
        />
        {!mayMove ? <Muted>Kassenbewegungen sind fuer Ihren Zugang nicht freigegeben.</Muted> : null}

        <Card>
          <Title>Bewegungen dieser Schicht</Title>
          {kasse.cashMovements.length === 0 ? <Muted>Noch keine Bewegung gebucht.</Muted> : null}
          {[...kasse.cashMovements].reverse().map((movement) => (
            <ListRow
              key={movement.id}
              subtitle={`${movement.createdAt.replace("T", " ").slice(0, 16)} · ${movement.reason}`}
              title={CASH_MOVEMENT_LABELS[movement.type]}
              tone={movement.amount < 0 ? "danger" : "success"}
              value={formatEuro(movement.amount)}
            />
          ))}
        </Card>

        <Muted>
          Eine gebuchte Bewegung kann nicht geaendert oder geloescht werden. Eine falsche Buchung wird durch eine
          gegenlaeufige mit entsprechendem Grund ausgeglichen - so bleibt beides nachvollziehbar.
        </Muted>
      </ScrollView>

      {/* --- Tageseroeffnung -------------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Abbrechen" onPress={() => setOpeningVisible(false)} style={styles.flex} />
            <Button label="Tag eroeffnen" onPress={saveOpening} style={styles.flex} tone="accent" />
          </View>
        }
        onClose={() => setOpeningVisible(false)}
        open={openingVisible}
        title="Anfangsbestand zaehlen"
        wide
      >
        <Zaehlprotokoll
          counts={counts}
          hint="Anzahl je Nennwert eintragen. Was nicht in der Kasse ist, bleibt leer."
          onChange={(next) => {
            setOpeningProblem(null);
            setCounts(next);
          }}
        />
        <Row bold label="Gezaehlt" value={formatEuro(countedTotal)} />
        {openingProblem ? <Text style={styles.problem}>{openingProblem}</Text> : null}
      </Sheet>

      {/* --- Bewegung buchen ------------------------------------------- */}
      <Sheet
        footer={
          <View style={styles.actions}>
            <Button label="Abbrechen" onPress={() => setMovementVisible(false)} style={styles.flex} />
            <Button label="Buchen" onPress={saveMovement} style={styles.flex} tone="accent" />
          </View>
        }
        onClose={() => setMovementVisible(false)}
        open={movementVisible}
        title="Kassenbewegung"
        wide
      >
        <Segmented
          onChange={setType}
          options={MANUAL_TYPES.map((item) => ({ value: item, label: CASH_MOVEMENT_LABELS[item] }))}
          value={type}
        />
        <Muted>
          {type === "WITHDRAWAL"
            ? "Privatentnahme: Geld, das der Betrieb aus der Kasse nimmt."
            : type === "DEPOSIT"
              ? "Einlage: Geld, das in die Kasse gelegt wird, etwa Wechselgeld."
              : type === "TRANSIT"
                ? "Geldtransit: Geld, das zur Bank oder in den Safe geht."
                : "Trinkgeld an Arbeitnehmer: aus der Kasse ausgezahltes Trinkgeld."}
        </Muted>
        <Field
          keyboardType="decimal-pad"
          label="Betrag"
          onChangeText={(value) => {
            setAmountProblem(null);
            setAmount(value);
          }}
          placeholder="0,00"
          problem={amountProblem}
          value={amount}
        />
        <Field
          label="Grund"
          multiline
          onChangeText={(value) => {
            setReasonProblem(null);
            setReason(value);
          }}
          placeholder={type === "WITHDRAWAL" ? "z. B. Einkauf Milch bei Metro" : "z. B. Wechselgeld nachgelegt"}
          problem={reasonProblem}
          value={reason}
        />
        <Muted>
          Der Grund ist Pflicht und steht spaeter im Kassenbuch und im Pruefprotokoll. Er soll so genau sein, dass
          er in einem halben Jahr noch verstaendlich ist.
        </Muted>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { gap: space.md, padding: space.md },
  card: { gap: space.xs },
  actions: { flexDirection: "row", gap: space.sm },
  problem: { color: colors.danger, fontSize: font.body, fontWeight: "600" },
});
