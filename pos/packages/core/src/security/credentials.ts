/**
 * Anmeldung am Geraet.
 *
 * ## Was eine PIN leisten kann - und was nicht
 *
 * Das muss vorab klar sein, weil sonst eine falsche Sicherheit entsteht. Eine
 * vierstellige PIN hat 10.000 moegliche Werte. Wer die Datenbank des Geraets in
 * die Hand bekommt, kann sie mit genuegend Rechenzeit durchprobieren -
 * unabhaengig davon, wie gut sie gespeichert ist. Die PIN schuetzt also:
 *
 *   - **Ja:** einen Mitarbeiter davor, am Geraet etwas zu tun, was er nicht
 *     darf; und einen Fremden, der das unbeaufsichtigte Tablet findet, davor,
 *     einfach weiterzukassieren.
 *   - **Nein:** gegen jemanden, der das Geraet mitnimmt und die Datenbank
 *     ausliest.
 *
 * Deshalb ist die Schluesselstreckung hier nicht das Hauptmittel, sondern die
 * **Sperre nach Fehlversuchen**: sie begrenzt das Durchprobieren am Geraet auf
 * wenige Versuche pro Zeiteinheit. Gegen den Diebstahl des Geraets wirkt nur
 * die Verschluesselung der Datenbank und die Geraetesperre des Betriebssystems
 * (siehe docs/SICHERHEIT.md).
 *
 * ## Wie gespeichert wird
 *
 * Format: `pbkdf2$sha256$<runden>$<salz-hex>$<pruefwert-hex>`
 *
 * Die Runden stehen **im** Pruefwert. So laesst sich die Zahl spaeter erhoehen,
 * ohne alle Zugaenge zurueckzusetzen: alte Werte werden mit ihrer alten
 * Rundenzahl geprueft und bei der naechsten erfolgreichen Anmeldung neu
 * abgeleitet. Eine feste Rundenzahl im Code waere eine Einbahnstrasse.
 */

import { HashError, fromHex, pbkdf2Sha256, randomBytes, timingSafeEqual, toHex, utf8 } from "./hash.ts";
import { checkPin } from "../validation.ts";

export class CredentialError extends Error {}

/**
 * Runden der Schluesselstreckung.
 *
 * 60.000 Runden brauchen in reinem JavaScript auf einem Mittelklassetelefon
 * etwa eine halbe bis eine Sekunde. Das ist die Grenze des Zumutbaren fuer eine
 * Anmeldung, die beim Schichtwechsel mehrmals passiert - und gleichzeitig das
 * Hoechste, was sich ohne native Kryptobibliothek erreichen laesst. Die Zahl
 * steht im gespeicherten Wert und kann spaeter erhoeht werden.
 */
export const PIN_ITERATIONS = 60_000;

/** Laenge des Salzes. 16 Byte sind Stand der Technik und reichlich. */
export const SALT_LENGTH = 16;

/** Laenge des abgeleiteten Pruefwerts. */
export const KEY_LENGTH = 32;

const PREFIX = "pbkdf2$sha256$";

/**
 * PIN zu einem speicherbaren Pruefwert ableiten.
 *
 * Die PIN selbst wird nirgends gespeichert - auch nicht verschluesselt, auch
 * nicht kurzzeitig. Was hier herauskommt, ist alles, was das Geraet ueber die
 * PIN weiss.
 */
export function hashPin(pin: string, options: { readonly iterations?: number; readonly salt?: Uint8Array } = {}): string {
  const checked = checkPin(pin);
  if (!checked.ok) throw new CredentialError(checked.reason);

  const iterations = options.iterations ?? PIN_ITERATIONS;
  const salt = options.salt ?? randomBytes(SALT_LENGTH);
  if (salt.length < 8) throw new CredentialError("Das Salz ist zu kurz - mindestens 8 Byte.");

  const derived = pbkdf2Sha256(utf8(checked.value), salt, iterations, KEY_LENGTH);
  return `${PREFIX}${iterations}$${toHex(salt)}$${toHex(derived)}`;
}

interface ParsedHash {
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly key: Uint8Array;
}

/** Gespeicherten Pruefwert zerlegen. */
export function parsePinHash(stored: string): ParsedHash {
  if (!stored.startsWith(PREFIX)) {
    throw new CredentialError("Der gespeicherte Pruefwert hat ein unbekanntes Format.");
  }
  const parts = stored.slice(PREFIX.length).split("$");
  if (parts.length !== 3) throw new CredentialError("Der gespeicherte Pruefwert ist unvollstaendig.");

  const [iterationsText, saltHex, keyHex] = parts as [string, string, string];
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new CredentialError("Die Rundenzahl im Pruefwert ist unbrauchbar.");
  }
  try {
    return { iterations, salt: fromHex(saltHex), key: fromHex(keyHex) };
  } catch (error) {
    if (error instanceof HashError) throw new CredentialError("Der Pruefwert enthaelt keinen gueltigen Hexadezimaltext.");
    throw error;
  }
}

export interface PinVerification {
  readonly ok: boolean;
  /**
   * `true`, wenn der Pruefwert mit weniger Runden abgeleitet wurde als heute
   * ueblich. Dann sollte er bei dieser Anmeldung neu abgeleitet werden - der
   * einzige Zeitpunkt, an dem die PIN im Klartext vorliegt.
   */
  readonly needsRehash: boolean;
}

/**
 * PIN gegen den gespeicherten Wert pruefen.
 *
 * Der Vergleich laeuft in konstanter Zeit. Ein unbrauchbarer gespeicherter Wert
 * ergibt `false` und keinen Fehler: ein Zugang mit kaputtem Pruefwert darf nicht
 * anmelden, aber er darf auch nicht die Anmeldung aller anderen mit einem
 * Absturz verhindern.
 */
export function verifyPin(pin: string, stored: string | null | undefined): PinVerification {
  if (!stored) return { ok: false, needsRehash: false };

  let parsed: ParsedHash;
  try {
    parsed = parsePinHash(stored);
  } catch {
    return { ok: false, needsRehash: false };
  }

  // Die PIN wird hier **nicht** durch checkPin geschickt: eine bestehende PIN,
  // die nach heutigen Regeln zu schwach waere, muss weiter anmelden koennen -
  // sonst sperrt eine verschaerfte Regel den Betrieb aus.
  const candidate = pbkdf2Sha256(utf8(pin.trim()), parsed.salt, parsed.iterations, parsed.key.length);
  return {
    ok: timingSafeEqual(candidate, parsed.key),
    needsRehash: parsed.iterations < PIN_ITERATIONS,
  };
}

// --- Sperre nach Fehlversuchen -------------------------------------------

/**
 * Nach so vielen Fehlversuchen wird gesperrt.
 *
 * Fuenf ist die Zahl, die ein Mensch mit einer vergessenen PIN braucht, und
 * deutlich zu wenig, um 10.000 Moeglichkeiten durchzuprobieren.
 */
export const MAX_PIN_ATTEMPTS = 5;

/**
 * Sperrdauer in Sekunden, nach Stufen.
 *
 * Steigend, damit ein Mensch nach dem fuenften Versuch kurz wartet und ein
 * Automat nach dem zwanzigsten stundenlang. Gedeckelt bei einer Stunde: eine
 * dauerhafte Sperre wuerde den Betrieb anhalten, und dann wird die Kasse
 * umgangen statt benutzt.
 */
export function lockSeconds(lockCount: number): number {
  const steps = [30, 120, 600, 1800, 3600];
  return steps[Math.min(Math.max(lockCount, 1) - 1, steps.length - 1)] as number;
}

export interface LoginAttemptState {
  /** Fehlversuche seit der letzten erfolgreichen Anmeldung. */
  readonly failedAttempts: number;
  /** Wie oft schon gesperrt wurde - bestimmt die Sperrdauer. */
  readonly lockCount: number;
  /** Gesperrt bis zu diesem Zeitpunkt; `null` = nicht gesperrt. */
  readonly lockedUntil: string | null;
}

export const NO_ATTEMPTS: LoginAttemptState = { failedAttempts: 0, lockCount: 0, lockedUntil: null };

/** Ist der Zugang gerade gesperrt, und fuer wie lange noch? */
export function lockStatus(
  state: LoginAttemptState,
  now: string,
): { readonly locked: boolean; readonly secondsLeft: number } {
  if (!state.lockedUntil) return { locked: false, secondsLeft: 0 };
  const until = Date.parse(state.lockedUntil);
  const current = Date.parse(now);
  if (Number.isNaN(until) || Number.isNaN(current)) return { locked: false, secondsLeft: 0 };
  if (until <= current) return { locked: false, secondsLeft: 0 };
  return { locked: true, secondsLeft: Math.ceil((until - current) / 1000) };
}

/** Fehlversuch verbuchen und bei Erreichen der Grenze sperren. */
export function registerFailedAttempt(state: LoginAttemptState, now: string): LoginAttemptState {
  const failedAttempts = state.failedAttempts + 1;
  if (failedAttempts < MAX_PIN_ATTEMPTS) {
    return { failedAttempts, lockCount: state.lockCount, lockedUntil: null };
  }

  const lockCount = state.lockCount + 1;
  const until = new Date(Date.parse(now) + lockSeconds(lockCount) * 1000);
  return {
    // Zaehler zuruecksetzen: nach der Sperre gibt es wieder volle Versuche,
    // aber die naechste Sperre dauert laenger.
    failedAttempts: 0,
    lockCount,
    lockedUntil: until.toISOString(),
  };
}

/** Erfolgreiche Anmeldung setzt alles zurueck. */
export function registerSuccessfulAttempt(): LoginAttemptState {
  return NO_ATTEMPTS;
}

/** Verbleibende Versuche bis zur Sperre - fuer die Anzeige. */
export function attemptsLeft(state: LoginAttemptState): number {
  return Math.max(0, MAX_PIN_ATTEMPTS - state.failedAttempts);
}

/**
 * Sperrdauer als Text fuer den Bediener.
 *
 * "Noch 4 Minuten" ist brauchbar, "gesperrt bis 2026-09-26T09:34:12+02:00"
 * nicht.
 */
export function formatLockDuration(secondsLeft: number): string {
  if (secondsLeft <= 60) return `noch ${Math.max(1, secondsLeft)} Sekunden`;
  const minutes = Math.ceil(secondsLeft / 60);
  if (minutes < 60) return `noch ${minutes} Minuten`;
  const hours = Math.ceil(minutes / 60);
  return `noch ${hours} Stunde${hours === 1 ? "" : "n"}`;
}

// --- Gesamtergebnis einer Anmeldung --------------------------------------

export type LoginOutcome =
  | { readonly result: "OK"; readonly needsRehash: boolean; readonly state: LoginAttemptState }
  | { readonly result: "WRONG_PIN"; readonly state: LoginAttemptState; readonly attemptsLeft: number }
  | { readonly result: "LOCKED"; readonly state: LoginAttemptState; readonly secondsLeft: number }
  | { readonly result: "NO_PIN_SET"; readonly state: LoginAttemptState }
  | { readonly result: "INACTIVE"; readonly state: LoginAttemptState };

/**
 * Anmeldung durchfuehren.
 *
 * Eine Stelle fuer den ganzen Ablauf: Sperre pruefen, PIN pruefen, Zaehler
 * fortschreiben. Verteilt man das ueber die Oberflaeche, wird die Sperre beim
 * dritten Bildschirm vergessen.
 *
 * Der Unterschied zwischen "falsche PIN" und "kein solcher Bediener" wird
 * **nicht** nach aussen gegeben: das waere eine Auskunft darueber, welche
 * Zugaenge es gibt. Am Geraet einer Kasse ist das weniger heikel als im
 * Internet, aber es kostet auch nichts, es richtig zu machen.
 */
export function attemptLogin(
  user: { readonly pinHash?: string | null; readonly active: boolean },
  pin: string,
  state: LoginAttemptState,
  now: string,
): LoginOutcome {
  const lock = lockStatus(state, now);
  if (lock.locked) return { result: "LOCKED", state, secondsLeft: lock.secondsLeft };

  if (!user.active) {
    // Kein Fehlversuch verbucht: ein deaktivierter Zugang soll nicht die
    // Sperre eines aktiven ausloesen koennen.
    return { result: "INACTIVE", state };
  }
  if (!user.pinHash) return { result: "NO_PIN_SET", state };

  const verification = verifyPin(pin, user.pinHash);
  if (verification.ok) {
    return { result: "OK", needsRehash: verification.needsRehash, state: registerSuccessfulAttempt() };
  }

  const next = registerFailedAttempt(state, now);
  const nextLock = lockStatus(next, now);
  if (nextLock.locked) return { result: "LOCKED", state: next, secondsLeft: nextLock.secondsLeft };
  return { result: "WRONG_PIN", state: next, attemptsLeft: attemptsLeft(next) };
}

/** Meldung zum Ergebnis, fuer die Anzeige am Geraet. */
export function describeLoginOutcome(outcome: LoginOutcome): string {
  switch (outcome.result) {
    case "OK":
      return "Angemeldet.";
    case "WRONG_PIN":
      return outcome.attemptsLeft === 1
        ? "PIN falsch. Noch ein Versuch, danach wird der Zugang kurz gesperrt."
        : `PIN falsch. Noch ${outcome.attemptsLeft} Versuche.`;
    case "LOCKED":
      return `Zu viele Fehlversuche. Der Zugang ist gesperrt - ${formatLockDuration(outcome.secondsLeft)}.`;
    case "NO_PIN_SET":
      return "Fuer diesen Zugang ist keine PIN eingerichtet. Der Inhaber kann sie in den Einstellungen setzen.";
    case "INACTIVE":
      return "Dieser Zugang ist deaktiviert.";
  }
}
