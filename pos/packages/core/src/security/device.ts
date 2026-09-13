/**
 * Geraeteschutz, Geheimnisse und Transportverschluesselung.
 *
 * Die drei Dinge, die zusammen das Geraet absichern - und ein Abschnitt dazu,
 * was sie **nicht** leisten, weil eine falsche Erwartung hier teurer ist als
 * eine fehlende Funktion.
 *
 * ## 1. Das Geraet vor Ort
 *
 * Ein Tablet am Verkaufsstand ist unbeaufsichtigt, sobald der Bediener sich
 * umdreht. Die Gegenmittel, in der Reihenfolge ihrer Wirkung:
 *
 *   - **Geraetesperre des Betriebssystems** mit Verschluesselung. Das ist das
 *     Wirksamste, und die Kasse kann es nicht ersetzen - sie kann nur darauf
 *     hinweisen, wenn sie fehlt.
 *   - **Sperre der App nach Inaktivitaet** (hier umgesetzt). Sie verhindert,
 *     dass der Naechste einfach weiterkassiert oder in die Umsaetze sieht.
 *   - **Sperre beim Wechsel in den Hintergrund** bei heiklen Bildschirmen.
 *   - **Deaktivieren aus der Ferne**: ein verlorenes Geraet wird im Server als
 *     Kasse deaktiviert; beim naechsten Abgleich verweigert es den Dienst.
 *     Wirkt nicht offline - das ist die Grenze, und sie ist zu nennen.
 *
 * ## 2. Geheimnisse
 *
 * Zugangsdaten der TSE, Schluessel des Zahlungsdienstleisters, Tokens des
 * Servers: alles davon gehoert in die Schluesselverwaltung des Betriebssystems
 * (Keychain auf iOS, Keystore auf Android), **nicht** in die SQLite-Datei. Der
 * Unterschied ist erheblich: die Datenbank liegt als Datei im App-Verzeichnis
 * und landet in Sicherungen; die Schluesselverwaltung ist hardwaregestuetzt und
 * an das Geraet gebunden.
 *
 * ## 3. Transport
 *
 * Jede Verbindung nach draussen ueber TLS, ohne Ausnahme und ohne
 * abschaltbare Zertifikatspruefung. Eine Kasse, die im Gastnetz eines
 * Marktplatzes haengt, ist genau die Lage, fuer die TLS erfunden wurde.
 */

import type { Timestamp } from "../model.ts";

export class SecurityError extends Error {}

// =========================================================================
// Sperre der App
// =========================================================================

/**
 * Voreinstellungen der Sperre.
 *
 * Fuenf Minuten sind lang genug, dass ein Bediener nicht mitten im Verkauf
 * ausgesperrt wird, und kurz genug, dass ein liegengebliebenes Tablet in der
 * Mittagspause gesperrt ist. Der Kassenbildschirm selbst haelt die Sperre auf,
 * solange getippt wird - gesperrt wird bei *Inaktivitaet*, nicht nach Zeit.
 */
export interface LockPolicy {
  /** Sperren nach so vielen Sekunden ohne Bedienung. 0 schaltet die Sperre ab. */
  readonly idleSeconds: number;
  /** Beim Wechsel in den Hintergrund sofort sperren. */
  readonly lockOnBackground: boolean;
  /**
   * Auch dann sperren, wenn ein Vorgang im Warenkorb liegt?
   *
   * Standard nein: ein halb erfasster Warenkorb waere nach der Sperre verloren
   * oder muesste geparkt werden, und beides aergert mehr als es schuetzt. Der
   * Warenkorb enthaelt keine Umsatzhistorie - das Schuetzenswerte liegt in den
   * Berichten und Einstellungen, und die sind hinter der Sperre.
   */
  readonly lockWithOpenCart: boolean;
}

export const DEFAULT_LOCK_POLICY: LockPolicy = {
  idleSeconds: 300,
  lockOnBackground: false,
  lockWithOpenCart: false,
};

/** Strengere Voreinstellung fuer Geraete, die unbeaufsichtigt stehen. */
export const STRICT_LOCK_POLICY: LockPolicy = {
  idleSeconds: 60,
  lockOnBackground: true,
  lockWithOpenCart: true,
};

export interface LockState {
  /** Letzte Bedienung. */
  readonly lastActivityAt: Timestamp;
  /** Ist die App gerade gesperrt? */
  readonly locked: boolean;
  /** Liegt ein Vorgang im Warenkorb? */
  readonly hasOpenCart: boolean;
}

export type LockReason = "IDLE" | "BACKGROUND" | "MANUAL";

export const LOCK_REASON_LABELS: Record<LockReason, string> = {
  IDLE: "nach Inaktivitaet gesperrt",
  BACKGROUND: "beim Verlassen der App gesperrt",
  MANUAL: "von Hand gesperrt",
};

/**
 * Muss jetzt gesperrt werden?
 *
 * Reine Funktion ueber den Zustand - kein Zeitgeber darin. Die App fragt bei
 * jeder Bedienung und bei jedem Wechsel in den Vordergrund; damit ist die
 * Sperre auch dann wirksam, wenn das Betriebssystem die App zwischenzeitlich
 * eingefroren hat und kein Zeitgeber lief. Ein Zeitgeber allein wuerde genau
 * diesen Fall verpassen - und das ist der haeufigste.
 */
export function shouldLock(
  state: LockState,
  policy: LockPolicy,
  now: Timestamp,
  trigger: "activity-check" | "foreground" | "background" = "activity-check",
): { readonly lock: boolean; readonly reason: LockReason | null } {
  if (state.locked) return { lock: false, reason: null };

  if (trigger === "background") {
    if (!policy.lockOnBackground) return { lock: false, reason: null };
    if (state.hasOpenCart && !policy.lockWithOpenCart) return { lock: false, reason: null };
    return { lock: true, reason: "BACKGROUND" };
  }

  if (policy.idleSeconds <= 0) return { lock: false, reason: null };
  if (state.hasOpenCart && !policy.lockWithOpenCart) return { lock: false, reason: null };

  const last = Date.parse(state.lastActivityAt);
  const current = Date.parse(now);
  if (Number.isNaN(last) || Number.isNaN(current)) {
    // Unlesbarer Zeitstempel: im Zweifel sperren. Eine unnoetige Sperre kostet
    // eine PIN-Eingabe, eine unterlassene kostet die Umsaetze.
    return { lock: true, reason: "IDLE" };
  }
  const idle = (current - last) / 1000;
  return idle >= policy.idleSeconds ? { lock: true, reason: "IDLE" } : { lock: false, reason: null };
}

/** Bedienung vermerken - setzt die Untaetigkeit zurueck. */
export function touchActivity(state: LockState, now: Timestamp): LockState {
  return { ...state, lastActivityAt: now, locked: false };
}

/** Sekunden bis zur Sperre - fuer einen Hinweis kurz davor. */
export function secondsUntilLock(state: LockState, policy: LockPolicy, now: Timestamp): number | null {
  if (policy.idleSeconds <= 0 || state.locked) return null;
  if (state.hasOpenCart && !policy.lockWithOpenCart) return null;
  const last = Date.parse(state.lastActivityAt);
  const current = Date.parse(now);
  if (Number.isNaN(last) || Number.isNaN(current)) return 0;
  return Math.max(0, Math.ceil(policy.idleSeconds - (current - last) / 1000));
}

// =========================================================================
// Geheimnisse
// =========================================================================

/**
 * Was als Geheimnis gilt.
 *
 * Die Liste ist absichtlich vollstaendig aufgezaehlt und nicht "alles, was
 * geheim aussieht": nur so kann geprueft werden, dass nichts davon in der
 * Datenbank landet.
 */
export type SecretKey =
  /** Zugangsdaten der TSE beim Anbieter. */
  | "tse.apiKey"
  | "tse.apiSecret"
  /** Schluessel des Zahlungsdienstleisters. */
  | "terminal.apiKey"
  /** Token fuer den Abgleich mit dem Server. */
  | "sync.accessToken"
  | "sync.refreshToken"
  /** Schluessel der Datenbankverschluesselung. */
  | "db.encryptionKey";

export const SECRET_KEYS: readonly SecretKey[] = [
  "tse.apiKey",
  "tse.apiSecret",
  "terminal.apiKey",
  "sync.accessToken",
  "sync.refreshToken",
  "db.encryptionKey",
];

/**
 * Schluesselverwaltung des Betriebssystems.
 *
 * Die App bringt die Umsetzung mit (auf beiden Plattformen ueber
 * `expo-secure-store`, das Keychain bzw. Keystore benutzt). Der Kern kennt nur
 * diese Schnittstelle - damit ist im Test ersetzbar, was sonst ein Geraet
 * braeuchte.
 */
export interface SecretStore {
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  remove(key: SecretKey): Promise<void>;
  /** Alle Geheimnisse loeschen - beim Zurueckgeben oder Verlieren des Geraets. */
  clear(): Promise<void>;
}

/**
 * Geheimnisspeicher, der nur im Arbeitsspeicher lebt.
 *
 * Fuer Tests. Ausdruecklich **nicht** fuer den Betrieb: nach dem Beenden der
 * App ist alles weg, und vorher liegt es unverschluesselt im Speicher.
 */
export function inMemorySecretStore(initial: Partial<Record<SecretKey, string>> = {}): SecretStore {
  const values = new Map<SecretKey, string>(Object.entries(initial) as [SecretKey, string][]);
  return {
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value) {
      if (value === "") throw new SecurityError(`Ein leerer Wert ist kein Geheimnis: ${key}`);
      values.set(key, value);
    },
    async remove(key) {
      values.delete(key);
    },
    async clear() {
      values.clear();
    },
  };
}

/**
 * Pruefen, dass ein Datensatz kein Geheimnis enthaelt, bevor er in die
 * Datenbank geht.
 *
 * Aufgerufen an den Stellen, an denen Einstellungen gespeichert werden. Der
 * Fall, den das abfaengt: jemand ergaenzt ein Feld `apiKey` in der
 * Geraetekonfiguration, und damit steht der Schluessel des
 * Zahlungsdienstleisters in einer Datei, die in jeder Sicherung landet.
 */
export function assertNoSecretFields(record: Readonly<Record<string, unknown>>, what: string): void {
  const suspicious = /(secret|api[_-]?key|token|passwo?rt?|password|credential|private[_-]?key|encryption[_-]?key)/i;
  for (const [key, value] of Object.entries(record)) {
    if (value == null || value === "") continue;
    if (suspicious.test(key)) {
      throw new SecurityError(
        `"${key}" sieht wie ein Geheimnis aus und darf nicht in ${what} gespeichert werden - solche Werte gehoeren in die Schluesselverwaltung des Geraets.`,
      );
    }
  }
}

// =========================================================================
// Transport
// =========================================================================

/**
 * Adresse fuer eine Verbindung nach draussen pruefen.
 *
 * Erlaubt ist nur `https`. Kein Schalter, kein "nur zum Testen": eine
 * abschaltbare Verschluesselung ist in der Praxis eine abgeschaltete. Die
 * einzige Ausnahme ist `http` auf das eigene Netz - und die gilt
 * ausdruecklich **nicht** fuer diese Funktion, sondern nur fuer den
 * Netzwerkdrucker, der kein TLS spricht und keine personenbezogenen Daten
 * empfaengt (siehe `checkLocalPrinterUrl`).
 */
export function checkSecureUrl(url: string): { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly reason: string } {
  const text = url.trim();
  if (text === "") return { ok: false, reason: "Die Adresse fehlt." };

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, reason: "Die Adresse ist nicht lesbar. Beispiel: https://kasse.beispiel.de" };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `Verbindungen nach draussen laufen nur ueber https - "${parsed.protocol}" ist nicht zulaessig. Im Gastnetz eines Marktplatzes liest sonst jeder mit.`,
    };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "Zugangsdaten gehoeren nicht in die Adresse." };
  }
  return { ok: true, url: parsed };
}

/**
 * Adresse eines Druckers im eigenen Netz.
 *
 * Hier ist `http` bzw. eine rohe TCP-Verbindung zulaessig, weil Bondrucker kein
 * TLS sprechen. Die Einschraenkung dafuer: nur private Adressbereiche. Ein
 * "Drucker" im Internet ist kein Drucker, sondern ein Datenabfluss - und der
 * Bon enthaelt die Umsaetze des Tages.
 */
export function checkLocalPrinterUrl(host: string): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const value = host.trim().toLowerCase();
  if (value === "") return { ok: false, reason: "Die Druckeradresse fehlt." };

  // Rechnernamen im lokalen Netz sind zulaessig; sie loesen sich ohnehin nur
  // dort auf.
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    if (value.endsWith(".local") || !value.includes(".")) return { ok: true };
    return {
      ok: false,
      reason: `"${value}" liegt ausserhalb des eigenen Netzes. Ein Drucker im Internet wuerde die Umsaetze des Tages unverschluesselt uebertragen.`,
    };
  }

  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 255)) return { ok: false, reason: `"${value}" ist keine IP-Adresse.` };
  const [a, b] = parts as [number, number, number, number];

  const isPrivate =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254);

  return isPrivate
    ? { ok: true }
    : {
        ok: false,
        reason: `${value} liegt nicht im eigenen Netz. Zulaessig sind 10.x, 172.16-31.x, 192.168.x und Namen mit .local.`,
      };
}

/**
 * Kopfzeilen fuer eine Anfrage nach draussen.
 *
 * An einer Stelle gebildet, damit keine Anfrage ohne sie hinausgeht. Das Token
 * kommt als Parameter und wird **nicht** hier gespeichert - es liegt in der
 * Schluesselverwaltung des Geraets und wird nur fuer die Dauer der Anfrage
 * gehalten.
 */
export function secureHeaders(accessToken: string | null, options: { readonly contentType?: string } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    // Verhindert, dass ein Antwortinhalt anders geraten wird als angegeben.
    "x-content-type-options": "nosniff",
  };
  if (options.contentType) headers["content-type"] = options.contentType;
  if (accessToken) {
    const token = accessToken.trim();
    if (token === "") throw new SecurityError("Ein leeres Zugangstoken ist kein Token.");
    headers["authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Hinweise zur Absicherung des Geraets, die die Kasse nicht selbst herstellen
 * kann.
 *
 * Steht in den Einstellungen. Eine Kasse, die vorgibt, das Geraet zu sichern,
 * waere unehrlich - sie kann nur sagen, was noetig ist.
 */
export const DEVICE_HARDENING_ADVICE: readonly string[] = [
  "Geraetesperre des Betriebssystems mit Code oder Biometrie einschalten - sie ist der wirksamste Schutz und die Kasse kann sie nicht ersetzen.",
  "Geraeteverschluesselung pruefen: auf iPhone und iPad mit Code aktiv, auf Android unter Sicherheit zu pruefen.",
  "Automatische Sicherungen der App-Daten in eine Cloud abschalten, wenn dort keine Verschluesselung mit eigenem Schluessel moeglich ist.",
  "Kein zweiter Benutzer und kein Gastmodus auf dem Geraet, das kassiert.",
  "Bei Verlust: die Kasse im Kassenverzeichnis deaktivieren. Wirkt erst beim naechsten Abgleich - offline kann das Geraet weiter kassieren.",
  "Die App nur aus dem offiziellen Store beziehen und Aktualisierungen zeitnah einspielen.",
];
