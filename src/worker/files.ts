import { Buffer } from "node:buffer";
import type { Database } from "./database.ts";

export async function putFile(
  db: Database,
  mailboxId: number,
  key: string,
  content: ArrayBuffer | Uint8Array,
  contentType: string,
): Promise<void> {
  await db.query(
    `INSERT INTO stored_files (key, mailbox_id, content, content_type)
     VALUES ($1, $2, $3, $4)`,
    [
      key,
      mailboxId,
      Buffer.from(
        content instanceof ArrayBuffer ? new Uint8Array(content) : content,
      ),
      contentType,
    ],
  );
}

export async function getFile(
  db: Database,
  key: string,
): Promise<Uint8Array | null> {
  const file = await db.one<{ content: Buffer }>(
    "SELECT content FROM stored_files WHERE key = $1",
    [key],
  );
  return file ? new Uint8Array(file.content) : null;
}
