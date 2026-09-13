import { test } from "node:test";
import assert from "node:assert/strict";
import { openTestDb } from "./testing/nodeDb.ts";
import { getTenant, saveTenant } from "./repositories.ts";

test("Migrationen laufen und die Datenbank ist ansprechbar", async () => {
  const db = openTestDb();
  try {
    const version = db.handle.prepare("PRAGMA user_version").get() as { user_version: number };
    assert.equal(version.user_version, 1);

    assert.equal(await getTenant(db), null);
    await saveTenant(db, {
      id: "t1", name: "Kiosk", legalName: "Kiosk", street: "Weg 1", postalCode: "24103", city: "Kiel",
      countryCode: "DE", taxNumber: "20/1", vatId: null, email: null, phone: null, smallBusiness: false,
      receiptFooter: null, currency: "EUR", timeZone: "Europe/Berlin", createdAt: "2026-01-01T00:00:00+01:00",
    });
    const tenant = await getTenant(db);
    assert.equal(tenant?.name, "Kiosk");
    assert.equal(tenant?.smallBusiness, false, "0 aus SQLite darf nicht als wahr gelten");
  } finally {
    db.close();
  }
});
