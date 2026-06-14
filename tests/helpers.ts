import { Database } from "bun:sqlite";
import { migrate, setDb } from "../src/db/index.ts";

let counter = 0;

/** Create a fresh in-memory DB and install it as the process singleton. */
export function freshDb(): Database {
  const conn = new Database(":memory:");
  conn.exec("PRAGMA foreign_keys = ON;");
  migrate(conn);
  setDb(conn);
  return conn;
}

export function uniqueSuffix(): string {
  return `${Date.now()}-${counter++}`;
}
