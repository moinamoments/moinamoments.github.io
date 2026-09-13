import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type FetchLike,
  ImageSearchError,
  USABLE_LICENSES,
  describeLicense,
  formatAttribution,
  openFoodFactsSource,
  openverseSource,
  ownPhoto,
  toCandidate,
  toProductImage,
} from "./images.ts";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const openverseHit = {
  id: "abc",
  title: "Cup of coffee",
  url: "https://example.invalid/kaffee.jpg",
  thumbnail: "https://example.invalid/kaffee-klein.jpg",
  creator: "Jane Doe",
  license: "by",
  license_version: "4.0",
  license_url: "https://creativecommons.org/licenses/by/4.0/",
  foreign_landing_url: "https://commons.example.invalid/kaffee",
  source: "wikimedia",
};

test("nur Lizenzen ohne Einschraenkung fuer Gewerbe stehen auf der Liste", () => {
  // "nc" waere fuer einen Gewerbebetrieb unbrauchbar - eine Kasse steht
  // immer in einem Gewerbe.
  for (const license of USABLE_LICENSES) {
    assert.equal(license.includes("nc"), false, `${license} schliesst gewerbliche Nutzung aus`);
  }
  assert.ok(USABLE_LICENSES.includes("cc0"));
  assert.ok(USABLE_LICENSES.includes("by-sa"));
});

test("Lizenzen werden lesbar benannt", () => {
  assert.equal(describeLicense("cc0"), "CC0 (gemeinfrei)");
  assert.equal(describeLicense("pdm"), "Gemeinfrei");
  assert.equal(describeLicense("by", "4.0"), "CC BY 4.0");
  assert.equal(describeLicense("by-sa", "3.0"), "CC BY-SA 3.0");
  assert.equal(describeLicense("by-sa"), "CC BY-SA");
});

test("Treffer ohne Lizenz oder ohne Adresse wird verworfen", () => {
  assert.equal(toCandidate({ url: "https://x.invalid/a.jpg" }), null, "ohne Lizenz");
  assert.equal(toCandidate({ license: "by" }), null, "ohne Adresse");
  // Eine Lizenz, die gewerbliche Nutzung ausschliesst, wird nicht uebernommen.
  assert.equal(toCandidate({ url: "https://x.invalid/a.jpg", license: "by-nc" }), null);
  assert.equal(toCandidate({ url: "https://x.invalid/a.jpg", license: "by-nc-sa" }), null);
});

test("Treffer wird mit Lizenz, Urheber und Quelle uebernommen", () => {
  const candidate = toCandidate(openverseHit);
  assert.ok(candidate);
  assert.equal(candidate!.license, "CC BY 4.0");
  assert.equal(candidate!.creator, "Jane Doe");
  assert.equal(candidate!.sourceUrl, "https://commons.example.invalid/kaffee");
  assert.equal(candidate!.provider, "openverse/wikimedia");
  assert.equal(candidate!.attributionRequired, true);

  const public_domain = toCandidate({ ...openverseHit, license: "cc0", creator: undefined });
  assert.equal(public_domain?.attributionRequired, false, "CC0 verlangt keine Namensnennung");
  assert.equal(public_domain?.creator, null);
});

test("Bildsuche filtert die Lizenzen bereits in der Anfrage", async () => {
  let requested = "";
  const fetchImpl: FetchLike = async (url) => {
    requested = url;
    return jsonResponse({ results: [openverseHit] });
  };
  const source = openverseSource(fetchImpl);
  const results = await source.search("Kaffee", { limit: 5 });

  assert.equal(results.length, 1);
  assert.ok(requested.includes("q=Kaffee"));
  assert.ok(requested.includes("page_size=5"));
  for (const license of USABLE_LICENSES) {
    assert.ok(requested.includes(encodeURIComponent(license)) || requested.includes(license), `Lizenz ${license} fehlt in der Anfrage`);
  }
});

test("Bildsuche verwirft ungeeignete Treffer aus der Antwort", async () => {
  // Auch wenn der Dienst etwas liefert, das nicht passt: es wird nicht
  // uebernommen. Auf die Filterung der Gegenseite allein ist kein Verlass.
  const fetchImpl: FetchLike = async () =>
    jsonResponse({
      results: [
        openverseHit,
        { ...openverseHit, id: "2", license: "by-nc" },
        { ...openverseHit, id: "3", license: undefined },
        { ...openverseHit, id: "4", url: undefined },
      ],
    });
  const results = await openverseSource(fetchImpl).search("Kaffee");
  assert.equal(results.length, 1);
});

test("leerer Suchbegriff fragt nicht erst an", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return jsonResponse({ results: [] });
  };
  assert.deepEqual(await openverseSource(fetchImpl).search("   "), []);
  assert.equal(calls, 0);
});

test("Fehler des Dienstes werden gemeldet, nicht verschluckt", async () => {
  const fetchImpl: FetchLike = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "zu viele Anfragen" });
  await assert.rejects(() => openverseSource(fetchImpl).search("Kaffee"), ImageSearchError);
});

test("Produktfoto zum Barcode samt Name", async () => {
  const fetchImpl: FetchLike = async (url) => {
    assert.ok(url.includes("/api/v2/product/4006381333931.json"));
    return jsonResponse({
      status: 1,
      product: {
        product_name: "Limonade Zitrone",
        brands: "Beispielmarke, Zweitmarke",
        image_front_url: "https://images.example.invalid/limo.jpg",
        image_front_small_url: "https://images.example.invalid/limo-klein.jpg",
      },
    });
  };
  const result = await openFoodFactsSource(fetchImpl).byBarcode("4006381333931");
  assert.equal(result.name, "Beispielmarke Limonade Zitrone");
  assert.equal(result.image?.license, "CC BY-SA 3.0");
  assert.equal(result.image?.attributionRequired, true);
  assert.ok(result.image?.sourceUrl?.includes("4006381333931"));
});

test("unbekannter Barcode liefert nichts, statt zu werfen", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ status: 0 });
  assert.deepEqual(await openFoodFactsSource(fetchImpl).byBarcode("4006381333931"), { name: null, image: null });
});

test("unvollstaendiger Barcode wird abgewiesen", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ status: 1 });
  await assert.rejects(() => openFoodFactsSource(fetchImpl).byBarcode("123"), ImageSearchError);
});

test("Uebernahme erzwingt die Lizenzangabe", () => {
  const candidate = toCandidate(openverseHit)!;
  const image = toProductImage(candidate);
  assert.equal(image.license, "CC BY 4.0");
  assert.equal(image.creator, "Jane Doe");

  assert.throws(() => toProductImage({ ...candidate, license: "" }), ImageSearchError);
  assert.throws(() => toProductImage({ ...candidate, url: "" }), ImageSearchError);
  // Namensnennung verlangt, aber weder Urheber noch Quelle bekannt.
  assert.throws(
    () => toProductImage({ ...candidate, creator: null, sourceUrl: null }),
    ImageSearchError,
  );
  // Ohne Pflicht zur Namensnennung ist das kein Problem.
  assert.doesNotThrow(() =>
    toProductImage({ ...candidate, license: "CC0 (gemeinfrei)", attributionRequired: false, creator: null, sourceUrl: null }),
  );
});

test("Namensnennung wird als fertige Zeile gebildet", () => {
  assert.equal(
    formatAttribution(toProductImage(toCandidate(openverseHit)!)),
    "Jane Doe · CC BY 4.0 · https://commons.example.invalid/kaffee",
  );
  assert.equal(formatAttribution({ url: "x", license: "CC0 (gemeinfrei)" }), "CC0 (gemeinfrei)");
});

test("eigenes Foto braucht keine Lizenzrecherche", () => {
  const image = ownPhoto("file:///bilder/kaffee.jpg", "Kiosk am Markt");
  assert.equal(image.license, "Eigenes Foto");
  assert.equal(image.creator, "Kiosk am Markt");
  assert.equal(formatAttribution(image), "Kiosk am Markt · Eigenes Foto");
});
