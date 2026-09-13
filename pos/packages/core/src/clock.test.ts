import { test } from "node:test";
import assert from "node:assert/strict";
import { fixedClock, isoWithOffset, sequentialIds } from "./clock.ts";

test("isoWithOffset schreibt Ortszeit mit Offset", () => {
  // Sommerzeit in Berlin: UTC+2
  assert.equal(isoWithOffset(new Date("2026-09-26T09:04:12Z"), "Europe/Berlin"), "2026-09-26T11:04:12+02:00");
  // Winterzeit: UTC+1
  assert.equal(isoWithOffset(new Date("2026-12-24T09:04:12Z"), "Europe/Berlin"), "2026-12-24T10:04:12+01:00");
  // UTC selbst
  assert.equal(isoWithOffset(new Date("2026-09-26T09:04:12Z"), "UTC"), "2026-09-26T09:04:12+00:00");
});

test("isoWithOffset trifft den Sommerzeitwechsel auf die Stunde", () => {
  // Umstellung 2026: 25.10. um 03:00 Ortszeit zurueck auf 02:00
  assert.equal(isoWithOffset(new Date("2026-10-25T00:30:00Z"), "Europe/Berlin"), "2026-10-25T02:30:00+02:00");
  assert.equal(isoWithOffset(new Date("2026-10-25T01:30:00Z"), "Europe/Berlin"), "2026-10-25T02:30:00+01:00");
});

test("fixedClock laesst sich im Test weiterschieben", () => {
  const clock = fixedClock("2026-09-26T09:00:00Z");
  assert.equal(clock.now(), "2026-09-26T09:00:00+00:00");
  clock.advance(90);
  assert.equal(clock.now(), "2026-09-26T09:01:30+00:00");
});

test("sequentialIds zaehlt durch", () => {
  const id = sequentialIds("beleg");
  assert.equal(id(), "beleg-1");
  assert.equal(id(), "beleg-2");
});
