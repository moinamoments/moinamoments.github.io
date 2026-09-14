# Roadmap

Was fehlt, in welcher Reihenfolge und **warum**. Ohne Termine: die hängen an
Verträgen mit Dritten, nicht an Entwicklungszeit.

Jeder Eintrag nennt, was heute an seiner Stelle passiert. Eine Lücke, die
benannt ist, wird geschlossen — eine verschwiegene bleibt.

## Stufe 1: Voraussetzung für den Produktivbetrieb

Ohne diese vier Punkte darf die Kasse nicht in einem Betrieb laufen.

### 1.1 TSE anbinden

**Fehlt:** Vertrag mit einem TSE-Anbieter und die Client-Id je Kasse.

**Fertig:** die Schnittstelle (`tse/types.ts`), der Adapter für fiskaly
(`tse/fiskaly.ts`, geprüft gegen die dokumentierten Antwortformate) und eine
Test-TSE für die Entwicklung.

**Heute:** ohne TSE entstehen Belege, die auf dem Bon als **nicht abgesichert**
gekennzeichnet sind; der Ausfall wird in `tse_incident` dokumentiert. Die
Test-TSE trägt eine Seriennummer, die `TEST-TSE` enthält — ein damit
abgeschlossener Beleg fällt auf und geht nicht als echter durch.

**Zu tun:** Vertrag, Client-Id in den Einstellungen eintragen, einen
Entwicklungs-Build bauen und einen echten Beleg gegen die Produktiv-TSE prüfen.

### 1.2 DSFinV-K-Export auf ein Speichermedium schreiben

**Fehlt:** Datei schreiben, als ZIP packen, außerhalb des Geräts ablegen.

**Fertig:** der Export selbst (`dsfinvk/export.ts`) erzeugt alle Dateien der
Spezifikation 2.3 mit korrekten Inhalten; der Kassenabschluss zeigt sie an.

**Heute:** der Export entsteht im Speicher und wird angezeigt, aber nicht
geschrieben.

**Warum zuerst:** § 147 AO verlangt zehn Jahre maschinell auswertbare
Aufbewahrung. **Ein Gerät ist kein Archiv** — es geht verloren, fällt herunter
und wird gestohlen. Solange der Export das Gerät nicht verlässt, ist die Pflicht
nicht erfüllt, auch wenn die Daten technisch korrekt entstehen.

**Zu tun:** `expo-file-system` und `expo-sharing` sind schon eingebunden (die
Artikelsicherung nutzt sie); es fehlt das ZIP-Packen und ein Bildschirm, der den
Export eines Zeitraums statt nur eines Abschlusses ausgibt.

### 1.3 Verschlüsselung der Datenbank

**Fehlt:** SQLCipher, dazu ein Entwicklungs-Build (in Expo Go nicht möglich).

**Fertig:** `SecretStore` als Schnittstelle, `SECRET_KEYS` als vollständige
Aufzählung dessen, was nie in der Datenbank stehen darf, und
`assertNoSecretFields` als Netz dagegen.

**Heute:** die SQLite-Datei liegt unverschlüsselt im geschützten Bereich der
App. Auf einem entsperrten oder gerooteten Gerät ist sie lesbar. Das steht so in
[SICHERHEIT.md](SICHERHEIT.md) — **ein gestohlenes, entsperrtes Gerät gibt seine
Umsatzdaten her.**

**Zu tun:** SQLCipher einbinden, Schlüssel in `expo-secure-store` (Keychain
beziehungsweise Keystore) ablegen, Migration der bestehenden Datei.

### 1.4 Bondruck: der Bluetooth-Kanal und der Entwicklungs-Build

**Fertig:** der Befehlsaufbau (`escpos.ts`) mit Codepage 858 für Umlaute,
Rastergrafik für den QR-Code, Schnitt, Geldschublade und Umbruch für 58- und
80-mm-Papier; der **Transport** (`printing/transport.ts`) mit Stückelung,
Zeitgeber und der Prüfung, dass ein Netzwerkdrucker im eigenen Netz steht; die
Einrichtung samt Testdruck; der Druckknopf am Bon. Der Transport ist gegen einen
echten TCP-Server geprüft — nicht nur gegen eine Attrappe.

**Fehlt:** zweierlei.

* **Der Entwicklungs-Build.** `react-native-tcp-socket` ist ein natives Modul und
  in Expo Go nicht vorhanden. Die App lädt es deshalb verzögert und sagt, wenn
  es fehlt — sie stürzt nicht ab, und der Bon geht anders heraus. Für den echten
  Druck braucht es `npx expo prebuild` und einen eigenen Build.
* **Bluetooth.** Der Transport im Kern ist da und geprüft; es fehlt das
  SPP-Modul auf der Geräteseite. Die Kopplung selbst gehört in die Einstellungen
  des Betriebssystems — eine App, die Geräte selbst koppelt, braucht Rechte, die
  sie nicht braucht.

**Heute:** der Bon wird angezeigt und kann per E-Mail, SMS oder Systemfreigabe
herausgegeben werden. Das **erfüllt die Belegausgabepflicht** (§ 146a Abs. 2 AO)
— der Druck ist Komfort, nicht Pflicht. Deshalb steht dieser Punkt in Stufe 1
nur mit halber Dringlichkeit.

## Stufe 2: Was der Betrieb im Alltag vermisst

### 2.1 DATEV- und Lexware-Export

**Warum:** der Steuerberater bekommt heute den DSFinV-K-Export, und der ist für
eine Prüfung gedacht, nicht für die Buchführung. Ein Buchungsstapel spart im
Monat eine Stunde Abtipperei.

**Zu tun:** DATEV-Buchungsstapel (Format `EXTF`, CSV mit definiertem Kopf) und
das Lexware-Format. **Die Konten dürfen nicht erfunden werden:** SKR03 und SKR04
unterscheiden sich, und jeder Betrieb hat seine eigene Zuordnung. Sie gehören
je Mandant einstellbar — mit den Vorschlägen des jeweiligen Kontenrahmens, aber
ohne sie fest zu verdrahten. Ein falsch gebuchter Erlöskonto-Schlüssel ist ein
Fehler, den der Steuerberater ausbügeln muss.

### 2.2 Wareneingang aus der Lieferantenrechnung

**Warum gefragt:** „wenn bei Metro etwas für den Betrieb eingekauft wird, soll
es automatisch eingebucht werden."

**Was sinnvoll ist:** ZUGFeRD und XRechnung — beides strukturierte
Rechnungsformate, die Großhändler zunehmend liefern. Daraus lassen sich Positionen
und Mengen zuverlässig lesen. Dazu CSV-Import für Lieferanten, die kein
strukturiertes Format haben, und Barcode-Unterstützung: Artikel scannen, Menge
eintippen.

**Was ausdrücklich nicht kommt:** Texterkennung auf einem Rechnungsfoto. Eine
falsch erkannte Menge ist schlimmer als keine — sie sieht richtig aus. Wer einen
Wareneingang aus einem unscharfen Foto bucht, hat einen Bestand, dem er nicht
trauen kann, und merkt es erst bei der Inventur.

**Heute:** Wareneingang wird von Hand gebucht (Bildschirm „Bestand", Grund
`PURCHASE`), mit Bemerkung für die Rechnungsnummer.

### 2.3 Kartenzahlung wirklich abwickeln

**Fertig:** die Schnittstelle (`payment/terminal.ts`), ein Simulator für Tests
ohne Vertrag, die Einrichtung in der App inklusive der Voraussetzungen, die Tap
to Pay verlangt.

**Fehlt:** Vertrag mit einem Zahlungsdienstleister und dessen SDK. Bei Apple
zusätzlich ein eigens beantragtes Entitlement; bei Android die Freigabe des
Anbieters. In Expo Go ist kein Zugriff auf die NFC-Einheit möglich — es braucht
einen Entwicklungs-Build.

**Heute:** eine Kartenzahlung wird auf dem Beleg **gebucht**, aber nicht von der
Kasse abgewickelt. Der Beleg ist dabei vollständig und richtig; es fehlt die
Referenz des Anbieters. Das Geld kommt über ein separates Terminal — für viele
kleine Betriebe ist das der heutige Stand, nicht ein Mangel.

### 2.4 Bestandswert zu Einkaufspreisen

**Warum:** für die Inventur braucht man nicht die Menge, sondern den Wert. Heute
führt der Artikel nur einen Verkaufspreis.

**Zu tun:** Einkaufspreis je Artikel, gewichteter Durchschnitt über die
Wareneingänge, Bestandswert im Bestandsbildschirm. Hängt sinnvollerweise an 2.2:
der Einkaufspreis kommt aus der Lieferantenrechnung.

### 2.5 Zusätze mit eigenem Steuersatz

**Heute:** ein Zusatz („mit Sahne", „großer Becher") teilt den Steuersatz seiner
Position. `cart.ts` **weist einen Zusatz mit eigenem Satz ausdrücklich ab**,
statt ihn falsch zu rechnen.

**Wann es gebraucht wird:** ein Essen (7 %) mit einem Getränk als Zusatz (19 %).
Dann muss der Zusatz eine eigene Belegposition mit eigenem Satz werden — kein
Aufpreis innerhalb einer Position, denn die Steueraufstellung rechnet je
Position.

## Stufe 3: Mehrere Kassen wirklich zusammenführen

### 3.1 Server und Abgleich

**Fertig:** die Outbox auf dem Gerät (`sync/outbox.ts`) mit Wiederholung und
steigenden Abständen; jeder Beleg und jeder Abschluss landet darin.

**Fehlt:** der Server.

**Was dabei nicht verhandelbar ist** (steht in [SICHERHEIT.md](SICHERHEIT.md)):
die Mandanten-Id kommt aus dem geprüften Zugangstoken, niemals aus der Anfrage;
zusätzlich Row Level Security in PostgreSQL, damit eine vergessene
`WHERE`-Bedingung eine leere Antwort ergibt und kein Datenleck; und der Server
prüft, was das Gerät sendet — gehört der Beleg zum Mandanten, liegt die Nummer im
Nummernkreis dieses Geräts, existiert sie schon.

Der Kern läuft dort unverändert. Das war der Grund für den Schnitt.

### 3.2 Artikelstamm über Kassen verteilen

**Heute:** jede Kasse hat ihren eigenen Stamm. Ein neuer Artikel muss an jedem
Gerät angelegt werden — oder über die Sicherung übertragen.

**Zu tun:** hängt an 3.1. Der Stamm gehört dem Mandanten, die Belege dem Gerät.

### 3.3 Auswertung über Kassen und Tage

**Heute:** der Z-Bericht gilt je Kasse und Zeitraum. Was der Betrieb mit drei
Ständen an einem Markttag zusammen umgesetzt hat, muss er addieren.

## Stufe 4: Bedienung feilen

Kein Zwang, aber jedes davon kostet am Stand täglich Zeit:

* **Barcode-Scanner** am Kassenbildschirm. `checkBarcode` und das Feld am Artikel
  sind fertig; es fehlt die Kamera (`expo-camera`) und ein Entwicklungs-Build.
* **Kacheln sortieren** durch Ziehen. Heute bestimmt `sortOrder` die Reihenfolge,
  aber es gibt keinen Bildschirm dafür.
* **Häufige Artikel nach vorn**, aus den Verkäufen der letzten Tage gerechnet.
* **Tastenbelegung** für ein angeschlossenes Zifferneingabegerät.
* **Dunkel und hell.** Die Kasse ist dunkel, weil sie oft in der Sonne steht;
  in einem Innenraum ist hell angenehmer.

## Ausdrücklich nicht geplant

Damit klar ist, wo die Grenze liegt:

* **Warenwirtschaft.** Die Obergrenzen (`limits.ts`: 2000 Artikel, 300
  Warengruppen) sind bewusst so gesetzt, dass eine Kasse bedienbar bleibt. Ein
  Betrieb mit zehntausend Artikeln braucht eine Warenwirtschaft und eine Kasse,
  die daran hängt — nicht eine Kasse, die beides sein will und in keinem von
  beidem gut ist.
* **Personalzeiterfassung.** Andere Pflichten, andere Prüfung, anderes Produkt.
* **Tischverwaltung mit Grundriss.** Für Gastronomie im Haus richtig, für einen
  Verkaufsstand Ballast. Das Parken von Vorgängen deckt den Fall ab, für den es
  hier gebraucht wird.
* **Texterkennung auf Rechnungsfotos.** Siehe 2.2.
* **Eigene Zahlungsabwicklung.** Das ist ein Geschäft mit Zulassung und Haftung,
  kein Modul.
