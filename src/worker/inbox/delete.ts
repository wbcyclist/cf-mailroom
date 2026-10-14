import { type Database, statement } from "../database.ts";
export interface InboxDeletionEnv {
  DB: Database;
}

export interface DeletedInbox {
  id: number;
  address: string;
  domainId: number | null;
}

export class InboxDeletionError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "InboxDeletionError";
    this.status = status;
  }
}

export async function deleteInbox(
  env: InboxDeletionEnv,
  input: { id: number; confirmAddress: string },
): Promise<DeletedInbox> {
  return env.DB.transaction(async (db) => {
    const inbox = await db.one<{
      id: number;
      address: string;
      domain_id: number | null;
    }>(
      "SELECT id, address, domain_id FROM mailboxes WHERE id = $1 FOR UPDATE",
      [input.id],
    );

    if (!inbox) throw new InboxDeletionError("Inbox not found", 404);
    if (
      input.confirmAddress.trim().toLowerCase() !== inbox.address.toLowerCase()
    ) {
      throw new InboxDeletionError(
        "Type the inbox address to confirm deletion",
        400,
      );
    }

    const activeSend = await db.one<{ active: number }>(
      `SELECT 1 AS active
     FROM reply_attempts ra
     JOIN threads t ON t.id = ra.thread_id
     WHERE t.mailbox_id = $1 AND ra.status IN ('pending', 'sending')
     UNION ALL
     SELECT 1 AS active
     FROM outbound_attempts oa
     WHERE (oa.mailbox_id = $2 OR oa.thread_id IN (
       SELECT id FROM threads WHERE mailbox_id = $3
     )) AND oa.status IN ('pending', 'sending')
     LIMIT 1`,
      [inbox.id, inbox.id, inbox.id],
    );

    if (activeSend) {
      throw new InboxDeletionError(
        "Wait for the current email to finish sending, then try again",
        409,
      );
    }

    const threadIds = "SELECT id FROM threads WHERE mailbox_id = $1";
    const results = await db.batch([
      statement(
        `DELETE FROM reply_attempts WHERE thread_id IN (${threadIds})`,
        [inbox.id],
      ),
      statement(
        `DELETE FROM outbound_attempts
       WHERE mailbox_id = $1 OR thread_id IN (${threadIds})`,
        [inbox.id],
      ),
      statement(`DELETE FROM draft_runs WHERE thread_id IN (${threadIds})`, [
        inbox.id,
      ]),
      statement(`DELETE FROM drafts WHERE thread_id IN (${threadIds})`, [
        inbox.id,
      ]),
      statement(`DELETE FROM thread_labels WHERE thread_id IN (${threadIds})`, [
        inbox.id,
      ]),
      statement(`DELETE FROM messages WHERE thread_id IN (${threadIds})`, [
        inbox.id,
      ]),
      statement("DELETE FROM threads WHERE mailbox_id = $1", [inbox.id]),
      statement("DELETE FROM playbooks WHERE mailbox_id = $1", [inbox.id]),
      statement("DELETE FROM labels WHERE mailbox_id = $1", [inbox.id]),
      statement("DELETE FROM mailboxes WHERE id = $1", [inbox.id]),
    ]);

    if (results.at(-1)?.rowCount !== 1) {
      throw new InboxDeletionError(
        "Inbox changed while it was being deleted",
        409,
      );
    }

    return { id: inbox.id, address: inbox.address, domainId: inbox.domain_id };
  });
}
