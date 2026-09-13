/**
 * Datenbank fuer Tests, auf Node-SQLite.
 *
 * NUR FUER TESTS. In der App laeuft expo-sqlite; hier laeuft dieselbe
 * Schnittstelle `Db` auf der in Node eingebauten SQLite. Der Gewinn ist
 * erheblich: Schema, Trigger, Fremdschluessel und jede Abfrage der Repositories
 * werden gegen eine echte SQLite geprueft, ohne Geraet und ohne Emulator.
 * Ein Trigger, der das Aendern bezahlter Belege verhindern soll, ist sonst nur
 * eine Behauptung im Schema.
 *
 * Diese Datei wird von der App nie importiert und landet damit nicht im Bundle.
 */

import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../schema.ts";
import type { Db, SqlValue } from "../database.ts";

export interface TestDb extends Db {
  /** Rohzugriff fuer Zusicherungen, die kein Repository anbietet. */
  readonly handle: DatabaseSync;
  close(): void;
}

/** Neue Datenbank im Speicher, Migrationen angewendet. */
export function openTestDb(): TestDb {
  const handle = new DatabaseSync(":memory:");
  handle.exec("PRAGMA foreign_keys = ON");

  for (const migration of MIGRATIONS) {
    for (const statement of migration.statements) handle.exec(statement);
    handle.exec(`PRAGMA user_version = ${migration.version}`);
  }

  // Node-SQLite kennt keine verschachtelten Transaktionen. Die Repositories
  // rufen `transaction` teils ineinander (saveProduct in einer aeusseren
  // Transaktion) - deshalb wird nur die aeusserste wirklich eroeffnet.
  let depth = 0;

  return {
    handle,
    async run(sql: string, params: readonly SqlValue[] = []) {
      handle.prepare(sql).run(...(params as SqlValue[]));
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return handle.prepare(sql).all(...(params as SqlValue[])) as T[];
    },
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      return (handle.prepare(sql).get(...(params as SqlValue[])) as T) ?? null;
    },
    async transaction<T>(work: () => Promise<T>) {
      if (depth > 0) return work();
      depth++;
      handle.exec("BEGIN");
      try {
        const result = await work();
        handle.exec("COMMIT");
        return result;
      } catch (error) {
        handle.exec("ROLLBACK");
        throw error;
      } finally {
        depth--;
      }
    },
    close() {
      handle.close();
    },
  };
}
