export interface LabelRule {
  id: number;
  name: string;
  condition: string;
}

const LABEL_MODEL = "typesafe/jev";
const MATCH_THRESHOLD = 0.5;
const MAX_BODY_CHARS = 8_000;
const MAX_LABELS_PER_EVALUATION = 20;

export async function labelNewThread(
  env: Env,
  threadId: number,
  inboundMessageId: number,
): Promise<void> {
  if (!env.AI) return;

  const message = await env.DB.one<{
    subject: string;
    from_address: string;
    from_name: string | null;
    text_body: string | null;
    mailbox_id: number;
  }>(
    `SELECT msg.subject, msg.from_address, msg.from_name, msg.text_body,
            t.mailbox_id
     FROM messages msg
     JOIN threads t ON t.id = msg.thread_id
     WHERE msg.id = $1 AND msg.thread_id = $2`,
    [inboundMessageId, threadId],
  );
  if (!message) return;

  const { rows: labels } = await env.DB.query<LabelRule>(
    "SELECT id, name, condition FROM labels WHERE mailbox_id = $1 ORDER BY id",
    [message.mailbox_id],
  );
  if (labels.length === 0) return;

  const evaluatedLabels = labels.slice(0, MAX_LABELS_PER_EVALUATION);
  const response = await env.AI.run(LABEL_MODEL, {
    state: {
      from: message.from_name
        ? `${message.from_name} <${message.from_address}>`
        : message.from_address,
      subject: message.subject,
      body: (message.text_body ?? "").slice(0, MAX_BODY_CHARS),
    },
    questions: buildJevQuestions(evaluatedLabels),
  });

  const matched = matchedLabelIds(evaluatedLabels, response);
  for (const labelId of matched) {
    await env.DB.query(
      "INSERT INTO thread_labels (thread_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [threadId, labelId],
    );
  }
}

export function buildJevQuestions(
  labels: LabelRule[],
): Record<string, unknown> {
  return Object.fromEntries(
    labels.map((label) => [
      questionKey(label.id),
      {
        type: "noul",
        instructions: `Does this email match the "${label.name}" label?`,
        criteria: {
          true: label.condition,
          false: `The email does not match: ${label.condition}`,
        },
      },
    ]),
  );
}

export function matchedLabelIds(
  labels: LabelRule[],
  response: unknown,
): number[] {
  // Cloudflare's third-party model transport wraps the model output, while
  // the JEV schema documents the bare payload. Accept both response shapes.
  const envelope = response as { state?: unknown; result?: unknown } | null;
  if (envelope?.state !== undefined && envelope.state !== "Completed") {
    throw new Error("Invalid JEV response: evaluation did not complete");
  }
  const result = envelope?.state === "Completed" ? envelope.result : response;
  const answers = (result as { answers?: unknown } | null)?.answers;

  return labels
    .filter(
      (label) => jevNoul(answers, questionKey(label.id)) >= MATCH_THRESHOLD,
    )
    .map((label) => label.id);
}

function questionKey(labelId: number): string {
  return `label_${labelId}`;
}

function jevNoul(answers: unknown, key: string): number {
  const answer = (answers as Record<string, unknown> | null)?.[key];
  const noul = (answer as { noul?: unknown } | null)?.noul;
  if (
    typeof noul !== "number" ||
    !Number.isFinite(noul) ||
    noul < 0 ||
    noul > 1
  ) {
    throw new Error(
      `Invalid JEV response: missing or invalid probability for ${key}`,
    );
  }
  return noul;
}
