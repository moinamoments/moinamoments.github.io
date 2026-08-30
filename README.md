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
(Mehmet Gelgel, Kiel, `info@moina.world`, Kleinunternehmer nach § 19 UStG).

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

1. Auf github.com ein neues Repository anlegen (z. B. `moina-website`).
2. Im Ordner `D:\Dokumente\Webseite` einmalig:

```bash
git init -b main
git add .
git commit -m "MOINA Website"
git remote add origin https://github.com/BENUTZERNAME/moina-website.git
git push -u origin main
```

3. Im Repository: **Settings → Pages → Source: „Deploy from a branch“**,
   Branch `main`, Ordner `/ (root)` → Save.
4. Nach ein bis zwei Minuten ist die Seite erreichbar unter
   `https://BENUTZERNAME.github.io/moina-website/`.

Änderungen später einfach mit `git add . && git commit -m "..." && git push` hochladen.

### Eigene Domain

Die Seite ist bereits auf **`moina.world`** ausgerichtet (Canonical-URL und Social-Preview).

1. Beim Domain-Anbieter die DNS-Einträge setzen:
   - für `www.moina.world` einen **CNAME** auf `BENUTZERNAME.github.io`
   - für `moina.world` (ohne www) vier **A-Records** auf
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
2. Danach im Repository unter **Settings → Pages → Custom domain** `moina.world` eintragen.
   GitHub legt die `CNAME`-Datei dann selbst an und stellt HTTPS bereit
   („Enforce HTTPS“ anhaken, sobald es auswählbar ist).

Solange die Domain noch nicht verbunden ist, läuft die Seite unter
`https://BENUTZERNAME.github.io/moina-website/` – die Canonical-URL zeigt dann schon
auf `moina.world`, was aber erst mit der Indexierung relevant wird.

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
