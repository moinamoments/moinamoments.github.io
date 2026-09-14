# Kassensystem

Ein Kassensystem (POS) für Android und iOS: ein Warenkorb, ein Beleg, ein
Kassenabschluss — und die deutschen Pflichten dazu, von Anfang an eingebaut und
nicht nachträglich angeklebt.

Das Produkt ist **mandantenfähig**: es ist nicht für einen Betrieb gebaut,
sondern für viele, wie SumUp oder orderbird. Jeder Datensatz gehört zu genau
einem Mandanten, und zwar seit der ersten Zeile — nachträglich
Mandantenfähigkeit einzubauen ist der teuerste Umbau, den ein Kassensystem
erleben kann.

## Was es kann

| Bereich | Stand |
| --- | --- |
| Verkauf mit Warengruppen, Untergruppen, Gewichtsware, offenem Preis | fertig |
| Pfand: beliebig viele frei definierbare Pfandartikel, Rücknahme | fertig |
| Beleg nach § 6 KassenSichV mit QR-Code (eigener Encoder) | fertig |
| TSE-Anbindung (Schnittstelle, Test-TSE, fiskaly-Adapter) | Adapter fertig, Vertrag fehlt |
| Kassenabschluss (Z-Bericht) und DSFinV-K-Export | fertig |
| Bestand: Wareneingang, Zählung, Schwund, Journal | fertig |
| Bons parken und später abschließen | fertig |
| Storno und **Teil**storno mit anteiliger Auszahlung | fertig |
| Kassenbuch mit Tageseröffnung, Einlage, Entnahme, Transit | fertig |
| PIN-Anmeldung, Rollen und einzelne Rechte, Gerätesperre | fertig |
| Mehrere Kassen je Betrieb, je mit eigenem Belegnummernkreis | fertig |
| Prüfprotokoll: wer hat was am System getan | fertig |
| Belegausgabe per E-Mail und SMS | fertig |
| Artikelstamm als CSV bearbeiten, Sicherung mit Prüfsumme | fertig |
| Bondruck über LAN/WLAN | fertig, braucht einen Entwicklungs-Build |
| Bondruck über Bluetooth | Transport fertig, Gerätemodul offen |
| Kartenzahlung und Tap to Pay | Schnittstelle und Simulator fertig, Anbieter fehlt |
| DATEV- und Lexware-Export (Buchungsstapel) | fertig, Konten müssen bestätigt werden |
| Wareneingang aus Lieferantenrechnung (ZUGFeRD, XRechnung, CSV) | fertig |

Was noch fehlt und warum, steht in [docs/ROADMAP.md](docs/ROADMAP.md).

## Aufbau

```
pos/
  packages/core/     die gesamte Rechen- und Rechtslogik, ohne React,
                     ohne Datenbank, ohne Betriebssystem
  apps/kasse/        die Expo-App: Bildschirme, SQLite, Gerätezugriff
  docs/              Architektur, Rechtliches, Sicherheit, Roadmap
```

Der Schnitt ist die wichtigste Entscheidung des Projekts: **eine Belegsumme darf
nicht davon abhängen, auf welchem Gerät sie berechnet wird.** Deshalb kennt
`@kp/core` weder React noch SQLite und läuft im Test, in der App und später im
Server unverändert. Mehr dazu in [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md).

## Entwickeln

Voraussetzung: Node 22 oder neuer (die Tests nutzen das eingebaute
TypeScript-Stripping und `node:sqlite`, beide ohne Zusatzpakete).

```bash
cd pos
npm install

npm test                          # alle Tests (Kern und Ablauftests)
npm run typecheck --workspaces    # tsc für beide Pakete

cd apps/kasse
npx expo start                    # App im Entwicklungsmodus
npx expo export --platform android --platform ios --output-dir dist
```

### Tests

645 Tests, aufgeteilt in drei Arten:

* **Kerntests** (`packages/core/src/*.test.ts`) prüfen Rechnen und Recht ohne
  jede Umgebung: Centbeträge, Umsatzsteuer je Gruppe, Storno, Pfand, QR-Code
  Modul für Modul, Kryptobausteine byteweise gegen `node:crypto`.
* **Härteproben** (`packages/core/src/purchase/robustness.test.ts`) werfen rund
  zehntausend abgeschnittene, verdrehte und zufällige Dateien auf die
  Rechnungsleser. Dort kommen Dateien an, die jemand anders geschrieben hat —
  ein Leser darf sie lesen oder einen benannten Fehler werfen, aber niemals
  abstürzen, kreisen oder eine unbrauchbare Zahl in den Bestand schreiben.
* **Ablauftests** (`apps/kasse/src/db/flows.test.ts`) gehen die Wege, die am
  Verkaufsstand wirklich gegangen werden — **durch das echte Schema**, mit
  denselben Triggern und denselben Abfragen wie in der App. Darunter ein
  vollständiger Verkaufstag von der Anmeldung bis zum Abschluss.

Nicht abgedeckt: das Zeichnen der Bildschirme. Dass eine Kachel an der richtigen
Stelle sitzt, kann nur ein Gerät zeigen. Getestet ist alles, was darunter liegt —
und dort sitzen die Fehler, die Geld kosten.

## Vor dem Produktivbetrieb

Diese Punkte sind **keine Feinarbeit**, sondern Voraussetzung. Sie stehen
ausführlich in [docs/RECHTLICHES.md](docs/RECHTLICHES.md):

1. **TSE anbinden.** Ohne zertifizierte technische Sicherheitseinrichtung sind
   die Belege nicht abgesichert. Die App kennzeichnet das auf jedem Bon — sie
   verschweigt es nicht, aber sie ersetzt die TSE auch nicht.
2. **Kasse dem Finanzamt melden** (§ 146a Abs. 4 AO).
3. **Betriebsdaten ausfüllen.** Ein Bon mit Platzhalteradresse ist kein
   gültiger Beleg. Die App warnt, solange die Platzhalter drinstehen.
4. **DSFinV-K-Export prüfen lassen.** Er entsteht aus der Spezifikation, nicht
   aus einer Zertifizierung — vor dem Produktivstart gehört das Ergebnis einem
   Steuerberater oder Prüfer vorgelegt.
5. **PIN vergeben.** Solange kein Bediener eine PIN hat, fragt die Kasse beim
   Start nicht nach, und jeder, der das Gerät in die Hand nimmt, kann
   kassieren, stornieren und Geld entnehmen.

## Rechtlicher Hinweis

Diese Software ist kein Rechts- oder Steuerberatungsprodukt. Die eingebauten
Regeln geben den Stand der Umsetzung wieder, nicht eine verbindliche Auskunft.
Ob eine Kasse im Einzelfall den Anforderungen genügt, entscheiden Finanzamt und
Prüfer — nicht der Hersteller.
