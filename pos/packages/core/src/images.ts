/**
 * Artikelbilder aus frei lizenzierten Quellen.
 *
 * Der Anspruch ist, dass ein Betrieb ein Bild zum Artikel bekommt, ohne
 * Urheberrechte zu verletzen. Das heisst ausdruecklich **nicht** "Bildersuche
 * und das erste Ergebnis nehmen": ein Bild aus einer allgemeinen Suche ist im
 * Regelfall geschuetzt, und wer es in einer gewerblich genutzten App zeigt,
 * haftet dafuer. Deshalb sucht dieses Modul nur in Quellen, die die Lizenz
 * maschinenlesbar mitliefern:
 *
 *   - **Openverse** (von der WordPress Foundation betrieben) durchsucht
 *     Wikimedia Commons, Flickr und weitere Sammlungen und filtert auf
 *     Creative-Commons-Lizenzen und gemeinfreie Werke.
 *   - **Open Food Facts** liefert Produktfotos zu einem Barcode unter
 *     CC BY-SA - fuer Flaschen, Dosen und Verpacktes der direkte Weg.
 *
 * Zwei Dinge, die dabei nicht verhandelbar sind:
 *
 *   1. **Keine Lizenz, kein Bild.** Ein Treffer ohne Lizenzangabe wird
 *      verworfen, nicht "vorsichtshalber" uebernommen.
 *   2. **Die Namensnennung wird mitgespeichert.** CC BY und CC BY-SA
 *      verlangen Urheber, Lizenz und Quelle. Wer das erst beim Anzeigen
 *      nachschlagen will, hat es spaeter nicht mehr. Deshalb ist
 *      `ProductImage` ohne Lizenzfeld nicht konstruierbar.
 *
 * Was dieses Modul *nicht* tut: Bilder herunterladen oder weiterverbreiten.
 * Es liefert Adresse und Lizenzangabe; die App zeigt das Bild von der Quelle
 * oder legt es lokal ab. Eine eigene Zwischenspeicherung waere eine
 * Vervielfaeltigung und braucht eine Lizenz, die das erlaubt - siehe
 * docs/RECHTLICHES.md.
 */

import type { ProductImage } from "./model.ts";

export class ImageSearchError extends Error {}

/** Minimale `fetch`-Signatur, damit das Modul ohne Browser testbar bleibt. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface ImageCandidate extends ProductImage {
  /** Kurzbeschreibung des Treffers, damit die Auswahl ohne Raten geht. */
  readonly title: string;
  /** Kleinere Vorschau, wenn die Quelle eine anbietet. */
  readonly thumbnailUrl?: string | null;
  /**
   * Verlangt die Lizenz eine Namensnennung? Steuert, ob die App die
   * Urheberzeile zwingend anzeigen muss.
   */
  readonly attributionRequired: boolean;
}

/**
 * Lizenzen, die fuer einen Gewerbebetrieb ohne weitere Pruefung nutzbar sind.
 *
 * Bewusst ohne die `nc`-Varianten (nicht kommerziell): eine Kasse steht in
 * einem Gewerbebetrieb, damit ist jede Nutzung kommerziell. Und ohne `nd`
 * (keine Bearbeitung) nur deshalb nicht, weil ein unveraendert gezeigtes Bild
 * davon nicht betroffen ist - zugeschnitten werden darf es dann aber nicht.
 */
export const USABLE_LICENSES: readonly string[] = ["cc0", "pdm", "by", "by-sa", "by-nd"];

/** Lizenzen, die eine Namensnennung verlangen. */
const ATTRIBUTION_REQUIRED: readonly string[] = ["by", "by-sa", "by-nd"];

/** Lesbare Bezeichnung einer Openverse-Lizenz. */
export function describeLicense(license: string, version?: string | null): string {
  const upper = license.toUpperCase();
  switch (license) {
    case "cc0":
      return "CC0 (gemeinfrei)";
    case "pdm":
      return "Gemeinfrei";
    default:
      return version ? `CC ${upper} ${version}` : `CC ${upper}`;
  }
}

/**
 * Namensnennung als fertige Zeile.
 *
 * Genau die Zeile, die unter dem Bild stehen muss. Sie hier zu bilden und
 * nicht in der Oberflaeche stellt sicher, dass sie ueberall gleich aussieht -
 * und dass sie nicht vergessen wird.
 */
export function formatAttribution(image: ProductImage): string {
  const parts: string[] = [];
  if (image.creator) parts.push(image.creator);
  parts.push(image.license);
  if (image.sourceUrl) parts.push(image.sourceUrl);
  return parts.join(" · ");
}

export interface ImageSearchOptions {
  /** Hoechstzahl der Treffer. Am Telefon sind mehr als zwoelf sinnlos. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/** Quelle fuer Artikelbilder. */
export interface ImageSource {
  readonly name: string;
  search(query: string, options?: ImageSearchOptions): Promise<ImageCandidate[]>;
}

// --- Openverse -----------------------------------------------------------

interface OpenverseResult {
  id?: string;
  title?: string;
  url?: string;
  thumbnail?: string;
  creator?: string;
  license?: string;
  license_version?: string;
  license_url?: string;
  foreign_landing_url?: string;
  source?: string;
}

/**
 * Bildsuche ueber Openverse.
 *
 * Der Dienst ist ohne Anmeldung nutzbar, begrenzt dann aber die Zahl der
 * Anfragen. Ein Zugangstoken kann mitgegeben werden, sobald der Betrieb eines
 * hat - der Aufrufweg bleibt derselbe.
 */
export function openverseSource(
  fetchImpl: FetchLike,
  config: { readonly baseUrl?: string; readonly accessToken?: string | null } = {},
): ImageSource {
  const baseUrl = config.baseUrl ?? "https://api.openverse.org/v1";

  return {
    name: "openverse",
    async search(query, options = {}) {
      const term = query.trim();
      if (term === "") return [];
      const limit = Math.min(Math.max(options.limit ?? 12, 1), 20);

      const url =
        `${baseUrl}/images/?q=${encodeURIComponent(term)}` +
        `&license=${encodeURIComponent(USABLE_LICENSES.join(","))}` +
        `&page_size=${limit}` +
        // Nur Treffer, deren Lizenz der Dienst bestaetigt hat.
        `&filter_dead=true&mature=false`;

      const headers: Record<string, string> = { accept: "application/json" };
      if (config.accessToken) headers["authorization"] = `Bearer ${config.accessToken}`;

      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ImageSearchError(`Bildsuche antwortete mit ${response.status}: ${body.slice(0, 200)}`);
      }

      const payload = (await response.json()) as { results?: OpenverseResult[] };
      const results = Array.isArray(payload.results) ? payload.results : [];
      return results.flatMap((result) => {
        const candidate = toCandidate(result);
        return candidate ? [candidate] : [];
      });
    },
  };
}

/**
 * Einen Treffer in einen verwendbaren Kandidaten umwandeln.
 *
 * Gibt `null` zurueck, wenn Adresse oder Lizenz fehlen oder die Lizenz nicht
 * auf der Liste steht. Ein Treffer ohne belegte Lizenz ist kein brauchbares
 * Bild, sondern ein Haftungsrisiko.
 */
export function toCandidate(result: OpenverseResult): ImageCandidate | null {
  const url = result.url;
  const license = result.license?.toLowerCase();
  if (!url || !license) return null;
  if (!USABLE_LICENSES.includes(license)) return null;

  return {
    url,
    thumbnailUrl: result.thumbnail ?? null,
    title: result.title?.trim() || "Ohne Titel",
    license: describeLicense(license, result.license_version ?? null),
    licenseUrl: result.license_url ?? null,
    creator: result.creator?.trim() || null,
    sourceUrl: result.foreign_landing_url ?? null,
    provider: result.source ? `openverse/${result.source}` : "openverse",
    attributionRequired: ATTRIBUTION_REQUIRED.includes(license),
  };
}

// --- Open Food Facts -----------------------------------------------------

/**
 * Produktfoto zu einem Barcode.
 *
 * Open Food Facts ist eine offene Datenbank; die Fotos stehen unter
 * CC BY-SA 3.0. Fuer Flaschen, Dosen und Verpacktes ist das der beste Weg:
 * ein Scan, und Name und Bild sind da - ohne Suchbegriff und ohne Auswahl.
 */
export function openFoodFactsSource(
  fetchImpl: FetchLike,
  config: { readonly baseUrl?: string; readonly userAgent?: string } = {},
): {
  readonly name: string;
  byBarcode(barcode: string, options?: ImageSearchOptions): Promise<{ name: string | null; image: ImageCandidate | null }>;
} {
  const baseUrl = config.baseUrl ?? "https://world.openfoodfacts.org";

  return {
    name: "openfoodfacts",
    async byBarcode(barcode, options = {}) {
      const code = barcode.replace(/\D/g, "");
      if (code.length < 8) throw new ImageSearchError(`"${barcode}" ist kein vollstaendiger Barcode`);

      const response = await fetchImpl(`${baseUrl}/api/v2/product/${code}.json?fields=product_name,image_front_url,image_front_small_url,brands`, {
        method: "GET",
        headers: {
          accept: "application/json",
          // Der Dienst bittet um eine erkennbare Kennung.
          "user-agent": config.userAgent ?? "Kassenpilot POS",
        },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (!response.ok) {
        throw new ImageSearchError(`Produktdatenbank antwortete mit ${response.status}`);
      }

      const payload = (await response.json()) as {
        status?: number;
        product?: { product_name?: string; brands?: string; image_front_url?: string; image_front_small_url?: string };
      };
      if (payload.status !== 1 || !payload.product) return { name: null, image: null };

      const product = payload.product;
      const name = [product.brands?.split(",")[0]?.trim(), product.product_name?.trim()]
        .filter((part): part is string => !!part)
        .join(" ")
        .trim();

      const url = product.image_front_url;
      return {
        name: name === "" ? null : name,
        image: url
          ? {
              url,
              thumbnailUrl: product.image_front_small_url ?? null,
              title: name || code,
              license: "CC BY-SA 3.0",
              licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0/",
              creator: "Open Food Facts",
              sourceUrl: `${baseUrl}/product/${code}`,
              provider: "openfoodfacts",
              attributionRequired: true,
            }
          : null,
      };
    },
  };
}

/**
 * Einen Kandidaten als Artikelbild uebernehmen.
 *
 * Die Umwandlung ist der Ort, an dem die Lizenzangabe erzwungen wird: ein Bild
 * ohne Lizenz kommt hier nicht durch, und damit gelangt es auch nicht in den
 * Artikelstamm.
 */
export function toProductImage(candidate: ImageCandidate): ProductImage {
  if (!candidate.url) throw new ImageSearchError("Ein Bild ohne Adresse ist kein Bild");
  if (!candidate.license) throw new ImageSearchError("Ein Bild ohne Lizenzangabe darf nicht uebernommen werden");
  if (candidate.attributionRequired && !candidate.creator && !candidate.sourceUrl) {
    throw new ImageSearchError(
      `Die Lizenz ${candidate.license} verlangt eine Namensnennung, der Treffer nennt aber weder Urheber noch Quelle`,
    );
  }
  return {
    url: candidate.url,
    license: candidate.license,
    licenseUrl: candidate.licenseUrl ?? null,
    creator: candidate.creator ?? null,
    sourceUrl: candidate.sourceUrl ?? null,
    provider: candidate.provider ?? null,
  };
}

/** Eigenes Foto des Betriebs - braucht keine Lizenzrecherche. */
export function ownPhoto(url: string, tenantName: string): ProductImage {
  return {
    url,
    license: "Eigenes Foto",
    licenseUrl: null,
    creator: tenantName,
    sourceUrl: null,
    provider: "self",
  };
}
