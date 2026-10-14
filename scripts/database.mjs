import pg from "pg";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_DATABASE_URL =
  "postgresql://mailroom:mailroom_local@127.0.0.1:55432/mailroom";

export async function migrate(client, log = console.log) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(726004, 1)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const directory = new URL("../migrations/postgres/", import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(new URL(name, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const applied = (
        await client.query(
          "SELECT checksum FROM schema_migrations WHERE name = $1",
          [name],
        )
      ).rows[0];
      if (applied) {
        if (applied.checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [name, checksum],
      );
      log(`Applied ${name}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  if (
    !["migrate", "seed"].includes(command) ||
    flags.some((flag) => flag !== "--local")
  ) {
    throw new Error(
      "Usage: node scripts/database.mjs migrate [--local] | seed --local",
    );
  }
  const local = flags.includes("--local");
  const connectionString = local
    ? LOCAL_DATABASE_URL
    : process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error(
      "Set DATABASE_URL to the direct PostgreSQL connection URL for migrations.",
    );
  if (command === "seed" && !local)
    throw new Error("Demo seeding is only available with --local.");
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    if (command === "migrate") await migrate(client);
    else {
      await client.query("BEGIN");
      try {
        await client.query("SELECT pg_advisory_xact_lock(726004, 1)");
        const count = (
          await client.query("SELECT count(*) AS count FROM mailboxes")
        ).rows[0].count;
        if (Number(count) > 0)
          throw new Error(
            "Demo seed requires an empty local database; existing data was preserved.",
          );
        await client.query(
          await readFile(new URL("./seed.sql", import.meta.url), "utf8"),
        );
        await client.query("COMMIT");
        console.log("Created local demo data.");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    // Connection errors can contain credentials or server details. Print only the code.
    console.error(
      error?.code
        ? `PostgreSQL operation failed (${error.code}).`
        : error.message,
    );
    process.exitCode = 1;
  });
}
