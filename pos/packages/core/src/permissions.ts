/**
 * Rollen und Rechte.
 *
 * Eine Kasse wird von Leuten bedient, die nicht alle alles duerfen. Ein
 * Aushilfsverkaeufer soll kassieren koennen - er soll nicht den Tagesabschluss
 * machen, Geld entnehmen oder Belege stornieren. Das ist keine
 * Misstrauensfrage: Storno und Entnahme sind die beiden Wege, auf denen Geld
 * aus einer Kasse verschwindet, ohne dass es auffaellt. Wer sie nicht braucht,
 * bekommt sie nicht.
 *
 * ## Die Systematik: Rolle als Voreinstellung, Abweichungen je Bediener
 *
 * Reine Rollen reichen in der Praxis nicht. Es gibt immer den Mitarbeiter, der
 * die Artikel pflegen darf, aber weiterhin nicht stornieren soll - und fuer den
 * legt man keine eigene Rolle an. Umgekehrt fuehrt eine Kasse mit frei
 * zusammengeklickten Rechten je Person dazu, dass nach einem halben Jahr
 * niemand mehr weiss, wer was darf.
 *
 * Deshalb dasselbe Modell, das SumUp, Zettle, Lightspeed und die uebrigen
 * verwenden, und aus demselben Grund:
 *
 *   1. **Drei Rollen als Voreinstellung.** Mitarbeiter, Schichtleitung,
 *      Inhaber. Damit ist ein neuer Bediener in einem Griff eingerichtet, und
 *      die Voreinstellung ist die sichere.
 *   2. **Einzelne Abweichungen je Bediener.** Ein Recht kann zusaetzlich
 *      erteilt oder weggenommen werden (`permissionOverrides`). Die Rolle
 *      bleibt sichtbar, die Abweichung ist die Ausnahme und als solche
 *      erkennbar.
 *   3. **Keine Rechteerhoehung.** Niemand kann ein Recht erteilen, das er
 *      selbst nicht hat. Ohne diese Regel ist jedes Rechtesystem in zwei
 *      Schritten ausgehebelt.
 *   4. **Der letzte Inhaber bleibt Inhaber.** Sonst steht der Betrieb ohne
 *      Admin da und kommt an seine eigenen Einstellungen nicht mehr heran.
 *
 * Ausdruecklich **keine** Sicherheit gegen einen Angreifer mit dem Geraet in
 * der Hand: eine PIN am Telefon haelt einen Mitarbeiter davon ab, etwas zu tun,
 * was er nicht soll. Sie haelt niemanden ab, der die Datenbank ausliest. Fuer
 * die Trennung von Mandanten im Server gilt das nicht - dort entscheidet der
 * Server, nicht das Geraet.
 */

// `Allowed` ist derselbe Begriff wie bei den Obergrenzen: erlaubt, oder
// abgelehnt mit Begruendung. Zwei Typen fuer dieselbe Sache waeren der Anfang
// von zwei Arten, Ablehnungen zu behandeln.
import type { Allowed } from "./limits.ts";
import type { User, UserRole } from "./model.ts";

export class PermissionError extends Error {}

/**
 * Was in der Kasse getan werden kann.
 *
 * Absichtlich feingliedrig: "Kassieren" und "Stornieren" sind verschiedene
 * Dinge, auch wenn beide den Kassenbildschirm benutzen. Und "Artikel pflegen"
 * ist getrennt von "Einstellungen aendern", weil genau diese Trennung der
 * haeufigste Wunsch ist.
 */
export type Capability =
  /** Verkaufen, bezahlen, Beleg erstellen. */
  | "SELL"
  /** Pfand zurueckzahlen. */
  | "REFUND_DEPOSIT"
  /** Beleg ganz oder teilweise stornieren und auszahlen. */
  | "VOID_RECEIPT"
  /** Rabatt auf Position oder Beleg geben. */
  | "DISCOUNT"
  /** Geld entnehmen, einlegen, Transit buchen. */
  | "CASH_MOVEMENT"
  /** Tag eroeffnen mit gezaehltem Anfangsbestand. */
  | "OPEN_DAY"
  /** Kassenabschluss erstellen. */
  | "CLOSE_DAY"
  /** Warengruppen anlegen und aendern. */
  | "MANAGE_CATEGORIES"
  /** Artikel und Pfandartikel anlegen und aendern. */
  | "MANAGE_PRODUCTS"
  /** Preise aendern. Getrennt vom Anlegen - das ist der haeufigste Wunsch. */
  | "CHANGE_PRICES"
  /** Bestand buchen: Wareneingang, Zaehlung, Schwund. */
  | "MANAGE_STOCK"
  /** Betriebsdaten, Drucker, TSE einstellen. */
  | "MANAGE_SETTINGS"
  /** Kassen anlegen, benennen, deaktivieren. */
  | "MANAGE_DEVICES"
  /** Bediener anlegen, Rolle aendern, PIN setzen, Rechte abweichen lassen. */
  | "MANAGE_USERS"
  /** Belege und Berichte ansehen. */
  | "VIEW_REPORTS"
  /** DSFinV-K, DATEV, Lexware ausgeben. */
  | "EXPORT_DATA";

/** Alle Rechte, in der Reihenfolge, in der sie in der Oberflaeche stehen. */
export const ALL_CAPABILITIES: readonly Capability[] = [
  "SELL",
  "REFUND_DEPOSIT",
  "VOID_RECEIPT",
  "DISCOUNT",
  "CASH_MOVEMENT",
  "OPEN_DAY",
  "CLOSE_DAY",
  "MANAGE_CATEGORIES",
  "MANAGE_PRODUCTS",
  "CHANGE_PRICES",
  "MANAGE_STOCK",
  "VIEW_REPORTS",
  "EXPORT_DATA",
  "MANAGE_SETTINGS",
  "MANAGE_DEVICES",
  "MANAGE_USERS",
];

/** Klartext fuer Meldungen und die Rechteuebersicht. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  SELL: "Kassieren",
  REFUND_DEPOSIT: "Pfand zurueckzahlen",
  VOID_RECEIPT: "Stornieren und auszahlen",
  DISCOUNT: "Rabatt geben",
  CASH_MOVEMENT: "Geld entnehmen oder einlegen",
  OPEN_DAY: "Tag eroeffnen",
  CLOSE_DAY: "Kassenabschluss",
  MANAGE_CATEGORIES: "Warengruppen anlegen und aendern",
  MANAGE_PRODUCTS: "Artikel anlegen und aendern",
  CHANGE_PRICES: "Preise aendern",
  MANAGE_STOCK: "Bestand buchen",
  VIEW_REPORTS: "Berichte ansehen",
  EXPORT_DATA: "Daten exportieren",
  MANAGE_SETTINGS: "Einstellungen aendern",
  MANAGE_DEVICES: "Kassen verwalten",
  MANAGE_USERS: "Bediener verwalten",
};

/**
 * Kurze Begruendung, warum ein Recht heikel ist.
 *
 * Steht in der Oberflaeche neben dem Schalter. Wer ein Recht erteilt, soll
 * wissen, was er erteilt - "Stornieren" klingt harmlos, ist aber der Weg, auf
 * dem Geld die Kasse verlaesst.
 */
export const CAPABILITY_NOTES: Partial<Record<Capability, string>> = {
  VOID_RECEIPT: "Damit kann Geld ausgezahlt werden. Nur an Personen, die Bargeld verantworten.",
  CASH_MOVEMENT: "Damit kann Geld aus der Kasse entnommen werden.",
  DISCOUNT: "Damit kann der Preis gesenkt werden, ohne dass es als Storno auffaellt.",
  CHANGE_PRICES: "Aendert den Preis fuer alle kuenftigen Verkaeufe.",
  CLOSE_DAY: "Ein Abschluss laesst sich nicht zuruecknehmen.",
  MANAGE_USERS: "Damit koennen weitere Rechte vergeben werden.",
  EXPORT_DATA: "Der Export enthaelt alle Umsaetze des Zeitraums.",
};

/**
 * Rechte je Rolle - die Voreinstellung.
 *
 * `CASHIER` ist der Mitarbeiter am Stand: verkaufen, Pfand zuruecknehmen, Tag
 * eroeffnen. Pfandruecknahme ist dabei, weil sie zum Verkauf gehoert und der
 * Betrag durch das Pfand des Artikels gedeckelt ist - im Unterschied zu einem
 * Storno, dessen Betrag frei ist.
 *
 * `MANAGER` fuehrt die Schicht: zusaetzlich stornieren, Rabatt geben, Geld
 * bewegen, abschliessen, Warengruppen und Artikel pflegen, Bestand buchen,
 * Berichte lesen. **Nicht** dabei: Einstellungen, Kassen, Bediener - das sind
 * die Dinge, die den Betrieb als Ganzes betreffen.
 *
 * `OWNER` ist der Admin: alles.
 */
export const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  CASHIER: ["SELL", "REFUND_DEPOSIT", "OPEN_DAY"],
  MANAGER: [
    "SELL",
    "REFUND_DEPOSIT",
    "VOID_RECEIPT",
    "DISCOUNT",
    "CASH_MOVEMENT",
    "OPEN_DAY",
    "CLOSE_DAY",
    "MANAGE_CATEGORIES",
    "MANAGE_PRODUCTS",
    "CHANGE_PRICES",
    "MANAGE_STOCK",
    "VIEW_REPORTS",
  ],
  OWNER: [...ALL_CAPABILITIES],
};

export const ROLE_LABELS: Record<UserRole, string> = {
  OWNER: "Inhaber / Admin",
  MANAGER: "Schichtleitung",
  CASHIER: "Mitarbeiter",
};

export const ROLE_ORDER: readonly UserRole[] = ["CASHIER", "MANAGER", "OWNER"];

/** Rechte einer Rolle, fuer die Uebersicht in den Einstellungen. */
export function capabilitiesOf(role: UserRole): readonly Capability[] {
  return ROLE_CAPABILITIES[role];
}

/** Darf diese Rolle das - ohne Abweichungen zu beruecksichtigen? */
export function roleCan(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

type UserLike = Pick<User, "role" | "active"> & { readonly permissionOverrides?: Readonly<Record<string, boolean>> | null };

/**
 * Tatsaechliche Rechte eines Bedieners: Rolle plus Abweichungen.
 *
 * Ein deaktivierter Bediener hat keine Rechte - auch nicht zum Kassieren. Wer
 * aus dem Betrieb ausgeschieden ist, soll keine Belege mehr erzeugen koennen,
 * und der Weg dazu ist das Deaktivieren, nicht das Loeschen (alte Belege
 * verweisen auf ihn).
 */
export function effectiveCapabilities(user: UserLike): readonly Capability[] {
  if (!user.active) return [];
  const overrides = user.permissionOverrides ?? {};
  return ALL_CAPABILITIES.filter((capability) => {
    const override = overrides[capability];
    return override === undefined ? roleCan(user.role, capability) : override;
  });
}

/** Darf dieser Bediener das? */
export function userCan(user: UserLike, capability: Capability): boolean {
  if (!user.active) return false;
  const override = user.permissionOverrides?.[capability];
  return override === undefined ? roleCan(user.role, capability) : override;
}

/** Wie `userCan`, wirft aber mit einer Meldung fuer den Bediener. */
export function requireCapability(user: UserLike & Pick<User, "name">, capability: Capability): void {
  if (userCan(user, capability)) return;
  if (!user.active) {
    throw new PermissionError(`Der Zugang von ${user.name} ist deaktiviert.`);
  }
  throw new PermissionError(
    `"${CAPABILITY_LABELS[capability]}" ist fuer ${user.name} nicht freigegeben. Der Inhaber kann das Recht in den Einstellungen erteilen.`,
  );
}

/** Weicht dieses Recht von der Rolle ab? Fuer die Anzeige der Ausnahme. */
export function isOverridden(user: UserLike, capability: Capability): boolean {
  const override = user.permissionOverrides?.[capability];
  return override !== undefined && override !== roleCan(user.role, capability);
}

/** Abweichungen, die tatsaechlich etwas aendern - fuer die Uebersicht. */
export function listOverrides(user: UserLike): { capability: Capability; granted: boolean }[] {
  return ALL_CAPABILITIES.filter((capability) => isOverridden(user, capability)).map((capability) => ({
    capability,
    granted: userCan(user, capability),
  }));
}

/**
 * Darf `actor` dem Bediener `target` das Recht `capability` erteilen oder
 * nehmen?
 *
 * Die Regeln, in dieser Reihenfolge:
 *
 *   1. Nur wer Bediener verwalten darf, aendert Rechte.
 *   2. Erteilen kann man nur, was man selbst hat. Sonst reicht ein
 *      Schichtleiter mit Bedienerverwaltung, um sich selbst zum Inhaber zu
 *      machen - in zwei Schritten.
 *   3. Sich selbst kann man das Verwalten von Bedienern nicht nehmen, wenn man
 *      der letzte ist, der es hat.
 */
export function canSetCapability(
  actor: UserLike & Pick<User, "id">,
  target: Pick<User, "id" | "role">,
  capability: Capability,
  granted: boolean,
  allUsers: readonly (UserLike & Pick<User, "id">)[],
): Allowed {
  if (!userCan(actor, "MANAGE_USERS")) {
    return { ok: false, reason: "Nur wer Bediener verwalten darf, kann Rechte aendern." };
  }
  if (granted && !userCan(actor, capability)) {
    return {
      ok: false,
      reason: `"${CAPABILITY_LABELS[capability]}" kann nicht erteilt werden - das Recht fehlt Ihnen selbst.`,
    };
  }
  if (!granted && capability === "MANAGE_USERS" && target.id === actor.id) {
    const others = allUsers.filter((user) => user.id !== actor.id && userCan(user, "MANAGE_USERS"));
    if (others.length === 0) {
      return {
        ok: false,
        reason: "Sie sind der letzte, der Bediener verwalten darf - dieses Recht kann sich nicht selbst entziehen.",
      };
    }
  }
  return { ok: true };
}

/**
 * Abweichung setzen und das Ergebnis zurueckgeben.
 *
 * Stimmt die Abweichung mit der Rolle ueberein, wird sie *entfernt* statt
 * gespeichert. Sonst sammeln sich Abweichungen an, die keine sind, und die
 * Uebersicht zeigt Ausnahmen, wo keine sind.
 */
export function withCapability(
  user: UserLike,
  capability: Capability,
  granted: boolean,
): Readonly<Record<string, boolean>> {
  const overrides: Record<string, boolean> = { ...(user.permissionOverrides ?? {}) };
  if (roleCan(user.role, capability) === granted) delete overrides[capability];
  else overrides[capability] = granted;
  return overrides;
}

/**
 * Darf `actor` die Rolle von `target` auf `newRole` setzen?
 *
 * Eine Rolle zu vergeben heisst, alle ihre Rechte zu vergeben - also gilt
 * dieselbe Regel: keine Rolle, deren Rechte man selbst nicht hat.
 */
export function canAssignRole(
  actor: UserLike & Pick<User, "id">,
  target: Pick<User, "id" | "role">,
  newRole: UserRole,
  allUsers: readonly (UserLike & Pick<User, "id" | "role">)[],
): Allowed {
  if (!userCan(actor, "MANAGE_USERS")) {
    return { ok: false, reason: "Nur wer Bediener verwalten darf, kann Rollen aendern." };
  }

  const missing = ROLE_CAPABILITIES[newRole].filter((capability) => !userCan(actor, capability));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Die Rolle "${ROLE_LABELS[newRole]}" umfasst Rechte, die Ihnen selbst fehlen: ${missing
        .map((capability) => CAPABILITY_LABELS[capability])
        .join(", ")}.`,
    };
  }

  if (target.id === actor.id && !ROLE_CAPABILITIES[newRole].includes("MANAGE_USERS")) {
    const others = allUsers.filter((user) => user.id !== actor.id && userCan(user, "MANAGE_USERS"));
    if (others.length === 0) {
      return {
        ok: false,
        reason: "Es muss mindestens ein Bediener die Bedienerverwaltung behalten - sonst kommt niemand mehr an die Einstellungen.",
      };
    }
  }
  return { ok: true };
}

/** Darf dieser Bediener deaktiviert werden? */
export function canDeactivateUser(
  actor: UserLike & Pick<User, "id">,
  target: Pick<User, "id" | "role">,
  allUsers: readonly (UserLike & Pick<User, "id">)[],
): Allowed {
  if (!userCan(actor, "MANAGE_USERS")) {
    return { ok: false, reason: "Nur wer Bediener verwalten darf, kann Zugaenge deaktivieren." };
  }
  const others = allUsers.filter((user) => user.id !== target.id && userCan(user, "MANAGE_USERS"));
  if (others.length === 0) {
    return { ok: false, reason: "Der letzte Bediener mit Bedienerverwaltung kann nicht deaktiviert werden." };
  }
  return { ok: true };
}

/**
 * Vorschlag fuer einen neuen Bediener.
 *
 * Die sichere Voreinstellung ist die kleinste Rolle. Ein Bediener, der
 * versehentlich mehr darf als gedacht, faellt niemandem auf; einer, der zu
 * wenig darf, meldet sich sofort.
 */
export function defaultRoleForNewUser(): UserRole {
  return "CASHIER";
}
