# Architektur

## Der eine Schnitt, auf dem alles steht

```
┌─────────────────────────────────────────────┐
│ apps/kasse        Bildschirme, SQLite,      │
│                   Drucker, Terminal, TSE    │
│                   (alles, was ein Gerät hat)│
└───────────────────┬─────────────────────────┘
                    │ ruft auf, kennt Typen
                    ▼
┌─────────────────────────────────────────────┐
│ packages/core     Rechnen und Recht         │
│                   kein React                │
│                   keine Datenbank           │
│                   kein Betriebssystem       │
└─────────────────────────────────────────────┘
```

Der Kern kennt die App nicht. Er kennt keine Datenbank, kein React, keinen
Drucker. Dafür gibt es einen Grund, der sich in einem Satz sagen lässt: **eine
Belegsumme darf nicht davon abhängen, auf welchem Gerät sie berechnet wird.**

Daraus folgt alles andere:

* Die Summen-, Steuer- und Stornologik lässt sich ohne Emulator testen — und
  wird es auch, Fall für Fall.
* Derselbe Code läuft später im Server. Ein Abgleich, der auf dem Server anders
  rechnet als auf dem Gerät, ist kein Fehler, den man findet; er ist einer, der
  Monate später als Kassendifferenz auffällt.
* Ein Umbau der Oberfläche kann keine Belegsumme verändern.

Umgekehrt gilt: **der Kern speichert nichts.** Er bildet Datensätze, die die App
speichert. `buildMovement` liefert eine Bestandsbewegung, `applyStockMovement`
schreibt sie — getrennt, damit Bewegung und fortgeschriebener Bestand in einer
unteilbaren Einheit landen.

## Was im Kern liegt

| Datei | Verantwortung |
| --- | --- |
| `money.ts` | Centbeträge, Mengen in Tausendsteln, symmetrisches Runden, Verteilung nach größtem Rest |
| `tax.ts` | Steuerschlüssel der DSFinV-K, Aufsummierung je Gruppe, Kleinunternehmer |
| `model.ts` | das Datenmodell, jeder Datensatz mit `tenantId` |
| `limits.ts` | Obergrenzen mit Begründung (Warengruppen, Artikel, Belegzeilen) |
| `validation.ts` | jede Eingabeprüfung der App an einer Stelle |
| `permissions.ts` | Rollen, einzelne Rechte, Schutz vor Rechteausweitung |
| `security/` | Kryptobausteine, PIN, Mandantentrennung, Prüfprotokoll, Gerätesperre |
| `catalog.ts` | Warengruppenbaum, absturzfest gegen fehlerhafte Daten |
| `stock.ts` | Bestand als Journal, nie als gesetzte Zahl |
| `deposit.ts`, `cart.ts` | Warenkorb, Pfand abgeleitet statt gespeichert |
| `order.ts` | Belegabschluss, Zahlungen, Storno und Teilstorno |
| `receipt.ts` | Bon nach § 6 KassenSichV, Umbruch für 58- und 80-mm-Papier |
| `qr.ts` | eigener QR-Encoder, Versionen 1–40 |
| `escpos.ts` | Druckbefehle, Codepage 858, Rastergrafik |
| `payment/terminal.ts` | Kartenzahlung und Tap to Pay, Schnittstelle und Simulator |
| `cashbook.ts`, `closing.ts` | Kassenbuch und Z-Bericht |
| `tse/` | TSE-Schnittstelle, Test-TSE, fiskaly-Adapter |
| `dsfinvk/export.ts` | Kassendaten-Schnittstelle 2.3 |
| `backup.ts` | Artikelstamm als CSV und als Sicherung mit Prüfsumme |
| `sync/outbox.ts` | Warteschlange für den späteren Serverabgleich |

## Die Reihenfolge beim Bezahlen

Das ist der Ablauf, an dem die KassenSichV hängt, und er steht genau so in
`KasseProvider.pay()`:

1. **Belegnummer** aus dem Nummernkreis des Geräts ziehen
2. **TSE-Transaktion abschließen** — oder den Ausfall dokumentieren
3. **Beleg in die Datenbank schreiben**, unteilbar
4. Beleg in die **Outbox** legen
5. erst danach den **Warenkorb leeren**

Schlägt Schritt 3 fehl, ist kein Beleg entstanden und der Warenkorb steht
unverändert da: der Bediener versucht es erneut, ohne dass Ware oder Geld
verloren geht.

Bei Kartenzahlung kommt die Autorisierung **vor** Schritt 2. Wird erst der Beleg
signiert und dann die Karte abgelehnt, steht ein bezahlter Beleg im Bestand, dem
kein Geld gegenübersteht — und der lässt sich nur noch stornieren.

Die TSE-Transaktion beginnt nicht beim Bezahlen, sondern **sobald die erste
Position im Warenkorb landet**. Sonst stünde auf dem Bon eine Startzeit, die
nach der tatsächlichen Erfassung liegt.

## Datenhaltung

SQLite auf dem Gerät ist die **führende** Datenhaltung, kein Cache: die Kasse
muss vollständig offline arbeiten, und ein Beleg ist gültig, sobald er dort
steht. Der Server bekommt ihn später über die Outbox.

Zwei Regeln setzt das Schema selbst durch — nicht nur die Anwendung:

1. **Abgeschlossene Belege sind unveränderlich** (§ 146 Abs. 4 AO). Trigger
   verhindern Ändern und Löschen, damit auch ein Fehler im Code es nicht kann.
   Die einzige erlaubte Änderung ist die Zuordnung zum Kassenabschluss.
2. **Journale sind nur anfügbar.** Bestandsbewegungen, Kassenbewegungen und das
   Prüfprotokoll lassen sich nicht ändern und nicht löschen. Ein Protokoll, das
   sich ändern lässt, beweist nichts — und gebraucht wird es genau dann, wenn
   jemand einen Grund hätte, es zu ändern.

### Zwei Fallen, die schon zugeschlagen haben

**Zeitstempel sortieren nicht chronologisch.** Unsere Zeitstempel tragen den
Offset der Ortszeit, und als Zeichenkette verglichen liegt `09:00+02:00` hinter
`09:00+00:00` — real aber davor. Über die Sommerzeitumstellung hinweg stünde ein
Journal damit in falscher Reihenfolge. Deshalb wird überall nach `rowid`
sortiert, nicht nach dem Zeitstempeltext.

**Ein Artikelformular darf den Bestand nicht mitschreiben.** Sonst macht jedes
Speichern eines Artikels alle Bestandsbewegungen zunichte. `saveProduct`
schreibt die Bestandsspalte deshalb bewusst nicht; sie ändert sich nur über
`applyStockMovement`.

## Nummernkreise

Jede Kasse hat einen **eigenen** Belegnummernkreis, geführt in einer eigenen
Tabelle statt als `MAX(nummer)+1` — damit die Nummer auch dann lückenlos
weiterläuft, wenn ein Beleg beim Speichern scheitert.

Genau ein Eintrag in `device` trägt `is_this_device = 1`. Zwei Geräte, die aus
demselben Nummernkreis ziehen, erzeugen zwei verschiedene Belege mit derselben
Nummer, und das ist bei einer Kassennachschau nicht mehr zu erklären.

## Mandantentrennung

Auf dem Gerät liegt praktisch immer nur ein Mandant. Die Prüfungen in
`security/tenant.ts` sind trotzdem scharf, weil derselbe Code im Server läuft und
weil ein Gerätewechsel oder ein fehlerhafter Abgleich Daten zweier Mandanten
zusammenbringen kann.

Im Server gilt die Regel, die keine Ausnahme kennt: **die Mandanten-Id kommt
niemals aus der Anfrage.** Wer dem Client glaubt, hat keine Mandantentrennung,
sondern eine Bitte. Sie wird aus dem geprüften Zugangstoken abgeleitet, und
zusätzlich sichert die Datenbank sie ab (bei PostgreSQL: Row Level Security),
damit eine vergessene `WHERE`-Bedingung kein Datenleck ist, sondern eine leere
Antwort.

## Warum eigene Bausteine statt Bibliotheken

Drei Stellen sind selbst geschrieben, jede aus einem konkreten Anlass:

* **QR-Encoder** (`qr.ts`). `react-native-qrcode-svg` zog über
  `react-native-svg/css` → `css-tree` → `source-map` das Node-Modul `url`
  herein und zerlegte damit das Bundle. Der eigene Encoder ist Modul für Modul
  gegen eine unabhängige Umsetzung geprüft, für alle acht Masken und die
  Versionen 1–40.
* **Kryptobausteine** (`security/hash.ts`). Hermes hat keine Web Crypto. SHA-256,
  HMAC und PBKDF2 sind deshalb in reinem TypeScript und byteweise gegen
  `node:crypto` geprüft. `randomBytes` **wirft**, statt auf `Math.random`
  auszuweichen — ein schlechter Zufall bei einem Salt fällt nie auf.
* **Oberflächenbausteine** (`components/ui.tsx`). Eine Kasse braucht wenige,
  dafür verlässlich große Elemente. Jede Schaltfläche ist mindestens 56 px hoch,
  jede Kachel 96 px: unter 44 px trifft niemand mit klebrigen Fingern.

## Tests ohne Gerät

Die Ablauftests laufen über `node:sqlite` gegen **dasselbe Schema** wie die App —
dieselben Trigger, dieselben Fremdschlüssel, dieselben Abfragen der
Repositories. Ein Trigger, der das Ändern bezahlter Belege verhindern soll, ist
sonst nur eine Behauptung im Schema.

`apps/kasse/src/db/testing/nodeDb.ts` ist die einzige Datei dafür; sie wird von
der App nie importiert und landet nicht im Bundle.

## Migrationen

Sie laufen über `user_version`, unteilbar, genau einmal, nur nach vorne. Ein
Rückwärtsweg ist nicht vorgesehen: eine Kasse mit Belegen wird nicht
zurückgerollt.

Solange die App nicht ausgeliefert ist, wird Migration 1 fortgeschrieben — ein
Schema aus zwanzig Änderungsschritten an einer nie benutzten Tabelle liest
niemand mehr. **Ab der ersten Auslieferung gilt das nicht mehr:** dann bekommt
jede Änderung ihre eigene Migration, weil auf den Geräten Belege liegen, die
zehn Jahre lesbar bleiben müssen.
