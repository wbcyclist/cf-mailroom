import { readLimitedStream } from "../shared/stream-limit.ts";

export interface InlineImage {
  id: number;
  size: number;
  content_type: string;
}

const RASTER_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

export function selectInlineImages(images: InlineImage[]): InlineImage[] {
  let bytes = 0;
  const selected = new Map<number, InlineImage>();
  for (const image of images) {
    if (selected.has(image.id)) continue;
    if (!Number.isSafeInteger(image.id) || image.id <= 0 ||
        !Number.isSafeInteger(image.size) || image.size <= 0 || image.size > MAX_IMAGE_BYTES ||
        !RASTER_TYPES.has(image.content_type.toLowerCase())) continue;
    if (selected.size >= 10 || bytes + image.size > MAX_TOTAL_BYTES) continue;
    bytes += image.size;
    selected.set(image.id, image);
  }
  return [...selected.values()];
}

/** Only the parent page fetches approved current-message attachments. */
export async function loadInlineImages(
  images: InlineImage[],
  signal: AbortSignal,
  accept: (id: number, objectUrl: string) => void,
): Promise<void> {
  const pending = [...selectInlineImages(images)];
  await Promise.all(Array.from({ length: Math.min(2, pending.length) }, async () => {
    while (pending.length && !signal.aborted) {
      const image = pending.shift()!;
      try {
        const response = await fetch(`/api/attachments/${image.id}`, { signal, redirect: "error" });
        if (!response.ok) {
          await response.body?.cancel();
          continue;
        }
        const bytes = await readLimitedStream(response.body, image.size);
        if (signal.aborted || bytes.byteLength !== image.size) continue;
        const blob = new Blob([bytes], { type: image.content_type.toLowerCase() });
        accept(image.id, URL.createObjectURL(blob));
      } catch {
        // Missing or oversized attachments must not fall back to an external URL.
      }
    }
  }));
}
