import { useI18n, Trans } from "./LanguageProvider";
import { useDeferredValue, useEffect, useRef } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  accessSetupError,
  fetchLabels,
  fetchMailboxes,
  fetchThreads,
  searchThreads,
  THREAD_PAGE_SIZE,
  type ThreadCursor,
} from "./api";
import { AccessSetup } from "./components/AccessSetup";
import { AgentSettings } from "./components/AgentSettings";
import { GeneralSettings } from "./components/GeneralSettings";
import { ComposeEmailProvider, useCompose } from "./components/ComposeEmail";
import { InboxIcon } from "./components/Icons";
import { Sidebar } from "./components/Sidebar";
import { ThreadList, type ThreadFilter, type ThreadScope } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { useUnreadIndicator } from "./use-unread-indicator";

type WorkspaceView = "inbox" | "archive" | "settings";
type SettingsSection = "general" | "inboxes";

export function App() {
  return (
    <ComposeEmailProvider>
    <Routes>
      <Route path="/" element={<Navigate to="/inbox" replace />} />
      <Route path="/inbox" element={<Workspace view="inbox" />} />
      <Route path="/inbox/:threadId" element={<Workspace view="inbox" />} />
      <Route path="/archive" element={<Workspace view="archive" />} />
      <Route path="/archive/:threadId" element={<Workspace view="archive" />} />
      <Route path="/mailboxes/:mailboxId" element={<Workspace view="inbox" mailboxScoped />} />
      <Route
        path="/mailboxes/:mailboxId/threads/:threadId"
        element={<Workspace view="inbox" mailboxScoped />}
      />
      <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
      <Route
        path="/settings/general"
        element={<Workspace view="settings" settingsSection="general" />}
      />
      <Route
        path="/settings/inboxes"
        element={<Workspace view="settings" settingsSection="inboxes" />}
      />
      <Route
        path="/settings/inboxes/:mailboxId"
        element={<Workspace view="settings" settingsSection="inboxes" />}
      />
      <Route path="*" element={<Navigate to="/inbox" replace />} />
    </Routes>
    </ComposeEmailProvider>
  );
}

function Workspace(props: {
  view: WorkspaceView;
  mailboxScoped?: boolean;
  settingsSection?: SettingsSection;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const openCompose = useCompose();
  const location = useLocation();
  const params = useParams<{ mailboxId?: string; threadId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const autoSelectedScope = useRef<string | null>(null);

  const routeMailboxId = parseId(params.mailboxId);
  const selectedMailbox =
    props.mailboxScoped ||
    (props.view === "settings" && props.settingsSection === "inboxes")
      ? routeMailboxId
      : null;
  const selectedThread = parseId(params.threadId);
  const search = searchParams.get("q") ?? "";
  const filter = parseFilter(searchParams.get("filter"));
  const activeLabel = parseId(searchParams.get("label") ?? undefined);
  const deferredSearch = useDeferredValue(search.trim());
  const isArchive = props.view === "archive";
  const isMailView = props.view !== "settings";
  const autoSelected = (location.state as { autoSelected?: boolean } | null)?.autoSelected === true;

  const mailboxes = useQuery({
    queryKey: ["mailboxes"],
    queryFn: fetchMailboxes,
    retry: (failureCount, error) => !accessSetupError(error) && failureCount < 3,
    refetchIntervalInBackground: true,
  });
  useUnreadIndicator(
    accessSetupError(mailboxes.error)
      ? 0
      : mailboxes.data?.reduce((sum, mailbox) => sum + mailbox.unread_count, 0),
  );
  const labels = useQuery({ queryKey: ["labels"], queryFn: () => fetchLabels() });
  const threadQuery = {
    mailboxId: selectedMailbox,
    labelId: activeLabel,
    unread: filter === "unread",
  };
  const threads = useInfiniteQuery({
    queryKey: ["threads", props.view, selectedMailbox, deferredSearch, activeLabel, filter],
    queryFn: ({ pageParam }) =>
      deferredSearch
        ? searchThreads(deferredSearch, threadQuery)
        : fetchThreads({ ...threadQuery, status: isArchive ? "archived" : "open" }, pageParam),
    initialPageParam: null as ThreadCursor | null,
    getNextPageParam: (lastPage) => {
      const last = lastPage.at(-1);
      return deferredSearch || !last || lastPage.length < THREAD_PAGE_SIZE
        ? undefined
        : { at: last.last_message_at, id: last.id };
    },
    placeholderData: keepPreviousData,
    enabled: isMailView,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.some(
          (thread) =>
            thread.draft_run_status === "queued" || thread.draft_run_status === "generating",
        ),
      )
        ? 3_000
        : 30_000,
  });
  const threadRows = threads.data?.pages.flat() ?? [];

  const listPath = isArchive
    ? "/archive"
    : selectedMailbox === null
      ? "/inbox"
      : `/mailboxes/${selectedMailbox}`;

  useEffect(() => {
    if (selectedThread !== null) autoSelectedScope.current = listPath;
  }, [listPath, selectedThread]);

  useEffect(() => {
    if (
      isMailView &&
      selectedThread === null &&
      autoSelectedScope.current !== listPath &&
      threadRows.length &&
      !threads.isPlaceholderData &&
      window.matchMedia("(min-width: 768px)").matches
    ) {
      autoSelectedScope.current = listPath;
      navigate(
        { pathname: `${threadListBase(listPath)}/${threadRows[0].id}`, search: location.search },
        { replace: true, state: { autoSelected: true } },
      );
    }
  }, [
    isMailView,
    listPath,
    location.search,
    navigate,
    selectedThread,
    threadRows,
    threads.isPlaceholderData,
  ]);

  useEffect(() => {
    if (
      props.view !== "settings" ||
      props.settingsSection !== "inboxes" ||
      selectedMailbox !== null ||
      !mailboxes.data?.length
    ) return;
    const defaultMailbox =
      mailboxes.data.find((mailbox) => mailbox.agent_mode !== "off") ?? mailboxes.data[0];
    navigate(`/settings/inboxes/${defaultMailbox.id}`, { replace: true });
  }, [mailboxes.data, navigate, props.settingsSection, props.view, selectedMailbox]);

  const selectMailbox = (id: number | null) => {
    navigate(id === null ? "/inbox" : `/mailboxes/${id}`);
  };

  const selectScope = (scope: ThreadScope) => {
    if (scope === "archive") navigate("/archive");
    else selectMailbox(scope === "all" ? null : scope);
  };

  const openSettings = () => {
    navigate("/settings/general");
  };

  const openInboxSettings = () => {
    const mailboxId =
      selectedMailbox ??
      mailboxes.data?.find((mailbox) => mailbox.agent_mode !== "off")?.id ??
      mailboxes.data?.[0]?.id;
    navigate(mailboxId ? `/settings/inboxes/${mailboxId}` : "/settings/inboxes");
  };

  const updateQuery = (key: "q" | "filter" | "label", value: string, defaultValue = "") => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (!value || value === defaultValue) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  };

  const selectedMailboxName = isArchive
    ? t("Archive")
    : selectedMailbox === null
      ? t("All inboxes")
      : (mailboxes.data?.find((mailbox) => mailbox.id === selectedMailbox)?.address ??
        t("Inbox"));
  const scopeUnread = (mailboxes.data ?? [])
    .filter((mailbox) => selectedMailbox === null || mailbox.id === selectedMailbox)
    .reduce((sum, mailbox) => sum + mailbox.unread_count, 0);
  const inboxIsEmpty =
    props.view === "inbox" &&
    selectedThread === null &&
    !threads.isLoading &&
    !threads.isError &&
    !threads.isPlaceholderData &&
    deferredSearch === "" &&
    filter === "all" &&
    activeLabel === null &&
    threadRows.length === 0;

  const setupError = accessSetupError(mailboxes.error);
  if (setupError) {
    return (
      <AccessSetup
        error={setupError}
        onRetry={() => window.location.reload()}
        retrying={mailboxes.isFetching}
      />
    );
  }

  return (
    <div className="flex h-dvh min-h-[560px] overflow-hidden bg-background text-foreground">
      <Sidebar
        mailboxes={mailboxes.data ?? []}
        selected={selectedMailbox}
        activeView={props.view}
        onSelect={selectMailbox}
        onOpenArchive={() => navigate("/archive")}
        onOpenSettings={openSettings}
        onCompose={() => openCompose(selectedMailbox)}
      />

      {props.view === "settings" ? (
        <main className="min-w-0 flex-1 overflow-hidden">
          {props.settingsSection === "general" ? (
            <GeneralSettings
              onBack={() => navigate("/inbox")}
              onOpenInboxes={openInboxSettings}
            />
          ) : (
            <AgentSettings
              mailboxes={mailboxes.data ?? []}
              mailboxId={selectedMailbox}
              onSelectMailbox={(id) => navigate(`/settings/inboxes/${id}`)}
              onMailboxDeleted={(nextMailboxId) =>
                navigate(
                  nextMailboxId === null
                    ? "/settings/inboxes"
                    : `/settings/inboxes/${nextMailboxId}`,
                  { replace: true },
                )
              }
              onOpenGeneral={() => navigate("/settings/general")}
              onBack={() => navigate("/inbox")}
            />
          )}
        </main>
      ) : (
        <>
          <ThreadList
            mailboxes={mailboxes.data ?? []}
            threads={threadRows}
            labels={labels.data ?? []}
            title={selectedMailboxName}
            selected={selectedThread}
            selectedMailbox={selectedMailbox}
            scope={isArchive ? "archive" : (selectedMailbox ?? "all")}
            archive={isArchive}
            unreadCount={!isArchive && !deferredSearch && activeLabel === null ? scopeUnread : null}
            showMailboxChip={selectedMailbox === null}
            search={search}
            filter={filter}
            activeLabel={activeLabel}
            loading={threads.isLoading}
            fetching={threads.isFetching && !threads.isFetchingNextPage}
            hasMore={threads.hasNextPage}
            loadingMore={threads.isFetchingNextPage}
            onLoadMore={() => threads.fetchNextPage()}
            error={threads.isError}
            detailsOpen={selectedThread !== null}
            emptyInbox={inboxIsEmpty}
            onSearch={(query) => updateQuery("q", query)}
            onFilter={(nextFilter) => updateQuery("filter", nextFilter, "all")}
            onSelectLabel={(id) => updateQuery("label", id === null ? "" : String(id))}
            onSelectScope={selectScope}
            onOpenSettings={openSettings}
            onCompose={() => openCompose(selectedMailbox)}
            onOpenMailboxSettings={(id) => navigate(`/settings/inboxes/${id}`)}
            onSelect={(id) =>
              navigate({ pathname: `${threadListBase(listPath)}/${id}`, search: location.search })
            }
            onMarkedUnread={(ids) => {
              if (selectedThread !== null && ids.includes(selectedThread)) {
                navigate({ pathname: listPath, search: location.search });
              }
            }}
          />
          <main
            className={`min-w-0 flex-1 overflow-hidden ${selectedThread === null ? "hidden md:block" : "block"}`}
          >
            {selectedThread !== null ? (
              <ThreadView
                key={selectedThread}
                threadId={selectedThread}
                deferMarkRead={autoSelected}
                onBack={() => navigate({ pathname: listPath, search: location.search })}
                onMoved={() => navigate({ pathname: listPath, search: location.search })}
              />
            ) : (
              <EmptyReadingPane empty={inboxIsEmpty} />
            )}
          </main>
        </>
      )}
    </div>
  );
}

function EmptyReadingPane(props: { empty: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center bg-canvas px-6 pb-16 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full border bg-background text-muted-foreground">
        <InboxIcon className="h-5 w-5" />
      </span>
      <p className="mt-3 text-[13px] font-medium text-foreground">
        {props.empty ? t("Nothing here yet") : t("No conversation selected")}
      </p>
      <p className="mt-1 max-w-64 text-[12.5px] leading-5 text-muted-foreground">
        {props.empty ? (
          t("New email sent to your inboxes will appear in the list.")
        ) : (
          <>
            <Trans message="Choose one from the list, or press {key} to search." values={{
              key: <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-background px-1 align-[1px] font-sans text-[11px] font-medium">/</kbd>,
            }} />
          </>
        )}
      </p>
    </div>
  );
}

function parseId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseFilter(value: string | null): ThreadFilter {
  return value === "unread" ? value : "all";
}

function threadListBase(listPath: string): string {
  return listPath.startsWith("/mailboxes/") ? `${listPath}/threads` : listPath;
}
