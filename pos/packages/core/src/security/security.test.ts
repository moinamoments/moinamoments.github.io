import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CredentialError,
  MAX_PIN_ATTEMPTS,
  NO_ATTEMPTS,
  PIN_ITERATIONS,
  attemptLogin,
  attemptsLeft,
  describeLoginOutcome,
  formatLockDuration,
  hashPin,
  lockSeconds,
  lockStatus,
  parsePinHash,
  registerFailedAttempt,
  registerSuccessfulAttempt,
  verifyPin,
} from "./credentials.ts";
import {
  TenantIsolationError,
  assertAllSameTenant,
  assertDeviceBelongs,
  assertSameTenant,
  deviceScope,
  filterToTenant,
  sameScope,
  tenantCondition,
  tokenScope,
} from "./tenant.ts";
import {
  AUDIT_LABELS,
  AuditError,
  CRITICAL_EVENTS,
  accessDenied,
  assertNoSecrets,
  buildAuditEntry,
  formatAuditEntry,
  summarizeAudit,
  type AuditEntry,
} from "./audit.ts";

// =========================================================================
// Anmeldung
// =========================================================================

/** Wenige Runden, damit die Tests schnell bleiben - geprueft wird die Logik. */
const FAST = { iterations: 1000 };

test("PIN wird als Pruefwert mit Verfahren, Runden und Salz gespeichert", () => {
  const stored = hashPin("8261", FAST);
  assert.ok(stored.startsWith("pbkdf2$sha256$1000$"));

  const parsed = parsePinHash(stored);
  assert.equal(parsed.iterations, 1000);
  assert.equal(parsed.salt.length, 16);
  assert.equal(parsed.key.length, 32);

  // Die PIN selbst steht nirgends darin.
  assert.equal(stored.includes("8261"), false);
});

test("zwei gleiche PINs ergeben verschiedene Pruefwerte", () => {
  // Das ist der Zweck des Salzes: die Datenbank darf nicht verraten, wer
  // dieselbe PIN benutzt.
  const a = hashPin("8261", FAST);
  const b = hashPin("8261", FAST);
  assert.notEqual(a, b);
  assert.ok(verifyPin("8261", a).ok);
  assert.ok(verifyPin("8261", b).ok);
});

test("schwache PINs werden beim Setzen abgelehnt", () => {
  assert.throws(() => hashPin("1234", FAST), CredentialError);
  assert.throws(() => hashPin("1111", FAST), CredentialError);
  assert.throws(() => hashPin("123", FAST), CredentialError);
  assert.throws(() => hashPin("", FAST), CredentialError);
  assert.throws(() => hashPin("abcd", FAST), CredentialError);
});

test("die richtige PIN wird erkannt, eine falsche nicht", () => {
  const stored = hashPin("8261", FAST);
  assert.equal(verifyPin("8261", stored).ok, true);
  assert.equal(verifyPin("8262", stored).ok, false);
  assert.equal(verifyPin("", stored).ok, false);
  assert.equal(verifyPin("82610", stored).ok, false);
  // Leerzeichen am Rand sollen nicht aussperren.
  assert.equal(verifyPin("  8261  ", stored).ok, true);
});

test("eine bestehende PIN bleibt gueltig, auch wenn die Regeln sich verschaerfen", () => {
  // Sonst sperrt eine neue Regel den Betrieb aus seiner eigenen Kasse aus.
  const stored = hashPin("8261", FAST);
  const weakButExisting = stored.replace(/\$[0-9a-f]+\$[0-9a-f]+$/, (suffix) => suffix);
  assert.equal(verifyPin("8261", weakButExisting).ok, true);
});

test("ein unbrauchbarer Pruefwert sperrt nur diesen Zugang, statt abzustuerzen", () => {
  assert.equal(verifyPin("8261", null).ok, false);
  assert.equal(verifyPin("8261", "").ok, false);
  assert.equal(verifyPin("8261", "kaputt").ok, false);
  assert.equal(verifyPin("8261", "pbkdf2$sha256$1000$zz$zz").ok, false);
  assert.equal(verifyPin("8261", "pbkdf2$sha256$0$aa$bb").ok, false);
  assert.throws(() => parsePinHash("md5$xyz"), CredentialError);
  assert.throws(() => parsePinHash("pbkdf2$sha256$1000$aa"), CredentialError);
});

test("ein mit weniger Runden abgeleiteter Wert wird zum Erneuern gemeldet", () => {
  const old = hashPin("8261", { iterations: 1000 });
  const verification = verifyPin("8261", old);
  assert.equal(verification.ok, true);
  assert.equal(verification.needsRehash, true, "bei der Anmeldung neu ableiten");

  const current = hashPin("8261", { iterations: PIN_ITERATIONS });
  assert.equal(verifyPin("8261", current).needsRehash, false);
});

test("Sperrdauer steigt und ist bei einer Stunde gedeckelt", () => {
  assert.equal(lockSeconds(1), 30);
  assert.equal(lockSeconds(2), 120);
  assert.equal(lockSeconds(3), 600);
  assert.equal(lockSeconds(4), 1800);
  assert.equal(lockSeconds(5), 3600);
  // Eine dauerhafte Sperre wuerde den Betrieb anhalten - dann wird die Kasse
  // umgangen statt benutzt.
  assert.equal(lockSeconds(50), 3600);
  assert.equal(lockSeconds(0), 30);
});

test("nach fuenf Fehlversuchen wird gesperrt", () => {
  const now = "2026-09-26T09:00:00+02:00";
  let state = NO_ATTEMPTS;
  for (let attempt = 1; attempt < MAX_PIN_ATTEMPTS; attempt++) {
    state = registerFailedAttempt(state, now);
    assert.equal(state.lockedUntil, null, `nach ${attempt} Versuchen noch offen`);
    assert.equal(attemptsLeft(state), MAX_PIN_ATTEMPTS - attempt);
  }

  state = registerFailedAttempt(state, now);
  assert.ok(state.lockedUntil, "der fuenfte Fehlversuch sperrt");
  assert.equal(state.lockCount, 1);
  assert.equal(state.failedAttempts, 0, "nach der Sperre wieder volle Versuche");

  const status = lockStatus(state, now);
  assert.equal(status.locked, true);
  assert.equal(status.secondsLeft, 30);
});

test("die Sperre laeuft ab", () => {
  const state = registerFailedAttempt({ failedAttempts: 4, lockCount: 0, lockedUntil: null }, "2026-09-26T09:00:00+02:00");
  assert.equal(lockStatus(state, "2026-09-26T09:00:29+02:00").locked, true);
  assert.equal(lockStatus(state, "2026-09-26T09:00:31+02:00").locked, false);
});

test("Sperre wird auch ueber verschiedene Zeitzonenangaben richtig gerechnet", () => {
  // Als Zeichenkette verglichen waere das falsch: 09:00+02:00 liegt real vor
  // 09:00+00:00.
  const state = { failedAttempts: 0, lockCount: 1, lockedUntil: "2026-09-26T09:00:30+02:00" };
  assert.equal(lockStatus(state, "2026-09-26T07:00:10+00:00").locked, true, "07:00 UTC ist 09:00 in Berlin");
  assert.equal(lockStatus(state, "2026-09-26T07:01:00+00:00").locked, false);
});

test("erfolgreiche Anmeldung setzt Zaehler und Sperre zurueck", () => {
  assert.deepEqual(registerSuccessfulAttempt(), NO_ATTEMPTS);
});

test("vollstaendige Anmeldung: richtig, falsch, gesperrt", () => {
  const now = "2026-09-26T09:00:00+02:00";
  const user = { pinHash: hashPin("8261", FAST), active: true };

  const ok = attemptLogin(user, "8261", NO_ATTEMPTS, now);
  assert.equal(ok.result, "OK");
  assert.deepEqual(ok.state, NO_ATTEMPTS);

  let state = NO_ATTEMPTS;
  for (let attempt = 0; attempt < MAX_PIN_ATTEMPTS - 1; attempt++) {
    const wrong = attemptLogin(user, "0000", state, now);
    assert.equal(wrong.result, "WRONG_PIN");
    state = wrong.state;
  }
  const locked = attemptLogin(user, "0000", state, now);
  assert.equal(locked.result, "LOCKED");

  // Auch die richtige PIN kommt jetzt nicht durch.
  const blocked = attemptLogin(user, "8261", locked.state, now);
  assert.equal(blocked.result, "LOCKED");
  // Nach Ablauf schon.
  assert.equal(attemptLogin(user, "8261", locked.state, "2026-09-26T09:01:00+02:00").result, "OK");
});

test("deaktivierter Zugang und fehlende PIN sind eigene Faelle", () => {
  const now = "2026-09-26T09:00:00+02:00";
  const inactive = attemptLogin({ pinHash: hashPin("8261", FAST), active: false }, "8261", NO_ATTEMPTS, now);
  assert.equal(inactive.result, "INACTIVE");
  // Ein deaktivierter Zugang darf die Sperre eines aktiven nicht ausloesen.
  assert.deepEqual(inactive.state, NO_ATTEMPTS);

  assert.equal(attemptLogin({ pinHash: null, active: true }, "8261", NO_ATTEMPTS, now).result, "NO_PIN_SET");
});

test("Meldungen sind fuer den Bediener brauchbar", () => {
  const now = "2026-09-26T09:00:00+02:00";
  const user = { pinHash: hashPin("8261", FAST), active: true };

  assert.equal(describeLoginOutcome(attemptLogin(user, "8261", NO_ATTEMPTS, now)), "Angemeldet.");
  assert.match(describeLoginOutcome(attemptLogin(user, "0000", NO_ATTEMPTS, now)), /Noch 4 Versuche/);
  assert.match(
    describeLoginOutcome(attemptLogin(user, "0000", { failedAttempts: 3, lockCount: 0, lockedUntil: null }, now)),
    /Noch ein Versuch/,
  );
  assert.match(
    describeLoginOutcome(attemptLogin(user, "0000", { failedAttempts: 4, lockCount: 0, lockedUntil: null }, now)),
    /gesperrt/,
  );
  assert.equal(formatLockDuration(20), "noch 20 Sekunden");
  assert.equal(formatLockDuration(120), "noch 2 Minuten");
  assert.equal(formatLockDuration(3600), "noch 1 Stunde");
  assert.equal(formatLockDuration(7200), "noch 2 Stunden");
});

// =========================================================================
// Mandantentrennung
// =========================================================================

test("ein Datensatz eines anderen Mandanten wird abgewiesen", () => {
  const own = { tenantId: "t1", name: "Kaffee" };
  assert.equal(assertSameTenant(own, "t1"), own);

  const foreign = { tenantId: "t2", name: "Fremder Artikel" };
  assert.throws(() => assertSameTenant(foreign, "t1"), TenantIsolationError);
});

test("die Fehlermeldung nennt keine Daten des fremden Mandanten", () => {
  // Fehlermeldungen landen in Protokollen - was darin steht, verlaesst das
  // Geraet.
  try {
    assertSameTenant({ tenantId: "t2", name: "Umsatz Konkurrenz GmbH" }, "t1", "Der Artikel");
    assert.fail("haette werfen muessen");
  } catch (error) {
    assert.ok(error instanceof TenantIsolationError);
    assert.equal(error.message.includes("Konkurrenz"), false);
    assert.equal(error.expectedTenantId, "t1");
    assert.equal(error.actualTenantId, "t2");
  }
});

test("eine Liste wird vollstaendig geprueft", () => {
  const list = [{ tenantId: "t1" }, { tenantId: "t1" }, { tenantId: "t2" }];
  assert.throws(() => assertAllSameTenant(list, "t1"), TenantIsolationError);
  assert.doesNotThrow(() => assertAllSameTenant(list.slice(0, 2), "t1"));
});

test("Filtern meldet, wie viele Datensaetze aussortiert wurden", () => {
  // Eine stillschweigend gefilterte Liste versteckt einen Fehler, den jemand
  // beheben muss.
  const result = filterToTenant([{ tenantId: "t1" }, { tenantId: "t2" }, { tenantId: "t1" }], "t1");
  assert.equal(result.kept.length, 2);
  assert.equal(result.removed, 1);
  assert.equal(filterToTenant([], "t1").removed, 0);
});

test("der Mandantenbereich sagt, woher er kommt", () => {
  assert.deepEqual(deviceScope("t1"), { tenantId: "t1", source: "device-session" });
  assert.deepEqual(tokenScope("t1"), { tenantId: "t1", source: "access-token" });
  assert.throws(() => deviceScope(""), TenantIsolationError);
  assert.throws(() => tokenScope("   "), TenantIsolationError);
  assert.equal(sameScope(deviceScope("t1"), tokenScope("t1")), true);
  assert.equal(sameScope(deviceScope("t1"), tokenScope("t2")), false);
});

test("die SQL-Bedingung gibt Wert und Platzhalter getrennt zurueck", () => {
  // Eine fertige Zeichenkette mit eingesetztem Wert waere mit einer
  // Mandanten-Id wie x' OR '1'='1 auszuhebeln.
  const condition = tenantCondition(deviceScope("t1"));
  assert.equal(condition.sql, "tenant_id = ?");
  assert.deepEqual(condition.params, ["t1"]);

  const injected = tenantCondition(deviceScope("x' OR '1'='1"));
  assert.equal(injected.sql, "tenant_id = ?", "der Wert landet nie im SQL-Text");
  assert.deepEqual(injected.params, ["x' OR '1'='1"]);

  assert.throws(() => tenantCondition(deviceScope("t1"), "tenant_id; DROP TABLE"), TenantIsolationError);
});

test("ein Geraet aus einem anderen Betrieb wird erkannt", () => {
  const scope = deviceScope("t1");
  const store = { id: "s1", tenantId: "t1" };
  assert.doesNotThrow(() => assertDeviceBelongs({ tenantId: "t1", storeId: "s1" }, scope, store));

  assert.throws(() => assertDeviceBelongs({ tenantId: "t2", storeId: "s1" }, scope, store), TenantIsolationError);
  assert.throws(() => assertDeviceBelongs({ tenantId: "t1", storeId: "s9" }, scope, store), /Betriebsstaette/);
  assert.throws(
    () => assertDeviceBelongs({ tenantId: "t1", storeId: "s1" }, scope, { id: "s1", tenantId: "t2" }),
    TenantIsolationError,
  );
});

// =========================================================================
// Pruefprotokoll
// =========================================================================

const auditBase = {
  id: "a1",
  tenantId: "t1",
  deviceId: "d1",
  userId: "u1",
  userName: "Aushilfe",
  createdAt: "2026-09-26T09:00:00+02:00",
};

test("Protokolleintrag haelt fest, wer was getan hat", () => {
  const entry = buildAuditEntry({
    ...auditBase,
    event: "RECEIPT_VOIDED",
    subject: "K1-000042",
    detail: "Teilstorno, 1 von 3 Flaschen",
    amount: -275,
  });
  assert.equal(entry.event, "RECEIPT_VOIDED");
  assert.equal(entry.userName, "Aushilfe");
  assert.equal(entry.amount, -275);
  assert.equal(AUDIT_LABELS.RECEIPT_VOIDED, "Storno");
  assert.match(formatAuditEntry(entry), /26.09.2026|2026-09-26/);
  assert.ok(formatAuditEntry(entry).includes("Aushilfe"));
  assert.ok(formatAuditEntry(entry).includes("K1-000042"));
});

test("jedes Ereignis hat einen Klartext", () => {
  for (const event of CRITICAL_EVENTS) {
    assert.ok(AUDIT_LABELS[event], `Klartext fuer ${event} fehlt`);
  }
});

test("Geheimnisse kommen nicht ins Protokoll", () => {
  // Ein Protokoll wird exportiert und aufbewahrt - was darin steht, verlaesst
  // irgendwann das Geraet.
  assert.throws(
    () => buildAuditEntry({ ...auditBase, event: "USER_CHANGED", detail: "pbkdf2$sha256$60000$aa$bb" }),
    AuditError,
  );
  assert.throws(
    () => buildAuditEntry({ ...auditBase, event: "DATA_EXPORTED", detail: "Bearer eyJhbGciOi" }),
    AuditError,
  );
  assert.throws(
    () => buildAuditEntry({ ...auditBase, event: "SETTINGS_CHANGED", detail: "api_key=geheim123" }),
    AuditError,
  );
  // Eine vollstaendige Kartennummer gehoert nirgends hin ausser zum
  // Zahlungsdienst.
  assert.throws(
    () => buildAuditEntry({ ...auditBase, event: "RECEIPT_VOIDED", subject: "4242424242424242" }),
    AuditError,
  );
  // Eine Belegnummer oder die letzten vier Stellen sind unbedenklich.
  assert.doesNotThrow(() => buildAuditEntry({ ...auditBase, event: "RECEIPT_VOIDED", subject: "K1-000042" }));
  assert.doesNotThrow(() => buildAuditEntry({ ...auditBase, event: "RECEIPT_VOIDED", detail: "girocard ...4242" }));

  assert.doesNotThrow(() => assertNoSecrets(null, "detail"));
  assert.doesNotThrow(() => assertNoSecrets("", "detail"));
});

test("verweigerter Zugriff wird protokolliert", () => {
  const entry = accessDenied(auditBase, "VOID_RECEIPT", "Storno Beleg K1-000042");
  assert.equal(entry.event, "ACCESS_DENIED");
  assert.equal(entry.subject, "Storno Beleg K1-000042");
  assert.ok(entry.detail?.includes("VOID_RECEIPT"));
});

test("Auswertung zeigt, wo hingesehen werden muss", () => {
  const entries: AuditEntry[] = [
    buildAuditEntry({ ...auditBase, id: "a1", event: "RECEIPT_VOIDED", amount: -1000 }),
    buildAuditEntry({ ...auditBase, id: "a2", event: "RECEIPT_VOIDED", amount: -2500 }),
    buildAuditEntry({ ...auditBase, id: "a3", userName: "Schichtleitung", event: "RECEIPT_VOIDED", amount: -500 }),
    buildAuditEntry({ ...auditBase, id: "a4", event: "LOGIN_FAILED" }),
    buildAuditEntry({ ...auditBase, id: "a5", event: "LOGIN_FAILED" }),
    buildAuditEntry({ ...auditBase, id: "a6", event: "LOGIN_LOCKED" }),
    buildAuditEntry({ ...auditBase, id: "a7", event: "TSE_FAILURE" }),
    buildAuditEntry({ ...auditBase, id: "a8", event: "ACCESS_DENIED" }),
    buildAuditEntry({ ...auditBase, id: "a9", event: "LOGIN_OK" }),
  ];

  const summary = summarizeAudit(entries);
  assert.equal(summary.totalEntries, 9);
  assert.equal(summary.failedLogins, 2);
  assert.equal(summary.lockouts, 1);
  assert.equal(summary.tseFailures, 1);
  assert.equal(summary.deniedAccess, 1);
  assert.equal(summary.byEvent["RECEIPT_VOIDED"], 3);

  // Nach Betrag sortiert: wer am meisten storniert hat, steht oben.
  assert.deepEqual(summary.voidsByUser, [
    { userName: "Aushilfe", count: 2, amount: 3500 },
    { userName: "Schichtleitung", count: 1, amount: 500 },
  ]);
});

test("ein leeres Protokoll ergibt eine leere Auswertung", () => {
  const summary = summarizeAudit([]);
  assert.equal(summary.totalEntries, 0);
  assert.deepEqual(summary.voidsByUser, []);
  assert.equal(summary.failedLogins, 0);
});
