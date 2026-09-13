/**
 * Pruefprotokoll fuer sicherheitsrelevante Vorgaenge.
 *
 * Getrennt von der Aufzeichnung der Geschaeftsvorfaelle: die Belege sagen, was
 * verkauft wurde. Dieses Protokoll sagt, **wer was am System getan hat** -
 * angemeldet, storniert, Geld entnommen, Rechte vergeben, Daten ausgegeben.
 *
 * Warum das eigenstaendig sein muss: wenn am Monatsende Geld fehlt, ist die
 * erste Frage nicht "welche Belege gibt es", sondern "wer war angemeldet und
 * was hat er gemacht". Ohne dieses Protokoll ist die Antwort nicht zu
 * beschaffen, und der Verdacht bleibt an allen haengen.
 *
 * Zwei Regeln, die es brauchbar halten:
 *
 *   1. **Nur anfuegen.** Ein Protokoll, das sich aendern laesst, beweist
 *      nichts. Die Datenbank verhindert Aenderung und Loeschung per Trigger.
 *   2. **Keine Geheimnisse darin.** Kein PIN, kein Token, keine vollstaendige
 *      Kundenadresse. Ein Protokoll wird exportiert, weitergegeben und
 *      aufbewahrt - was darin steht, verlaesst irgendwann das Geraet.
 */

import type { Id, Timestamp } from "../model.ts";
import type { Capability } from "../permissions.ts";

export type AuditEvent =
  /** Anmeldung am Geraet gelungen. */
  | "LOGIN_OK"
  /** Anmeldung fehlgeschlagen - falsche PIN. */
  | "LOGIN_FAILED"
  /** Zugang nach Fehlversuchen gesperrt. */
  | "LOGIN_LOCKED"
  /** Abmeldung oder Bedienerwechsel. */
  | "LOGOUT"
  /** Geraet nach Inaktivitaet gesperrt. */
  | "DEVICE_LOCKED"
  /** Ein Recht wurde erteilt oder entzogen. */
  | "PERMISSION_CHANGED"
  /** Rolle eines Bedieners geaendert. */
  | "ROLE_CHANGED"
  /** Bediener angelegt, deaktiviert oder PIN gesetzt. */
  | "USER_CHANGED"
  /** Beleg ganz oder teilweise storniert. */
  | "RECEIPT_VOIDED"
  /** Geld entnommen, eingelegt oder transferiert. */
  | "CASH_MOVEMENT"
  /** Kassenabschluss erstellt. */
  | "CLOSING_CREATED"
  /** Daten ausgegeben: DSFinV-K, DATEV, Lexware. */
  | "DATA_EXPORTED"
  /** Einstellungen geaendert, die den Beleg betreffen. */
  | "SETTINGS_CHANGED"
  /** Preis eines Artikels geaendert. */
  | "PRICE_CHANGED"
  /** Bestand von Hand korrigiert. */
  | "STOCK_ADJUSTED"
  /** Verkauf ohne funktionierende TSE. */
  | "TSE_FAILURE"
  /** Ein Vorgang wurde verworfen, ohne abgeschlossen zu werden. */
  | "SALE_DISCARDED"
  /** Ein Zugriff wurde wegen fehlender Rechte verweigert. */
  | "ACCESS_DENIED";

export const AUDIT_LABELS: Record<AuditEvent, string> = {
  LOGIN_OK: "Anmeldung",
  LOGIN_FAILED: "Anmeldung fehlgeschlagen",
  LOGIN_LOCKED: "Zugang gesperrt",
  LOGOUT: "Abmeldung",
  DEVICE_LOCKED: "Geraet gesperrt",
  PERMISSION_CHANGED: "Recht geaendert",
  ROLE_CHANGED: "Rolle geaendert",
  USER_CHANGED: "Bediener geaendert",
  RECEIPT_VOIDED: "Storno",
  CASH_MOVEMENT: "Kassenbewegung",
  CLOSING_CREATED: "Kassenabschluss",
  DATA_EXPORTED: "Datenexport",
  SETTINGS_CHANGED: "Einstellung geaendert",
  PRICE_CHANGED: "Preis geaendert",
  STOCK_ADJUSTED: "Bestand korrigiert",
  TSE_FAILURE: "TSE-Ausfall",
  SALE_DISCARDED: "Vorgang verworfen",
  ACCESS_DENIED: "Zugriff verweigert",
};

/**
 * Ereignisse, die eine Pruefung zuerst ansieht.
 *
 * Danach wird die Liste in der Oberflaeche vorgefiltert - die uebrigen
 * Ereignisse sind haeufig und wuerden diese ueberdecken.
 */
export const CRITICAL_EVENTS: readonly AuditEvent[] = [
  "RECEIPT_VOIDED",
  "CASH_MOVEMENT",
  "PERMISSION_CHANGED",
  "ROLE_CHANGED",
  "USER_CHANGED",
  "DATA_EXPORTED",
  "PRICE_CHANGED",
  "STOCK_ADJUSTED",
  "TSE_FAILURE",
  "LOGIN_LOCKED",
];

export interface AuditEntry {
  readonly id: Id;
  readonly tenantId: Id;
  readonly deviceId: Id;
  /** Wer - `null` nur bei Ereignissen vor der Anmeldung. */
  readonly userId: Id | null;
  /** Name zum Zeitpunkt des Ereignisses, damit das Protokoll ohne Verknuepfung lesbar bleibt. */
  readonly userName: string | null;
  readonly event: AuditEvent;
  /** Worauf es sich bezieht: Belegnummer, Artikelname, Bedienername. */
  readonly subject: string | null;
  /** Kurzbeschreibung in Klartext, ohne Geheimnisse. */
  readonly detail: string | null;
  /** Betrag, wo einer im Spiel ist - fuer die Auswertung nach Hoehe. */
  readonly amount: number | null;
  readonly createdAt: Timestamp;
}

export class AuditError extends Error {}

/**
 * Muster, die niemals in einem Protokolleintrag stehen duerfen.
 *
 * Das ist kein vollstaendiger Schutz - es ist ein Netz fuer den Fall, dass
 * irgendwo ein Wert durchgereicht wird, der dort nichts zu suchen hat. Beim
 * Anlegen wird geprueft und **abgebrochen**: ein Protokoll, das ein Geheimnis
 * enthaelt, ist schlimmer als kein Protokoll.
 */
const FORBIDDEN_PATTERNS: readonly { readonly pattern: RegExp; readonly what: string }[] = [
  { pattern: /pbkdf2\$/i, what: "ein PIN-Pruefwert" },
  { pattern: /\bBearer\s+\S+/i, what: "ein Zugangstoken" },
  { pattern: /\b(api[_-]?key|secret|passwo?rt?|password)\s*[:=]\s*\S+/i, what: "ein Geheimnis" },
  // Eine vollstaendige PAN gehoert nirgends hin ausser zum Zahlungsdienst.
  { pattern: /\b\d{13,19}\b/, what: "eine vollstaendige Kartennummer" },
];

/** Text auf Geheimnisse pruefen. */
export function assertNoSecrets(text: string | null, field: string): void {
  if (!text) return;
  for (const { pattern, what } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      throw new AuditError(`Das Feld "${field}" enthaelt ${what}. Das darf nicht ins Pruefprotokoll.`);
    }
  }
}

export interface AuditRequest {
  readonly id: Id;
  readonly tenantId: Id;
  readonly deviceId: Id;
  readonly userId?: Id | null;
  readonly userName?: string | null;
  readonly event: AuditEvent;
  readonly subject?: string | null;
  readonly detail?: string | null;
  readonly amount?: number | null;
  readonly createdAt: Timestamp;
}

/** Protokolleintrag bilden. */
export function buildAuditEntry(request: AuditRequest): AuditEntry {
  assertNoSecrets(request.subject ?? null, "subject");
  assertNoSecrets(request.detail ?? null, "detail");

  return {
    id: request.id,
    tenantId: request.tenantId,
    deviceId: request.deviceId,
    userId: request.userId ?? null,
    userName: request.userName ?? null,
    event: request.event,
    subject: request.subject ?? null,
    detail: request.detail ?? null,
    amount: request.amount ?? null,
    createdAt: request.createdAt,
  };
}

/** Eintrag fuer eine verweigerte Handlung. */
export function accessDenied(
  base: Omit<AuditRequest, "event" | "detail" | "subject">,
  capability: Capability,
  attempted: string,
): AuditEntry {
  return buildAuditEntry({
    ...base,
    event: "ACCESS_DENIED",
    subject: attempted,
    detail: `Fehlendes Recht: ${capability}`,
  });
}

/** Eine Zeile des Protokolls, wie sie angezeigt wird. */
export function formatAuditEntry(entry: AuditEntry): string {
  const parts = [
    entry.createdAt.replace("T", " ").slice(0, 19),
    AUDIT_LABELS[entry.event],
    entry.userName ?? "unbekannt",
  ];
  if (entry.subject) parts.push(entry.subject);
  if (entry.detail) parts.push(entry.detail);
  return parts.join(" · ");
}

/**
 * Auffaelligkeiten im Protokoll.
 *
 * Kein Ersatz fuer eine Pruefung durch einen Menschen, aber ein Hinweis auf das,
 * was man sonst uebersieht: viele Storni durch einen Bediener, wiederholte
 * Fehlanmeldungen, Entnahmen ausserhalb der Geschaeftszeit. Absichtlich mit
 * Zahlen, nicht mit einer Bewertung - die Kasse weiss nicht, ob ein Betrieb
 * dreissig Storni am Tag normal findet.
 */
export interface AuditSummary {
  readonly totalEntries: number;
  readonly byEvent: Readonly<Record<string, number>>;
  readonly voidsByUser: readonly { readonly userName: string; readonly count: number; readonly amount: number }[];
  readonly failedLogins: number;
  readonly lockouts: number;
  readonly tseFailures: number;
  readonly deniedAccess: number;
}

export function summarizeAudit(entries: readonly AuditEntry[]): AuditSummary {
  const byEvent: Record<string, number> = {};
  const voids = new Map<string, { count: number; amount: number }>();

  for (const entry of entries) {
    byEvent[entry.event] = (byEvent[entry.event] ?? 0) + 1;
    if (entry.event === "RECEIPT_VOIDED") {
      const name = entry.userName ?? "unbekannt";
      const current = voids.get(name) ?? { count: 0, amount: 0 };
      voids.set(name, { count: current.count + 1, amount: current.amount + Math.abs(entry.amount ?? 0) });
    }
  }

  return {
    totalEntries: entries.length,
    byEvent,
    voidsByUser: [...voids.entries()]
      .map(([userName, value]) => ({ userName, count: value.count, amount: value.amount }))
      .sort((a, b) => b.amount - a.amount || b.count - a.count),
    failedLogins: byEvent["LOGIN_FAILED"] ?? 0,
    lockouts: byEvent["LOGIN_LOCKED"] ?? 0,
    tseFailures: byEvent["TSE_FAILURE"] ?? 0,
    deniedAccess: byEvent["ACCESS_DENIED"] ?? 0,
  };
}
