import pg from "pg";
import { migrate } from "../../scripts/database.mjs";
import { randomUUID } from "node:crypto";
import { Database, databaseTypes } from "../../src/worker/database.ts";

export async function databaseFixture(t) {
  const connectionString =
    process.env.TEST_DATABASE_URL ??
    "postgresql://mailroom:mailroom_local@127.0.0.1:55432/mailroom";
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString,
    options: `-c search_path=${schema}`,
    types: databaseTypes,
    max: 6,
  });
  const db = new Database(pool);
  t.after(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await admin.query(`SET search_path TO ${schema}`);
  await migrate(admin, () => {});
  return db;
}

export async function seedInbox(db) {
  const domain = await db.one(
    "INSERT INTO domains (name, status) VALUES ('example.com', 'active') RETURNING id",
  );
  return db.one(
    "INSERT INTO mailboxes (address, domain_id) VALUES ('support@example.com', $1) RETURNING *",
    [domain.id],
  );
}
