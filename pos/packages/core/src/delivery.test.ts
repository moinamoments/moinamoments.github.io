import { test } from "node:test";
import assert from "node:assert/strict";
import { ONE } from "./money.ts";
import { fixedClock, sequentialIds } from "./clock.ts";
import { addProduct, emptyCart } from "./cart.ts";
import type { Device, Order, Product, Store, Tenant, User } from "./model.ts";
import { MockTse } from "./tse/mock.ts";
import { beginTransaction, finishTransaction, type TransactionContext } from "./order.ts";
import { buildReceiptView, type ReceiptView } from "./receipt.ts";
import {
  DELIVERY_LABELS,
  DeliveryError,
  SMALL_INVOICE_LIMIT,
  anonymizeContact,
  checkInvoiceRequirements,
  needsCustomerAddress,
  prepareDelivery,
  prepareEmail,
  prepareSms,
  receiptEmailBody,
  receiptSmsBody,
  receiptSubject,
  recordDelivery,
} from "./delivery.ts";

const tenant: Tenant = {
  id: "t1", name: "Kiosk am Markt", legalName: "Petra Beispiel", street: "Marktweg 3",
  postalCode: "24103", city: "Kiel", countryCode: "DE", taxNumber: "21/815/08150", vatId: null,
  email: "info@kiosk-beispiel.de", phone: null, smallBusiness: false, receiptFooter: null,
  currency: "EUR", timeZone: "Europe/Berlin", createdAt: "x",
};
const store: Store = { id: "s1", tenantId: "t1", name: "Stand", active: true };
const device: Device = {
  id: "d1", tenantId: "t1", storeId: "s1", name: "Kasse 1", serialNumber: "KASSE-0001",
  tseClientId: "c1", receiptPrefix: "K1", active: true,
};
const user: User = { id: "u1", tenantId: "t1", name: "Bediener", role: "OWNER", active: true };
const kaffee: Product = {
  id: "p1", tenantId: "t1", categoryId: "c1", name: "Kaffee", price: 250, taxKey: 1,
  unit: "PIECE", sortOrder: 0, active: true, updatedAt: "x",
};

async function sampleReceipt(quantity = 2): Promise<{ order: Order; view: ReceiptView }> {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  const ctx: TransactionContext = {
    tenant, store, device, user, clock, newId: sequentialIds("o"), tse: new MockTse({ clock }),
  };
  const open = await beginTransaction(ctx);
  clock.advance(30);
  const cart = addProduct(emptyCart("t1"), kaffee, { id: "l1", quantity: quantity * ONE });
  const { order } = await finishTransaction(
    ctx, open, cart, [{ method: "CASH", amount: quantity * 250, tendered: quantity * 250 }], { sequence: 42 },
  );
  return { order, view: buildReceiptView(order, { tenant, store, device }) };
}

test("Betreff enthaelt Betrieb, Belegnummer und Betrag", async () => {
  const { view } = await sampleReceipt();
  const subject = receiptSubject(tenant, view);
  assert.ok(subject.includes("Kiosk am Markt"));
  assert.ok(subject.includes("K1-000042"));
  assert.ok(subject.includes("5,00"));
  assert.equal(DELIVERY_LABELS.EMAIL, "E-Mail");
  assert.equal(DELIVERY_LABELS.SMS, "SMS");
});

test("die E-Mail enthaelt den vollstaendigen Bon und die Pruefangabe", async () => {
  const { view } = await sampleReceipt();
  const body = receiptEmailBody(tenant, view, { name: "Frau Mueller" });

  assert.ok(body.startsWith("Hallo Frau Mueller,"), "mit Namen wird gegruesst");
  assert.ok(body.includes("Kiosk am Markt"));
  assert.ok(body.includes("K1-000042"));
  assert.ok(body.includes("SUMME"), "der ganze Bon steht darin");
  assert.ok(body.includes("Marktweg 3"), "mit der Adresse des Betriebs");
  assert.ok(body.includes("V0;KASSE-0001;"), "und mit dem Inhalt des Pruef-QR-Codes");
  assert.ok(body.includes("info@kiosk-beispiel.de"));
});

test("ohne Namen wird neutral gegruesst", async () => {
  const { view } = await sampleReceipt();
  assert.ok(receiptEmailBody(tenant, view, {}).startsWith("Guten Tag,"));
});

test("die SMS bleibt kurz und enthaelt die Pflichtangaben in Kurzform", async () => {
  const { view } = await sampleReceipt();
  const body = receiptSmsBody(tenant, view);

  // Eine SMS fasst 160 Zeichen; darueber wird sie geteilt und kostet mehrfach.
  assert.ok(body.length <= 160, `SMS ist ${body.length} Zeichen lang`);
  assert.ok(body.includes("Kiosk am Markt"));
  assert.ok(body.includes("K1-000042"));
  assert.ok(body.includes("5,00"));
});

test("E-Mail-Versand: Adresse wird geprueft, bevor etwas geoeffnet wird", async () => {
  const { view } = await sampleReceipt();

  const message = prepareEmail(tenant, view, { name: "Frau Mueller", email: " Frau.Mueller@Beispiel.de " });
  assert.equal(message.channel, "EMAIL");
  assert.equal(message.to, "Frau.Mueller@beispiel.de", "die Domain kleingeschrieben, das Postfach nicht");
  assert.ok(message.url.startsWith("mailto:"));
  assert.ok(message.url.includes("subject="));
  assert.ok(message.url.includes("body="));
  // Alles kodiert: Umlaute und Umbrueche duerfen den Aufruf nicht zerlegen.
  assert.equal(message.url.includes(" "), false);
  assert.equal(message.url.includes("\n"), false);

  assert.throws(() => prepareEmail(tenant, view, {}), DeliveryError);
  assert.throws(() => prepareEmail(tenant, view, { email: "keine-adresse" }), DeliveryError);
  assert.throws(() => prepareEmail(tenant, view, { email: "keine-adresse" }), /nicht lesbar/);
});

test("SMS-Versand: Nummer wird auf die Form mit Laendervorwahl gebracht", async () => {
  const { view } = await sampleReceipt();

  const message = prepareSms(tenant, view, { phone: "0431 123456" });
  assert.equal(message.channel, "SMS");
  assert.equal(message.to, "+49431123456");
  assert.ok(message.url.startsWith("sms:"));
  assert.ok(message.url.includes("body="));

  assert.throws(() => prepareSms(tenant, view, {}), DeliveryError);
  assert.throws(() => prepareSms(tenant, view, { phone: "0431" }), /zu kurz/);
});

test("prepareDelivery waehlt den Kanal", async () => {
  const { view } = await sampleReceipt();
  assert.equal(prepareDelivery("EMAIL", tenant, view, { email: "a@b.de" }).channel, "EMAIL");
  assert.equal(prepareDelivery("SMS", tenant, view, { phone: "+4943112345678" }).channel, "SMS");
});

test("Umlaute und Sonderzeichen im Aufruf bleiben unbeschaedigt", async () => {
  const { view } = await sampleReceipt();
  const withUmlauts: Tenant = { ...tenant, name: "Königs Café & Söhne" };
  const message = prepareEmail(withUmlauts, view, { email: "a@b.de" });
  // Dekodiert muss der Name wieder da sein.
  assert.ok(decodeURIComponent(message.url.split("subject=")[1]!.split("&")[0]!).includes("Königs Café & Söhne"));
  // Das Kaufmanns-Und darf den Aufruf nicht in zwei Parameter zerlegen.
  assert.equal(message.url.split("&").length, 2, "genau ein Trennzeichen zwischen subject und body");
});

// --- Rechnung statt Kassenbon --------------------------------------------

test("bis 250 Euro genuegt die Kleinbetragsrechnung", () => {
  assert.equal(SMALL_INVOICE_LIMIT, 25_000);
  assert.equal(needsCustomerAddress(24_999, true), false);
  assert.equal(needsCustomerAddress(25_000, true), false, "genau auf der Grenze noch nicht");
  assert.equal(needsCustomerAddress(25_001, true), true);
  // Ein normaler Kassenbon braucht die Adresse nie - danach zu fragen waere
  // ueberfluessige Datenerhebung.
  assert.equal(needsCustomerAddress(100_000, false), false);
});

test("ab 250 Euro fehlen ohne Adresse die Pflichtangaben", () => {
  const small = checkInvoiceRequirements({ total: 5000 }, null);
  assert.deepEqual(small, { ok: true, problems: [] });

  const missing = checkInvoiceRequirements({ total: 30_000 }, null);
  assert.equal(missing.ok, false);
  assert.ok(missing.problems[0]?.includes("14 Abs. 4 UStG"));

  const incomplete = checkInvoiceRequirements({ total: 30_000 }, { name: "Firma Beispiel" });
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.problems.some((problem) => problem.includes("Strasse")));
  assert.ok(incomplete.problems.some((problem) => problem.includes("Postleitzahl")));

  const complete = checkInvoiceRequirements(
    { total: 30_000 },
    { name: "Firma Beispiel", street: "Weg 1", postalCode: "24103", city: "Kiel" },
  );
  assert.deepEqual(complete, { ok: true, problems: [] });
});

// --- Datenschutz ----------------------------------------------------------

test("Empfaenger wird fuer die Aufbewahrung verkuerzt", () => {
  // Nachweisbar bleiben muss, DASS ein Beleg herausgegeben wurde - nicht, an
  // welche vollstaendige Adresse.
  // "frau.mueller" hat zwoelf Zeichen: der erste bleibt, elf werden ersetzt.
  assert.equal(anonymizeContact("EMAIL", "frau.mueller@beispiel.de"), `f${"*".repeat(11)}@beispiel.de`);
  assert.equal(anonymizeContact("EMAIL", "a@b.de"), "a*@b.de");
  assert.equal(anonymizeContact("EMAIL", "kaputt"), "***");

  assert.equal(anonymizeContact("SMS", "+49431123456"), "+49*******56");
  assert.equal(anonymizeContact("SMS", "+12"), "***");
});

test("Versandprotokoll haelt fest, dass und wie versandt wurde", async () => {
  const { order, view } = await sampleReceipt();
  const message = prepareEmail(tenant, view, { email: "frau.mueller@beispiel.de" });

  const record = recordDelivery(order, message, {
    sentAt: "2026-09-26T09:01:00+02:00",
    via: "device",
    ok: true,
  });
  assert.equal(record.orderId, order.id);
  assert.equal(record.channel, "EMAIL");
  assert.equal(record.via, "device");
  assert.equal(record.ok, true);
  assert.equal(record.error, null);
  // Im Protokoll steht nur die verkuerzte Adresse.
  assert.equal(record.recipient.includes("frau.mueller"), false);
  assert.ok(record.recipient.endsWith("@beispiel.de"));
});

test("ein gescheiterter Versand wird mit Grund protokolliert", async () => {
  const { order, view } = await sampleReceipt();
  const message = prepareSms(tenant, view, { phone: "+4943112345678" });
  const record = recordDelivery(order, message, {
    sentAt: "2026-09-26T09:01:00+02:00",
    via: "provider",
    ok: false,
    error: "Empfaenger nicht erreichbar",
  });
  assert.equal(record.ok, false);
  assert.equal(record.error, "Empfaenger nicht erreichbar");
});
