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
| `index.html` – JSON-LD im `<head>` | `priceRange`, sobald die Preise feststehen |
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

### E-Mail: info@moinamoments.de (Zoho Mail, EU-Rechenzentrum)

Das Postfach liegt bei **Zoho Mail EU**. Die dafür nötigen DNS-Einträge stehen bei
Namecheap unter Advanced DNS und sind unabhängig von den A-Records der Website:

| Typ | Host | Wert | Prio |
|---|---|---|---|
| MX | `@` | `mx.zoho.eu` | 10 |
| MX | `@` | `mx2.zoho.eu` | 20 |
| MX | `@` | `mx3.zoho.eu` | 50 |
| TXT | `@` | `v=spf1 include:zohomail.eu ~all` | – |
| TXT | `@` | `zoho-verification=zb85702319.zmverify.zoho.eu` | – |
| TXT | `zmail._domainkey` | `v=DKIM1; k=rsa; p=…` | – |

SPF und DKIM sind aktiv und geprüft.

Wichtig: Die MX-Einträge dürfen nicht auf `@` mit den GitHub-A-Records verwechselt
werden. Beide existieren parallel, MX steuert nur die Mailzustellung.

#### DMARC – noch offen

`_dmarc.moinamoments.de` existiert nicht. Ohne DMARC sagt die Domain den
Empfängerservern nicht, was mit Mails passieren soll, die SPF und DKIM nicht
bestehen – Spoofing im Namen der Domain bleibt so folgenlos, und die
Zustellbarkeit bei Gmail und Outlook ist schlechter als nötig.

Neuer TXT-Eintrag bei Namecheap, Host `_dmarc`:

```
v=DMARC1; p=none; rua=mailto:info@moinamoments.de; adkim=r; aspf=r
```

`p=none` heißt: nur beobachten, nichts blockieren. Das ist der richtige Start –
zuerst zwei Wochen die Berichte ansehen, ob wirklich alle legitimen Mails SPF und
DKIM bestehen. Danach auf die schärfere Stufe wechseln:

```
v=DMARC1; p=quarantine; rua=mailto:info@moinamoments.de; adkim=r; aspf=r
```

Die `rua`-Berichte kommen als XML-Anhänge und sind ohne Auswertungstool mühsam zu
lesen. Wenn sie stören, kann der `rua`-Teil entfallen – der Schutz bleibt.

---

## Kontakt

Es gibt **kein Formular** mehr. Der Kontaktbereich in `index.html` enthält einen
`mailto:`-Button, der das Standard-Mailprogramm des Besuchers mit vorbereitetem
Betreff und Textgerüst (Anlass, Wunschtermin, Ort, Gästezahl) öffnet.

Das braucht kein JavaScript und keinen Server – funktioniert also auch auf GitHub Pages
zuverlässig. Empfängeradresse und Textvorlage stehen direkt im `href` des Links
(Abschnitt `contact-cta` in `index.html`); Sonderzeichen dort sind URL-kodiert
(`%20` Leerzeichen, `%0A` Zeilenumbruch, `%C3%BC` = ü).

---

## Strukturierte Daten (SEO)

Zwei Ebenen, damit `menu-data.js` die einzige Pflegestelle für die Karte bleibt:

**Statisch in `index.html`** – ein `@graph` mit `FoodEstablishment` und `WebSite`:
Name, Beschreibung, Telefon, E-Mail, Logo, Bilder, Gründer, Adresse auf Ortsebene
(bewusst ohne Straße), `areaServed` als `City` Kiel plus `GeoCircle` mit 30 km Radius
und ein `contactPoint` mit der telefonischen Erreichbarkeit.

**Dynamisch aus `assets/js/main.js`** – `initMenuSchema()` baut aus `MENU` ein
`Menu`-Objekt mit allen Kategorien und Gerichten und hängt es als zweiten
JSON-LD-Block an. Preise werden nur ausgegeben, wenn in `menu-data.js` welche
stehen; `—` und leere Werte werden übersprungen. Die Tags „Vegan“ und
„Vegetarisch“ werden automatisch zu `suitableForDiet`.

Sobald du die Preise einträgst, erscheinen sie also ohne weiteres Zutun in den
strukturierten Daten.

> **Noch offen:** `priceRange` im `FoodEstablishment` fehlt bewusst, solange keine
> Preise feststehen. Ebenso `openingHoursSpecification` – die „Mo – Fr, 10 – 18 Uhr“
> sind die telefonische Erreichbarkeit, keine Verkaufszeiten. Wenn es feste
> Standzeiten gibt, gehören sie als `openingHoursSpecification` ergänzt.

Prüfen lässt sich das Ergebnis mit dem
[Rich Results Test](https://search.google.com/test/rich-results) – dort die URL
`https://moinamoments.de/` eingeben.

---

## Bilder

Die Fotos aus `quellbilder/` wurden zugeschnitten und komprimiert nach `assets/img/`
gelegt (das Logo z. B. von 11,5 MB auf 49 KB). Neue Bilder bitte ebenfalls verkleinern –
Breite maximal ca. 1800 px, JPEG-Qualität ~82.
