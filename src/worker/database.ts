import pg, { type PoolClient, type QueryResult, type QueryResultRow } from "pg";

export interface SqlStatement {
  text: string;
  values: unknown[];
}

export function statement(text: string, values: unknown[] = []): SqlStatement {
  return { text, values };
}

// Public IDs and counts are JSON numbers. Refuse silent bigint precision loss.
function safeInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error("Database integer exceeds the JSON number range");
  return number;
}

export const databaseTypes = {
  getTypeParser(oid: number, format?: string) {
    if (format !== "binary") {
      if (oid === 20) return safeInteger;
      if (oid === 1184) return (value: string) => new Date(value).toISOString();
    }
    return pg.types.getTypeParser(oid, format as "text");
  },
};

/** A request-scoped pool. Hyperdrive owns the shared origin connection pool. */
export class Database {
  private pool: pg.Pool;
  private client?: PoolClient;

  constructor(pool: pg.Pool, client?: PoolClient) {
    this.pool = pool;
    this.client = client;
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return (this.client ?? this.pool).query<Row>(text, values);
  }

  async one<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<Row | null> {
    return (await this.query<Row>(text, values)).rows[0] ?? null;
  }

  async transaction<T>(work: (db: Database) => Promise<T>): Promise<T> {
    if (this.client) return work(this);
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const result = await work(new Database(this.pool, client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }

  async batch<Row extends QueryResultRow = QueryResultRow>(
    statements: SqlStatement[],
  ): Promise<QueryResult<Row>[]> {
    return this.transaction(async (db) => {
      const results: QueryResult<Row>[] = [];
      for (const item of statements)
        results.push(await db.query<Row>(item.text, item.values));
      return results;
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createDatabase(connectionString: string): Database {
  const pool = new pg.Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    types: databaseTypes,
  });
  pool.on("error", () => console.error("Idle PostgreSQL connection failed"));
  return new Database(pool);
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}
