import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment } from "../../shared/types";
import { buildEmailHtmlDocument, inlineImageCandidates } from "../email-html";
import { loadInlineImages, type InlineImage } from "../email-images";

const MIN_EMAIL_HEIGHT = 80;
const MAX_EMAIL_HEIGHT = 20_000;

export function EmailHtmlBody({
  html,
  attachments,
  sender,
}: {
  html: string;
  attachments: Attachment[];
  sender: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [imageSources, setImageSources] = useState<ReadonlyMap<number, string>>(new Map());
  const imageKey = useMemo(() => JSON.stringify(inlineImageCandidates(html, attachments)), [html, attachments]);
  useEffect(() => {
    const controller = new AbortController();
    const sources = new Map<number, string>();
    setImageSources(new Map());
    void loadInlineImages(JSON.parse(imageKey) as InlineImage[], controller.signal, (id, url) => {
      if (controller.signal.aborted) URL.revokeObjectURL(url);
      else sources.set(id, url);
    }).then(() => {
      if (!controller.signal.aborted) setImageSources(new Map(sources));
    });
    return () => {
      controller.abort();
      for (const url of sources.values()) URL.revokeObjectURL(url);
    };
  }, [imageKey]);
  const sourceDocument = useMemo(
    () => buildEmailHtmlDocument(html, attachments, imageSources),
    [attachments, html, imageSources],
  );

  useEffect(
    () => () => {
      resizeObserverRef.current?.disconnect();
    },
    [],
  );

  const fitContent = () => {
    const frame = frameRef.current;
    const document = frame?.contentDocument;
    if (!frame || !document) return;

    const resize = () => {
      const measuredHeight = Math.max(
        // The root scrollHeight is at least the current frame height, which
        // prevents the frame from shrinking when quoted history is closed.
        document.body?.getBoundingClientRect().height ?? 0,
        document.body?.scrollHeight ?? 0,
        MIN_EMAIL_HEIGHT,
      );
      frame.style.height = `${Math.min(Math.ceil(measuredHeight), MAX_EMAIL_HEIGHT)}px`;
    };

    resizeObserverRef.current?.disconnect();
    const observer = new ResizeObserver(resize);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
    resizeObserverRef.current = observer;
    resize();
  };

  return (
    <>
      <p className="mt-3 text-xs text-muted-foreground">External images are blocked.</p>
      <iframe
        ref={frameRef}
        title={`Email from ${sender}`}
        srcDoc={sourceDocument}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
        onLoad={fitContent}
        className="mt-3 block min-h-20 w-full border-0 bg-white"
      />
    </>
  );
}
