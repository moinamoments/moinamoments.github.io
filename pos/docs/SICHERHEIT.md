# Sicherheit

Fünf Bereiche, und für jeden das Risiko, wenn er vernachlässigt wird. Dieselbe
Aufteilung, in der sie gestellt wurden — weil sie richtig ist.

| Bereich | Risiko | Stand |
| --- | --- | --- |
| Nutzer-Authentifizierung | Übernahme eines Zugangs | umgesetzt |
| Backend-Absicherung | Datenleck, Manipulation von Verkaufsdaten | vorbereitet, Server fehlt |
| Verschlüsselung (Transport und Ruhe) | DSGVO-Verstoß, Bußgeld | Transport umgesetzt, Ruhe offen |
| Mandantentrennung | Kunde A sieht Daten von Kunde B | umgesetzt |
| Geräte- und App-Sicherheit | gestohlenes Gerät, physischer Zugriff | umgesetzt, mit Grenzen |

## 1. Anmeldung

### PIN, nicht Passwort

Am Verkaufsstand wird eine PIN getippt, kein Passwort. Vier bis acht Ziffern,
Ziffernblock mit 72-px-Tasten — eine Systemtastatur trifft niemand im Stehen mit
klebrigen Fingern.

Gespeichert wird nur ein **PBKDF2-HMAC-SHA256-Prüfwert** mit 60 000 Runden und
einem zufälligen Salt je Bediener. Format:

```
pbkdf2$sha256$60000$<salt>$<key>
```

Die Rundenzahl steht **im Prüfwert**. Damit lässt sie sich später erhöhen, ohne
alle PINs ungültig zu machen: beim nächsten erfolgreichen Anmelden wird neu
gehasht — der einzige Zeitpunkt, an dem die PIN im Klartext vorliegt.

Verglichen wird in konstanter Zeit (`timingSafeEqual`). Ein Vergleich, der bei der
ersten abweichenden Stelle abbricht, verrät über die Laufzeit, wie viele Stellen
stimmen.

`randomBytes` **wirft**, wenn kein kryptographischer Zufall verfügbar ist, statt
auf `Math.random` auszuweichen. Ein schlechter Zufall bei einem Salt fällt nie
auf — und ist genau dann fatal, wenn es darauf ankommt.

### Zu schwache PIN wird abgelehnt

`checkPin` weist `1111` und `1234` ab. Eine Kasse mit der PIN 1234 schützt
nichts, und das fällt erst auf, wenn Geld fehlt.

Beim **Eingeben** gilt die Regel absichtlich nicht: eine bestehende PIN muss sich
eingeben lassen, auch wenn sie nach heutigen Regeln nicht mehr vergeben würde.
`verifyPin` prüft nicht nach, ob die PIN den heutigen Regeln entspricht — sonst
sperrt eine verschärfte Regel Bediener aus.

### Fehlversuche

Nach fünf Fehlversuchen wird gesperrt, steigend: 30 s → 2 min → 10 min → 30 min
→ 1 h, gedeckelt bei einer Stunde. Eine dauerhafte Sperre würde den Betrieb
anhalten, und dann wird die Kasse umgangen statt benutzt.

Gezählt wird **je Bediener und je Gerät**. Sonst könnte ein falsch getippter PIN
am Nebenstand den Hauptstand stilllegen. Die Sperre steht in der Datenbank, nicht
im Arbeitsspeicher — ein Neustart der App darf sie nicht aufheben, sonst ist sie
wertlos.

Ein **deaktivierter** Zugang löst keine Sperre aus: sonst könnte ein
ausgeschiedener Mitarbeiter mit seiner alten PIN den Zugang eines aktiven
sperren.

Nach außen wird nicht unterschieden, ob die PIN falsch war oder der Bediener
nicht existiert. Am Gerät einer Kasse ist das weniger heikel als im Internet,
aber es kostet auch nichts, es richtig zu machen.

### Rechte

Rollen als Voreinstellung — Mitarbeiter, Schichtleitung, Inhaber — und **einzelne
Abweichungen** davon. Das ist der Fall, den ein Betrieb wirklich hat: „Lena darf
Artikel pflegen, aber nicht stornieren." Mit Rollen allein müsste man für jeden
Sonderfall eine neue Rolle erfinden.

Sechzehn Rechte, fein geschnitten, weil genau diese Trennungen gewünscht werden:
Kassieren ≠ Stornieren, Artikel pflegen ≠ Preise ändern ≠ Einstellungen ändern.

Drei Regeln schützen vor Rechteausweitung, alle im Kern geprüft:

1. **Erteilen kann man nur, was man selbst hat.** Sonst reicht eine
   Schichtleitung mit Bedienerverwaltung, um sich in zwei Schritten zum Inhaber
   zu machen.
2. Eine **Rolle** zu vergeben heißt, alle ihre Rechte zu vergeben — dieselbe
   Regel gilt.
3. Der **letzte** Zugang mit Bedienerverwaltung kann sich dieses Recht nicht
   selbst nehmen und nicht deaktiviert werden. Sonst kommt niemand mehr an die
   Einstellungen.

Ein deaktivierter Bediener hat **keine** Rechte, auch nicht zum Kassieren. Und er
wird deaktiviert, nicht gelöscht: alte Belege verweisen auf ihn.

Die Bildschirme fragen `can(...)` und blenden aus, was nicht erlaubt ist. Die
Aktionen im Zustand prüfen es **zusätzlich** — ein ausgeblendeter Knopf ist keine
Sicherung. Eine verweigerte Handlung landet im Prüfprotokoll.

## 2. Backend

Es gibt noch keinen Server. Was vorbereitet ist und gilt, sobald es einen gibt:

**SQL-Injection.** Jede Abfrage ist parametrisiert; es gibt keine Stelle, an der
ein Wert in eine SQL-Zeichenkette gesetzt wird. Auch die Mandantenbedingung
liefert Bedingung und Parameter **getrennt** zurück (`tenant_id = ?`) — das ist
der Unterschied zwischen einer sicheren Abfrage und einer, die sich mit einer
Mandanten-Id wie `x' OR '1'='1` aushebeln lässt. Selbst der Spaltenname wird
gegen ein Muster geprüft, obwohl er aus dem Code kommt: die Prüfung ist die
Zusicherung, dass das so bleibt.

**Zugriffsschutz.** Der Server leitet die Mandanten-Id aus dem geprüften
Zugangstoken ab und niemals aus der Anfrage. Zusätzlich eine Prüfung auf
Datenbankebene (bei PostgreSQL: Row Level Security), damit eine vergessene
`WHERE`-Bedingung kein Datenleck ist, sondern eine leere Antwort.

**Die Outbox ist kein Freibrief.** Was das Gerät sendet, muss der Server prüfen:
Gehört der Beleg zum Mandanten des Tokens? Ist die Belegnummer im Nummernkreis
dieses Geräts? Existiert sie schon? Ein Server, der Belege ungeprüft übernimmt,
ist die einfachste Stelle, Verkaufsdaten zu manipulieren.

## 3. Verschlüsselung

### Transport

Nach draußen nur über **https**, geprüft durch `checkSecureUrl`. Kein
Rückfallweg auf http, und Zugangsdaten in der Adresse werden abgelehnt (sie
landen in Protokollen und Verläufen). Der Grund ist konkret: eine Kasse hängt
oft im Gastnetz eines Marktes, und dort liest jeder mit.

Eine Ausnahme, mit Auflage: **Bondrucker sprechen kein TLS.** Dafür dürfen sie
nur im eigenen Netz stehen — `checkLocalPrinterUrl` lässt ausschließlich private
Adressbereiche zu (10.x, 172.16–31.x, 192.168.x, 127.x, `.local`, Namen ohne
Punkt). Ein „Drucker" im Internet bekäme den Tagesumsatz im Klartext zugeschickt.

### Ruhe

**Offen, und bewusst als offen benannt.** Was heute gilt:

* **Geheimnisse gehören nicht in die Datenbank.** `SECRET_KEYS` zählt sie
  vollständig auf (TSE-Schlüssel, Zugangstoken, Datenbankschlüssel);
  `assertNoSecretFields` bricht ab, wenn ein Feld wie `apiKey` in einem
  Datensatz auftaucht. Der abgefangene Fall: jemand ergänzt ein Feld in der
  Gerätekonfiguration, und damit steht der Schlüssel in einer Datei, die in jeder
  Sicherung landet.
* Die `SecretStore`-Schnittstelle steht; anzubinden ist `expo-secure-store`
  (Keychain auf iOS, Keystore auf Android).
* Die SQLite-Datei selbst ist **nicht** verschlüsselt. Sie liegt im geschützten
  Bereich der App — auf einem entsperrten, gerooteten Gerät ist sie lesbar.
  SQLCipher braucht einen Entwicklungs-Build; siehe [ROADMAP.md](ROADMAP.md).

Was das bedeutet, ohne Beschönigung: **ein gestohlenes, entsperrtes Gerät gibt
seine Umsatzdaten her.** Die Gerätesperre des Betriebssystems ist dagegen die
erste Verteidigung, nicht diese App.

## 4. Mandantentrennung

Das Risiko, das ein Produkt beendet. Passiert es einmal nachweisbar, ist es eine
meldepflichtige Verletzung nach Art. 33 DSGVO und das Ende des Vertrauens —
beides lässt sich nicht nachträglich reparieren.

Jede Zeile jeder Tabelle trägt `tenant_id`, seit der ersten Migration. Die
Prüfungen in `security/tenant.ts` stehen überall dort, wo Daten aus verschiedenen
Quellen zusammenkommen, und sie sind absichtlich unbequem: sie **werfen**, statt
still zu filtern. Ein stiller Filter versteckt den Fehler, ein Abbruch zeigt ihn
beim ersten Test.

Die eine Ausnahme ist der Kassenbildschirm: dort wäre ein Abbruch schlimmer als
eine unvollständige Liste. `filterToTenant` gibt deshalb die
Zahl der aussortierten Datensätze zurück, und der Aufrufer **muss** sie melden.

Fehlermeldungen nennen nur Ids, nie Daten des fremden Mandanten. Eine
Fehlermeldung mit dem Namen eines anderen Betriebs wäre selbst ein kleines
Datenleck, und Fehlermeldungen landen in Protokollen.

`assertDeviceBelongs` fängt den Fall ab, der in der Praxis passiert: ein Gerät
wird aus einem Betrieb in einen anderen gegeben, ohne zurückgesetzt zu werden.
Dann liegen zwei Mandanten auf einem Gerät, und der nächste Beleg trägt die
falsche Adresse.

## 5. Gerät und App

### Sperre

Nach fünf Minuten ohne Bedienung und beim Wechsel in den Hintergrund (mit
strenger Einstellung) wird gesperrt; danach ist eine PIN nötig.

Die entscheidende Umsetzungsentscheidung: **die Sperre wird beim Aufwachen
gerechnet, nicht von einem Zeitgeber.** Das Betriebssystem hält eine App im
Hintergrund an — ein `setInterval` läuft dort nicht weiter, und ein Tablet in der
Tasche wäre nach zwei Stunden unversperrt. Beim Zurückkommen wird gerechnet, wie
lange die App weg war.

Ein **offener Warenkorb** hält die Sperre auf: ein Vorgang, der mitten im
Kassieren abbricht, ärgert den Kunden und erzeugt einen halben Beleg. Wer das
anders will, schaltet die strenge Einstellung ein.

Ein **unlesbarer Zeitstempel sperrt im Zweifel**. Eine unnötige Sperre kostet eine
PIN-Eingabe, eine unterlassene die Umsätze.

Der Anmeldebildschirm **ersetzt** die Reiter, statt über ihnen zu liegen: ein
Fenster kann geschlossen werden, ein nicht gezeichneter Bildschirm nicht. Ein
noch offener Verweis auf `/artikel` ist damit wirkungslos.

### Prüfprotokoll

Getrennt von den Belegen. Die Belege sagen, was verkauft wurde; das Protokoll
sagt, **wer was am System getan hat** — angemeldet, storniert, Geld entnommen,
Preise geändert, Rechte vergeben, Daten ausgegeben.

Warum eigenständig: wenn am Monatsende Geld fehlt, ist die erste Frage nicht
„welche Belege gibt es", sondern „wer war angemeldet und was hat er gemacht".
Ohne dieses Protokoll ist die Antwort nicht zu beschaffen, und der Verdacht bleibt
an allen hängen.

Zwei Regeln halten es brauchbar:

1. **Nur anfügen.** Trigger verhindern Ändern und Löschen. Ein Protokoll, das
   sich ändern lässt, beweist nichts — und gebraucht wird es genau dann, wenn
   jemand einen Grund hätte, es zu ändern.
2. **Keine Geheimnisse darin.** `assertNoSecrets` weist einen Eintrag ab, der
   einen PIN-Prüfwert, ein Bearer-Token, ein `api_key=` oder eine vollständige
   Kartennummer enthält — und bricht ab, statt zu schreiben. Ein Protokoll wird
   exportiert, weitergegeben und aufbewahrt; was darin steht, verlässt irgendwann
   das Gerät.

Die Auswertung nennt Zahlen, keine Bewertung: Storni je Bediener nach Betrag,
Fehlanmeldungen, Sperren, TSE-Ausfälle, verweigerte Zugriffe. Die Kasse weiß
nicht, ob ein Betrieb dreißig Storni am Tag normal findet.

### Was die App nicht kann

Diese Grenzen stehen auch in der App (`DEVICE_HARDENING_ADVICE`), damit niemand
sich auf etwas verlässt, das nicht da ist:

* **Gerätesperre des Betriebssystems** einschalten — sie ist die erste
  Verteidigung, nicht diese App.
* **Kein Fernzugriff und keine Fernlöschung.** Die Kasse arbeitet offline; ein
  verlorenes Gerät lässt sich von hier aus nicht sperren. Das leistet eine
  Geräteverwaltung (MDM), nicht die App.
* Kein Schutz gegen ein **gerootetes** Gerät. Wer Systemrechte hat, liest die
  Datenbank.
* **Bediener deaktivieren**, wenn jemand ausscheidet — nicht die PIN
  weitergeben.
* Nach einem Verlust: **PINs neu vergeben** und die TSE-Zugangsdaten beim
  Anbieter austauschen.

## 6. Fremde Dateien

Der Wareneingang (Bildschirm „Wareneingang") ist die einzige Stelle, an der die
Kasse **eine Datei öffnet, die jemand anders geschrieben hat** — eine
Lieferantenrechnung als PDF, XML oder CSV. Das ist eine eigene Angriffsfläche,
und sie wird wie eine behandelt.

### Keine Dokumenttypdefinition

`<!DOCTYPE>` wird abgewiesen, bevor irgendetwas gelesen wird. Dort stehen
Entitätsdefinitionen, und daran hängen zwei alte Angriffe:

* **XXE** — eine Entität verweist auf `file:///…` und liest damit Dateien vom
  Gerät in die Rechnung hinein. Ein Angreifer, der eine Rechnung schicken darf,
  bekommt so den Inhalt der Kassendatenbank zu sehen.
* **Die „Milliarde Lacher"** — verschachtelte Entitäten blähen wenige Kilobyte
  auf Gigabyte im Speicher auf. Die App ist danach nicht gehackt, sondern
  einfach aus, und zwar mitten im Verkauf.

Wer keine Entitätsdefinitionen versteht, kann beides nicht. Echte ZUGFeRD- und
XRechnungs-Dateien haben keinen DOCTYPE — abgewiesen wird also nichts, was ein
Lieferant wirklich schickt.

### Grenzen an jeder Stelle

Jeder Leser hat eine Obergrenze, und zwar bevor gelesen wird, nicht danach:

| Grenze | Wert | wogegen |
| --- | --- | --- |
| XML-Datei | 8 MB | Speicher |
| Schachtelungstiefe | 40 Ebenen | Aufrufstapel |
| XML-Elemente | 200 000 | Speicher und Rechenzeit |
| PDF-Datei | 32 MB | Speicher |
| Ausgepackte Daten | 64 MB | **Zip-Bombe** |
| Rechnungspositionen | 1000 | Bedienbarkeit |

Die Grenze beim Auspacken ist die wichtigste: Kompression erreicht Verhältnisse
von 1:1000, eine winzige Datei kann zu einem Gigabyte werden. Geprüft wird
**während** des Auspackens, nicht hinterher — hinterher wäre der Speicher schon
voll.

### Was die Daten aus der Datei dürfen

Nichts von allein. Eine eingelesene Rechnung ist ein **Vorschlag**: sie ändert
keinen Bestand, keinen Preis und keinen Artikel, bevor ein Mensch bestätigt hat.
Eine Datei, die eine Menge von 10 000 behauptet, führt zu einer Zeile auf dem
Bildschirm, nicht zu einer Buchung.

Und: Artikel werden **nicht** aus der Rechnung angelegt oder geändert. Der
Lieferant bestimmt nicht, was im Artikelstamm steht.

## Was bewusst offen ist

* **Verschlüsselung der Datenbank** (SQLCipher) — braucht einen
  Entwicklungs-Build.
* **Geheimnisse im Systemschlüsselbund** — Schnittstelle steht,
  `expo-secure-store` anzubinden.
* **Server samt Absicherung** — der Abgleich liegt heute in der Outbox und
  wartet.
* **Zertifikatsbindung** (Certificate Pinning) für den Serverabgleich.
* **Verschlüsselte PDF-Dateien** werden nicht geöffnet, sondern abgewiesen. Das
  ist kein Mangel an Sicherheit, sondern eine fehlende Funktion — wer eine
  geschützte Rechnung bekommt, braucht sie ungeschützt oder als XML.

Diese Liste ist nicht Beschönigung, sondern der Punkt: eine Sicherheitslücke, die
benannt ist, wird geschlossen. Eine, die verschwiegen wird, bleibt.
