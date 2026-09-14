import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_FORMAT_VERSION,
  BackupError,
  CSV_BOM,
  ONE,
  PRODUCT_COLUMNS,
  TAX_RATES,
  backupFileName,
  backupImageLicenses,
  buildBackup,
  buildProductCsv,
  catalogCsvField,
  catalogCsvLine,
  categoryPathLabel,
  describeBackup,
  parseCatalogCsv,
  planCatalogImport,
  readBackup,
  serializeBackup,
  type Category,
  type Product,
  type Store,
  type Tenant,
} from "./index.ts";

const NOW = "2026-09-26T09:00:00+02:00";

const tenant: Tenant = {
  id: "t1",
  name: "Kiosk am Markt",
  legalName: "Petra Beispiel",
  street: "Marktweg 3",
  postalCode: "24103",
  city: "Kiel",
  countryCode: "DE",
  taxNumber: "20/123/45678",
  vatId: null,
  email: null,
  phone: null,
  smallBusiness: false,
  receiptFooter: null,
  currency: "EUR",
  timeZone: "Europe/Berlin",
  createdAt: NOW,
};

const store: Store = { id: "s1", tenantId: "t1", name: "Stand", street: null, postalCode: null, city: null, active: true };

const categories: Category[] = [
  { id: "c-getr", tenantId: "t1", name: "Getraenke", parentId: null, color: null, sortOrder: 1, active: true },
  { id: "c-heiss", tenantId: "t1", name: "Heissgetraenke", parentId: "c-getr", color: null, sortOrder: 1, active: true },
  { id: "c-pfand", tenantId: "t1", name: "Pfand", parentId: null, color: null, sortOrder: 9, active: true },
];

function product(over: Partial<Product> & Pick<Product, "id" | "name" | "categoryId">): Product {
  return {
    tenantId: "t1",
    description: null,
    price: 250,
    taxKey: TAX_RATES.NORMAL.key,
    taxKeyDineIn: null,
    sku: null,
    unit: "PIECE",
    depositProductIds: null,
    isDeposit: false,
    color: null,
    image: null,
    trackStock: false,
    stock: 0,
    lowStockThreshold: null,
    sortOrder: 0,
    active: true,
    updatedAt: NOW,
    ...over,
  };
}

const becher = product({ id: "p-becher", name: "Becher", categoryId: "c-pfand", price: 100, isDeposit: true });
const kaffee = product({
  id: "p-kaffee",
  name: "Kaffee",
  categoryId: "c-heiss",
  price: 250,
  depositProductIds: ["p-becher"],
  sku: "4012345678901",
});
const mutzen = product({
  id: "p-mutzen",
  name: "Mutzen lose",
  categoryId: "c-getr",
  price: 1200,
  unit: "KILOGRAM",
  taxKey: TAX_RATES.REDUCED.key,
  taxKeyDineIn: TAX_RATES.NORMAL.key,
  trackStock: true,
  stock: 4500,
  lowStockThreshold: 2 * ONE,
});
const products = [becher, kaffee, mutzen];

let counter = 0;
const newId = (): string => `neu-${++counter}`;

function planOf(csv: string, over: Partial<Parameters<typeof planCatalogImport>[1]> = {}) {
  counter = 0;
  return planCatalogImport(csv, { tenantId: "t1", categories, products, newId, now: NOW, ...over });
}

// --- CSV-Grundlagen -------------------------------------------------------

test("Felder mit Semikolon, Anfuehrungszeichen und Umbruch ueberleben die Runde", () => {
  const values = ['Kaffee "gross"', "Becher; Deckel", "Zeile 1\nZeile 2", "einfach"];
  const text = catalogCsvLine(values);
  const back = parseCatalogCsv(text);
  assert.equal(back.length, 1, "der Umbruch im Feld darf keine zweite Zeile ergeben");
  assert.deepEqual(back[0], values);
});

test("ein Feld ohne Sonderzeichen wird nicht in Anfuehrungszeichen gesetzt", () => {
  // Sonst ist die Datei voller Anfuehrungszeichen und in einem Texteditor
  // nicht mehr zu lesen.
  assert.equal(catalogCsvField("Kaffee"), "Kaffee");
  assert.equal(catalogCsvField("Becher; Deckel"), '"Becher; Deckel"');
  assert.equal(catalogCsvField('Er sagte "nein"'), '"Er sagte ""nein"""');
});

test("die Byte-Reihenfolge-Marke landet nicht im ersten Spaltennamen", () => {
  const rows = parseCatalogCsv(`${CSV_BOM}Name;Preis\nKaffee;2,50\n`);
  assert.equal(rows[0]?.[0], "Name");
  assert.equal(rows.length, 2);
});

test("leere Zeilen am Ende sind keine Daten", () => {
  assert.equal(parseCatalogCsv("Name\nKaffee\n\n\n").length, 2);
  assert.equal(parseCatalogCsv("Name\r\nKaffee\r\n").length, 2, "auch mit CRLF");
});

// --- Export ---------------------------------------------------------------

test("der Export enthaelt alle Artikel mit lesbarem Pfad, Preis und Pfand", () => {
  const csv = buildProductCsv(products, categories);
  assert.ok(csv.startsWith(CSV_BOM), "mit Marke, sonst zerlegt Excel die Umlaute");
  const rows = parseCatalogCsv(csv);

  assert.deepEqual(rows[0], [...PRODUCT_COLUMNS]);
  assert.equal(rows.length, 4);

  const kaffeeRow = rows.find((row) => row[1] === "Kaffee")!;
  assert.equal(kaffeeRow[0], "4012345678901");
  assert.equal(kaffeeRow[2], "Getraenke > Heissgetraenke", "der ganze Pfad, nicht nur die Gruppe");
  assert.equal(kaffeeRow[3], "2,50", "Dezimalkomma - die Datei wird in einer deutschen Tabelle geoeffnet");
  assert.equal(kaffeeRow[4], "19");
  assert.equal(kaffeeRow[7], "Becher", "Pfand ueber den Namen, nicht ueber eine Id");

  const mutzenRow = rows.find((row) => row[1] === "Mutzen lose")!;
  assert.equal(mutzenRow[4], "7");
  assert.equal(mutzenRow[5], "19", "der abweichende Satz vor Ort steht dabei");
  assert.equal(mutzenRow[6], "Kilogramm");
  assert.equal(mutzenRow[11], "4.500", "der Bestand ist zu sehen");

  const becherRow = rows.find((row) => row[1] === "Becher")!;
  assert.equal(becherRow[8], "ja");
  assert.equal(becherRow[2], "", "ein Pfandartikel liegt ausserhalb des Verkaufsbaums");
});

test("der Pfad einer Warengruppe bricht auch bei einem Zyklus ab", () => {
  // Fehlerhafte Daten duerfen den Export nicht zum Haengen bringen.
  const broken: Category[] = [
    { id: "a", tenantId: "t1", name: "A", parentId: "b", color: null, sortOrder: 1, active: true },
    { id: "b", tenantId: "t1", name: "B", parentId: "a", color: null, sortOrder: 1, active: true },
  ];
  const label = categoryPathLabel(broken, "a");
  assert.ok(label.length > 0);
  assert.ok(label.split(" > ").length <= 16);
});

// --- Einlesen -------------------------------------------------------------

test("Preisaenderungen werden als Aenderung erkannt, nicht als neue Artikel", () => {
  const csv = buildProductCsv(products, categories).replace("2,50", "2,80");
  const plan = planOf(csv);

  assert.equal(plan.created, 0);
  assert.equal(plan.updated, 1);
  assert.equal(plan.unchanged, 2);
  assert.equal(plan.rejected, 0);

  const row = plan.rows.find((entry) => entry.action === "UPDATE")!;
  assert.equal(row.existingId, "p-kaffee");
  assert.equal(row.matchedBy, "sku", "die Artikelnummer ist der verlaesslichste Schluessel");
  assert.equal(row.product?.price, 280);
  assert.ok(row.changes.some((change) => change.includes("2,50") && change.includes("2,80")));
  assert.equal(row.problems.length, 0);
  // Die Id bleibt: sie steht auf jedem alten Beleg.
  assert.equal(row.product?.id, "p-kaffee");
});

test("ein unveraenderter Export erzeugt keine einzige Aenderung", () => {
  // Der wichtigste Test der Runde: exportieren und ohne Bearbeitung einlesen
  // darf nichts anfassen. Tut es das doch, ist eine Spalte falsch geschrieben
  // oder falsch gelesen - und das faellt sonst erst beim Kunden auf.
  const plan = planOf(buildProductCsv(products, categories));
  assert.equal(plan.unchanged, 3, plan.rows.map((row) => `${row.line}: ${row.changes.join(", ")}`).join(" | "));
  assert.equal(plan.created, 0);
  assert.equal(plan.updated, 0);
  assert.equal(plan.rejected, 0);
  assert.equal(plan.newCategoryPaths.length, 0);
});

test("ein neuer Artikel mit neuer Warengruppe wird angekuendigt, nicht still angelegt", () => {
  const csv = [
    catalogCsvLine([...PRODUCT_COLUMNS]),
    catalogCsvLine(["", "Apfelsaft", "Getraenke > Kaltgetraenke", "2,20", "19", "", "Stueck", "", "nein", "ja", "6", "0", "ja"]),
  ].join("\n");
  const plan = planOf(csv);

  assert.equal(plan.created, 1);
  const row = plan.rows[0]!;
  assert.equal(row.action, "CREATE");
  assert.equal(row.newCategoryPath, "Getraenke > Kaltgetraenke");
  assert.deepEqual(plan.newCategoryPaths, ["Getraenke > Kaltgetraenke"]);
  assert.equal(row.product?.name, "Apfelsaft");
  assert.equal(row.product?.price, 220);
  assert.equal(row.product?.trackStock, true);
  assert.equal(row.product?.lowStockThreshold, 6 * ONE);
  assert.equal(row.product?.stock, 0, "ein neuer Artikel beginnt bei null - Bestand kommt aus Bewegungen");
});

test("der Bestand aus der Datei wird nicht uebernommen", () => {
  // Sonst wuerde eine CSV jede Bestandsbewegung ueberschreiben, und das Journal
  // waere wertlos.
  const csv = buildProductCsv(products, categories).replace("4.500", "999.000");
  const plan = planOf(csv);
  const row = plan.rows.find((entry) => entry.product?.id === "p-mutzen")!;
  assert.equal(row.product?.stock, 4500);
  assert.equal(row.action, "UNCHANGED", "eine geaenderte Bestandsspalte ist keine Aenderung");
});

test("unlesbare Werte werden zeilenweise abgewiesen, der Rest laeuft durch", () => {
  const csv = [
    catalogCsvLine([...PRODUCT_COLUMNS]),
    catalogCsvLine(["", "Kakao", "Getraenke", "zwei Euro", "19", "", "Stueck", "", "nein", "nein", "", "0", "ja"]),
    catalogCsvLine(["", "Tee", "Getraenke", "2,00", "23", "", "Stueck", "", "nein", "nein", "", "0", "ja"]),
    catalogCsvLine(["", "Wasser", "Getraenke", "1,50", "19", "", "Eimer", "", "nein", "nein", "", "0", "ja"]),
    catalogCsvLine(["", "", "Getraenke", "1,50", "19", "", "Stueck", "", "nein", "nein", "", "0", "ja"]),
    catalogCsvLine(["", "Saft", "Getraenke", "1,90", "19", "", "Stueck", "", "nein", "nein", "", "0", "ja"]),
  ].join("\n");
  const plan = planOf(csv);

  assert.equal(plan.rejected, 4);
  assert.equal(plan.created, 1, "der gueltige Saft wird trotzdem angelegt");
  assert.match(plan.rows[0]?.problems[0] ?? "", /kein Preis/);
  assert.match(plan.rows[1]?.problems[0] ?? "", /Steuersatz/);
  assert.match(plan.rows[2]?.problems[0] ?? "", /Einheit/);
  assert.match(plan.rows[3]?.problems[0] ?? "", /Artikelname/);
  // Die Zeilennummer muss stimmen, sonst sucht der Bediener an der falschen
  // Stelle. Kopfzeile ist 1.
  assert.equal(plan.rows[0]?.line, 2);
  assert.equal(plan.rows[4]?.line, 6);
});

test("fehlende Zeilen loeschen nichts, werden aber gemeldet", () => {
  const csv = [
    catalogCsvLine([...PRODUCT_COLUMNS]),
    catalogCsvLine(["4012345678901", "Kaffee", "Getraenke > Heissgetraenke", "2,50", "19", "", "Stueck", "Becher", "nein", "nein", "", "0", "ja"]),
  ].join("\n");
  const plan = planOf(csv);

  assert.equal(plan.rejected, 0);
  // Becher und Mutzen fehlen in der Datei - sie bleiben unangetastet.
  assert.equal(plan.missingFromFile.length, 2);
  assert.ok(plan.missingFromFile.some((item) => item.name === "Becher"));
  assert.ok(plan.rows.every((row) => row.action !== "REJECTED"));
});

test("derselbe Artikel zweimal in einer Datei wird abgewiesen", () => {
  const csv = [
    catalogCsvLine([...PRODUCT_COLUMNS]),
    catalogCsvLine(["4012345678901", "Kaffee", "Getraenke > Heissgetraenke", "2,60", "19", "", "Stueck", "Becher", "nein", "nein", "", "0", "ja"]),
    catalogCsvLine(["4012345678901", "Kaffee", "Getraenke > Heissgetraenke", "2,90", "19", "", "Stueck", "Becher", "nein", "nein", "", "0", "ja"]),
  ].join("\n");
  const plan = planOf(csv);

  assert.equal(plan.updated, 1);
  assert.equal(plan.rejected, 1, "welcher Preis gelten soll, kann die Kasse nicht entscheiden");
  assert.match(plan.rows[1]?.problems[0] ?? "", /mehrfach/);
});

test("ein Pfandartikel ohne Betrag wird abgewiesen", () => {
  const csv = [
    catalogCsvLine([...PRODUCT_COLUMNS]),
    catalogCsvLine(["", "Kiste", "", "", "19", "", "Stueck", "", "ja", "nein", "", "0", "ja"]),
    catalogCsvLine(["", "Kasten", "", "0,00", "19", "", "Stueck", "", "ja", "nein", "", "0", "ja"]),
  ].join("\n");
  const plan = planOf(csv);
  assert.equal(plan.rejected, 2);
  assert.match(plan.rows[0]?.problems[0] ?? "", /offener Preis/);
  assert.match(plan.rows[1]?.problems[0] ?? "", /kein Pfand/);
});

test("ein unbekannter Pfandartikel wird gemeldet, die Zeile aber uebernommen", () => {
  const csv = [
    catalogCsvLine([...PRODUCT_COLUMNS]),
    catalogCsvLine(["4012345678901", "Kaffee", "Getraenke > Heissgetraenke", "2,50", "19", "", "Stueck", "Becher + Deckel", "nein", "nein", "", "0", "ja"]),
  ].join("\n");
  const plan = planOf(csv);

  const row = plan.rows[0]!;
  assert.notEqual(row.action, "REJECTED");
  assert.deepEqual(row.product?.depositProductIds, ["p-becher"]);
  assert.match(row.problems[0] ?? "", /Deckel/);
});

test("umsortierte Spalten werden nach Namen gelesen", () => {
  // Sobald jemand in der Tabelle arbeitet, verschieben sich Spalten. Nach
  // Position zu lesen hiesse, Preise in die Steuerspalte zu schreiben.
  const csv = ["Name;Steuersatz;Preis;Warengruppe", "Kaffee;19;3,10;Getraenke > Heissgetraenke"].join("\n");
  const plan = planOf(csv);
  assert.equal(plan.updated, 1);
  assert.equal(plan.rows[0]?.product?.price, 310);
  assert.equal(plan.rows[0]?.product?.taxKey, TAX_RATES.NORMAL.key);
});

test("eine Datei ohne Namensspalte wird gar nicht erst gelesen", () => {
  assert.throws(() => planOf("Preis;Steuersatz\n2,50;19"), BackupError);
  assert.throws(() => planOf(""), /leer/);
});

test("die drei Faelle ohne Steuer werden als Wort geschrieben, nicht als 0", () => {
  // Als 0 waeren "nicht steuerbar", "steuerfrei" und "nicht ermittelbar" beim
  // Einlesen nicht auseinanderzuhalten - die Kasse wuerde einen davon raten.
  const steuerfrei = product({ id: "p-frei", name: "Gutschein", categoryId: "c-getr", price: 1000, taxKey: 6 });
  const csv = buildProductCsv([steuerfrei], categories);
  assert.ok(csv.includes("steuerfrei"), csv);

  const plan = planCatalogImport(csv, {
    tenantId: "t1", categories, products: [steuerfrei], newId, now: NOW,
  });
  assert.equal(plan.unchanged, 1);
  assert.equal(plan.rows[0]?.product?.taxKey, 6);
});

test("ein erfundener Steuersatz wird abgewiesen statt auf den naechstbesten abgebildet", () => {
  // 23 % gibt es in Deutschland nicht. Es still als 19 % zu buchen waere ein
  // Fehler, der erst in der Umsatzsteuererklaerung auffaellt.
  const plan = planOf(["Name;Preis;Steuersatz", "Kakao;2,10;23"].join("\n"));
  assert.equal(plan.rejected, 1);
  assert.match(plan.rows[0]?.problems[0] ?? "", /kein bekannter Steuersatz/);
  // Auch der DSFinV-K-Schluessel selbst ist keine gueltige Eingabe: "7" bedeutet
  // 7 Prozent, nicht Schluessel 7.
  const seven = planOf(["Name;Preis;Steuersatz", "Kakao;2,10;7"].join("\n"));
  assert.equal(seven.rows[0]?.product?.taxKey, TAX_RATES.REDUCED.key);
});

test("eine betriebseigene Artikelnummer wird uebernommen und gemeldet", () => {
  const csv = ["Name;Preis;Steuersatz;Artikelnummer", "Kakao;2,10;19;KAKAO-01"].join("\n");
  const plan = planOf(csv);
  const row = plan.rows[0]!;
  assert.equal(row.action, "CREATE");
  assert.equal(row.product?.sku, "KAKAO-01");
  assert.match(row.problems[0] ?? "", /Scanner/);
});

// --- Sicherung ------------------------------------------------------------

test("Sicherung schreiben und wieder einlesen", () => {
  const file = buildBackup({ tenant, stores: [store], categories, products, createdAt: NOW });
  assert.equal(file.payload.formatVersion, BACKUP_FORMAT_VERSION);
  assert.equal(file.payload.products.length, 3);

  const back = readBackup(serializeBackup(file));
  assert.deepEqual(back.payload, file.payload);
  assert.equal(back.checksum, file.checksum);
  // Die Ids bleiben erhalten - sonst verweisen die Belege nach dem Einspielen
  // ins Leere.
  assert.equal(back.payload.products[1]?.id, "p-kaffee");
});

test("eine veraenderte Sicherung wird nicht eingespielt", () => {
  const text = serializeBackup(buildBackup({ tenant, stores: [store], categories, products, createdAt: NOW }));
  const tampered = text.replace('"price": 250', '"price": 1');
  assert.notEqual(tampered, text, "die Testvoraussetzung muss greifen");
  assert.throws(() => readBackup(tampered), /Pruefsumme/);
});

test("eine abgeschnittene oder fremde Datei wird abgewiesen", () => {
  const text = serializeBackup(buildBackup({ tenant, stores: [store], categories, products, createdAt: NOW }));
  assert.throws(() => readBackup(text.slice(0, text.length / 2)), /laesst sich nicht lesen/);
  assert.throws(() => readBackup("{}"), /keine Sicherung/);
  assert.throws(() => readBackup('{"payload":{},"checksum":"x"}'), /Format/);
});

test("eine Sicherung aus einer neueren Fassung wird abgewiesen, nicht geraten", () => {
  const file = buildBackup({ tenant, stores: [store], categories, products, createdAt: NOW });
  const future = JSON.parse(serializeBackup(file)) as { payload: { formatVersion: number } };
  future.payload.formatVersion = BACKUP_FORMAT_VERSION + 1;
  assert.throws(() => readBackup(JSON.stringify(future)), /Format 2/);
});

test("die Beschreibung nennt, was eingespielt wird", () => {
  const text = describeBackup(buildBackup({ tenant, stores: [store], categories, products, createdAt: NOW }));
  assert.match(text, /Kiosk am Markt/);
  assert.match(text, /3 Warengruppen/);
  assert.match(text, /2 Artikel, 1 Pfandartikel/);
});

test("Bildlizenzen bleiben in der Sicherung nachlesbar", () => {
  const withImage = product({
    id: "p-bild",
    name: "Limonade",
    categoryId: "c-getr",
    image: { url: "https://beispiel.de/limo.jpg", license: "CC BY 4.0", creator: "A. Fotograf", sourceUrl: "https://beispiel.de/seite" },
  });
  const file = buildBackup({ tenant, stores: [store], categories, products: [...products, withImage], createdAt: NOW });
  const licenses = backupImageLicenses(file);
  assert.equal(licenses.length, 1);
  assert.equal(licenses[0]?.name, "Limonade");
  assert.equal(licenses[0]?.image.license, "CC BY 4.0");
});

test("der Dateiname ist ohne Umlaute und ohne Leerzeichen brauchbar", () => {
  assert.equal(backupFileName("Kiosk am Markt", NOW, "json"), "kiosk-am-markt-artikel-2026-09-26-0900.json");
  assert.equal(backupFileName("Müller & Söhne", NOW, "csv"), "mueller-soehne-artikel-2026-09-26-0900.csv");
  assert.equal(backupFileName("", NOW, "csv"), "kasse-artikel-2026-09-26-0900.csv");
});
