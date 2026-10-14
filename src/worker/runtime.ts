import { createDatabase } from "./database.ts";

/** Keep the request pool alive until all background database work has finished. */
export async function withDatabase<T>(
  bindings: WorkerEnv,
  ctx: ExecutionContext,
  work: (env: Env, ctx: ExecutionContext) => Promise<T> | T,
): Promise<T> {
  const db = createDatabase(bindings.HYPERDRIVE.connectionString);
  const pending: Promise<unknown>[] = [];
  const scopedContext = new Proxy(ctx, {
    get(target, key) {
      if (key === "waitUntil")
        return (promise: Promise<unknown>) => {
          pending.push(Promise.resolve(promise));
          target.waitUntil(promise);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    return await work({ ...bindings, DB: db }, scopedContext);
  } finally {
    ctx.waitUntil(
      (async () => {
        // A background job can enqueue more background work before it completes.
        while (pending.length) await Promise.allSettled(pending.splice(0));
        await db.close();
      })(),
    );
  }
}
