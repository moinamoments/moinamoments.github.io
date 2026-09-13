/**
 * Mandantentrennung.
 *
 * Das Risiko, das ein Produkt beendet: Kunde A sieht die Umsaetze von Kunde B.
 * Passiert das einmal nachweisbar, ist es eine meldepflichtige Datenschutz-
 * verletzung nach Art. 33 DSGVO und das Ende des Vertrauens - beides laesst
 * sich nicht nachtraeglich reparieren.
 *
 * ## Wo die Trennung wirklich stattfindet
 *
 * Wichtig ist, wo die Trennung **durchgesetzt** wird, nicht wo sie
 * hingeschrieben ist:
 *
 *   - **Auf dem Geraet** liegt praktisch immer nur ein Mandant. Die Pruefungen
 *     hier sind trotzdem scharf, weil derselbe Code im Server laeuft und weil
 *     ein Geraetewechsel oder ein fehlerhafter Abgleich Daten zweier Mandanten
 *     zusammenbringen kann.
 *   - **Im Server** ist die Trennung Pflicht und darf **niemals** von einer
 *     Mandanten-Id abhaengen, die der Client mitschickt. Wer dem Client glaubt,
 *     hat keine Mandantentrennung, sondern eine Bitte. Der Server leitet die
 *     Mandanten-Id aus dem Zugangstoken ab und filtert jede Abfrage damit -
 *     zusaetzlich zu einer Pruefung auf Datenbankebene (bei PostgreSQL: Row
 *     Level Security), damit eine vergessene `WHERE`-Bedingung kein Datenleck
 *     ist, sondern eine leere Antwort.
 *
 * Dieses Modul liefert die Pruefungen, die im Code ueberall dort stehen, wo
 * Daten aus verschiedenen Quellen zusammenkommen. Sie sind absichtlich
 * unbequem: sie werfen, statt still zu filtern. Ein stiller Filter versteckt
 * den Fehler, ein Abbruch zeigt ihn beim ersten Test.
 */

export class TenantIsolationError extends Error {
  readonly expectedTenantId: string;
  readonly actualTenantId: string | null | undefined;

  constructor(message: string, expectedTenantId: string, actualTenantId: string | null | undefined) {
    super(message);
    this.name = "TenantIsolationError";
    this.expectedTenantId = expectedTenantId;
    this.actualTenantId = actualTenantId;
  }
}

/** Alles, was zu einem Mandanten gehoert. */
export interface TenantScoped {
  readonly tenantId: string;
}

/**
 * Pruefen, dass ein Datensatz zum erwarteten Mandanten gehoert.
 *
 * Die Meldung nennt **keine** Daten des fremden Mandanten - nur die Ids. Eine
 * Fehlermeldung, die den Namen eines anderen Betriebs enthaelt, waere selbst
 * schon ein kleines Datenleck, und Fehlermeldungen landen in Protokollen.
 */
export function assertSameTenant<T extends TenantScoped>(entity: T, tenantId: string, what = "Der Datensatz"): T {
  if (entity.tenantId !== tenantId) {
    throw new TenantIsolationError(
      `${what} gehoert zu einem anderen Mandanten und wurde nicht verarbeitet.`,
      tenantId,
      entity.tenantId,
    );
  }
  return entity;
}

/** Wie `assertSameTenant`, aber fuer eine Liste. */
export function assertAllSameTenant<T extends TenantScoped>(
  entities: readonly T[],
  tenantId: string,
  what = "Ein Datensatz",
): readonly T[] {
  for (const entity of entities) assertSameTenant(entity, tenantId, what);
  return entities;
}

/**
 * Fremde Datensaetze aussortieren, statt zu werfen.
 *
 * Nur fuer Anzeigen, bei denen ein Abbruch schlimmer waere als eine
 * unvollstaendige Liste - etwa der Kassenbildschirm. Der Aufrufer bekommt die
 * Zahl der ausgesorteten Datensaetze zurueck und **muss** sie melden: eine
 * stillschweigend gefilterte Liste versteckt einen Fehler, den jemand beheben
 * muss.
 */
export function filterToTenant<T extends TenantScoped>(
  entities: readonly T[],
  tenantId: string,
): { readonly kept: T[]; readonly removed: number } {
  const kept = entities.filter((entity) => entity.tenantId === tenantId);
  return { kept, removed: entities.length - kept.length };
}

/**
 * Die Mandanten-Id einer Sitzung.
 *
 * Der Punkt dieses Typs ist, dass er **nicht** aus einer Anfrage kommt. Er
 * entsteht beim Anmelden aus dem, was das Geraet oder der Server ueber den
 * Benutzer weiss - und wird von dort nach unten durchgegeben. Ein Feld
 * `tenantId` in einem Nutzdatensatz, das der Client schickt, wird geprueft,
 * aber niemals als Quelle verwendet.
 */
export interface TenantScope {
  readonly tenantId: string;
  /** Woher die Id stammt - fuer die Pruefung im Test und im Protokoll. */
  readonly source: "device-session" | "access-token";
}

/** Mandantenbereich aus der Sitzung am Geraet. */
export function deviceScope(tenantId: string): TenantScope {
  if (tenantId.trim() === "") throw new TenantIsolationError("Ohne Mandant gibt es keine Sitzung.", "", tenantId);
  return { tenantId, source: "device-session" };
}

/**
 * Mandantenbereich aus einem Zugangstoken.
 *
 * Bewusst mit dem Hinweis versehen: der Aufrufer muss das Token **geprueft**
 * haben, bevor er hier hereinkommt. Diese Funktion prueft keine Signatur - sie
 * kann es nicht, weil der Schluessel nur dem Server bekannt ist.
 */
export function tokenScope(tenantId: string): TenantScope {
  if (tenantId.trim() === "") {
    throw new TenantIsolationError("Das Zugangstoken nennt keinen Mandanten.", "", tenantId);
  }
  return { tenantId, source: "access-token" };
}

/**
 * SQL-Bedingung fuer den Mandanten.
 *
 * Gibt Bedingung und Parameter getrennt zurueck - nie eine fertige
 * Zeichenkette mit eingesetztem Wert. Das ist der Unterschied zwischen einer
 * Abfrage, die sicher ist, und einer, die sich mit einer Mandanten-Id wie
 * `x' OR '1'='1` aushebeln laesst.
 */
export function tenantCondition(scope: TenantScope, column = "tenant_id"): { sql: string; params: [string] } {
  if (!/^[a-z_][a-z0-9_]*$/i.test(column)) {
    // Der Spaltenname kommt aus dem Code, nicht von aussen. Die Pruefung ist
    // die Zusicherung, dass das so bleibt.
    throw new TenantIsolationError(`"${column}" ist kein zulaessiger Spaltenname.`, scope.tenantId, null);
  }
  return { sql: `${column} = ?`, params: [scope.tenantId] };
}

/**
 * Zwei Mandantenbereiche vergleichen.
 *
 * Gebraucht beim Abgleich mit dem Server: was hereinkommt, muss zu der Sitzung
 * gehoeren, die es angefordert hat. Andernfalls wird es verworfen und gemeldet
 * - nicht gespeichert.
 */
export function sameScope(a: TenantScope, b: TenantScope): boolean {
  return a.tenantId === b.tenantId;
}

/**
 * Pruefen, dass ein Geraet zum Mandanten und zur Betriebsstaette passt.
 *
 * Der Fall, den das abfaengt: ein Geraet wird aus einem Betrieb in einen
 * anderen gegeben, ohne zurueckgesetzt zu werden. Dann liegen zwei Mandanten
 * auf einem Geraet, und der naechste Beleg traegt die falsche Adresse.
 */
export function assertDeviceBelongs(
  device: { readonly tenantId: string; readonly storeId: string },
  scope: TenantScope,
  store: { readonly id: string; readonly tenantId: string },
): void {
  assertSameTenant(device, scope.tenantId, "Die Kasse");
  assertSameTenant(store, scope.tenantId, "Die Betriebsstaette");
  if (device.storeId !== store.id) {
    throw new TenantIsolationError(
      "Die Kasse ist einer anderen Betriebsstaette zugeordnet. Das Geraet muss neu eingerichtet werden.",
      scope.tenantId,
      device.tenantId,
    );
  }
}
