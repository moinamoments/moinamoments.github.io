/**
 * Repositories: Datenbankzeilen in Domaenenobjekte und zurueck.
 *
 * Die Umwandlung steht an genau einer Stelle. SQLite kennt kein `boolean`
 * (0/1) und keine verschachtelten Werte (JSON-Spalten) - wuerde jede
 * Bildschirmseite das selbst umrechnen, waere der erste Beleg mit
 * `small_business = 0` als "wahr" nur eine Frage der Zeit.
 */

import {
  type CashCountEntry,
  type Category,
  type Closing,
  type ClosingReport,
  type Device,
  type Id,
  type Order,
  type OrderLine,
  type Payment,
  type PaymentMethod,
  type Product,
  type Store,
  type Tenant,
  type TseTransactionRecord,
  type User,
  type OutboxEntry,
  type OutboxKind,
  type OutboxState,
  type ServiceMode,
  type ProductImage,
  type StockMovement,
  type StockMovementReason,
  type AuditEntry,
  type AuditEvent,
  type CashMovement,
  type CashMovementType,
  type DeliveryChannel,
  type DeliveryRecord,
  type LoginAttemptState,
  type ParkedSale,
  type Cart,
  type PrinterConfig,
  type TerminalConfig,
  type AccountMapping,
  DEFAULT_PRINTER_CONFIG,
  DEFAULT_TERMINAL_CONFIG,
  NO_ATTEMPTS,
  SKR03_PROPOSAL,
} from "@kp/core";
import type { Db, SqlValue } from "./database.ts";

const bool = (value: number | null): boolean => value === 1;
const flag = (value: boolean): number => (value ? 1 : 0);

// --- Mandant, Betriebsstaette, Geraet, Bediener ---------------------------

interface TenantRow {
  id: string; name: string; legal_name: string; street: string; postal_code: string; city: string;
  country_code: string; tax_number: string | null; vat_id: string | null; email: string | null;
  phone: string | null; small_business: number; receipt_footer: string | null; currency: string;
  time_zone: string; created_at: string;
}

export async function getTenant(db: Db): Promise<Tenant | null> {
  const row = await db.first<TenantRow>("SELECT * FROM tenant LIMIT 1");
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    street: row.street,
    postalCode: row.postal_code,
    city: row.city,
    countryCode: row.country_code,
    taxNumber: row.tax_number,
    vatId: row.vat_id,
    email: row.email,
    phone: row.phone,
    smallBusiness: bool(row.small_business),
    receiptFooter: row.receipt_footer,
    currency: "EUR",
    timeZone: row.time_zone,
    createdAt: row.created_at,
  };
}

export async function saveTenant(db: Db, tenant: Tenant): Promise<void> {
  await db.run(
    `INSERT INTO tenant (id, name, legal_name, street, postal_code, city, country_code, tax_number,
        vat_id, email, phone, small_business, receipt_footer, currency, time_zone, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, legal_name = excluded.legal_name, street = excluded.street,
        postal_code = excluded.postal_code, city = excluded.city, country_code = excluded.country_code,
        tax_number = excluded.tax_number, vat_id = excluded.vat_id, email = excluded.email,
        phone = excluded.phone, small_business = excluded.small_business,
        receipt_footer = excluded.receipt_footer, time_zone = excluded.time_zone`,
    [
      tenant.id, tenant.name, tenant.legalName, tenant.street, tenant.postalCode, tenant.city,
      tenant.countryCode, tenant.taxNumber ?? null, tenant.vatId ?? null, tenant.email ?? null,
      tenant.phone ?? null, flag(tenant.smallBusiness), tenant.receiptFooter ?? null, "EUR",
      tenant.timeZone, tenant.createdAt,
    ],
  );
}

// --- Buchhaltung ----------------------------------------------------------

/**
 * Einstellungen fuer den Buchungsstapel.
 *
 * `mapping` ist die Kontenzuordnung, die Zahlen daneben sind die Kopfangaben der
 * DATEV-Datei. Sie sind absichtlich `null`, solange sie nicht eingetragen sind -
 * eine Voreinstellung waere hier gefaehrlich: eine erfundene Mandantennummer
 * bucht in die Buchhaltung eines anderen Betriebs.
 */
export interface AccountingSettings {
  readonly mapping: AccountMapping;
  readonly consultantNumber: number | null;
  readonly clientNumber: number | null;
  readonly fiscalYearStart: string | null;
  readonly initials: string | null;
}

export async function getAccountingSettings(db: Db, tenantId: Id): Promise<AccountingSettings> {
  const row = await db.first<{
    mapping_json: string; consultant_number: number | null; client_number: number | null;
    fiscal_year_start: string | null; initials: string | null;
  }>("SELECT * FROM accounting WHERE tenant_id = ?", [tenantId]);

  if (!row) {
    // Noch nicht eingerichtet: der SKR03-Vorschlag als Ausgangspunkt. Er ist
    // als unbestaetigt gekennzeichnet, und die Oberflaeche sagt das auch.
    return { mapping: SKR03_PROPOSAL, consultantNumber: null, clientNumber: null, fiscalYearStart: null, initials: null };
  }

  let mapping: AccountMapping = SKR03_PROPOSAL;
  try {
    const parsed = JSON.parse(row.mapping_json) as unknown;
    // Nur uebernehmen, was wie eine Zuordnung aussieht. Beschaedigtes JSON
    // ergibt den Vorschlag - und der ist als unbestaetigt gekennzeichnet, also
    // faellt es auf.
    if (parsed && typeof parsed === "object" && "revenue" in parsed && "clearing" in parsed) {
      mapping = { ...SKR03_PROPOSAL, ...(parsed as AccountMapping) };
    }
  } catch {
    mapping = SKR03_PROPOSAL;
  }

  return {
    mapping,
    consultantNumber: row.consultant_number,
    clientNumber: row.client_number,
    fiscalYearStart: row.fiscal_year_start,
    initials: row.initials,
  };
}

export async function saveAccountingSettings(db: Db, tenantId: Id, settings: AccountingSettings): Promise<void> {
  await db.run(
    `INSERT INTO accounting (tenant_id, mapping_json, consultant_number, client_number, fiscal_year_start, initials)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(tenant_id) DO UPDATE SET mapping_json = excluded.mapping_json,
        consultant_number = excluded.consultant_number, client_number = excluded.client_number,
        fiscal_year_start = excluded.fiscal_year_start, initials = excluded.initials`,
    [tenantId, JSON.stringify(settings.mapping), settings.consultantNumber, settings.clientNumber,
      settings.fiscalYearStart, settings.initials],
  );
}

// --- Betriebsstaette ------------------------------------------------------

interface StoreRow {
  id: string; tenant_id: string; name: string; street: string | null; postal_code: string | null;
  city: string | null; active: number;
}

export async function getStore(db: Db): Promise<Store | null> {
  const row = await db.first<StoreRow>("SELECT * FROM store WHERE active = 1 LIMIT 1");
  if (!row) return null;
  return {
    id: row.id, tenantId: row.tenant_id, name: row.name, street: row.street,
    postalCode: row.postal_code, city: row.city, active: bool(row.active),
  };
}

export async function saveStore(db: Db, store: Store): Promise<void> {
  await db.run(
    `INSERT INTO store (id, tenant_id, name, street, postal_code, city, active) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, street = excluded.street,
        postal_code = excluded.postal_code, city = excluded.city, active = excluded.active`,
    [store.id, store.tenantId, store.name, store.street ?? null, store.postalCode ?? null, store.city ?? null, flag(store.active)],
  );
}

interface DeviceRow {
  id: string; tenant_id: string; store_id: string; name: string; serial_number: string;
  tse_client_id: string | null; receipt_prefix: string; printer_json: string | null;
  terminal_json: string | null; is_this_device: number; active: number;
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id, tenantId: row.tenant_id, storeId: row.store_id, name: row.name,
    serialNumber: row.serial_number, tseClientId: row.tse_client_id,
    receiptPrefix: row.receipt_prefix, active: bool(row.active),
  };
}

/**
 * Die Kasse, die dieses Geraet ist.
 *
 * Nicht "die erste aktive": ein Betrieb mit drei Kassen hat drei Zeilen, und
 * jedes Geraet muss seine eigene kennen - sonst ziehen zwei Geraete aus
 * demselben Belegnummernkreis, und die DSFinV-K hat zwei Belege mit derselben
 * Nummer. Das ist genau der Fehler, den `is_this_device` verhindert.
 *
 * Der Rueckfall auf die erste aktive Zeile gilt nur fuer eine Datenbank, in der
 * noch keine Kasse gekennzeichnet ist - dann ist es die einzige.
 */
export async function getDevice(db: Db): Promise<Device | null> {
  const row =
    (await db.first<DeviceRow>("SELECT * FROM device WHERE is_this_device = 1 AND active = 1 LIMIT 1")) ??
    (await db.first<DeviceRow>("SELECT * FROM device WHERE active = 1 ORDER BY rowid LIMIT 1"));
  return row ? toDevice(row) : null;
}

/** Alle Kassen des Betriebs - fuer die Verwaltung. */
export async function listDevices(db: Db, includeInactive = false): Promise<{ device: Device; isThisDevice: boolean }[]> {
  const rows = await db.all<DeviceRow>(
    `SELECT * FROM device ${includeInactive ? "" : "WHERE active = 1"} ORDER BY name`,
  );
  return rows.map((row) => ({ device: toDevice(row), isThisDevice: bool(row.is_this_device) }));
}

export async function saveDevice(db: Db, device: Device, options: { readonly isThisDevice?: boolean } = {}): Promise<void> {
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO device (id, tenant_id, store_id, name, serial_number, tse_client_id, receipt_prefix,
          printer_json, terminal_json, is_this_device, active)
       VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, serial_number = excluded.serial_number,
          tse_client_id = excluded.tse_client_id, receipt_prefix = excluded.receipt_prefix,
          active = excluded.active`,
      [device.id, device.tenantId, device.storeId, device.name, device.serialNumber,
        device.tseClientId ?? null, device.receiptPrefix, flag(options.isThisDevice === true), flag(device.active)],
    );
    if (options.isThisDevice === true) await markThisDevice(db, device.id);
  });
}

/**
 * Diese Kasse kennzeichnen.
 *
 * Genau eine Zeile traegt die Kennzeichnung. Das Zuruecksetzen der anderen
 * gehoert in dieselbe Transaktion - zwei gekennzeichnete Kassen waeren
 * schlimmer als keine.
 */
export async function markThisDevice(db: Db, deviceId: Id): Promise<void> {
  await db.transaction(async () => {
    await db.run("UPDATE device SET is_this_device = 0 WHERE id <> ?", [deviceId]);
    await db.run("UPDATE device SET is_this_device = 1 WHERE id = ?", [deviceId]);
  });
}

/**
 * Drucker- und Terminaleinstellungen einer Kasse.
 *
 * Fehlerhaftes JSON ergibt die Voreinstellung, nicht einen Absturz: eine
 * unlesbare Druckereinstellung darf die Kasse nicht am Verkaufen hindern - der
 * Bon wird dann angezeigt statt gedruckt.
 */
export async function getDeviceConfig(
  db: Db,
  deviceId: Id,
): Promise<{ printer: PrinterConfig; terminal: TerminalConfig }> {
  const row = await db.first<{ printer_json: string | null; terminal_json: string | null }>(
    "SELECT printer_json, terminal_json FROM device WHERE id = ?",
    [deviceId],
  );
  const parse = <T>(json: string | null, fallback: T): T => {
    if (!json) return fallback;
    try {
      const parsed = JSON.parse(json) as unknown;
      if (!parsed || typeof parsed !== "object") return fallback;
      return { ...fallback, ...(parsed as T) };
    } catch {
      return fallback;
    }
  };
  return {
    printer: parse(row?.printer_json ?? null, DEFAULT_PRINTER_CONFIG),
    terminal: parse(row?.terminal_json ?? null, DEFAULT_TERMINAL_CONFIG),
  };
}

export async function savePrinterConfig(db: Db, deviceId: Id, config: PrinterConfig): Promise<void> {
  await db.run("UPDATE device SET printer_json = ? WHERE id = ?", [JSON.stringify(config), deviceId]);
}

export async function saveTerminalConfig(db: Db, deviceId: Id, config: TerminalConfig): Promise<void> {
  await db.run("UPDATE device SET terminal_json = ? WHERE id = ?", [JSON.stringify(config), deviceId]);
}

interface UserRow {
  id: string; tenant_id: string; name: string; role: string; permission_overrides: string;
  pin_hash: string | null; pin_set_at: string | null; active: number;
}

/**
 * Rechteabweichungen aus der JSON-Spalte lesen.
 *
 * Fehlerhaftes JSON darf keinen Bediener aussperren und ihm auch keine Rechte
 * geben, die er nicht hat: im Zweifel gilt die Rolle allein. Das ist die
 * sichere Richtung - eine Abweichung erteilt Rechte oder nimmt sie, und beides
 * darf nicht aus einem Lesefehler entstehen.
 */
function toOverrides(json: string): Record<string, boolean> | null {
  if (!json || json === "{}") return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const result: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean") result[key] = value;
    }
    return Object.keys(result).length === 0 ? null : result;
  } catch {
    return null;
  }
}

function toUser(row: UserRow): User {
  return {
    id: row.id, tenantId: row.tenant_id, name: row.name, role: row.role as User["role"],
    permissionOverrides: toOverrides(row.permission_overrides), pinHash: row.pin_hash,
    active: bool(row.active),
  };
}

/** Alle Bediener - standardmaessig nur die aktiven. */
export async function listUsers(db: Db, includeInactive = false): Promise<User[]> {
  const rows = await db.all<UserRow>(
    `SELECT * FROM app_user ${includeInactive ? "" : "WHERE active = 1"} ORDER BY name`,
  );
  return rows.map(toUser);
}

export async function getUser(db: Db, userId: Id): Promise<User | null> {
  const row = await db.first<UserRow>("SELECT * FROM app_user WHERE id = ?", [userId]);
  return row ? toUser(row) : null;
}

export async function saveUser(db: Db, user: User, options: { readonly pinSetAt?: string } = {}): Promise<void> {
  await db.run(
    `INSERT INTO app_user (id, tenant_id, name, role, permission_overrides, pin_hash, pin_set_at, active)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role,
        permission_overrides = excluded.permission_overrides,
        pin_hash = excluded.pin_hash, active = excluded.active,
        -- Der Zeitpunkt der PIN-Vergabe wird nur beim Setzen einer PIN
        -- ueberschrieben. Ein Formular, das nur den Namen aendert, darf ihn
        -- nicht auf "heute" ziehen.
        pin_set_at = CASE WHEN excluded.pin_set_at IS NULL THEN app_user.pin_set_at ELSE excluded.pin_set_at END`,
    [user.id, user.tenantId, user.name, user.role,
      JSON.stringify(user.permissionOverrides ?? {}), user.pinHash ?? null,
      options.pinSetAt ?? null, flag(user.active)],
  );
}

// --- Anmeldeversuche ------------------------------------------------------

/**
 * Fehlversuche eines Bedieners an diesem Geraet.
 *
 * Kein Datensatz bedeutet: noch kein Fehlversuch. Das ist der Normalfall und
 * darf deshalb keinen Fehler ergeben.
 */
export async function getLoginAttempts(db: Db, userId: Id, deviceId: Id): Promise<LoginAttemptState> {
  const row = await db.first<{ failed_attempts: number; lock_count: number; locked_until: string | null }>(
    "SELECT failed_attempts, lock_count, locked_until FROM login_attempt WHERE user_id = ? AND device_id = ?",
    [userId, deviceId],
  );
  if (!row) return NO_ATTEMPTS;
  return { failedAttempts: row.failed_attempts, lockCount: row.lock_count, lockedUntil: row.locked_until };
}

export async function saveLoginAttempts(
  db: Db,
  userId: Id,
  deviceId: Id,
  state: LoginAttemptState,
  now: string,
): Promise<void> {
  await db.run(
    `INSERT INTO login_attempt (user_id, device_id, failed_attempts, lock_count, locked_until, last_attempt_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id, device_id) DO UPDATE SET failed_attempts = excluded.failed_attempts,
        lock_count = excluded.lock_count, locked_until = excluded.locked_until,
        last_attempt_at = excluded.last_attempt_at`,
    [userId, deviceId, state.failedAttempts, state.lockCount, state.lockedUntil ?? null, now],
  );
}

// --- Pruefprotokoll -------------------------------------------------------

/**
 * Protokolleintrag schreiben.
 *
 * Der Eintrag wird mit `buildAuditEntry` gebildet - dort wird geprueft, dass
 * kein Geheimnis darin steht. Diese Funktion nimmt nur den fertigen Eintrag,
 * damit die Pruefung nicht umgangen werden kann.
 */
export async function appendAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.run(
    `INSERT INTO audit_log (id, tenant_id, device_id, user_id, user_name, event, subject, detail, amount, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [entry.id, entry.tenantId, entry.deviceId, entry.userId, entry.userName, entry.event,
      entry.subject, entry.detail, entry.amount, entry.createdAt],
  );
}

interface AuditRow {
  id: string; tenant_id: string; device_id: string; user_id: string | null; user_name: string | null;
  event: string; subject: string | null; detail: string | null; amount: number | null; created_at: string;
}

/**
 * Protokoll lesen, neueste zuerst.
 *
 * Sortiert nach `rowid` und nicht nach dem Zeitstempel - derselbe Grund wie
 * bei den Bestandsbewegungen: Zeitstempel mit Offset sortieren als Text nicht
 * chronologisch.
 */
export async function listAudit(
  db: Db,
  options: { readonly events?: readonly AuditEvent[]; readonly limit?: number } = {},
): Promise<AuditEntry[]> {
  const limit = options.limit ?? 200;
  const events = options.events ?? [];
  const rows = events.length > 0
    ? await db.all<AuditRow>(
        `SELECT * FROM audit_log WHERE event IN (${events.map(() => "?").join(",")})
         ORDER BY rowid DESC LIMIT ?`,
        [...events, limit],
      )
    : await db.all<AuditRow>("SELECT * FROM audit_log ORDER BY rowid DESC LIMIT ?", [limit]);

  return rows.map((row) => ({
    id: row.id, tenantId: row.tenant_id, deviceId: row.device_id, userId: row.user_id,
    userName: row.user_name, event: row.event as AuditEvent, subject: row.subject,
    detail: row.detail, amount: row.amount, createdAt: row.created_at,
  }));
}

// --- Geparkte Vorgaenge ---------------------------------------------------

interface ParkedRow {
  id: string; tenant_id: string; store_id: string; device_id: string; user_id: string;
  label: string; cart_json: string; started_at: string; parked_at: string;
  tse_transaction_number: number | null; tse_failure: string | null; total: number; line_count: number;
}

export async function listParkedSales(db: Db, deviceId: Id): Promise<ParkedSale[]> {
  const rows = await db.all<ParkedRow>(
    "SELECT * FROM parked_sale WHERE device_id = ? ORDER BY rowid",
    [deviceId],
  );
  return rows.map((row) => ({
    id: row.id, tenantId: row.tenant_id, storeId: row.store_id, deviceId: row.device_id,
    userId: row.user_id, label: row.label, cart: JSON.parse(row.cart_json) as Cart,
    startedAt: row.started_at, parkedAt: row.parked_at,
    tseTransactionNumber: row.tse_transaction_number, tseFailure: row.tse_failure,
    total: row.total, lineCount: row.line_count,
  }));
}

export async function saveParkedSale(db: Db, sale: ParkedSale): Promise<void> {
  await db.run(
    `INSERT INTO parked_sale (id, tenant_id, store_id, device_id, user_id, label, cart_json,
        started_at, parked_at, tse_transaction_number, tse_failure, total, line_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, cart_json = excluded.cart_json,
        parked_at = excluded.parked_at, total = excluded.total, line_count = excluded.line_count,
        tse_failure = excluded.tse_failure`,
    [sale.id, sale.tenantId, sale.storeId, sale.deviceId, sale.userId, sale.label,
      JSON.stringify(sale.cart), sale.startedAt, sale.parkedAt, sale.tseTransactionNumber,
      sale.tseFailure, sale.total, sale.lineCount],
  );
}

/**
 * Geparkten Vorgang entfernen.
 *
 * Anders als ein Beleg darf ein geparkter Vorgang geloescht werden: er ist
 * noch kein Geschaeftsvorfall, sondern eine Erfassung. Beim Fortsetzen
 * verschwindet er aus der Liste und wird zum Beleg; beim Verwerfen bleibt die
 * begonnene TSE-Transaktion offen und dort protokolliert - genau so ist es
 * vorgesehen.
 */
export async function deleteParkedSale(db: Db, id: Id): Promise<void> {
  await db.run("DELETE FROM parked_sale WHERE id = ?", [id]);
}

// --- Kassenbuch -----------------------------------------------------------

interface CashRow {
  id: string; tenant_id: string; store_id: string; device_id: string; type: string;
  amount: number; reason: string; cash_count_json: string; user_id: string;
  closing_id: string | null; created_at: string;
}

function toCashMovement(row: CashRow): CashMovement {
  const counted = JSON.parse(row.cash_count_json) as CashCountEntry[];
  return {
    id: row.id, tenantId: row.tenant_id, storeId: row.store_id, deviceId: row.device_id,
    type: row.type as CashMovementType, amount: row.amount, reason: row.reason,
    ...(counted.length > 0 ? { cashCount: counted } : {}),
    userId: row.user_id, createdAt: row.created_at,
  };
}

export async function appendCashMovement(db: Db, movement: CashMovement): Promise<void> {
  await db.run(
    `INSERT INTO cash_movement (id, tenant_id, store_id, device_id, type, amount, reason,
        cash_count_json, user_id, closing_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,NULL,?)`,
    [movement.id, movement.tenantId, movement.storeId, movement.deviceId, movement.type,
      movement.amount, movement.reason, JSON.stringify(movement.cashCount ?? []),
      movement.userId, movement.createdAt],
  );
}

/** Bewegungen, die noch zu keinem Abschluss gehoeren - die laufende Schicht. */
export async function listOpenCashMovements(db: Db, deviceId: Id): Promise<CashMovement[]> {
  const rows = await db.all<CashRow>(
    "SELECT * FROM cash_movement WHERE device_id = ? AND closing_id IS NULL ORDER BY rowid",
    [deviceId],
  );
  return rows.map(toCashMovement);
}

export async function listCashMovements(db: Db, deviceId: Id, limit = 200): Promise<CashMovement[]> {
  const rows = await db.all<CashRow>(
    "SELECT * FROM cash_movement WHERE device_id = ? ORDER BY rowid DESC LIMIT ?",
    [deviceId, limit],
  );
  return rows.map(toCashMovement);
}

// --- Belegausgabe ---------------------------------------------------------

export async function appendDelivery(
  db: Db,
  id: Id,
  tenantId: Id,
  record: DeliveryRecord,
): Promise<void> {
  await db.run(
    `INSERT INTO receipt_delivery (id, tenant_id, order_id, channel, recipient, sent_at, via, ok, error)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, record.orderId, record.channel, record.recipient, record.sentAt,
      record.via, flag(record.ok), record.error ?? null],
  );
}

export async function listDeliveries(db: Db, orderId: Id): Promise<DeliveryRecord[]> {
  const rows = await db.all<{
    order_id: string; channel: string; recipient: string; sent_at: string; via: string;
    ok: number; error: string | null;
  }>("SELECT * FROM receipt_delivery WHERE order_id = ? ORDER BY rowid", [orderId]);
  return rows.map((row) => ({
    orderId: row.order_id, channel: row.channel as DeliveryChannel, recipient: row.recipient,
    sentAt: row.sent_at, via: row.via as DeliveryRecord["via"], ok: bool(row.ok), error: row.error,
  }));
}

// --- Artikelstamm --------------------------------------------------------

interface CategoryRow {
  id: string; tenant_id: string; parent_id: string | null; name: string; color: string | null;
  sort_order: number; active: number;
}

export async function listCategories(db: Db): Promise<Category[]> {
  const rows = await db.all<CategoryRow>("SELECT * FROM category WHERE active = 1 ORDER BY sort_order, name");
  return rows.map((row) => ({
    id: row.id, tenantId: row.tenant_id, parentId: row.parent_id, name: row.name, color: row.color,
    sortOrder: row.sort_order, active: bool(row.active),
  }));
}

export async function saveCategory(db: Db, category: Category): Promise<void> {
  await db.run(
    `INSERT INTO category (id, tenant_id, parent_id, name, color, sort_order, active) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name,
        color = excluded.color, sort_order = excluded.sort_order, active = excluded.active`,
    [category.id, category.tenantId, category.parentId ?? null, category.name, category.color ?? null,
      category.sortOrder, flag(category.active)],
  );
}

/**
 * Warengruppe ausblenden.
 *
 * Untergruppen wandern eine Ebene nach oben, statt mit zu verschwinden - sonst
 * waeren ihre Artikel am Kassenbildschirm nicht mehr erreichbar. Artikel der
 * Gruppe selbst bleiben, wo sie sind; sie muessen umsortiert werden.
 */
export async function deactivateCategory(db: Db, categoryId: Id): Promise<void> {
  await db.transaction(async () => {
    const row = await db.first<{ parent_id: string | null }>("SELECT parent_id FROM category WHERE id = ?", [categoryId]);
    await db.run("UPDATE category SET parent_id = ? WHERE parent_id = ?", [row?.parent_id ?? null, categoryId]);
    await db.run("UPDATE category SET active = 0 WHERE id = ?", [categoryId]);
  });
}

/** Artikel einer Warengruppe, fuer die Pruefung vor dem Ausblenden. */
export async function countProductsInCategory(db: Db, categoryId: Id): Promise<number> {
  const row = await db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM product WHERE category_id = ? AND active = 1",
    [categoryId],
  );
  return row?.n ?? 0;
}

interface ProductRow {
  id: string; tenant_id: string; category_id: string; name: string; description: string | null;
  price: number | null; tax_key: number; tax_key_dine_in: number | null; sku: string | null;
  unit: string; is_deposit: number; color: string | null;
  image_url: string | null; image_license: string | null; image_license_url: string | null;
  image_creator: string | null; image_source_url: string | null; image_provider: string | null;
  track_stock: number; stock: number; low_stock_threshold: number | null;
  sort_order: number; active: number; updated_at: string;
}

/** Bildspalten in ein `ProductImage` - oder `null`, wenn kein Bild da ist. */
function toImage(row: ProductRow): ProductImage | null {
  // Die Lizenz ist Pflicht; der CHECK im Schema stellt sicher, dass es keine
  // Zeile mit Bild ohne Lizenz gibt. Die Pruefung hier faengt den Fall ab,
  // falls eine aeltere Datenbank doch eine hat.
  if (!row.image_url || !row.image_license) return null;
  return {
    url: row.image_url,
    license: row.image_license,
    licenseUrl: row.image_license_url,
    creator: row.image_creator,
    sourceUrl: row.image_source_url,
    provider: row.image_provider,
  };
}

/**
 * Alle Artikel mit ihren Pfandzuordnungen.
 *
 * Ein Aufruf, zwei Abfragen - nicht eine Abfrage je Artikel. Bei 300 Artikeln
 * waere das sonst der Grund, warum der Kassenbildschirm beim Start haengt.
 */
export async function listProducts(db: Db, includeInactive = false): Promise<Product[]> {
  const rows = await db.all<ProductRow>(
    `SELECT * FROM product ${includeInactive ? "" : "WHERE active = 1"} ORDER BY sort_order, name`,
  );
  const links = await db.all<{ product_id: string; deposit_product_id: string }>(
    "SELECT product_id, deposit_product_id FROM product_deposit ORDER BY sort_order",
  );
  const byProduct = new Map<string, string[]>();
  for (const link of links) {
    const list = byProduct.get(link.product_id);
    if (list) list.push(link.deposit_product_id);
    else byProduct.set(link.product_id, [link.deposit_product_id]);
  }

  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    categoryId: row.category_id,
    name: row.name,
    description: row.description,
    price: row.price,
    taxKey: row.tax_key,
    taxKeyDineIn: row.tax_key_dine_in,
    sku: row.sku,
    unit: row.unit as Product["unit"],
    depositProductIds: byProduct.get(row.id) ?? null,
    isDeposit: bool(row.is_deposit),
    color: row.color,
    image: toImage(row),
    trackStock: bool(row.track_stock),
    stock: row.stock,
    lowStockThreshold: row.low_stock_threshold,
    sortOrder: row.sort_order,
    active: bool(row.active),
    updatedAt: row.updated_at,
  }));
}

export async function saveProduct(db: Db, product: Product): Promise<void> {
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO product (id, tenant_id, category_id, name, description, price, tax_key, tax_key_dine_in,
          sku, unit, is_deposit, color, image_url, image_license, image_license_url, image_creator,
          image_source_url, image_provider, track_stock, stock, low_stock_threshold,
          sort_order, active, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET category_id = excluded.category_id, name = excluded.name,
          description = excluded.description, price = excluded.price, tax_key = excluded.tax_key,
          tax_key_dine_in = excluded.tax_key_dine_in, sku = excluded.sku, unit = excluded.unit,
          is_deposit = excluded.is_deposit, color = excluded.color,
          image_url = excluded.image_url, image_license = excluded.image_license,
          image_license_url = excluded.image_license_url, image_creator = excluded.image_creator,
          image_source_url = excluded.image_source_url, image_provider = excluded.image_provider,
          track_stock = excluded.track_stock, low_stock_threshold = excluded.low_stock_threshold,
          sort_order = excluded.sort_order, active = excluded.active,
          updated_at = excluded.updated_at`,
      // Der Bestand wird hier bewusst **nicht** mitgeschrieben: er aendert
      // sich nur ueber Bestandsbewegungen. Ein Artikelformular, das den
      // Bestand mit ueberschreibt, wuerde jede Bewegung wieder zunichte
      // machen - und genau das ist der Fehler, den das Journal verhindern
      // soll. Beim Anlegen ist der Startbestand 0, danach zaehlt nur
      // applyStockMovement.
      [
        product.id, product.tenantId, product.categoryId, product.name, product.description ?? null,
        product.price, product.taxKey, product.taxKeyDineIn ?? null, product.sku ?? null, product.unit,
        flag(product.isDeposit === true), product.color ?? null,
        product.image?.url ?? null, product.image?.license ?? null, product.image?.licenseUrl ?? null,
        product.image?.creator ?? null, product.image?.sourceUrl ?? null, product.image?.provider ?? null,
        flag(product.trackStock === true), product.stock ?? 0, product.lowStockThreshold ?? null,
        product.sortOrder, flag(product.active), product.updatedAt,
      ],
    );
    await db.run("DELETE FROM product_deposit WHERE product_id = ?", [product.id]);
    const ids = product.depositProductIds ?? [];
    for (let index = 0; index < ids.length; index++) {
      await db.run(
        "INSERT INTO product_deposit (product_id, deposit_product_id, sort_order) VALUES (?,?,?)",
        [product.id, ids[index] as string, index],
      );
    }
  });
}

/**
 * Artikel ausblenden statt loeschen.
 *
 * Ein geloeschter Artikel wuerde alte Belege unlesbar machen - sie verweisen
 * auf seine Id. Deshalb gibt es kein DELETE auf Artikeln, nur `active = 0`.
 */
export async function deactivateProduct(db: Db, productId: Id): Promise<void> {
  await db.run("UPDATE product SET active = 0 WHERE id = ?", [productId]);
}

// --- Nummernkreise -------------------------------------------------------

/**
 * Naechste Nummer eines Kreises.
 *
 * Erhoeht und liest in einem Schritt, damit zwei gleichzeitige Verkaeufe
 * (Bediener tippt schnell, Beleg speichert noch) nicht dieselbe Nummer
 * bekommen.
 */
export async function nextSequence(db: Db, deviceId: Id, name: "receipt" | "closing"): Promise<number> {
  return db.transaction(async () => {
    await db.run(
      `INSERT INTO sequence (device_id, name, value) VALUES (?,?,1)
       ON CONFLICT(device_id, name) DO UPDATE SET value = value + 1`,
      [deviceId, name],
    );
    const row = await db.first<{ value: number }>(
      "SELECT value FROM sequence WHERE device_id = ? AND name = ?",
      [deviceId, name],
    );
    return row?.value ?? 1;
  });
}

/** Aktueller Stand eines Kreises, ohne ihn zu erhoehen. */
export async function peekSequence(db: Db, deviceId: Id, name: "receipt" | "closing"): Promise<number> {
  const row = await db.first<{ value: number }>(
    "SELECT value FROM sequence WHERE device_id = ? AND name = ?",
    [deviceId, name],
  );
  return row?.value ?? 0;
}

// --- Belege --------------------------------------------------------------

export async function saveOrder(db: Db, order: Order): Promise<void> {
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO sales_order (id, tenant_id, store_id, device_id, user_id, receipt_number, state,
          service_mode, total, order_discount, started_at, paid_at, voids_order_id, closing_id,
          customer_name, note, tse_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        order.id, order.tenantId, order.storeId, order.deviceId, order.userId, order.receiptNumber,
        order.state, order.serviceMode, order.total, order.orderDiscount, order.startedAt,
        order.paidAt ?? null, order.voidsOrderId ?? null, order.closingId ?? null,
        order.customerName ?? null, order.note ?? null,
        order.tse ? JSON.stringify(order.tse) : null,
      ],
    );
    for (const line of order.lines) {
      await db.run(
        `INSERT INTO order_line (id, order_id, position, product_id, name, quantity, unit_price, gross,
            tax_key, business_case_type, discount, allocated_discount, deposit_for_line_id, modifiers_json, note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          line.id, order.id, line.position, line.productId, line.name, line.quantity, line.unitPrice,
          line.gross, line.taxKey, line.businessCaseType, line.discount, line.allocatedDiscount,
          line.depositForLineId ?? null, JSON.stringify(line.modifiers), line.note ?? null,
        ],
      );
    }
    for (const payment of order.payments) {
      await db.run(
        `INSERT INTO order_payment (id, order_id, method, amount, tendered, change, label, reference, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [payment.id, order.id, payment.method, payment.amount, payment.tendered, payment.change,
          payment.label, payment.reference ?? null, payment.createdAt],
      );
    }
    if (order.tse?.failureReason) {
      await db.run(
        "INSERT INTO tse_incident (id, tenant_id, device_id, order_id, occurred_at, reason) VALUES (?,?,?,?,?,?)",
        [`${order.id}-tse`, order.tenantId, order.deviceId, order.id,
          order.paidAt ?? order.startedAt, order.tse.failureReason],
      );
    }
  });
}

interface OrderRow {
  id: string; tenant_id: string; store_id: string; device_id: string; user_id: string;
  receipt_number: string; state: string; service_mode: string; total: number; order_discount: number;
  started_at: string; paid_at: string | null; voids_order_id: string | null; closing_id: string | null;
  customer_name: string | null; note: string | null; tse_json: string | null;
}

async function hydrateOrders(db: Db, rows: readonly OrderRow[]): Promise<Order[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const placeholders = ids.map(() => "?").join(",");
  const lineRows = await db.all<{
    id: string; order_id: string; position: number; product_id: string | null; name: string;
    quantity: number; unit_price: number; gross: number; tax_key: number; business_case_type: string;
    discount: number; allocated_discount: number; deposit_for_line_id: string | null;
    modifiers_json: string; note: string | null;
  }>(`SELECT * FROM order_line WHERE order_id IN (${placeholders}) ORDER BY order_id, position`, ids);
  const paymentRows = await db.all<{
    id: string; order_id: string; method: string; amount: number; tendered: number; change: number;
    label: string; reference: string | null; created_at: string;
  }>(`SELECT * FROM order_payment WHERE order_id IN (${placeholders}) ORDER BY order_id, created_at`, ids);

  const linesByOrder = new Map<string, OrderLine[]>();
  for (const row of lineRows) {
    const line: OrderLine = {
      id: row.id, position: row.position, productId: row.product_id, name: row.name,
      quantity: row.quantity, unitPrice: row.unit_price, gross: row.gross, taxKey: row.tax_key,
      businessCaseType: row.business_case_type as OrderLine["businessCaseType"],
      modifiers: JSON.parse(row.modifiers_json) as OrderLine["modifiers"],
      discount: row.discount, allocatedDiscount: row.allocated_discount,
      depositForLineId: row.deposit_for_line_id, note: row.note,
    };
    const list = linesByOrder.get(row.order_id);
    if (list) list.push(line);
    else linesByOrder.set(row.order_id, [line]);
  }

  const paymentsByOrder = new Map<string, Payment[]>();
  for (const row of paymentRows) {
    const payment: Payment = {
      id: row.id, method: row.method as PaymentMethod, amount: row.amount, tendered: row.tendered,
      change: row.change, label: row.label, reference: row.reference, createdAt: row.created_at,
    };
    const list = paymentsByOrder.get(row.order_id);
    if (list) list.push(payment);
    else paymentsByOrder.set(row.order_id, [payment]);
  }

  return rows.map((row) => ({
    id: row.id, tenantId: row.tenant_id, storeId: row.store_id, deviceId: row.device_id,
    userId: row.user_id, receiptNumber: row.receipt_number, state: row.state as Order["state"],
    serviceMode: row.service_mode as ServiceMode, lines: linesByOrder.get(row.id) ?? [],
    payments: paymentsByOrder.get(row.id) ?? [], total: row.total, orderDiscount: row.order_discount,
    startedAt: row.started_at, paidAt: row.paid_at, voidsOrderId: row.voids_order_id,
    closingId: row.closing_id, customerName: row.customer_name, note: row.note,
    tse: row.tse_json ? (JSON.parse(row.tse_json) as TseTransactionRecord) : null,
  }));
}

export async function getOrder(db: Db, orderId: Id): Promise<Order | null> {
  const row = await db.first<OrderRow>("SELECT * FROM sales_order WHERE id = ?", [orderId]);
  if (!row) return null;
  return (await hydrateOrders(db, [row]))[0] ?? null;
}

/** Belege, die noch zu keinem Kassenabschluss gehoeren. */
export async function listOpenForClosing(db: Db, deviceId: Id): Promise<Order[]> {
  const rows = await db.all<OrderRow>(
    "SELECT * FROM sales_order WHERE device_id = ? AND state = 'PAID' AND closing_id IS NULL ORDER BY receipt_number",
    [deviceId],
  );
  return hydrateOrders(db, rows);
}

/** Die letzten Belege, fuer die Belegliste und den Nachdruck. */
export async function listRecentOrders(db: Db, deviceId: Id, limit = 50): Promise<Order[]> {
  const rows = await db.all<OrderRow>(
    "SELECT * FROM sales_order WHERE device_id = ? ORDER BY receipt_number DESC LIMIT ?",
    [deviceId, limit],
  );
  return hydrateOrders(db, rows);
}

// --- Kassenabschluss -----------------------------------------------------

export async function saveClosing(
  db: Db,
  closing: Closing,
  reportJson: string,
): Promise<void> {
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO closing (id, tenant_id, store_id, device_id, number, from_at, to_at, created_at,
          user_id, opening_cash, cash_count_json, report_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [closing.id, closing.tenantId, closing.storeId, closing.deviceId, closing.number, closing.from,
        closing.to, closing.createdAt, closing.userId, closing.openingCash,
        JSON.stringify(closing.cashCount), reportJson],
    );
    // Die Belege dem Abschluss zuordnen. Die Zuordnung ist die einzige
    // Aenderung, die ein bezahlter Beleg noch erfaehrt - der Trigger im
    // Schema laesst genau das zu und sonst nichts.
    for (const orderId of closing.orderIds) {
      await db.run("UPDATE sales_order SET closing_id = ? WHERE id = ?", [closing.id, orderId]);
    }
    // Dasselbe fuer die Bargeldbewegungen der Schicht: sie gehoeren in die
    // Zaehlung dieses Abschlusses und duerfen im naechsten nicht wieder
    // auftauchen.
    await db.run(
      "UPDATE cash_movement SET closing_id = ? WHERE device_id = ? AND closing_id IS NULL",
      [closing.id, closing.deviceId],
    );
  });
}

export async function listClosings(db: Db, deviceId: Id, limit = 30): Promise<{ closing: Closing; reportJson: string }[]> {
  const rows = await db.all<{
    id: string; tenant_id: string; store_id: string; device_id: string; number: number;
    from_at: string; to_at: string; created_at: string; user_id: string; opening_cash: number;
    cash_count_json: string; report_json: string;
  }>("SELECT * FROM closing WHERE device_id = ? ORDER BY number DESC LIMIT ?", [deviceId, limit]);

  return rows.map((row) => ({
    closing: {
      id: row.id, tenantId: row.tenant_id, storeId: row.store_id, deviceId: row.device_id,
      number: row.number, from: row.from_at, to: row.to_at, createdAt: row.created_at,
      userId: row.user_id, openingCash: row.opening_cash,
      cashCount: JSON.parse(row.cash_count_json) as CashCountEntry[],
      orderIds: [],
    },
    reportJson: row.report_json,
  }));
}

/**
 * Abschluesse eines Zeitraums mit ihren Belegen - fuer den Buchungsstapel.
 *
 * Der gespeicherte Bericht wird gelesen statt neu gerechnet: er ist der Stand,
 * mit dem der Abschluss erstellt wurde, und genau der gehoert in die
 * Buchhaltung. Ihn neu zu rechnen koennte eine andere Zahl ergeben, sobald sich
 * eine Berechnung im Kern aendert - und dann stimmte der Stapel nicht mehr mit
 * dem Z-Bericht ueberein, den der Betrieb ausgedruckt hat.
 *
 * Der Zeitraum vergleicht `created_at` als Text. Das ist hier zulaessig, weil
 * verglichen wird, nicht sortiert: `>= "2026-09-01"` trifft jeden Zeitstempel
 * dieses Tages unabhaengig vom Offset.
 */
export async function listClosingsForPeriod(
  db: Db,
  deviceId: Id,
  from: string,
  to: string,
): Promise<{ report: ClosingReport; orders: Order[] }[]> {
  const rows = await db.all<{ id: string; report_json: string }>(
    `SELECT id, report_json FROM closing
     WHERE device_id = ? AND created_at >= ? AND created_at <= ?
     ORDER BY number`,
    [deviceId, from, `${to}T23:59:59+14:00`],
  );

  const result: { report: ClosingReport; orders: Order[] }[] = [];
  for (const row of rows) {
    let report: ClosingReport;
    try {
      report = JSON.parse(row.report_json) as ClosingReport;
    } catch {
      // Ein unlesbarer Bericht darf den ganzen Export nicht verhindern - die
      // uebrigen Abschluesse sind brauchbar. Er faellt auf, weil die Zahl der
      // Abschluesse dann nicht stimmt.
      continue;
    }
    const orderRows = await db.all<OrderRow>(
      "SELECT * FROM sales_order WHERE closing_id = ? ORDER BY receipt_number",
      [row.id],
    );
    result.push({ report, orders: await hydrateOrders(db, orderRows) });
  }
  return result;
}

/** Bargeldbestand zum Start: Endbestand des letzten Abschlusses. */
export async function lastCountedCash(db: Db, deviceId: Id): Promise<number> {
  const row = await db.first<{ cash_count_json: string; opening_cash: number; report_json: string }>(
    "SELECT cash_count_json, opening_cash, report_json FROM closing WHERE device_id = ? ORDER BY number DESC LIMIT 1",
    [deviceId],
  );
  if (!row) return 0;
  const counted = JSON.parse(row.cash_count_json) as CashCountEntry[];
  if (counted.length === 0) return 0;
  return counted.reduce((sum, entry) => sum + entry.denomination * entry.count, 0);
}

// --- Outbox --------------------------------------------------------------

export async function loadOutbox(db: Db): Promise<OutboxState> {
  const rows = await db.all<{
    key: string; kind: string; entity_id: string; tenant_id: string; payload: string;
    created_at: string; attempts: number; next_attempt_at: string; last_error: string | null;
    // Einfuegereihenfolge, nicht Zeitstempeltext - siehe listStockMovements.
  }>("SELECT * FROM outbox ORDER BY rowid");
  return {
    entries: rows.map((row) => ({
      key: row.key, kind: row.kind as OutboxKind, entityId: row.entity_id, tenantId: row.tenant_id,
      payload: row.payload, createdAt: row.created_at, attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at, lastError: row.last_error,
    })),
  };
}

export async function persistOutbox(db: Db, state: OutboxState): Promise<void> {
  await db.transaction(async () => {
    await db.run("DELETE FROM outbox");
    for (const entry of state.entries) {
      await db.run(
        `INSERT INTO outbox (key, kind, entity_id, tenant_id, payload, created_at, attempts, next_attempt_at, last_error)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [entry.key, entry.kind, entry.entityId, entry.tenantId, entry.payload, entry.createdAt,
          entry.attempts, entry.nextAttemptAt, entry.lastError],
      );
    }
  });
}

export async function upsertOutboxEntry(db: Db, entry: OutboxEntry): Promise<void> {
  await db.run(
    `INSERT INTO outbox (key, kind, entity_id, tenant_id, payload, created_at, attempts, next_attempt_at, last_error)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, attempts = 0,
        next_attempt_at = excluded.next_attempt_at, last_error = NULL`,
    [entry.key, entry.kind, entry.entityId, entry.tenantId, entry.payload, entry.createdAt,
      entry.attempts, entry.nextAttemptAt, entry.lastError],
  );
}

export async function countOutbox(db: Db): Promise<number> {
  const row = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM outbox");
  return row?.n ?? 0;
}

// --- Bestand -------------------------------------------------------------

/**
 * Bewegung buchen und den Bestand am Artikel fortschreiben.
 *
 * Beides in einer Transaktion: eine Bewegung ohne fortgeschriebenen Bestand
 * (oder umgekehrt) waere eine Zahl, die nicht mehr zu ihrem Journal passt -
 * und dann ist beides wertlos.
 */
export async function applyStockMovement(db: Db, movement: StockMovement): Promise<void> {
  await db.transaction(async () => {
    await db.run(
      `INSERT INTO stock_movement (id, tenant_id, store_id, product_id, quantity, resulting_stock,
          reason, order_id, user_id, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [movement.id, movement.tenantId, movement.storeId, movement.productId, movement.quantity,
        movement.resultingStock, movement.reason, movement.orderId ?? null, movement.userId,
        movement.note ?? null, movement.createdAt],
    );
    // Der Bestand wird aus der Bewegung fortgeschrieben, nicht gesetzt: zwei
    // gleichzeitige Bewegungen duerfen sich nicht gegenseitig ueberschreiben.
    await db.run("UPDATE product SET stock = stock + ? WHERE id = ?", [movement.quantity, movement.productId]);
  });
}

/**
 * Bewegungen eines Artikels oder aller Artikel, neueste zuerst.
 *
 * Sortiert wird nach der Einfuegereihenfolge (`rowid`), nicht nach dem
 * Zeitstempel. Der Grund: unsere Zeitstempel tragen den Offset der Ortszeit,
 * und als Zeichenkette sortieren die nicht chronologisch -
 * `09:00:00+02:00` liegt real *vor* `09:00:00+00:00`, als Text aber dahinter.
 * Ueber die Sommerzeitumstellung hinweg wuerde ein Journal damit in falscher
 * Reihenfolge stehen, und ein Journal in falscher Reihenfolge erklaert nichts
 * mehr.
 */
export async function listStockMovements(
  db: Db,
  options: { readonly productId?: Id; readonly limit?: number } = {},
): Promise<StockMovement[]> {
  const limit = options.limit ?? 100;
  const rows = options.productId
    ? await db.all<StockMovementRow>(
        "SELECT * FROM stock_movement WHERE product_id = ? ORDER BY rowid DESC LIMIT ?",
        [options.productId, limit],
      )
    : await db.all<StockMovementRow>(
        "SELECT * FROM stock_movement ORDER BY rowid DESC LIMIT ?",
        [limit],
      );

  return rows.map((row) => ({
    id: row.id, tenantId: row.tenant_id, storeId: row.store_id, productId: row.product_id,
    quantity: row.quantity, resultingStock: row.resulting_stock,
    reason: row.reason as StockMovementReason, orderId: row.order_id, userId: row.user_id,
    note: row.note, createdAt: row.created_at,
  }));
}

interface StockMovementRow {
  id: string; tenant_id: string; store_id: string; product_id: string; quantity: number;
  resulting_stock: number; reason: string; order_id: string | null; user_id: string;
  note: string | null; created_at: string;
}

/** TSE-Ausfaelle, fuer die Ausfalldokumentation und die Anzeige im Status. */
export async function listTseIncidents(db: Db, limit = 100): Promise<{ occurredAt: string; reason: string; orderId: string | null }[]> {
  const rows = await db.all<{ occurred_at: string; reason: string; order_id: string | null }>(
    "SELECT occurred_at, reason, order_id FROM tse_incident ORDER BY rowid DESC LIMIT ?",
    [limit],
  );
  return rows.map((row) => ({ occurredAt: row.occurred_at, reason: row.reason, orderId: row.order_id }));
}

export type { SqlValue };
