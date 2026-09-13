import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOCK_POLICY,
  DEVICE_HARDENING_ADVICE,
  LOCK_REASON_LABELS,
  SECRET_KEYS,
  STRICT_LOCK_POLICY,
  SecurityError,
  assertNoSecretFields,
  checkLocalPrinterUrl,
  checkSecureUrl,
  inMemorySecretStore,
  secondsUntilLock,
  secureHeaders,
  shouldLock,
  touchActivity,
  type LockState,
} from "./device.ts";

// --- Sperre der App -------------------------------------------------------

const active: LockState = { lastActivityAt: "2026-09-26T09:00:00+02:00", locked: false, hasOpenCart: false };

test("nach Inaktivitaet wird gesperrt, davor nicht", () => {
  assert.deepEqual(shouldLock(active, DEFAULT_LOCK_POLICY, "2026-09-26T09:04:59+02:00"), { lock: false, reason: null });
  assert.deepEqual(shouldLock(active, DEFAULT_LOCK_POLICY, "2026-09-26T09:05:00+02:00"), { lock: true, reason: "IDLE" });
  assert.equal(LOCK_REASON_LABELS.IDLE, "nach Inaktivitaet gesperrt");
});

test("Bedienung setzt die Untaetigkeit zurueck", () => {
  const touched = touchActivity(active, "2026-09-26T09:04:00+02:00");
  assert.equal(touched.lastActivityAt, "2026-09-26T09:04:00+02:00");
  assert.equal(touched.locked, false);
  assert.equal(shouldLock(touched, DEFAULT_LOCK_POLICY, "2026-09-26T09:08:00+02:00").lock, false);
  assert.equal(shouldLock(touched, DEFAULT_LOCK_POLICY, "2026-09-26T09:09:01+02:00").lock, true);
});

test("ein offener Warenkorb haelt die Sperre auf - ausser die Einstellung sagt anders", () => {
  const withCart: LockState = { ...active, hasOpenCart: true };
  assert.equal(shouldLock(withCart, DEFAULT_LOCK_POLICY, "2026-09-26T09:30:00+02:00").lock, false);
  assert.equal(shouldLock(withCart, STRICT_LOCK_POLICY, "2026-09-26T09:30:00+02:00").lock, true);
});

test("beim Wechsel in den Hintergrund wird nur mit strenger Einstellung gesperrt", () => {
  assert.equal(shouldLock(active, DEFAULT_LOCK_POLICY, "2026-09-26T09:00:01+02:00", "background").lock, false);
  const strict = shouldLock(active, STRICT_LOCK_POLICY, "2026-09-26T09:00:01+02:00", "background");
  assert.deepEqual(strict, { lock: true, reason: "BACKGROUND" });
});

test("eine bereits gesperrte App wird nicht erneut gesperrt", () => {
  const locked: LockState = { ...active, locked: true };
  assert.equal(shouldLock(locked, STRICT_LOCK_POLICY, "2026-09-26T12:00:00+02:00").lock, false);
});

test("Sperre abschaltbar, aber nur ausdruecklich", () => {
  const off = { ...DEFAULT_LOCK_POLICY, idleSeconds: 0 };
  assert.equal(shouldLock(active, off, "2026-09-26T23:00:00+02:00").lock, false);
  assert.equal(secondsUntilLock(active, off, "2026-09-26T09:01:00+02:00"), null);
});

test("unlesbarer Zeitstempel sperrt im Zweifel", () => {
  // Eine unnoetige Sperre kostet eine PIN-Eingabe, eine unterlassene die
  // Umsaetze.
  const broken: LockState = { lastActivityAt: "kaputt", locked: false, hasOpenCart: false };
  assert.deepEqual(shouldLock(broken, DEFAULT_LOCK_POLICY, "2026-09-26T09:00:00+02:00"), { lock: true, reason: "IDLE" });
});

test("Sperre wird ueber Zeitzonen hinweg richtig gerechnet", () => {
  // Als Zeichenkette verglichen waere das falsch.
  const state: LockState = { lastActivityAt: "2026-09-26T09:00:00+02:00", locked: false, hasOpenCart: false };
  assert.equal(shouldLock(state, DEFAULT_LOCK_POLICY, "2026-09-26T07:04:00+00:00").lock, false, "07:04 UTC ist 09:04 in Berlin");
  assert.equal(shouldLock(state, DEFAULT_LOCK_POLICY, "2026-09-26T07:06:00+00:00").lock, true);
});

test("Restzeit bis zur Sperre fuer den Hinweis", () => {
  assert.equal(secondsUntilLock(active, DEFAULT_LOCK_POLICY, "2026-09-26T09:04:30+02:00"), 30);
  assert.equal(secondsUntilLock(active, DEFAULT_LOCK_POLICY, "2026-09-26T09:06:00+02:00"), 0);
  assert.equal(secondsUntilLock({ ...active, locked: true }, DEFAULT_LOCK_POLICY, "2026-09-26T09:01:00+02:00"), null);
  assert.equal(secondsUntilLock({ ...active, hasOpenCart: true }, DEFAULT_LOCK_POLICY, "2026-09-26T09:01:00+02:00"), null);
});

// --- Geheimnisse ----------------------------------------------------------

test("Geheimnisspeicher legt ab, liest und loescht", async () => {
  const store = inMemorySecretStore();
  assert.equal(await store.get("tse.apiKey"), null);

  await store.set("tse.apiKey", "geheim");
  assert.equal(await store.get("tse.apiKey"), "geheim");

  await store.remove("tse.apiKey");
  assert.equal(await store.get("tse.apiKey"), null);

  await store.set("sync.accessToken", "token");
  await store.clear();
  assert.equal(await store.get("sync.accessToken"), null);

  await assert.rejects(() => store.set("tse.apiKey", ""), SecurityError);
});

test("die Liste der Geheimnisse ist vollstaendig aufgezaehlt", () => {
  // Nur so kann geprueft werden, dass nichts davon in der Datenbank landet.
  assert.ok(SECRET_KEYS.includes("tse.apiSecret"));
  assert.ok(SECRET_KEYS.includes("db.encryptionKey"));
  assert.equal(new Set(SECRET_KEYS).size, SECRET_KEYS.length);
});

test("Geheimnisse werden nicht in der Datenbank gespeichert", () => {
  // Der Fall: jemand ergaenzt ein Feld apiKey in der Geraetekonfiguration, und
  // damit steht der Schluessel in einer Datei, die in jeder Sicherung landet.
  assert.throws(() => assertNoSecretFields({ apiKey: "abc" }, "die Geraetedaten"), SecurityError);
  assert.throws(() => assertNoSecretFields({ api_key: "abc" }, "x"), SecurityError);
  assert.throws(() => assertNoSecretFields({ accessToken: "abc" }, "x"), SecurityError);
  assert.throws(() => assertNoSecretFields({ tseApiSecret: "abc" }, "x"), SecurityError);
  assert.throws(() => assertNoSecretFields({ dbEncryptionKey: "abc" }, "x"), SecurityError);
  assert.throws(() => assertNoSecretFields({ passwort: "abc" }, "x"), SecurityError);

  // Leere Felder sind kein Problem - so sieht eine unkonfigurierte Kasse aus.
  assert.doesNotThrow(() => assertNoSecretFields({ apiKey: "" }, "x"));
  assert.doesNotThrow(() => assertNoSecretFields({ apiKey: null }, "x"));
  // Gewoehnliche Felder gehen durch.
  assert.doesNotThrow(() => assertNoSecretFields({ name: "Kasse 1", host: "192.168.1.50", port: 9100 }, "x"));
  // Die Client-Id der TSE ist kein Geheimnis - sie steht auf dem Bon.
  assert.doesNotThrow(() => assertNoSecretFields({ tseClientId: "client-1" }, "x"));
});

// --- Transport ------------------------------------------------------------

test("nach draussen nur ueber https", () => {
  const ok = checkSecureUrl("https://kasse.beispiel.de/api");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true && ok.url.hostname, "kasse.beispiel.de");

  const plain = checkSecureUrl("http://kasse.beispiel.de/api");
  assert.equal(plain.ok, false);
  assert.ok(plain.ok === false && plain.reason.includes("https"));
  assert.ok(plain.ok === false && plain.reason.includes("Gastnetz"), "die Begruendung steht dabei");

  assert.equal(checkSecureUrl("ftp://beispiel.de").ok, false);
  assert.equal(checkSecureUrl("").ok, false);
  assert.equal(checkSecureUrl("kasse.beispiel.de").ok, false, "ohne Schema nicht lesbar");
});

test("Zugangsdaten gehoeren nicht in die Adresse", () => {
  const withCredentials = checkSecureUrl("https://nutzer:geheim@kasse.beispiel.de");
  assert.equal(withCredentials.ok, false);
  assert.ok(withCredentials.ok === false && withCredentials.reason.includes("Zugangsdaten"));
});

test("Drucker nur im eigenen Netz", () => {
  // Bondrucker sprechen kein TLS - dafuer duerfen sie nur lokal stehen.
  assert.equal(checkLocalPrinterUrl("192.168.1.50").ok, true);
  assert.equal(checkLocalPrinterUrl("10.0.0.5").ok, true);
  assert.equal(checkLocalPrinterUrl("172.16.3.4").ok, true);
  assert.equal(checkLocalPrinterUrl("172.31.255.1").ok, true);
  assert.equal(checkLocalPrinterUrl("127.0.0.1").ok, true);
  assert.equal(checkLocalPrinterUrl("drucker.local").ok, true);
  assert.equal(checkLocalPrinterUrl("bondrucker").ok, true);

  // Ein "Drucker" im Internet ist ein Datenabfluss - der Bon enthaelt die
  // Umsaetze des Tages.
  const public1 = checkLocalPrinterUrl("93.184.216.34");
  assert.equal(public1.ok, false);
  assert.ok(public1.ok === false && public1.reason.includes("eigenen Netz"));
  assert.equal(checkLocalPrinterUrl("172.32.0.1").ok, false, "knapp ausserhalb des privaten Bereichs");
  assert.equal(checkLocalPrinterUrl("drucker.beispiel.de").ok, false);
  assert.equal(checkLocalPrinterUrl("192.168.1.300").ok, false);
  assert.equal(checkLocalPrinterUrl("").ok, false);
});

test("Kopfzeilen werden an einer Stelle gebildet", () => {
  const anonymous = secureHeaders(null);
  assert.equal(anonymous["accept"], "application/json");
  assert.equal(anonymous["x-content-type-options"], "nosniff");
  assert.equal(anonymous["authorization"], undefined);

  const authenticated = secureHeaders("tok-123", { contentType: "application/json" });
  assert.equal(authenticated["authorization"], "Bearer tok-123");
  assert.equal(authenticated["content-type"], "application/json");

  assert.throws(() => secureHeaders("   "), SecurityError);
});

test("die Hinweise zur Geraetesicherung nennen, was die Kasse nicht kann", () => {
  assert.ok(DEVICE_HARDENING_ADVICE.length >= 5);
  assert.ok(DEVICE_HARDENING_ADVICE.some((line) => line.includes("Geraetesperre")));
  assert.ok(
    DEVICE_HARDENING_ADVICE.some((line) => line.includes("offline")),
    "die Grenze des Fernzugriffs muss dastehen",
  );
});
