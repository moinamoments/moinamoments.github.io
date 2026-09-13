import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedClock } from "../clock.ts";
import { MockTse } from "./mock.ts";
import { FiskalyTse, type FetchLike, mapTransaction } from "./fiskaly.ts";
import { TseError, encodeProcessData } from "./types.ts";

test("encodeProcessData baut das Format Kassenbeleg-V1", () => {
  assert.equal(
    encodeProcessData({
      processType: "Kassenbeleg-V1",
      grossByTaxRate: ["0.00", "4.50", "0.00", "0.00", "0.00"],
      payments: ["4.50:Bar"],
    }),
    "Kassenbeleg-V1^0.00_4.50_0.00_0.00_0.00^4.50:Bar",
  );
});

test("Mock-TSE zaehlt Transaktionen und Signaturen fortlaufend", async () => {
  const tse = new MockTse();
  const first = await tse.startTransaction({ clientId: "kasse-1" });
  assert.equal(first.transactionNumber, 1);
  assert.equal(first.signatureCounter, 1);

  const finished = await tse.finishTransaction({
    clientId: "kasse-1",
    transactionNumber: 1,
    processData: "Kassenbeleg-V1^0.00_4.50_0.00_0.00_0.00^4.50:Bar",
    processType: "Kassenbeleg-V1",
  });
  assert.equal(finished.transactionNumber, 1);
  assert.equal(finished.signatureCounter, 2, "jede Signatur erhoeht den Zaehler");

  const second = await tse.startTransaction({ clientId: "kasse-1" });
  assert.equal(second.transactionNumber, 2);
  assert.equal(second.signatureCounter, 3);
});

test("Mock-TSE haelt die Startzeit des Belegs fest", async () => {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  const tse = new MockTse({ clock });
  const start = await tse.startTransaction({ clientId: "kasse-1" });
  clock.advance(95);
  const finish = await tse.finishTransaction({
    clientId: "kasse-1",
    transactionNumber: start.transactionNumber,
    processData: "x",
    processType: "Kassenbeleg-V1",
  });
  assert.equal(finish.startTime, "2026-09-26T09:00:00+00:00", "die Startzeit bleibt die des Beginns");
  assert.equal(finish.logTime, "2026-09-26T09:01:35+00:00");
});

test("Mock-TSE weist doppelten Abschluss und fremde Kassen ab", async () => {
  const tse = new MockTse();
  const start = await tse.startTransaction({ clientId: "kasse-1" });
  const request = {
    clientId: "kasse-1",
    transactionNumber: start.transactionNumber,
    processData: "x",
    processType: "Kassenbeleg-V1",
  };
  await tse.finishTransaction(request);
  await assert.rejects(() => tse.finishTransaction(request), TseError);
  await assert.rejects(
    () => tse.finishTransaction({ ...request, transactionNumber: 999 }),
    TseError,
  );

  const other = await tse.startTransaction({ clientId: "kasse-1" });
  await assert.rejects(
    () => tse.finishTransaction({ ...request, transactionNumber: other.transactionNumber, clientId: "kasse-2" }),
    TseError,
  );
});

test("Signatur der Mock-TSE haengt an den Prozessdaten", async () => {
  const a = new MockTse();
  const b = new MockTse();
  await a.startTransaction({ clientId: "k" });
  await b.startTransaction({ clientId: "k" });
  const sigA = await a.finishTransaction({ clientId: "k", transactionNumber: 1, processData: "A", processType: "Kassenbeleg-V1" });
  const sigB = await b.finishTransaction({ clientId: "k", transactionNumber: 1, processData: "B", processType: "Kassenbeleg-V1" });
  assert.notEqual(sigA.signature, sigB.signature);
  assert.match(sigA.signature, /^[A-Za-z0-9+/=]+$/, "Base64");
});

test("Mock-TSE kann Ausfall simulieren", async () => {
  const tse = new MockTse({ available: false });
  assert.equal(await tse.isAvailable(), false);
  await assert.rejects(() => tse.startTransaction({ clientId: "k" }), (error: unknown) => {
    assert.ok(error instanceof TseError);
    assert.equal(error.options.retryable, true);
    return true;
  });
});

test("Testseriennummer ist als solche erkennbar", async () => {
  const info = await new MockTse().info();
  assert.match(info.serialNumber, /TEST-TSE/, "ein versehentlich echter Bon muss auffallen");
});

test("mapTransaction liest die Antwort der Cloud-TSE", () => {
  const mapped = mapTransaction({
    number: 4711,
    time_start: 1790000000,
    time_end: 1790000042,
    signature: { value: "MEUCIQ...", counter: 815, algorithm: "ecdsa-plain-SHA256" },
  });
  assert.equal(mapped.transactionNumber, 4711);
  assert.equal(mapped.signatureCounter, 815);
  assert.equal(mapped.signature, "MEUCIQ...");
  assert.equal(mapped.startTime, "2026-09-21T14:13:20Z");
  assert.equal(mapped.logTime, "2026-09-21T14:14:02Z");
});

test("mapTransaction verweigert unvollstaendige Antworten", () => {
  assert.throws(() => mapTransaction({ signature: { value: "x" } }), TseError);
  assert.throws(() => mapTransaction({ number: 1, signature: {} }), TseError);
});

test("Cloud-TSE meldet sich an und sendet das Token mit", async () => {
  const calls: { url: string; method: string; auth?: string; body?: unknown }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      auth: init.headers["authorization"],
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    if (url.endsWith("/auth")) {
      return json({ access_token: "tok-1", expires_in: 3600 });
    }
    return json({ number: 7, time_start: 1790000000, time_end: 1790000000, signature: { value: "sig", counter: 3 } });
  };

  const tse = new FiskalyTse(
    { baseUrl: "https://example.invalid/api/v2", tssId: "tss-1", apiKey: "k", apiSecret: "s" },
    fetchImpl,
  );
  const result = await tse.finishTransaction({
    clientId: "kasse-1",
    transactionNumber: 7,
    processData: "Kassenbeleg-V1^0.00_4.50_0.00_0.00_0.00^4.50:Bar",
    processType: "Kassenbeleg-V1",
  });

  assert.equal(result.transactionNumber, 7);
  assert.equal(calls[0]?.url, "https://example.invalid/api/v2/auth");
  assert.equal(calls[1]?.method, "PUT");
  assert.equal(calls[1]?.auth, "Bearer tok-1");
  assert.match(calls[1]?.url ?? "", /\/tss\/tss-1\/tx\/7\?tx_revision=2$/);
  assert.equal((calls[1]?.body as Record<string, unknown>)["state"], "FINISHED");

  // Zweiter Aufruf nutzt das gecachte Token, meldet sich also nicht neu an.
  await tse.finishTransaction({ clientId: "kasse-1", transactionNumber: 8, processData: "x", processType: "y" });
  assert.equal(calls.filter((c) => c.url.endsWith("/auth")).length, 1);
});

test("Cloud-TSE meldet sich nach 401 einmal neu an", async () => {
  let authCalls = 0;
  let txCalls = 0;
  const fetchImpl: FetchLike = async (url) => {
    if (url.endsWith("/auth")) {
      authCalls++;
      return json({ access_token: `tok-${authCalls}`, expires_in: 3600 });
    }
    txCalls++;
    if (txCalls === 1) return { ok: false, status: 401, json: async () => ({}), text: async () => "expired" };
    return json({ number: 1, time_start: 1790000000, time_end: 1790000000, signature: { value: "s", counter: 1 } });
  };
  const tse = new FiskalyTse({ baseUrl: "https://x.invalid", tssId: "t", apiKey: "k", apiSecret: "s" }, fetchImpl);
  const result = await tse.finishTransaction({ clientId: "k", transactionNumber: 1, processData: "d", processType: "p" });
  assert.equal(result.transactionNumber, 1);
  assert.equal(authCalls, 2);
  assert.equal(txCalls, 2);
});

test("Cloud-TSE markiert 5xx als wiederholbar und 4xx nicht", async () => {
  const make = (status: number) => {
    const fetchImpl: FetchLike = async (url) =>
      url.endsWith("/auth")
        ? json({ access_token: "t", expires_in: 3600 })
        : { ok: false, status, json: async () => ({}), text: async () => "boom" };
    return new FiskalyTse({ baseUrl: "https://x.invalid", tssId: "t", apiKey: "k", apiSecret: "s" }, fetchImpl);
  };

  await assert.rejects(
    () => make(503).finishTransaction({ clientId: "k", transactionNumber: 1, processData: "d", processType: "p" }),
    (error: unknown) => (error as TseError).options.retryable === true,
  );
  await assert.rejects(
    () => make(400).finishTransaction({ clientId: "k", transactionNumber: 1, processData: "d", processType: "p" }),
    (error: unknown) => (error as TseError).options.retryable === false,
  );
});

test("Cloud-TSE gilt bei Netzfehler als nicht verfuegbar, statt zu werfen", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("ENOTFOUND");
  };
  const tse = new FiskalyTse({ baseUrl: "https://x.invalid", tssId: "t", apiKey: "k", apiSecret: "s" }, fetchImpl);
  assert.equal(await tse.isAvailable(), false);
});

function json(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
