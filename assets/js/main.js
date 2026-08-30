/* ==========================================================================
   MOINA – Golden Moments
   Interaktionen: Navigation, Countdown, Speisekarte, Galerie, Formular
   Keine Abhängigkeiten – reines Vanilla JS.
   ========================================================================== */

/* --------------------------------------------------------------------------
   KONFIGURATION – hier anpassen
   -------------------------------------------------------------------------- */
const CONFIG = {
  // Eröffnungstermin (Platzhalter). Format: Jahr, Monat-1, Tag, Stunde, Minute
  launchDate: new Date(2026, 8, 26, 11, 0, 0), // 26.09.2026, 11:00 Uhr
  // E-Mail, an die das Kontaktformular die Anfrage adressiert
  contactEmail: "info@moina.world"
};

document.addEventListener("DOMContentLoaded", () => {
  initHeader();
  initNav();
  initCountdown();
  initMenu();
  initGallery();
  initForm();
  initReveal();
  initYear();
});

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

/* --- Countdown bis zur Eröffnung ----------------------------------------- */
function initCountdown() {
  const root = document.querySelector("[data-countdown]");
  if (!root) return;

  const fields = {
    days: root.querySelector('[data-unit="days"]'),
    hours: root.querySelector('[data-unit="hours"]'),
    minutes: root.querySelector('[data-unit="minutes"]'),
    seconds: root.querySelector('[data-unit="seconds"]')
  };
  const note = document.querySelector("[data-countdown-note]");

  const pad = (n) => String(n).padStart(2, "0");

  const tick = () => {
    const diff = CONFIG.launchDate - new Date();
    if (diff <= 0) {
      root.hidden = true;
      if (note) note.textContent = "Wir sind da – kommt vorbei!";
      clearInterval(timer);
      return;
    }
    const s = Math.floor(diff / 1000);
    fields.days.textContent = Math.floor(s / 86400);
    fields.hours.textContent = pad(Math.floor(s / 3600) % 24);
    fields.minutes.textContent = pad(Math.floor(s / 60) % 60);
    fields.seconds.textContent = pad(s % 60);
  };

  tick();
  const timer = setInterval(tick, 1000);
}

/* --- Speisekarte aus menu-data.js rendern -------------------------------- */
function initMenu() {
  const tabsEl = document.querySelector("[data-menu-tabs]");
  const gridEl = document.querySelector("[data-menu-grid]");
  if (!tabsEl || !gridEl || typeof MENU === "undefined") return;

  const render = (category) => {
    gridEl.innerHTML = category.items
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

/* --- Kontaktformular -----------------------------------------------------
   GitHub Pages kann keine Formulare verarbeiten. Standard ist deshalb ein
   vorbereiteter E-Mail-Entwurf (mailto). Für echten Versand ohne Server
   z. B. Formspree nutzen: form-Element mit action="https://formspree.io/f/XXX"
   und method="post" versehen – dann greift dieser Handler nicht mehr.
   ------------------------------------------------------------------------- */
function initForm() {
  const form = document.querySelector("[data-contact-form]");
  if (!form || form.getAttribute("action")) return;

  const status = form.querySelector("[data-form-status]");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const body = [
      `Name: ${data.get("name") || "-"}`,
      `E-Mail: ${data.get("email") || "-"}`,
      `Anlass: ${data.get("anlass") || "-"}`,
      `Wunschtermin: ${data.get("datum") || "-"}`,
      "",
      "Nachricht:",
      data.get("nachricht") || "-"
    ].join("\n");

    const href =
      `mailto:${CONFIG.contactEmail}` +
      `?subject=${encodeURIComponent("Anfrage über die Website – " + (data.get("anlass") || "Allgemein"))}` +
      `&body=${encodeURIComponent(body)}`;

    window.location.href = href;
    if (status) status.textContent = "Das E-Mail-Programm öffnet sich mit der fertigen Nachricht.";
  });
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
