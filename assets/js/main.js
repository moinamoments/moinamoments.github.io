/* ==========================================================================
   MOINA – Golden Moments
   Interaktionen: Navigation, Speisekarte, Galerie, Schema
   Keine Abhängigkeiten – reines Vanilla JS.
   ========================================================================== */

/* --------------------------------------------------------------------------
   KONFIGURATION – hier anpassen
   -------------------------------------------------------------------------- */
const CONFIG = {
  // GoatCounter – datenschutzfreundliche Reichweitenmessung ohne Cookies.
  // Hier NUR den Code eintragen, den du bei der Anmeldung auf goatcounter.com
  // gewählt hast: aus "https://beispiel.goatcounter.com" wird also "beispiel".
  // Solange das Feld leer ist, wird kein Skript geladen und nichts gezählt.
  goatCounterCode: "moinamoments"
};

// Jede Funktion laeuft einzeln abgesichert: Ein Fehler in einer davon darf
// nicht die uebrigen verhindern (sonst bleiben z. B. alle .reveal-Bloecke
// unsichtbar und die Speisekarte leer).
document.addEventListener("DOMContentLoaded", () => {
  [initHeader, initNav, initMenu, initMenuSchema, initTermine,
   initGallery, initReveal, initYear, initAnalytics].forEach((init) => {
    try { init(); } catch (err) { console.error(init.name + ":", err); }
  });
});

/* --- GoatCounter -----------------------------------------------------------
   Laedt das Zaehlskript nur, wenn in CONFIG ein Code hinterlegt ist. Ohne
   Code passiert gar nichts – die Seite bleibt dann vollstaendig frei von
   Drittanbieter-Anfragen.

   GoatCounter setzt keine Cookies, speichert keine IP-Adressen und zaehlt
   Aufrufe von localhost von sich aus nicht mit.
   -------------------------------------------------------------------------- */
function initAnalytics() {
  const code = (CONFIG.goatCounterCode || "").trim();
  if (!code) return;

  // "Do Not Track" des Browsers respektieren
  if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return;

  const s = document.createElement("script");
  s.async = true;
  s.src = "https://gc.zgo.at/count.js";
  s.setAttribute("data-goatcounter", `https://${code}.goatcounter.com/count`);
  document.head.appendChild(s);
}

/* --- Header: Hintergrund beim Scrollen ----------------------------------- */
function initHeader() {
  const header = document.querySelector(".header");
  if (!header) return;
  const onScroll = () => header.classList.toggle("is-stuck", window.scrollY > 40);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}

/* --- Navigation: Mobile-Menü + aktiver Abschnitt -------------------------- */
function initNav() {
  const burger = document.querySelector(".burger");
  const nav = document.querySelector(".nav");
  if (burger && nav) {
    const close = () => {
      nav.classList.remove("is-open");
      burger.setAttribute("aria-expanded", "false");
    };
    burger.addEventListener("click", () => {
      const open = nav.classList.toggle("is-open");
      burger.setAttribute("aria-expanded", String(open));
    });
    nav.addEventListener("click", (e) => {
      if (e.target.closest("a")) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  }

  // Aktiven Menüpunkt hervorheben
  const links = [...document.querySelectorAll('.nav__link[href^="#"]')];
  const sections = links
    .map((l) => document.querySelector(l.getAttribute("href")))
    .filter(Boolean);
  if (!sections.length || !("IntersectionObserver" in window)) return;

  const spy = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        links.forEach((l) =>
          l.classList.toggle("is-active", l.getAttribute("href") === "#" + entry.target.id)
        );
      });
    },
    { rootMargin: "-45% 0px -50% 0px" }
  );
  sections.forEach((s) => spy.observe(s));
}

/* --- Speisekarte aus menu-data.js rendern -------------------------------- */
function initMenu() {
  const tabsEl = document.querySelector("[data-menu-tabs]");
  const gridEl = document.querySelector("[data-menu-grid]");
  if (!tabsEl || !gridEl || typeof MENU === "undefined") return;

  const render = (category) => {
    // Optionaler Kategorie-Hinweis (z. B. "nur an ausgewaehlten Standorten")
    const note = category.note
      ? `<p class="menu-hint">${category.note}</p>`
      : "";

    gridEl.innerHTML = note + category.items
      .map((item) => {
        const tag = item.tag ? `<span class="tag">${item.tag}</span>` : "";
        const price = item.price ? item.price : PRICE_PLACEHOLDER;
        const desc = item.desc ? `<p class="menu-item__desc">${item.desc}</p>` : "";
        return `
          <article class="menu-item">
            <h3 class="menu-item__name">${item.name}${tag}</h3>
            <span class="menu-item__price">${price}</span>
            ${desc}
          </article>`;
      })
      .join("");
  };

  MENU.forEach((category, i) => {
    const btn = document.createElement("button");
    btn.className = "tab" + (i === 0 ? " is-active" : "");
    btn.type = "button";
    btn.textContent = category.label;
    btn.setAttribute("aria-controls", "menu-grid");
    btn.addEventListener("click", () => {
      tabsEl.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
      btn.classList.add("is-active");
      render(category);
    });
    tabsEl.appendChild(btn);
  });

  render(MENU[0]);
}

/* --- Galerie mit Lightbox ------------------------------------------------ */
function initGallery() {
  const gallery = document.querySelector("[data-gallery]");
  const lightbox = document.querySelector("[data-lightbox]");
  if (!gallery || !lightbox) return;

  const img = lightbox.querySelector("img");
  const closeBtn = lightbox.querySelector(".lightbox__close");

  const close = () => {
    lightbox.classList.remove("is-open");
    document.body.style.overflow = "";
  };

  gallery.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const source = btn.querySelector("img");
    img.src = source.dataset.full || source.src;
    img.alt = source.alt;
    lightbox.classList.add("is-open");
    document.body.style.overflow = "hidden";
    closeBtn.focus();
  });

  closeBtn.addEventListener("click", close);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
}

/* --- Speisekarte als strukturierte Daten ---------------------------------
   Erzeugt aus MENU (menu-data.js) ein Menu-Objekt nach schema.org und haengt
   es als zweiten JSON-LD-Block an. Dadurch bleibt menu-data.js die einzige
   Pflegestelle: sobald dort Preise stehen, erscheinen sie automatisch auch
   in den strukturierten Daten.

   Das statische JSON-LD in index.html bleibt fuer sich allein gueltig.
   Hier wird nur ueber die @id des Betriebs nachtraeglich hasMenu ergaenzt -
   JSON-LD fuehrt Knoten mit gleicher @id zusammen.
   ------------------------------------------------------------------------- */
const SITE_URL = "https://moinamoments.de/";
const BUSINESS_ID = SITE_URL + "#business";
const MENU_ID = SITE_URL + "#menu";

// "4,50 €" -> "4.50"   |   "—", "" oder fehlend -> null
function parsePrice(value) {
  if (!value) return null;
  const match = String(value).replace(",", ".").match(/\d+(\.\d+)?/);
  return match ? Number(match[0]).toFixed(2) : null;
}

// Tags aus menu-data.js auf schema.org-Diaeten abbilden
const DIETS = {
  "vegan": "https://schema.org/VeganDiet",
  "vegetarisch": "https://schema.org/VegetarianDiet"
};

function buildMenuItem(item) {
  const node = { "@type": "MenuItem", name: item.name };
  if (item.desc) node.description = item.desc;

  const diet = item.tag && DIETS[item.tag.toLowerCase()];
  if (diet) node.suitableForDiet = diet;

  const price = parsePrice(item.price);
  if (price) {
    node.offers = {
      "@type": "Offer",
      price: price,
      priceCurrency: "EUR",
      availability: "https://schema.org/InStock"
    };
  }
  return node;
}

function initMenuSchema() {
  if (typeof MENU === "undefined" || !Array.isArray(MENU) || !MENU.length) return;

  const sections = MENU
    .filter((section) => section.items && section.items.length)
    .map((section) => ({
      "@type": "MenuSection",
      "@id": SITE_URL + "#menu-" + section.id,
      name: section.label,
      hasMenuItem: section.items.map(buildMenuItem)
    }));

  if (!sections.length) return;

  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      { "@id": BUSINESS_ID, hasMenu: { "@id": MENU_ID } },
      {
        "@type": "Menu",
        "@id": MENU_ID,
        name: "Speisekarte – MOINA – Golden Moments",
        url: SITE_URL + "#karte",
        inLanguage: "de-DE",
        hasMenuSection: sections
      }
    ]
  };

  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.textContent = JSON.stringify(graph, null, 2);
  document.head.appendChild(script);
}

/* --- Termine aus termine-data.js ------------------------------------------
   Zeigt nur kommende Termine (Endzeit noch nicht erreicht), sortiert nach
   Datum, und haengt sie als Event-Daten fuer Google an. Gibt es keinen
   kommenden Termin, bleibt der Platzhalter aus dem HTML stehen.
   ------------------------------------------------------------------------- */
const MONATE = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];
const WOCHENTAGE = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Zeitzonen-Versatz von Kiel an einem Datum: Sommerzeit gilt in der EU vom
// letzten Sonntag im Maerz bis zum letzten Sonntag im Oktober (je 01:00 UTC).
function kielOffset(datum) {
  const [y, m, d] = datum.split("-").map(Number);
  const lastSunday = (month) => {
    const last = new Date(Date.UTC(y, month + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const t = Date.UTC(y, m - 1, d, 12);
  const start = Date.UTC(y, 2, lastSunday(2), 1);
  const end = Date.UTC(y, 9, lastSunday(9), 1);
  return t >= start && t < end ? "+02:00" : "+01:00";
}

const isoKiel = (datum, zeit) => `${datum}T${zeit}:00${kielOffset(datum)}`;
const uhr = (zeit) => zeit.replace(/^0/, "").replace(/:00$/, "");

const addDays = (datum, n) =>
  new Date(Date.parse(datum + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const wochentagVon = (datum) => new Date(datum + "T12:00:00Z").getUTCDay();

// Regelmaessigen Termin ("jeden: Samstag") in die naechsten konkreten Daten
// ab heute aufloesen – unter Beachtung von ab, endet und ausser.
function naechsteTermine(t, heute, anzahl) {
  const ziel = WOCHENTAGE.indexOf(t.jeden);
  if (ziel < 0) return [];
  let datum = t.ab && t.ab > heute ? t.ab : heute;
  datum = addDays(datum, (ziel - wochentagVon(datum) + 7) % 7);
  const ausser = Array.isArray(t.ausser) ? t.ausser : [];
  const out = [];
  for (let i = 0; out.length < anzahl && i < anzahl + 26; i++, datum = addDays(datum, 7)) {
    if (t.endet && datum > t.endet) break;
    if (!ausser.includes(datum)) out.push({ ...t, datum });
  }
  return out;
}

function initTermine() {
  const list = document.querySelector("[data-termine]");
  if (!list || typeof TERMINE === "undefined" || !Array.isArray(TERMINE)) return;

  const now = new Date();
  // "Heute" / "Morgen" bezogen auf das Kieler Datum, sonst der Wochentag
  const kielHeute = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(now);
  const morgen = addDays(kielHeute, 1);
  const tagLabel = (datum) =>
    datum === kielHeute ? "Heute" : datum === morgen ? "Morgen" : WOCHENTAGE[wochentagVon(datum)];
  const nachZeit = (a, b) => new Date(isoKiel(a.datum, a.von)) - new Date(isoKiel(b.datum, b.von));

  // Je Eintrag die kommenden Termine (Endzeit noch nicht erreicht);
  // regelmaessige Eintraege liefern mehrere, Einzeltermine hoechstens einen.
  const reihen = TERMINE
    .filter((t) => t.von && t.bis && (t.datum || t.jeden))
    .map((t) => (t.jeden ? naechsteTermine(t, kielHeute, 5) : [t])
      .filter((x) => x.datum && new Date(isoKiel(x.datum, x.bis)) > now))
    .filter((reihe) => reihe.length);

  if (!reihen.length) return;

  // Karten und Ankuendigung zeigen je Eintrag nur den naechsten Termin
  const naechste = reihen.map((reihe) => reihe[0]).sort(nachZeit);

  // "Heute" / "Samstag" – bei regelmaessigen Terminen mit "jeden …"
  const wannText = (t, mitDatum) => {
    const tag = tagLabel(t.datum);
    const nah = tag === "Heute" || tag === "Morgen";
    if (t.jeden) return nah ? `${tag} und jeden ${escapeHtml(t.jeden)}` : `Jeden ${escapeHtml(t.jeden)}`;
    if (nah || !mitDatum) return tag;
    const [, m, d] = t.datum.split("-").map(Number);
    return `${tag}, ${d}. ${MONATE[m - 1]}`;
  };

  // Ankuendigung im Startbereich: der naechste Termin mit ankuendigung: true
  const news = document.querySelector("[data-ankuendigung]");
  const highlight = naechste.find((t) => t.ankuendigung);
  if (news && highlight) {
    news.innerHTML = `<a href="#termine">${escapeHtml(highlight.titel)} · `
      + `<strong>${wannText(highlight, true)}, ${uhr(highlight.von)}–${uhr(highlight.bis)} Uhr</strong></a>`;
    news.hidden = false;
  }

  list.innerHTML = naechste.map((t) => {
    const [, m, d] = t.datum.split("-").map(Number);
    const ortText = [t.ort, t.stadt].filter(Boolean).join(", ");
    const karte = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(ortText);
    const hinweis = t.hinweis ? `<p>${escapeHtml(t.hinweis)}</p>` : "";
    return `
      <article class="date-card">
        <div class="date-card__day"><b>${d}</b><span>${MONATE[m - 1]}</span></div>
        <div>
          <h3>${escapeHtml(t.titel)}</h3>
          <p><strong>${wannText(t, false)}</strong> · ${uhr(t.von)}–${uhr(t.bis)} Uhr</p>
          <p><a href="${karte}" target="_blank" rel="noopener"><u>${escapeHtml(ortText)}</u></a></p>
          ${hinweis}
        </div>
      </article>`;
  }).join("");

  // Fuer Google: Einzeltermine plus die naechsten vier Termine je Reihe
  const kommend = reihen.flatMap((reihe) => reihe.slice(0, 4)).sort(nachZeit);
  const events = kommend.map((t) => ({
    "@type": "Event",
    name: `MOINA – ${t.titel}`,
    description: "Frische Crêpes, Churros oder Mutzen, Kaffee und Kaltgetränke aus dem MOINA-Verkaufsanhänger.",
    startDate: isoKiel(t.datum, t.von),
    endDate: isoKiel(t.datum, t.bis),
    eventStatus: "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    isAccessibleForFree: true,
    location: {
      "@type": "Place",
      name: t.ort || t.titel,
      address: { "@type": "PostalAddress", addressLocality: t.stadt, addressCountry: "DE" }
    },
    organizer: { "@id": BUSINESS_ID },
    image: [SITE_URL + "assets/img/anhaenger-beschriftet.jpg"],
    url: SITE_URL + "#termine"
  }));

  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.textContent = JSON.stringify({ "@context": "https://schema.org", "@graph": events }, null, 2);
  document.head.appendChild(script);
}

/* --- Einblenden beim Scrollen -------------------------------------------- */
function initReveal() {
  const items = document.querySelectorAll(".reveal");
  if (!items.length) return;
  if (!("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const io = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        obs.unobserve(entry.target);
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -60px 0px" }
  );
  items.forEach((el) => io.observe(el));
}

/* --- Jahreszahl im Footer ------------------------------------------------ */
function initYear() {
  document.querySelectorAll("[data-year]").forEach((el) => {
    el.textContent = new Date().getFullYear();
  });
}
