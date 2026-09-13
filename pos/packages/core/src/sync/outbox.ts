/**
 * Ausgangswarteschlange fuer die Server-Synchronisation.
 *
 * Eine Kasse am Marktstand hat kein verlaessliches Netz. Deshalb ist die App
 * offline-first: jeder Beleg wird lokal geschrieben und *danach* in diese
 * Warteschlange gelegt. Der Verkauf wartet nie auf den Server.
 *
 * Die drei Eigenschaften, auf die es ankommt:
 *
 *   1. **Reihenfolge.** Belege werden in der Reihenfolge uebertragen, in der
 *      sie entstanden sind. Ein Kassenabschluss darf den Server nicht vor den
 *      Belegen erreichen, die er zusammenfasst.
 *   2. **Idempotenz.** Jeder Eintrag traegt einen stabilen Schluessel. Kommt
 *      die Antwort des Servers nicht an und die Kasse sendet erneut, darf der
 *      Beleg nicht zweimal gezaehlt werden.
 *   3. **Kein Datenverlust.** Ein Eintrag verlaesst die Warteschlange nur bei
 *      Erfolg oder bei einer Ablehnung, die der Server *ausdruecklich* als
 *      endgueltig meldet. Nach einem Netzfehler bleibt er liegen - notfalls
 *      tagelang.
 */

export class OutboxError extends Error {}

export type OutboxKind = "order" | "closing" | "product" | "category" | "device" | "user";

export interface OutboxEntry {
  /**
   * Stabiler Schluessel, aus Art und Id gebildet. Zweimal dasselbe Ereignis
   * anzulegen erzeugt keinen zweiten Eintrag.
   */
  readonly key: string;
  readonly kind: OutboxKind;
  readonly entityId: string;
  readonly tenantId: string;
  /** Nutzlast als JSON-Text - bewusst schon serialisiert, damit ein spaeterer
   * Umbau des Datenmodells liegengebliebene Eintraege nicht unlesbar macht. */
  readonly payload: string;
  readonly createdAt: string;
  /** Bisherige Versuche. */
  readonly attempts: number;
  /** Zeitpunkt, ab dem der naechste Versuch erlaubt ist. */
  readonly nextAttemptAt: string;
  /** Fehlermeldung des letzten Versuchs, fuer die Anzeige im Geraetestatus. */
  readonly lastError: string | null;
}

export interface OutboxState {
  readonly entries: readonly OutboxEntry[];
}

export function emptyOutbox(): OutboxState {
  return { entries: [] };
}

export function outboxKey(kind: OutboxKind, entityId: string): string {
  return `${kind}:${entityId}`;
}

/**
 * Eintrag anlegen oder ersetzen.
 *
 * Existiert der Schluessel schon, wird die Nutzlast aktualisiert und die
 * Position in der Reihenfolge behalten: ein nachtraeglich geaenderter Artikel
 * soll nicht hinter Belege rutschen, die spaeter entstanden sind. Versuche und
 * Wartezeit werden dabei zurueckgesetzt, weil es neue Daten sind.
 */
export function enqueue(
  state: OutboxState,
  entry: { kind: OutboxKind; entityId: string; tenantId: string; payload: unknown; now: string },
): OutboxState {
  const key = outboxKey(entry.kind, entry.entityId);
  const payload = JSON.stringify(entry.payload);
  const fresh: OutboxEntry = {
    key,
    kind: entry.kind,
    entityId: entry.entityId,
    tenantId: entry.tenantId,
    payload,
    createdAt: entry.now,
    attempts: 0,
    nextAttemptAt: entry.now,
    lastError: null,
  };

  const index = state.entries.findIndex((e) => e.key === key);
  if (index < 0) return { entries: [...state.entries, fresh] };

  const entries = [...state.entries];
  entries[index] = { ...fresh, createdAt: (state.entries[index] as OutboxEntry).createdAt };
  return { entries };
}

/**
 * Zwei Zeitstempel vergleichen.
 *
 * **Nicht** als Zeichenkette: unsere Zeitstempel tragen den Offset der
 * Ortszeit, und `2026-09-26T09:00:00+02:00` liegt real *vor*
 * `2026-09-26T09:00:00+00:00`, als Text aber dahinter. Genau das passiert,
 * wenn die Kasse ihre Zeit in Ortszeit fuehrt und der Backoff in UTC rechnet -
 * oder nach der Sommerzeitumstellung. Ein Eintrag waere dann faellig, wenn er
 * es nicht ist, oder umgekehrt.
 */
function atOrBefore(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isNaN(left) || Number.isNaN(right)) {
    // Unlesbarer Zeitstempel: lieber senden als liegen lassen. Ein Beleg, der
    // wegen eines kaputten Zeitstempels nie uebertragen wird, faellt niemandem
    // auf.
    return true;
  }
  return left <= right;
}

/**
 * Die naechsten faelligen Eintraege, in Entstehungsreihenfolge.
 *
 * Ein Eintrag mit Wartezeit blockiert die Warteschlange *nicht*: haengt ein
 * Artikel-Upload an einem Serverfehler, muessen Belege trotzdem durchkommen.
 * Innerhalb einer Art bleibt die Reihenfolge erhalten.
 */
export function due(state: OutboxState, now: string, limit = 25): readonly OutboxEntry[] {
  return state.entries.filter((entry) => atOrBefore(entry.nextAttemptAt, now)).slice(0, limit);
}

/** Erfolgreich uebertragenen Eintrag entfernen. */
export function acknowledge(state: OutboxState, key: string): OutboxState {
  return { entries: state.entries.filter((entry) => entry.key !== key) };
}

/**
 * Wartezeit nach einem Fehlversuch.
 *
 * Verdoppelt sich je Versuch, ab 5 Sekunden, gedeckelt bei 10 Minuten. Der
 * Deckel ist wichtig: eine Kasse, die morgens um 6 einen Fehler hatte, soll
 * nicht bis zum Abend warten, sondern spaetestens alle zehn Minuten wieder
 * probieren.
 */
export function backoffSeconds(attempts: number): number {
  const seconds = 5 * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(seconds, 600);
}

/** Fehlversuch vermerken und die naechste Wartezeit setzen. */
export function reschedule(state: OutboxState, key: string, error: string, now: string): OutboxState {
  const index = state.entries.findIndex((entry) => entry.key === key);
  if (index < 0) return state;

  const current = state.entries[index] as OutboxEntry;
  const attempts = current.attempts + 1;
  const entries = [...state.entries];
  entries[index] = {
    ...current,
    attempts,
    lastError: error,
    nextAttemptAt: new Date(new Date(now).getTime() + backoffSeconds(attempts) * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "+00:00"),
  };
  return { entries };
}

/** Wie viele Eintraege warten - fuer die Statusanzeige am Kassenstand. */
export function pendingCount(state: OutboxState): number {
  return state.entries.length;
}

/**
 * Eintraege, die seit laengerem haengen.
 *
 * Am Geraet muss sichtbar werden, dass Daten nicht ankommen. Eine Kasse, die
 * seit drei Tagen nichts uebertragen hat, ist ein Problem - aber nur, wenn
 * jemand davon erfaehrt.
 */
export function stuck(state: OutboxState, minAttempts = 5): readonly OutboxEntry[] {
  return state.entries.filter((entry) => entry.attempts >= minAttempts);
}

export interface SyncTransport {
  /**
   * Einen Eintrag senden.
   *
   * `"ok"` entfernt ihn, `"retry"` laesst ihn liegen, `"rejected"` entfernt
   * ihn endgueltig - letzteres nur, wenn der Server die Daten ausdruecklich
   * dauerhaft ablehnt (etwa als Duplikat, das er schon hat). Bei allem anderen
   * gilt `"retry"`: lieber eine Warteschlange, die waechst, als ein Beleg, der
   * verschwindet.
   */
  send(entry: OutboxEntry): Promise<{ readonly result: "ok" | "retry" | "rejected"; readonly error?: string }>;
}

export interface FlushResult {
  readonly state: OutboxState;
  readonly sent: number;
  readonly failed: number;
  readonly rejected: number;
}

/**
 * Faellige Eintraege uebertragen.
 *
 * Bricht beim ersten `retry` innerhalb einer Art *nicht* ab, sondern
 * ueberspringt nur die restlichen Eintraege derselben Art - sonst wuerde ein
 * einzelner haengender Beleg alle spaeteren blockieren, und die
 * Reihenfolgegarantie fuer Belege gilt eben nur unter Belegen.
 */
export async function flush(
  state: OutboxState,
  transport: SyncTransport,
  now: string,
  limit = 25,
): Promise<FlushResult> {
  let current = state;
  let sent = 0;
  let failed = 0;
  let rejected = 0;
  const blocked = new Set<OutboxKind>();

  for (const entry of due(state, now, limit)) {
    if (blocked.has(entry.kind)) continue;

    let outcome: { result: "ok" | "retry" | "rejected"; error?: string };
    try {
      outcome = await transport.send(entry);
    } catch (error) {
      outcome = { result: "retry", error: (error as Error)?.message ?? String(error) };
    }

    if (outcome.result === "ok") {
      current = acknowledge(current, entry.key);
      sent++;
    } else if (outcome.result === "rejected") {
      current = acknowledge(current, entry.key);
      rejected++;
    } else {
      current = reschedule(current, entry.key, outcome.error ?? "unbekannter Fehler", now);
      failed++;
      blocked.add(entry.kind);
    }
  }

  return { state: current, sent, failed, rejected };
}
