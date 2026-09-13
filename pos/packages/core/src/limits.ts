/**
 * Obergrenzen.
 *
 * Warum es Grenzen gibt: "beliebig tief" und "beliebig viele" sind in einer
 * App auf einem Telefon keine Freiheit, sondern ein Absturzrisiko. Ein
 * Warengruppenbaum wird rekursiv aufgebaut und gezeichnet - bei genuegend
 * Tiefe reicht der Aufrufstapel nicht mehr. Ein Artikelstamm wird beim Start
 * vollstaendig geladen - bei genuegend Artikeln startet die Kasse nicht mehr,
 * und zwar genau dann, wenn der Kunde davorsteht.
 *
 * Alle Grenzen stehen hier zusammen, mit der Begruendung, warum sie so hoch
 * sind wie sie sind. Sie sind nicht willkuerlich gewaehlt, sondern an dem
 * ausgerichtet, was ein Betrieb tatsaechlich braucht - mit deutlich Luft nach
 * oben, damit niemand im Betrieb dagegen laeuft.
 */

export class LimitError extends Error {}

/**
 * Tiefe des Warengruppenbaums.
 *
 * Vier Ebenen, zum Beispiel: Getraenke > Heissgetraenke > Kaffee > Sirup.
 * Wer eine fuenfte braucht, beschreibt in Wahrheit eine Eigenschaft des
 * Artikels und keine Warengruppe - dafuer sind Zusaetze da. Zwei bis drei
 * Ebenen sind der Normalfall; vier ist die Reserve.
 */
export const MAX_CATEGORY_DEPTH = 4;

/**
 * Warengruppen je Mandant.
 *
 * 300 Gruppen sind mehr, als ein Betrieb mit einem Verkaufsstand oder einer
 * Filiale sinnvoll pflegen kann. Die Zahl begrenzt vor allem den Aufwand beim
 * Aufbauen des Baums und beim Zeichnen der Reiter.
 */
export const MAX_CATEGORIES = 300;

/** Untergruppen unmittelbar unter einer Gruppe. */
export const MAX_CHILDREN_PER_CATEGORY = 50;

/**
 * Artikel je Mandant.
 *
 * 2000 Artikel deckt einen gut sortierten Kiosk ab und bleibt eine Groesse,
 * die sich beim Start vollstaendig laden laesst (grob 1 MB im Speicher) und
 * die SQLite auf einem Telefon ohne Verzoegerung durchsucht. Ein Betrieb mit
 * mehr Artikeln braucht keine Kasse mit Kacheln, sondern einen Scanner und
 * eine Warenwirtschaft - siehe docs/ROADMAP.md.
 */
export const MAX_PRODUCTS = 2000;

/** Artikel unmittelbar in einer Warengruppe - so viele Kacheln passen. */
export const MAX_PRODUCTS_PER_CATEGORY = 200;

/**
 * Pfandartikel, die an einem Artikel haengen.
 *
 * Becher und Deckel sind zwei. Acht laesst Luft fuer Faelle, die niemand
 * vorhersieht, und haelt den Bon trotzdem lesbar.
 */
export const MAX_DEPOSITS_PER_PRODUCT = 8;

/**
 * Positionen auf einem Beleg.
 *
 * 300 Positionen ist eine Sammelbestellung fuer eine Betriebsfeier. Darueber
 * wird der Bon laenger als eine Papierrolle, und die Summenbildung laeuft bei
 * jedem Tastendruck ueber alle Positionen.
 */
export const MAX_CART_LINES = 300;

/** Zeichen in einem Namen - passt auf den Bon und in die DSFinV-K. */
export const MAX_NAME_LENGTH = 120;

/** Ergebnis einer Pruefung: entweder erlaubt, oder mit Grund abgelehnt. */
export type Allowed = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const ALLOWED: Allowed = { ok: true };

export function denied(reason: string): Allowed {
  return { ok: false, reason };
}

/** Namen pruefen und zurechtschneiden. */
export function checkName(name: string, what = "Der Name"): Allowed {
  const trimmed = name.trim();
  if (trimmed === "") return denied(`${what} darf nicht leer sein.`);
  if (trimmed.length > MAX_NAME_LENGTH) {
    return denied(`${what} darf hoechstens ${MAX_NAME_LENGTH} Zeichen lang sein.`);
  }
  return ALLOWED;
}
