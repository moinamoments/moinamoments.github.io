/**
 * Ersteinrichtung.
 *
 * Beim ersten Start ist die Datenbank leer, und eine leere Kasse ist
 * unbenutzbar: kein Mandant, keine Kasse, keine Artikel. Statt den Bediener
 * vor ein leeres Formular zu setzen, wird ein vollstaendig arbeitsfaehiger
 * Stand angelegt, den er danach auf seinen Betrieb umschreibt.
 *
 * Die Artikel sind Beispiele eines Imbissbetriebs, weil daran alles zu sehen
 * ist, was die Kasse koennen muss: Speisen mit 7/19-Prozent-Umschaltung,
 * Getraenke mit festen 19 Prozent, Becher- und Deckelpfand, Gewichtsware, ein
 * Artikel mit offenem Preis, Untergruppen und bestandsgefuehrte Flaschenware.
 *
 * Die Angaben des Mandanten sind ausdruecklich Platzhalter. Solange sie nicht
 * ersetzt sind, meldet die App das im Status - ein Bon mit Platzhalteradresse
 * ist kein gueltiger Beleg.
 */

import type { Category, Device, Product, Store, Tenant, User } from "@kp/core";
import { TAX_RATES } from "@kp/core";
import type { Db } from "../db/database.ts";
import {
  getTenant,
  saveCategory,
  saveDevice,
  saveProduct,
  saveStore,
  saveTenant,
  saveUser,
} from "../db/repositories.ts";

/** Erkennbar unausgefuellte Mandantendaten. */
export const PLACEHOLDER_NAME = "Mein Betrieb";

export function isPlaceholderTenant(tenant: Tenant): boolean {
  return tenant.name === PLACEHOLDER_NAME || tenant.street === "" || tenant.taxNumber === null;
}

export interface SeedResult {
  readonly tenant: Tenant;
  readonly store: Store;
  readonly device: Device;
  readonly user: User;
}

export async function ensureSeeded(db: Db, now: string, newId: () => string): Promise<void> {
  if (await getTenant(db)) return;

  const tenantId = newId();
  const storeId = newId();

  const tenant: Tenant = {
    id: tenantId,
    name: PLACEHOLDER_NAME,
    legalName: PLACEHOLDER_NAME,
    street: "",
    postalCode: "",
    city: "",
    countryCode: "DE",
    taxNumber: null,
    vatId: null,
    email: null,
    phone: null,
    smallBusiness: false,
    receiptFooter: null,
    currency: "EUR",
    timeZone: "Europe/Berlin",
    createdAt: now,
  };
  const store: Store = { id: storeId, tenantId, name: "Verkaufsstelle", street: null, postalCode: null, city: null, active: true };
  const device: Device = {
    id: newId(),
    tenantId,
    storeId,
    name: "Kasse 1",
    // Die Seriennummer steht auf jedem Bon und muss das Geraet eindeutig
    // bezeichnen. Bis zur Einrichtung ist sie erkennbar vorlaeufig.
    serialNumber: "KASSE-1",
    tseClientId: null,
    receiptPrefix: "K1",
    active: true,
  };
  const user: User = { id: newId(), tenantId, name: "Inhaber", role: "OWNER", pinHash: null, active: true };

  await saveTenant(db, tenant);
  await saveStore(db, store);
  // Die erste Kasse ist *diese* Kasse. Weitere, die der Betrieb spaeter
  // anlegt, sind Kassen der Verwaltung - jedes Geraet kennzeichnet seine
  // eigene, damit die Belegnummernkreise nicht kollidieren.
  await saveDevice(db, device, { isThisDevice: true });
  await saveUser(db, user);

  // Zwei Ebenen im Beispiel, damit sofort sichtbar ist, dass es Untergruppen
  // gibt - und wie sie am Kassenbildschirm aussehen.
  const speisen: Category = { id: newId(), tenantId, name: "Speisen", parentId: null, color: "#F59E0B", sortOrder: 1, active: true };
  const getraenke: Category = { id: newId(), tenantId, name: "Getraenke", parentId: null, color: "#38BDF8", sortOrder: 2, active: true };
  const heiss: Category = { id: newId(), tenantId, name: "Heissgetraenke", parentId: getraenke.id, color: "#38BDF8", sortOrder: 1, active: true };
  const kalt: Category = { id: newId(), tenantId, name: "Kaltgetraenke", parentId: getraenke.id, color: "#38BDF8", sortOrder: 2, active: true };
  const pfandKategorie: Category = { id: newId(), tenantId, name: "Pfand", parentId: null, color: "#A78BFA", sortOrder: 99, active: true };

  const categories: Category[] = [speisen, getraenke, heiss, kalt, pfandKategorie];
  for (const category of categories) await saveCategory(db, category);

  const product = (over: Partial<Product> & Pick<Product, "name" | "categoryId" | "taxKey">): Product => ({
    id: newId(),
    tenantId,
    description: null,
    price: 0,
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
    updatedAt: now,
    ...over,
  });

  // Pfandartikel zuerst: die Warenartikel verweisen darauf. Es sind nur
  // Beispiele - ein Betrieb legt seine eigenen Gebinde an, beliebig viele.
  const becher = product({ name: "Becher", categoryId: pfandKategorie.id, price: 100, taxKey: TAX_RATES.NORMAL.key, isDeposit: true, sortOrder: 1 });
  const deckel = product({ name: "Deckel", categoryId: pfandKategorie.id, price: 30, taxKey: TAX_RATES.NORMAL.key, isDeposit: true, sortOrder: 2 });
  const schale = product({ name: "Schale", categoryId: pfandKategorie.id, price: 200, taxKey: TAX_RATES.NORMAL.key, isDeposit: true, sortOrder: 3 });
  const flasche = product({ name: "Flaschenpfand", categoryId: pfandKategorie.id, price: 25, taxKey: TAX_RATES.NORMAL.key, isDeposit: true, sortOrder: 4 });
  for (const item of [becher, deckel, schale, flasche]) await saveProduct(db, item);

  const goods: Product[] = [
    // Speisen: ausser Haus 7 %, im Haus 19 %.
    product({
      name: "Crepe Zucker & Zimt", categoryId: speisen.id, price: 450,
      taxKey: TAX_RATES.REDUCED.key, taxKeyDineIn: TAX_RATES.NORMAL.key, sortOrder: 1,
    }),
    product({
      name: "Crepe Nutella", categoryId: speisen.id, price: 500,
      taxKey: TAX_RATES.REDUCED.key, taxKeyDineIn: TAX_RATES.NORMAL.key, sortOrder: 2,
    }),
    product({
      name: "Mutzen, 6 Stueck", categoryId: speisen.id, price: 350,
      taxKey: TAX_RATES.REDUCED.key, taxKeyDineIn: TAX_RATES.NORMAL.key, sortOrder: 3,
    }),
    // Gewichtsware mit Mehrwegschale.
    product({
      name: "Mutzen lose (kg)", categoryId: speisen.id, price: 1200, unit: "KILOGRAM",
      taxKey: TAX_RATES.REDUCED.key, taxKeyDineIn: TAX_RATES.NORMAL.key,
      depositProductIds: [schale.id], sortOrder: 4,
    }),
    // Heissgetraenke mit Becher und Deckel - in der Untergruppe.
    product({
      name: "Kaffee", categoryId: heiss.id, price: 250, taxKey: TAX_RATES.NORMAL.key,
      depositProductIds: [becher.id, deckel.id], sortOrder: 1,
    }),
    product({
      name: "Tee", categoryId: heiss.id, price: 220, taxKey: TAX_RATES.NORMAL.key,
      depositProductIds: [becher.id, deckel.id], sortOrder: 2,
    }),
    // Flaschenware: Pfand *und* Bestandsfuehrung. Flaschen zaehlt man, Kaffee
    // aus der Maschine nicht - genau der Unterschied, den die Kasse koennen
    // muss.
    product({
      name: "Limonade 0,5 l", categoryId: kalt.id, price: 250, taxKey: TAX_RATES.NORMAL.key,
      depositProductIds: [flasche.id], trackStock: true, lowStockThreshold: 6 * 1000, sortOrder: 1,
    }),
    product({
      name: "Wasser 0,5 l", categoryId: kalt.id, price: 200, taxKey: TAX_RATES.NORMAL.key,
      depositProductIds: [flasche.id], trackStock: true, lowStockThreshold: 6 * 1000, sortOrder: 2,
    }),
    // Offener Preis: der Betrag wird am Stand eingegeben.
    product({ name: "Sonstiges (Betrag eingeben)", categoryId: speisen.id, price: null, taxKey: TAX_RATES.NORMAL.key, sortOrder: 90 }),
  ];
  for (const item of goods) await saveProduct(db, item);
}
