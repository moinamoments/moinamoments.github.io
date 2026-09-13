import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type OutboxEntry,
  type SyncTransport,
  acknowledge,
  backoffSeconds,
  due,
  emptyOutbox,
  enqueue,
  flush,
  outboxKey,
  pendingCount,
  reschedule,
  stuck,
} from "./outbox.ts";

const NOW = "2026-09-26T09:00:00+00:00";

function add(state = emptyOutbox(), id = "o1", kind: OutboxEntry["kind"] = "order", now = NOW, payload: unknown = { total: 450 }) {
  return enqueue(state, { kind, entityId: id, tenantId: "t1", payload, now });
}

test("Eintrag wird mit stabilem Schluessel angelegt", () => {
  const state = add();
  assert.equal(pendingCount(state), 1);
  assert.equal(state.entries[0]?.key, outboxKey("order", "o1"));
  assert.equal(state.entries[0]?.attempts, 0);
  assert.equal(state.entries[0]?.payload, '{"total":450}');
});

test("derselbe Eintrag zweimal bleibt ein Eintrag und behaelt seine Position", () => {
  let state = add(emptyOutbox(), "o1");
  state = add(state, "o2");
  state = add(state, "o1", "order", "2026-09-26T10:00:00+00:00", { total: 999 });

  assert.equal(pendingCount(state), 2);
  assert.deepEqual(state.entries.map((e) => e.entityId), ["o1", "o2"], "Reihenfolge bleibt");
  assert.equal(state.entries[0]?.payload, '{"total":999}', "Nutzlast wird aktualisiert");
  assert.equal(state.entries[0]?.createdAt, NOW, "Entstehungszeit bleibt");
});

test("dieselbe Id in verschiedenen Arten sind verschiedene Eintraege", () => {
  let state = add(emptyOutbox(), "x", "order");
  state = add(state, "x", "product");
  assert.equal(pendingCount(state), 2);
});

test("faellige Eintraege kommen in Entstehungsreihenfolge", () => {
  let state = add(emptyOutbox(), "o1");
  state = add(state, "o2");
  state = add(state, "o3");
  assert.deepEqual(due(state, NOW).map((e) => e.entityId), ["o1", "o2", "o3"]);
  assert.deepEqual(due(state, NOW, 2).map((e) => e.entityId), ["o1", "o2"]);
});

test("ein Eintrag mit Wartezeit ist nicht faellig", () => {
  let state = add();
  state = reschedule(state, "order:o1", "Netz weg", NOW);
  assert.equal(due(state, NOW).length, 0);
  assert.equal(due(state, "2026-09-26T09:00:06+00:00").length, 1);
});

test("Backoff verdoppelt sich und ist bei zehn Minuten gedeckelt", () => {
  assert.equal(backoffSeconds(1), 5);
  assert.equal(backoffSeconds(2), 10);
  assert.equal(backoffSeconds(3), 20);
  assert.equal(backoffSeconds(7), 320);
  assert.equal(backoffSeconds(8), 600);
  assert.equal(backoffSeconds(50), 600, "kein Warten bis zum Abend");
  assert.equal(backoffSeconds(0), 5);
});

test("Fehlversuch vermerkt Grund und Versuchszahl", () => {
  let state = add();
  state = reschedule(state, "order:o1", "ENOTFOUND", NOW);
  state = reschedule(state, "order:o1", "500", NOW);
  assert.equal(state.entries[0]?.attempts, 2);
  assert.equal(state.entries[0]?.lastError, "500");
  assert.equal(state.entries[0]?.nextAttemptAt, "2026-09-26T09:00:10+00:00");
});

test("Fehlversuch an unbekanntem Schluessel aendert nichts", () => {
  const state = add();
  assert.equal(reschedule(state, "order:gibtsnicht", "x", NOW), state);
});

test("acknowledge entfernt genau einen Eintrag", () => {
  let state = add(emptyOutbox(), "o1");
  state = add(state, "o2");
  state = acknowledge(state, "order:o1");
  assert.deepEqual(state.entries.map((e) => e.entityId), ["o2"]);
});

test("flush uebertraegt alles Faellige", async () => {
  let state = add(emptyOutbox(), "o1");
  state = add(state, "o2");
  state = add(state, "z1", "closing");
  const seen: string[] = [];
  const transport: SyncTransport = {
    async send(entry) {
      seen.push(entry.key);
      return { result: "ok" };
    },
  };
  const result = await flush(state, transport, NOW);
  assert.deepEqual(seen, ["order:o1", "order:o2", "closing:z1"]);
  assert.equal(result.sent, 3);
  assert.equal(pendingCount(result.state), 0);
});

test("ein haengender Beleg blockiert die spaeteren Belege, nicht die anderen Arten", async () => {
  let state = add(emptyOutbox(), "o1");
  state = add(state, "o2");
  state = add(state, "p1", "product");
  const seen: string[] = [];
  const transport: SyncTransport = {
    async send(entry) {
      seen.push(entry.key);
      return entry.key === "order:o1" ? { result: "retry", error: "Netz weg" } : { result: "ok" };
    },
  };
  const result = await flush(state, transport, NOW);
  assert.deepEqual(seen, ["order:o1", "product:p1"], "o2 wird uebersprungen, damit die Reihenfolge haelt");
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.state.entries.map((e) => e.entityId), ["o1", "o2"]);
});

test("eine Ausnahme im Transport gilt als Wiederholung, nicht als Verlust", async () => {
  const state = add();
  const transport: SyncTransport = {
    async send() {
      throw new Error("Verbindung abgebrochen");
    },
  };
  const result = await flush(state, transport, NOW);
  assert.equal(result.failed, 1);
  assert.equal(pendingCount(result.state), 1, "der Beleg bleibt liegen");
  assert.equal(result.state.entries[0]?.lastError, "Verbindung abgebrochen");
});

test("nur eine ausdrueckliche Ablehnung entfernt einen Eintrag ungesendet", async () => {
  const state = add();
  const transport: SyncTransport = {
    async send() {
      return { result: "rejected", error: "kennt der Server schon" };
    },
  };
  const result = await flush(state, transport, NOW);
  assert.equal(result.rejected, 1);
  assert.equal(pendingCount(result.state), 0);
});

test("stuck meldet, was seit vielen Versuchen haengt", () => {
  let state = add();
  for (let i = 0; i < 5; i++) state = reschedule(state, "order:o1", "Netz weg", NOW);
  assert.equal(stuck(state).length, 1);
  assert.equal(stuck(state, 10).length, 0);
});

test("Warteschlange ist unveraenderlich", () => {
  const before = add();
  const after = acknowledge(before, "order:o1");
  assert.equal(pendingCount(before), 1);
  assert.equal(pendingCount(after), 0);
});
