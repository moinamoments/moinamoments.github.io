/**
 * Datenbankzugriff.
 *
 * Kapselt expo-sqlite hinter einem schmalen Interface. Der Grund ist nicht
 * Abstraktionsfreude: derselbe Repository-Code soll spaeter gegen eine
 * Serverdatenbank laufen koennen, und die Tests des Kerns sollen ohne
 * React Native auskommen.
 */

import * as SQLite from "expo-sqlite";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.ts";

export type SqlValue = string | number | null;

export interface Db {
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  /** Alles oder nichts. Ein halb gespeicherter Beleg darf nicht entstehen. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

export class DatabaseError extends Error {}

let handle: SQLite.SQLiteDatabase | null = null;

/** Datenbank oeffnen und Migrationen anwenden. Mehrfachaufruf ist unschaedlich. */
export async function openDb(name = "kassenpilot.db"): Promise<Db> {
  if (!handle) {
    handle = await SQLite.openDatabaseAsync(name);
    // WAL: gleichzeitiges Lesen waehrend eines Schreibvorgangs. Ohne das
    // blockiert die Artikelliste, waehrend ein Beleg gespeichert wird.
    await handle.execAsync("PRAGMA journal_mode = WAL");
    // Fremdschluessel sind in SQLite standardmaessig aus.
    await handle.execAsync("PRAGMA foreign_keys = ON");
    await migrate(handle);
  }
  return wrap(handle);
}

function wrap(db: SQLite.SQLiteDatabase): Db {
  return {
    async run(sql, params = []) {
      await db.runAsync(sql, params as SQLite.SQLiteBindValue[]);
    },
    async all<T>(sql: string, params: readonly SqlValue[] = []) {
      return (await db.getAllAsync(sql, params as SQLite.SQLiteBindValue[])) as T[];
    },
    async first<T>(sql: string, params: readonly SqlValue[] = []) {
      return ((await db.getFirstAsync(sql, params as SQLite.SQLiteBindValue[])) as T) ?? null;
    },
    async transaction<T>(work: () => Promise<T>) {
      let result: T;
      await db.withExclusiveTransactionAsync(async () => {
        result = await work();
      });
      return result!;
    },
  };
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  const current = row?.user_version ?? 0;

  if (current > SCHEMA_VERSION) {
    // Eine aeltere App-Version auf eine neuere Datenbank zu setzen, waere die
    // gefaehrlichste Variante: sie wuerde Spalten ignorieren, die sie nicht
    // kennt, und Belege unvollstaendig schreiben.
    throw new DatabaseError(
      `Die Datenbank hat Version ${current}, diese App-Version kennt nur ${SCHEMA_VERSION}. Bitte die App aktualisieren.`,
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    await db.withExclusiveTransactionAsync(async () => {
      for (const statement of migration.statements) {
        await db.execAsync(statement);
      }
    });
    // PRAGMA nimmt keine Parameter, die Zahl kommt aus dem Code - nicht von
    // aussen.
    await db.execAsync(`PRAGMA user_version = ${migration.version}`);
  }
}

/** Nur fuer Tests und den Geraetewechsel: Verbindung schliessen. */
export async function closeDb(): Promise<void> {
  await handle?.closeAsync();
  handle = null;
}
