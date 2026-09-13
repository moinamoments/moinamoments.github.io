/**
 * Zeit und Ids als einspeisbare Abhaengigkeiten.
 *
 * Eine Kasse darf nicht direkt `Date.now()` und `crypto.randomUUID()` im
 * Domaenencode aufrufen: Belegzeiten und Ids muessen im Test reproduzierbar
 * sein, und die TSE liefert ihre eigenen Zeitstempel, die mit denen der Kasse
 * zusammenpassen muessen.
 */

export interface Clock {
  /** Aktueller Zeitpunkt als ISO-8601 mit Offset. */
  now(): string;
}

export interface IdFactory {
  (): string;
}

/**
 * ISO-8601 mit Offset der angegebenen Zeitzone.
 *
 * Belege tragen die Ortszeit mit Offset, nicht UTC: der Bon zeigt dem Kunden
 * die Uhrzeit, die er auf seiner Uhr sieht, und der Offset macht die Angabe
 * trotzdem eindeutig - auch ueber die Sommerzeitumstellung hinweg.
 */
export function isoWithOffset(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const local = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;

  // Offset aus der Differenz zwischen Ortszeit und UTC derselben Sekunde.
  const asUtc = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(hour),
    Number(get("minute")),
    Number(get("second")),
  );
  const offsetMinutes = Math.round((asUtc - date.getTime() - date.getMilliseconds() * -0) / 60000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${local}${offset}`;
}

/** Systemuhr in der Zeitzone des Mandanten. */
export function systemClock(timeZone = "Europe/Berlin"): Clock {
  return { now: () => isoWithOffset(new Date(), timeZone) };
}

/** Feste Uhr fuer Tests; `advance` schiebt sie weiter. */
export function fixedClock(start: string): Clock & { advance(seconds: number): void } {
  let current = new Date(start);
  return {
    now: () => current.toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    advance(seconds: number) {
      current = new Date(current.getTime() + seconds * 1000);
    },
  };
}

/** Ids aus der Kryptobibliothek der Plattform. */
export const uuidFactory: IdFactory = () => globalThis.crypto.randomUUID();

/** Durchzaehlende Ids fuer Tests: `t-1`, `t-2`, ... */
export function sequentialIds(prefix = "id"): IdFactory {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
