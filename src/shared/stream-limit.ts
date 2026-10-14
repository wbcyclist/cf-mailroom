export class BodyLimitError extends Error {
  constructor() {
    super("Request body exceeds the size limit");
    this.name = "BodyLimitError";
  }
}

/** Bound allocation even when Content-Length is absent or incorrect. */
export async function readLimitedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new BodyLimitError();
      chunks.push(value);
    }
  } finally {
    // Cancellation must not wait for an untrusted sender to finish uploading.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
