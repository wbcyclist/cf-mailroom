export function isReplyAttribution(text: string): boolean {
  return /^On\s+.{4,}\s+w(?:rote|rites):$/i.test(text.replace(/\s+/g, " ").trim());
}

/**
 * Split a plain-text email body into the newly written part and the quoted
 * tail (the "On ... wrote:" block most clients append). Used by the UI for
 * collapsed display and by the inbound pipeline for clean snippets — the
 * stored body is never modified.
 */
export function splitQuotedTail(body: string): { main: string; quoted: string | null } {
  const lines = body.split("\n");
  const attributionRe =
    /^(-{3,}\s*Original Message\s*-{3,}|________________________________)/i;

  // Find the trailing quote block once. Inline replies must not rescan each suffix.
  let quoteStart = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && !line.startsWith(">")) break;
    if (line.startsWith(">")) quoteStart = i;
  }

  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (isReplyAttribution(line) || attributionRe.test(line)) {
      cut = i;
      break;
    }
    // A run of quoted lines with nothing but quotes after it
    if (i === quoteStart) {
      cut = i;
      break;
    }
  }
  if (cut <= 0) return { main: body, quoted: null };
  const main = lines.slice(0, cut).join("\n").trimEnd();
  const quoted = lines.slice(cut).join("\n").trim();
  if (!main) return { main: body, quoted: null };
  return { main, quoted };
}
