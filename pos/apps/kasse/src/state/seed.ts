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
 * Getraenke mit festen 19 Prozent, Becher- und Deckelpfand, Gewichtsware und
 * ein Artikel mit offenem Preis.
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
  await saveDevice(db, device);
  await saveUser(db, user);

  const categories: Category[] = [
    { id: newId(), tenantId, name: "Speisen", color: "#F59E0B", sortOrder: 1, active: true },
    { id: newId(), tenantId, name: "Getraenke", color: "#38BDF8", sortOrder: 2, active: true },
    { id: newId(), tenantId, name: "Pfand", color: "#A78BFA", sortOrder: 99, active: true },
  ];
  for (const category of categories) await saveCategory(db, category);
  const [speisen, getraenke, pfandKategorie] = categories as [Category, Category, Category];

  const product = (over: Partial<Product> & Pick<Product, "name" | "categoryId" | "taxKey">): Product => ({
    id: newId(),
    tenantId,
    description: null,
    price: 0,
    taxKeyDineIn: null,
    sku: null,
    unit: "PIECE",
    depositProductIds: null,
    deposit: null,
    color: null,
    sortOrder: 0,
    active: true,
    updatedAt: now,
    ...over,
  });

  // Pfandartikel zuerst: die Warenartikel verweisen darauf.
  const becher = product({
    name: "Mehrwegbecher",
    categoryId: pfandKategorie.id,
    price: 100,
    taxKey: TAX_RATES.NORMAL.key,
    deposit: { kind: "REUSABLE", refundable: true },
    sortOrder: 1,
  });
  const deckel = product({
    name: "Deckel",
    categoryId: pfandKategorie.id,
    price: 30,
    taxKey: TAX_RATES.NORMAL.key,
    deposit: { kind: "REUSABLE", refundable: true },
    sortOrder: 2,
  });
  const schale = product({
    name: "Mehrwegschale",
    categoryId: pfandKategorie.id,
    price: 200,
    taxKey: TAX_RATES.NORMAL.key,
    deposit: { kind: "REUSABLE", refundable: true },
    sortOrder: 3,
  });
  const einweg = product({
    name: "Einwegpfand",
    categoryId: pfandKategorie.id,
    price: 25,
    taxKey: TAX_RATES.NORMAL.key,
    deposit: { kind: "ONE_WAY", refundable: true },
    sortOrder: 4,
  });
  for (const item of [becher, deckel, schale, einweg]) await saveProduct(db, item);

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
    // Heissgetraenke mit Becher und Deckel.
    product({
      name: "Kaffee", categoryId: getraenke.id, price: 250, taxKey: TAX_RATES.NORMAL.key,
      depositProductIds: [becher.id, deckel.id], sortOrder: 1,
    }),
    product({
      name: "Tee", categoryId: getraenke.id, price: 220, taxKey: TAX_RATES.NORMAL.key,
      depositProductIds: [becher.id, deckel.id], sortOrder: 2,
    }),
    // Flaschenware mit Einwegpfand.
    product({
      name: "Limonade 0,5 l", categoryId: getraenke.id, price: 250, taxKey: TAX_RATES.NORMAL.key,
      depositProductIds: [einweg.id], sortOrder: 3,
    }),
    product({ name: "Wasser 0,5 l", categoryId: getraenke.id, price: 200, taxKey: TAX_RATES.NORMAL.key, depositProductIds: [einweg.id], sortOrder: 4 }),
    // Offener Preis: der Betrag wird am Stand eingegeben.
    product({ name: "Sonstiges (Betrag eingeben)", categoryId: speisen.id, price: null, taxKey: TAX_RATES.NORMAL.key, sortOrder: 90 }),
  ];
  for (const item of goods) await saveProduct(db, item);
}
