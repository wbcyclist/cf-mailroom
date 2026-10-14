import { isReplyAttribution } from "../shared/quote";

const REPLY_QUOTES = '.gmail_quote, .yahoo_quoted, blockquote[type="cite"]';

/** Fold only recognizable email history, preserving ordinary blockquotes and inline replies. */
export function collapseEmailQuotes(
  document: Document,
  labels = { show: "Show quoted text", hide: "Hide quoted text" },
): void {
  const body = document.body;
  const wrap = (range: Range) => {
    // A quote-only message must remain readable without opening a disclosure.
    const remainder = document.createElement("div");
    const before = document.createRange();
    before.selectNodeContents(body);
    before.setEnd(range.startContainer, range.startOffset);
    const after = document.createRange();
    after.selectNodeContents(body);
    after.setStart(range.endContainer, range.endOffset);
    remainder.replaceChildren(before.cloneContents(), after.cloneContents());
    if (!hasContent(remainder) || !hasContent(range.cloneContents())) return;

    const details = document.createElement("details");
    details.className = "mailroom-quoted-text";
    const summary = document.createElement("summary");
    const show = document.createElement("span");
    show.className = "mailroom-show-quote";
    show.textContent = labels.show;
    const hide = document.createElement("span");
    hide.className = "mailroom-hide-quote";
    hide.textContent = labels.hide;
    summary.append(show, hide);
    details.append(summary, range.extractContents());
    range.insertNode(details);
  };

  // Client wrappers delimit just the quote, so a reply below it stays visible.
  for (const quote of body.querySelectorAll(`${REPLY_QUOTES}, blockquote`)) {
    if (quote.closest(".mailroom-quoted-text") || quote.parentElement?.closest(REPLY_QUOTES)) continue;
    const attribution = precedingAttribution(quote);
    if (!quote.matches(REPLY_QUOTES) && !attribution) continue;
    const range = document.createRange();
    range.setStartBefore(attribution ?? quote);
    range.setEndAfter(quote);
    wrap(range);
  }

  // Outlook puts its reply header and history in sibling elements.
  const outlookHeader = body.querySelector("#divRplyFwdMsg");
  if (outlookHeader && !outlookHeader.closest(".mailroom-quoted-text")) {
    const range = document.createRange();
    range.setStartBefore(outlookHeader);
    range.setEnd(body, body.childNodes.length);
    wrap(range);
  }

  // Other clients use a standalone attribution followed by unwrapped history.
  for (const element of body.querySelectorAll("div, p")) {
    if (element.closest(".mailroom-quoted-text") || !isReplyAttribution(element.textContent ?? "")) continue;
    if ([...element.querySelectorAll("div, p")].some((child) => isReplyAttribution(child.textContent ?? ""))) continue;
    const range = document.createRange();
    range.setStartBefore(element);
    range.setEnd(body, body.childNodes.length);
    wrap(range);
    break;
  }
}

function precedingAttribution(quote: Element): Node | null {
  let text = "";
  for (let node = quote.previousSibling; node; node = node.previousSibling) {
    if (node instanceof Element && node.tagName === "BR") {
      if (text.trim()) break;
      continue;
    }
    text = (node.textContent ?? "") + text;
    if (isReplyAttribution(text)) return node;
    if (node instanceof Element && !node.matches("a, span, b, strong, i, em")) break;
  }
  return null;
}

function hasContent(node: ParentNode): boolean {
  const copy = node.cloneNode(true) as ParentNode;
  copy.querySelectorAll("style, summary, .mailroom-quoted-text").forEach((element) => element.remove());
  return Boolean(copy.textContent?.trim() || copy.querySelector("img, hr"));
}
