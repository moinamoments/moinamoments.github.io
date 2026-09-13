import { test } from "node:test";
import assert from "node:assert/strict";
import type { User } from "./model.ts";
import {
  ALL_CAPABILITIES,
  CAPABILITY_LABELS,
  PermissionError,
  ROLE_CAPABILITIES,
  ROLE_LABELS,
  canAssignRole,
  canDeactivateUser,
  canSetCapability,
  capabilitiesOf,
  defaultRoleForNewUser,
  effectiveCapabilities,
  isOverridden,
  listOverrides,
  requireCapability,
  roleCan,
  userCan,
  withCapability,
} from "./permissions.ts";

function user(over: Partial<User> = {}): User {
  return {
    id: "u1",
    tenantId: "t1",
    name: "Bediener",
    role: "CASHIER",
    permissionOverrides: null,
    pinHash: null,
    active: true,
    ...over,
  };
}

const cashier = user({ id: "u-kasse", name: "Aushilfe", role: "CASHIER" });
const manager = user({ id: "u-schicht", name: "Schichtleitung", role: "MANAGER" });
const owner = user({ id: "u-chef", name: "Inhaberin", role: "OWNER" });

test("jedes Recht hat einen Klartext und steht in der Liste", () => {
  for (const capability of ALL_CAPABILITIES) {
    assert.ok(CAPABILITY_LABELS[capability], `Klartext fuer ${capability} fehlt`);
  }
  // Die Liste ist vollstaendig - sonst fehlt ein Recht in der Oberflaeche.
  assert.equal(new Set(ALL_CAPABILITIES).size, ALL_CAPABILITIES.length, "kein Recht doppelt");
  for (const role of ["CASHIER", "MANAGER", "OWNER"] as const) {
    for (const capability of ROLE_CAPABILITIES[role]) {
      assert.ok(ALL_CAPABILITIES.includes(capability), `${capability} fehlt in ALL_CAPABILITIES`);
    }
    assert.ok(ROLE_LABELS[role]);
  }
});

test("Mitarbeiter darf kassieren und Pfand zurueckzahlen, aber nicht stornieren", () => {
  assert.equal(userCan(cashier, "SELL"), true);
  assert.equal(userCan(cashier, "REFUND_DEPOSIT"), true);
  assert.equal(userCan(cashier, "OPEN_DAY"), true);

  // Storno und Entnahme sind die beiden Wege, auf denen Geld verschwindet.
  assert.equal(userCan(cashier, "VOID_RECEIPT"), false);
  assert.equal(userCan(cashier, "CASH_MOVEMENT"), false);
  assert.equal(userCan(cashier, "DISCOUNT"), false);
  assert.equal(userCan(cashier, "CLOSE_DAY"), false);
  assert.equal(userCan(cashier, "MANAGE_PRODUCTS"), false);
  assert.equal(userCan(cashier, "MANAGE_SETTINGS"), false);
});

test("Schichtleitung fuehrt die Schicht, verwaltet aber nicht den Betrieb", () => {
  assert.equal(userCan(manager, "VOID_RECEIPT"), true);
  assert.equal(userCan(manager, "CLOSE_DAY"), true);
  assert.equal(userCan(manager, "MANAGE_PRODUCTS"), true);
  assert.equal(userCan(manager, "MANAGE_CATEGORIES"), true);
  assert.equal(userCan(manager, "MANAGE_STOCK"), true);

  assert.equal(userCan(manager, "MANAGE_SETTINGS"), false);
  assert.equal(userCan(manager, "MANAGE_DEVICES"), false);
  assert.equal(userCan(manager, "MANAGE_USERS"), false);
  assert.equal(userCan(manager, "EXPORT_DATA"), false);
});

test("Inhaber darf alles", () => {
  for (const capability of ALL_CAPABILITIES) {
    assert.equal(userCan(owner, capability), true, `Inhaber darf ${capability} nicht`);
  }
  assert.deepEqual(capabilitiesOf("OWNER"), ALL_CAPABILITIES);
});

test("ein deaktivierter Zugang darf nichts - auch nicht kassieren", () => {
  const gone = user({ role: "OWNER", active: false });
  for (const capability of ALL_CAPABILITIES) {
    assert.equal(userCan(gone, capability), false);
  }
  assert.deepEqual(effectiveCapabilities(gone), []);
  assert.throws(() => requireCapability(gone, "SELL"), PermissionError);
  assert.throws(() => requireCapability(gone, "SELL"), /deaktiviert/);
});

// --- Abweichungen je Bediener --------------------------------------------

test("einzelnes Recht zusaetzlich erteilen: Artikel pflegen, aber nicht stornieren", () => {
  // Genau der Fall, fuer den eine Rolle allein nicht reicht.
  const overrides = withCapability(cashier, "MANAGE_PRODUCTS", true);
  const mitPflege = user({ ...cashier, permissionOverrides: overrides });

  assert.equal(userCan(mitPflege, "MANAGE_PRODUCTS"), true);
  assert.equal(userCan(mitPflege, "MANAGE_CATEGORIES"), false, "nur das eine Recht, nicht die ganze Rolle");
  assert.equal(userCan(mitPflege, "VOID_RECEIPT"), false);
  assert.equal(userCan(mitPflege, "SELL"), true, "die Rolle wirkt weiter");
  assert.equal(mitPflege.role, "CASHIER", "die Rolle bleibt sichtbar");
});

test("einzelnes Recht wegnehmen: Schichtleitung ohne Rabatt", () => {
  const ohneRabatt = user({ ...manager, permissionOverrides: withCapability(manager, "DISCOUNT", false) });
  assert.equal(userCan(ohneRabatt, "DISCOUNT"), false);
  assert.equal(userCan(ohneRabatt, "VOID_RECEIPT"), true, "alles andere bleibt");
});

test("eine Abweichung, die der Rolle entspricht, wird nicht gespeichert", () => {
  // Sonst sammeln sich Ausnahmen an, die keine sind.
  assert.deepEqual(withCapability(cashier, "SELL", true), {}, "Kassieren hat die Rolle schon");
  assert.deepEqual(withCapability(manager, "VOID_RECEIPT", true), {});

  // Erteilen und wieder zurueck: die Abweichung verschwindet.
  const granted = withCapability(cashier, "MANAGE_PRODUCTS", true);
  assert.deepEqual(granted, { MANAGE_PRODUCTS: true });
  const withDeviation = user({ ...cashier, permissionOverrides: granted });
  assert.deepEqual(withCapability(withDeviation, "MANAGE_PRODUCTS", false), {});
});

test("Abweichungen sind als Ausnahme erkennbar", () => {
  const special = user({
    ...cashier,
    permissionOverrides: { MANAGE_PRODUCTS: true, SELL: false },
  });
  assert.equal(isOverridden(special, "MANAGE_PRODUCTS"), true);
  assert.equal(isOverridden(special, "SELL"), true);
  assert.equal(isOverridden(special, "VOID_RECEIPT"), false);

  assert.deepEqual(listOverrides(special), [
    { capability: "SELL", granted: false },
    { capability: "MANAGE_PRODUCTS", granted: true },
  ]);
});

test("effectiveCapabilities zaehlt Rolle plus Abweichungen zusammen", () => {
  const special = user({ ...cashier, permissionOverrides: { MANAGE_PRODUCTS: true, OPEN_DAY: false } });
  assert.deepEqual([...effectiveCapabilities(special)].sort(), ["MANAGE_PRODUCTS", "REFUND_DEPOSIT", "SELL"].sort());
});

// --- Keine Rechteerhoehung ----------------------------------------------

test("niemand kann ein Recht erteilen, das er selbst nicht hat", () => {
  // Eine Schichtleitung mit Bedienerverwaltung koennte sich sonst in zwei
  // Schritten zum Inhaber machen.
  const managerWithUsers = user({ ...manager, permissionOverrides: { MANAGE_USERS: true } });
  assert.equal(userCan(managerWithUsers, "MANAGE_USERS"), true);

  const denied = canSetCapability(managerWithUsers, cashier, "MANAGE_SETTINGS", true, [managerWithUsers, cashier]);
  assert.equal(denied.ok, false);
  assert.ok(denied.ok === false && denied.reason.includes("fehlt Ihnen selbst"));

  // Was er selbst hat, darf er erteilen.
  const allowed = canSetCapability(managerWithUsers, cashier, "MANAGE_PRODUCTS", true, [managerWithUsers, cashier]);
  assert.equal(allowed.ok, true);
});

test("Wegnehmen ist auch ohne eigenes Recht moeglich", () => {
  // Ein Recht zu entziehen erhoeht niemanden - das muss immer gehen.
  const managerWithUsers = user({ ...manager, permissionOverrides: { MANAGE_USERS: true } });
  const target = user({ ...cashier, permissionOverrides: { MANAGE_SETTINGS: true } });
  assert.equal(canSetCapability(managerWithUsers, target, "MANAGE_SETTINGS", false, [managerWithUsers, target]).ok, true);
});

test("ohne Bedienerverwaltung aendert niemand Rechte", () => {
  const denied = canSetCapability(manager, cashier, "SELL", true, [manager, cashier]);
  assert.equal(denied.ok, false);
  assert.ok(denied.ok === false && denied.reason.includes("Bediener verwalten"));
});

test("der letzte mit Bedienerverwaltung kann sie sich nicht entziehen", () => {
  const alone = canSetCapability(owner, owner, "MANAGE_USERS", false, [owner, manager, cashier]);
  assert.equal(alone.ok, false);
  assert.ok(alone.ok === false && alone.reason.includes("letzte"));

  // Mit einem zweiten Inhaber geht es.
  const second = user({ id: "u-chef2", name: "Zweiter Inhaber", role: "OWNER" });
  assert.equal(canSetCapability(owner, owner, "MANAGE_USERS", false, [owner, second]).ok, true);
});

// --- Rollen vergeben ----------------------------------------------------

test("Rolle vergeben nur bis zur eigenen Reichweite", () => {
  assert.equal(canAssignRole(owner, cashier, "MANAGER", [owner, cashier]).ok, true);
  assert.equal(canAssignRole(owner, cashier, "OWNER", [owner, cashier]).ok, true);

  const managerWithUsers = user({ ...manager, permissionOverrides: { MANAGE_USERS: true } });
  const denied = canAssignRole(managerWithUsers, cashier, "OWNER", [managerWithUsers, cashier]);
  assert.equal(denied.ok, false);
  assert.ok(denied.ok === false && denied.reason.includes("fehlen"));
  // Die eigene Rolle darf er weitergeben.
  assert.equal(canAssignRole(managerWithUsers, cashier, "MANAGER", [managerWithUsers, cashier]).ok, true);
});

test("der letzte Verwalter kann sich nicht selbst herabsetzen", () => {
  const denied = canAssignRole(owner, owner, "CASHIER", [owner, manager, cashier]);
  assert.equal(denied.ok, false);
  assert.ok(denied.ok === false && denied.reason.includes("mindestens ein"));

  const second = user({ id: "u-chef2", name: "Zweite", role: "OWNER" });
  assert.equal(canAssignRole(owner, owner, "CASHIER", [owner, second]).ok, true);
});

test("ohne Bedienerverwaltung keine Rollenaenderung", () => {
  assert.equal(canAssignRole(cashier, manager, "CASHIER", [cashier, manager]).ok, false);
});

// --- Deaktivieren -------------------------------------------------------

test("der letzte Verwalter bleibt aktiv", () => {
  const denied = canDeactivateUser(owner, owner, [owner, manager, cashier]);
  assert.equal(denied.ok, false);
  assert.ok(denied.ok === false && denied.reason.includes("letzte"));

  assert.equal(canDeactivateUser(owner, cashier, [owner, manager, cashier]).ok, true);

  const second = user({ id: "u-chef2", name: "Zweite", role: "OWNER" });
  assert.equal(canDeactivateUser(owner, owner, [owner, second]).ok, true);
});

test("requireCapability nennt Recht und Namen", () => {
  assert.doesNotThrow(() => requireCapability(cashier, "SELL"));
  assert.throws(() => requireCapability(cashier, "VOID_RECEIPT"), PermissionError);
  assert.throws(() => requireCapability(cashier, "VOID_RECEIPT"), /Aushilfe/);
  assert.throws(() => requireCapability(cashier, "VOID_RECEIPT"), /Stornieren/);
});

test("neue Bediener bekommen die kleinste Rolle", () => {
  // Ein Bediener, der versehentlich mehr darf, faellt niemandem auf.
  assert.equal(defaultRoleForNewUser(), "CASHIER");
  assert.equal(roleCan(defaultRoleForNewUser(), "VOID_RECEIPT"), false);
});
