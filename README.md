# MOINA – Golden Moments · Website

Statische Marketing-Website für den mobilen Verkaufsanhänger **MOINA – Golden Moments**
(Crêpes, Mutzen, Churros, Kaffee, Tee, Kaltgetränke). Start: **Ende September 2026**.

Kein Build-Prozess, keine Abhängigkeiten – reines HTML, CSS und JavaScript.
Direkt über GitHub Pages hostbar.

---

## Lokal ansehen

`index.html` einfach im Browser öffnen (Doppelklick). Das reicht für alles außer
sehr strengen Browser-Einstellungen.

---

## Dateien

```
index.html            Startseite (alle Abschnitte)
impressum.html        Impressum – Platzhalter, muss ausgefüllt werden
datenschutz.html      Datenschutzerklärung – Platzhalter, muss geprüft werden
assets/css/style.css  Gesamtes Design
assets/js/menu-data.js  ► SPEISEKARTE – hier die Menüitems pflegen
assets/js/main.js       Countdown, Navigation, Galerie, Formular + Konfiguration
assets/img/           Web-optimierte Bilder
quellbilder/          Original-Fotos (für die Website nicht nötig)
.nojekyll             Nötig, damit GitHub Pages die Dateien 1:1 ausliefert
```

---

## Was noch ausgefüllt werden muss

| Wo | Was |
|---|---|
| `assets/js/menu-data.js` | **Preise** der Menüitems (stehen alle auf „—“) |
| `assets/js/main.js` (oben, `CONFIG`) | Genaues Eröffnungsdatum |
| `index.html` – Abschnitt „Kontakt“ | Erreichbarkeit (steht auf „Mo – Fr, 10 – 18 Uhr“) |
| `index.html` – Abschnitt „Termine“ | Echte Termine statt der Platzhalter-Karten |

Kontaktdaten, Impressum und Datenschutzerklärung sind vollständig ausgefüllt
(Mehmet Gelgel, Kiel, `info@moinamoments.de`, Kleinunternehmer nach § 19 UStG).

### Speisekarte pflegen

Alles steckt in `assets/js/menu-data.js`. Ein Eintrag sieht so aus:

```js
{ name: "Zucker & Zimt", desc: "Der Klassiker.", price: "4,50 €", tag: "Beliebt" }
```

* `price` weglassen → es erscheint ein „—“ als Platzhalter
* `tag` ist optional (z. B. „Neu“, „Vegan“, „Saison“)
* Neue Kategorie = neuer Block mit `id`, `label` und `items` – der Reiter erscheint automatisch

### Eröffnungsdatum ändern

In `assets/js/main.js` ganz oben:

```js
launchDate: new Date(2026, 8, 26, 11, 0, 0) // Monat ist 0-basiert: 8 = September
```

Der Countdown blendet sich nach Ablauf automatisch aus und zeigt „Wir sind da – kommt vorbei!“.

---

## Veröffentlichen über GitHub Pages

Repository: **`moinamoments/moinamoments.github.io`** (User-/Org-Pages, läuft auf Root-Ebene).

Änderungen hochladen:

```bash
git add . && git commit -m "..." && git push
```

Einmalig im Repository: **Settings → Pages → Source: „Deploy from a branch“**,
Branch `main`, Ordner `/ (root)` → Save.
Ohne eigene Domain ist die Seite dann unter `https://moinamoments.github.io/` erreichbar.

### Eigene Domain: moinamoments.de

Die Seite ist vollständig auf **`moinamoments.de`** ausgerichtet (Canonical-URL,
Social-Preview, strukturierte Daten, E-Mail-Adresse). Die Datei `CNAME` im Repo-Root
teilt GitHub Pages die Domain mit – sie darf nicht gelöscht werden.

DNS beim Registrar (Namecheap → Domain List → Manage → **Advanced DNS**):

| Typ | Host | Wert |
|---|---|---|
| A Record | `@` | `185.199.108.153` |
| A Record | `@` | `185.199.109.153` |
| A Record | `@` | `185.199.110.153` |
| A Record | `@` | `185.199.111.153` |
| CNAME Record | `www` | `moinamoments.github.io.` |

Danach im Repository unter **Settings → Pages → Custom domain** `moinamoments.de`
eintragen und **„Enforce HTTPS"** anhaken, sobald es auswählbar ist. Das Zertifikat wird
erst nach der DNS-Propagierung ausgestellt – das kann bis zu 24 Stunden dauern.

Die Apex-Domain `moinamoments.de` ist die kanonische Adresse, `www` leitet dorthin um.

### E-Mail info@moinamoments.de

Impressum, Datenschutzerklärung und strukturierte Daten nennen `info@moinamoments.de`.
**Das Postfach muss vor dem Start existieren** – für ein Impressum ist eine funktionierende
Kontaktadresse Pflicht. Einfachster Weg bei Namecheap: **Advanced DNS → Mail Settings →
„Email Forwarding"** und auf die private Adresse weiterleiten. Das setzt eigene
MX-Records und berührt die A-Records oben nicht.

---

## Kontaktformular

GitHub Pages kann keine Formulare verarbeiten. Aktuell öffnet das Formular deshalb eine
fertig ausgefüllte E-Mail im Mailprogramm des Besuchers.

Für echten Versand ohne eigenen Server eignet sich z. B. [Formspree](https://formspree.io):
im `<form>`-Tag in `index.html` einfach ergänzen –

```html
<form class="form" action="https://formspree.io/f/DEINE-ID" method="post">
```

Sobald ein `action` gesetzt ist, schaltet sich der E-Mail-Fallback automatisch ab.

---

## Bilder

Die Fotos aus `quellbilder/` wurden zugeschnitten und komprimiert nach `assets/img/`
gelegt (das Logo z. B. von 11,5 MB auf 49 KB). Neue Bilder bitte ebenfalls verkleinern –
Breite maximal ca. 1800 px, JPEG-Qualität ~82.
