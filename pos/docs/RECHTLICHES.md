# Rechtliches

Diese Datei beschreibt, **welche Pflichten die Kasse erfüllt, wie sie es tut und
was noch fehlt**. Sie ist Dokumentation der Umsetzung, keine Rechts- oder
Steuerberatung. Ob eine Kasse im Einzelfall genügt, entscheiden Finanzamt und
Prüfer.

## Vor dem Produktivbetrieb

Diese fünf Punkte sind Voraussetzung, nicht Feinarbeit:

1. **Zertifizierte TSE anbinden** (§ 146a AO, § 2 KassenSichV). Der Adapter für
   fiskaly ist fertig; es fehlt der Vertrag und die Client-Id. Ohne TSE erstellt
   die App Belege und **kennzeichnet sie auf dem Bon als nicht abgesichert** —
   sie verschweigt es nicht, aber sie ersetzt die TSE auch nicht.
2. **Kasse dem Finanzamt melden** (§ 146a Abs. 4 AO). Art, Anzahl und
   Seriennummer der Kassen und der TSE.
3. **Betriebsdaten ausfüllen.** Ein Bon mit Platzhalteradresse ist kein gültiger
   Beleg. Die App warnt, solange die Platzhalter drinstehen.
4. **DSFinV-K-Export prüfen lassen.** Er entsteht aus der Spezifikation 2.3,
   nicht aus einer Zertifizierung.
5. **PIN vergeben.** Ohne PIN fragt die Kasse beim Start nicht nach.

## § 146a AO und KassenSichV

### Belegausgabepflicht (§ 146a Abs. 2 AO)

Dem Kunden ist ein Beleg **anzubieten** — nicht, ihn auszudrucken. Ein Bon auf
dem Bildschirm, den der Kunde ansehen oder abfotografieren kann, erfüllt das.
Deshalb ist die Bonanzeige der Regelfall und der Druck die Ergänzung; zusätzlich
kann der Beleg per E-Mail oder SMS herausgegeben werden.

### Pflichtangaben auf dem Bon (§ 6 KassenSichV)

Alle in `receipt.ts` umgesetzt und in `receipt.test.ts` geprüft:

| Angabe | Wo |
| --- | --- |
| vollständiger Name und Adresse des Betriebs | Bonkopf, aus den Betriebsdaten |
| Datum und Zeitpunkt des Vorgangsbeginns **und** des Abschlusses | „Beginn" / „Ende" |
| Menge und Art der Leistung | jede Belegzeile |
| Entgelt, aufgeteilt nach Steuersätzen | Steueraufstellung |
| Zahlungsart | Zahlungszeilen |
| Transaktionsnummer, Signaturzähler, Prüfwert | TSE-Block |
| Seriennummer der Kasse oder der TSE | TSE-Block |

Der QR-Code („digitaler Kassenbeleg", Format V0) enthält genau die Angaben, die
eine Prüfung braucht. Ist er vorhanden, sind die einzelnen TSE-Zeilen
entbehrlich — sie stehen trotzdem dabei, weil ein Kunde ohne Lesegerät sonst
nichts davon sieht.

### Ausfall der TSE

Ein Ausfall darf den Verkauf **nicht** anhalten — eine Kasse, die bei einem
Netzproblem nicht mehr kassiert, wird umgangen statt benutzt. Stattdessen:

* Der Beleg entsteht, trägt aber statt der Signatur den Hinweis
  „Sicherheitseinrichtung ausgefallen" samt Grund.
* Der Ausfall wird in `tse_incident` dokumentiert und in den Einstellungen
  angezeigt — § 146a AO verlangt die Dokumentation, nicht nur den Hinweis auf
  dem einzelnen Bon.
* Der Kassenabschluss nennt die Zahl der nicht abgesicherten Belege.

## § 146 Abs. 4 AO: Unveränderbarkeit

Ein abgeschlossener Beleg wird nicht geändert und nicht gelöscht. Korrekturen
sind **neue Belege** mit eigener Nummer und eigener TSE-Transaktion.

Durchgesetzt auf drei Ebenen:

1. Die Anwendung bietet es nicht an.
2. Die Repositories schreiben kein `UPDATE` auf bezahlte Belege.
3. **Trigger in SQLite** brechen ab, wenn es doch jemand versucht — damit auch
   ein Fehler im Code es nicht kann.

Der **Storno** erzeugt einen Beleg mit negativen Mengen. Der **Teilstorno** gibt
nur die gewählten Positionen zurück, mit dem anteiligen Betrag; das Pfand folgt
seiner Warenposition. Der Grund ist Pflicht — bei einer Kassennachschau ist er
die erste Frage, und „weiß ich nicht mehr" ist dort keine Antwort. Auf dem
Stornobon steht, welchen Beleg er berichtigt.

## § 147 AO: Aufbewahrung

Belege, Kassenabschlüsse und TSE-Daten sind **zehn Jahre** unveränderbar und
maschinell auswertbar vorzuhalten.

> **Eine Sicherung des Artikelstamms erfüllt das nicht.** Der Bildschirm
> „Artikel sichern" legt eine Sicherung der *Stammdaten* an — Artikel,
> Warengruppen, Preise. Die Aufzeichnungen sind das nicht. Dafür ist der
> DSFinV-K-Export im Kassenabschluss da. Wer das verwechselt, steht bei einer
> Kassennachschau ohne Aufzeichnungen da, und das ist kein Formfehler, sondern
> ein Grund für eine Schätzung.

Was die App heute leistet und was fehlt:

* Die Daten liegen unveränderbar auf dem Gerät, durch Trigger geschützt.
* Der DSFinV-K-Export entsteht je Abschluss.
* **Offen:** das Schreiben des Exports als ZIP auf ein Speichermedium und eine
  Ablage außerhalb des Geräts. Ein Gerät ist kein Archiv — es geht verloren,
  fällt herunter und wird gestohlen. Siehe [ROADMAP.md](ROADMAP.md).

## Umsatzsteuer

### Sätze und Schlüssel

Gerechnet wird mit den Schlüsseln der DSFinV-K (`USt_Schluessel`), nicht mit
Prozentzahlen: 1 = 19 %, 2 = 7 %, 3 = 10,7 %, 4 = 5,5 %, 5 = nicht steuerbar,
6 = steuerfrei, 7 = nicht ermittelbar. Eigene Sätze — etwa die befristeten
16 %/5 % aus 2020 oder ausländische Sätze — gehören in den Bereich ab 11; die
Bereiche 1–8 sind bundesweit belegt.

### Rundung

Preise sind **brutto in Cent**. Die Umsatzsteuer wird **je Steuergruppe auf die
Belegsumme** gerechnet, nicht je Position und dann addiert. Der Unterschied sind
einzelne Cent je Beleg — und genau die fallen bei einer Prüfung auf.

Gerundet wird symmetrisch (`roundHalfUp` rundet −2,5 auf −3), damit ein Storno
den Verkauf **exakt** umkehrt. Rundete man Beträge asymmetrisch, blieben nach
Verkauf und Storno Cent übrig.

### Verzehr vor Ort oder Mitnahme

Speisen sind außer Haus eine Lieferung (7 %), vor Ort eine sonstige Leistung
(19 %). Getränke bleiben in beiden Fällen bei 19 %. Umschaltbar **je Beleg**,
nicht je Artikel fest verdrahtet — für einen Verkaufsanhänger ist das der
Normalfall.

### Kleinunternehmer (§ 19 UStG)

Eingeschaltet weist die Kasse keine Umsatzsteuer aus, zieht alle Positionen auf
den Schlüssel 6 (steuerfrei) und setzt den vorgeschriebenen Hinweis auf jeden
Bon. Ohne den Hinweis ist der Beleg unvollständig und der Kunde könnte Vorsteuer
vermuten.

### Rechnung statt Kassenbon

Bis 250 EUR brutto genügt die Kleinbetragsrechnung (§ 33 UStDV). **Darüber**
verlangt § 14 Abs. 4 UStG Name und Adresse des Leistungsempfängers. Die App
weist darauf hin, sobald ein Beleg die Grenze überschreitet: ein Kunde, der eine
Rechnung über 300 EUR ohne seine Adresse bekommt, kann keine Vorsteuer ziehen —
und kommt zurück.

## Pfand

Frei definierbare Pfandartikel mit beliebigem Betrag; ein Artikel kann mehrere
mitbringen (Becher **und** Deckel). Pfand ist ein eigener Geschäftsvorfall
(`Pfand` / `PfandRueckzahlung`) und erscheint im Kassenabschluss **getrennt vom
Warenumsatz** — es ist kein Umsatz, sondern ein durchlaufender Posten.

Im Warenkorb wird das Pfand **abgeleitet** und nicht gespeichert: es kann damit
nicht von der Menge abweichen. Nimmt der Kunde sein eigenes Gefäß mit, entfällt
es je Position.

Die Einweg-Pfandpflicht des VerpackG bestimmt, *welche* Gebinde Pfand tragen —
das ist eine Entscheidung des Betriebs, nicht der Kasse. Die Kasse stellt nur
sicher, dass das eingestellte Pfand richtig gebucht wird.

## Kassenbuch und Kassensturz

Jede Bargeldbewegung ohne Beleg wird erfasst: Tageseröffnung, Einlage, Entnahme,
Geldtransit, Trinkgeldauszahlung. Jede mit **Grund** — eine Entnahme ohne Grund
ist bei einer Kassennachschau nicht erklärbar.

Die Tageseröffnung wird **gezählt**, nicht geschätzt: ohne Anfangsbestand ist die
Differenz am Abend ohne Aussage, denn das Wechselgeld erschiene als Überschuss.

Es gibt bewusst **keine Korrekturbuchung**. Eine falsche Entnahme wird durch eine
gegenläufige Einlage mit entsprechendem Grund ausgeglichen, so bleibt beides
sichtbar. Genau das ist der Sinn eines Journals.

## Datenschutz (DSGVO)

Die Kasse erhebt so wenig wie möglich:

* **Kein Kundenstamm.** Am Beleg steht höchstens ein Name, und nur wenn der
  Kunde ihn nennt. Für einen Bon unter 250 EUR braucht es keine Adresse.
* **Belegversand:** die Adresse wird für diesen Beleg verwendet und nicht
  gespeichert. Im Nachweis steht sie **verkürzt** (`p**********@beispiel.de`) —
  nachweisbar bleiben muss, *dass* ein Beleg herausgegeben wurde, nicht an welche
  Adresse (Art. 5 Abs. 1 Buchst. c DSGVO).
* **Keine Kartennummern.** Vom Terminal kommen höchstens die letzten vier
  Stellen. Das Prüfprotokoll weist einen Eintrag mit einer vollständigen
  Kartennummer aktiv ab.
* **Mandantentrennung:** siehe [SICHERHEIT.md](SICHERHEIT.md). Sieht Kunde A die
  Umsätze von Kunde B, ist das eine meldepflichtige Verletzung nach Art. 33
  DSGVO.

Wer die Kasse als Dienst anbietet, ist Auftragsverarbeiter seiner Kunden und
braucht einen Vertrag nach Art. 28 DSGVO. Das ist eine Aufgabe des Betreibers,
nicht der Software.

## Artikelbilder und Urheberrecht

Bilder werden nur aus Sammlungen gesucht, die die **Lizenz mitliefern**
(Openverse, Open Food Facts). Gespeichert werden Urheber, Lizenz und Quelle; ein
Bild ohne Lizenzangabe kann nicht gespeichert werden — die Datenbank lehnt es per
`CHECK` ab.

Lizenzen mit `nc` (nicht kommerziell) werden **ausgeschlossen**: eine Kasse ist
immer kommerzielle Nutzung. Eine allgemeine Bildersuche wäre ein Haftungsrisiko
und ist deshalb nicht eingebaut.

## Was diese Software nicht ist

Kein Rechts- und kein Steuerberatungsprodukt. Die eingebauten Regeln geben den
Stand der Umsetzung wieder. Für den eigenen Betrieb gilt die Auskunft des
Steuerberaters, nicht diese Datei.
