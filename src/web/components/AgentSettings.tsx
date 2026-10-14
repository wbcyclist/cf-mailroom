import { useI18n, Trans } from "../LanguageProvider";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Label, Mailbox, Playbook } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  activateDomain,
  createDomain,
  createLabel,
  createMailbox,
  createPlaybook,
  deleteLabel,
  deleteMailbox,
  deletePlaybook,
  fetchDomains,
  fetchLabels,
  fetchPlaybooks,
  updateLabel,
  updateMailbox,
  updatePlaybook,
} from "../api";
import {
  ExternalLinkIcon,
  PencilIcon,
  PlusIcon,
  SparklesIcon,
  TagIcon,
  TrashIcon,
} from "./Icons";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";

interface PlaybookEditorState {
  id?: number;
  name: string;
  whenToUse: string;
  instructions: string;
  exampleReply: string;
  enabled: boolean;
}

interface LabelEditorState {
  id?: number;
  name: string;
  condition: string;
}

interface InboxSetupState {
  address: string;
  localPart: string;
  domainName: string;
}

const CLOUDFLARE_EMAIL_ROUTING_URL =
  "https://dash.cloudflare.com/?to=%2F%3Aaccount%2Femail-service%2Frouting";
const CLOUDFLARE_EMAIL_SENDING_URL =
  "https://dash.cloudflare.com/?to=%2F%3Aaccount%2Femail-service%2Fsending";

const EMPTY_PLAYBOOK: PlaybookEditorState = {
  name: "",
  whenToUse: "",
  instructions: "",
  exampleReply: "",
  enabled: true,
};

const EMPTY_LABEL: LabelEditorState = {
  name: "",
  condition: "",
};

export function AgentSettings(props: {
  mailboxes: Mailbox[];
  mailboxId: number | null;
  onSelectMailbox: (id: number) => void;
  onMailboxDeleted: (nextMailboxId: number | null) => void;
  onOpenGeneral: () => void;
  onBack: () => void;
}) {
  const { t, errorMessage } = useI18n();
  const queryClient = useQueryClient();
  const [baseInstructions, setBaseInstructions] = useState("");
  const [editor, setEditor] = useState<PlaybookEditorState | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<number | null>(null);
  const [labelEditor, setLabelEditor] = useState<LabelEditorState | null>(null);
  const [labelDeleteConfirmation, setLabelDeleteConfirmation] = useState<number | null>(null);
  const [mailboxEditorOpen, setMailboxEditorOpen] = useState(false);
  const [mailboxAddress, setMailboxAddress] = useState("");
  const [mailboxValidationError, setMailboxValidationError] = useState<string | null>(null);
  const [inboxSetup, setInboxSetup] = useState<InboxSetupState | null>(null);
  const [routingConfirmed, setRoutingConfirmed] = useState(false);
  const [sendingConfirmed, setSendingConfirmed] = useState(false);
  const [routingAddress, setRoutingAddress] = useState<string | null>(null);
  const [deleteInboxOpen, setDeleteInboxOpen] = useState(false);
  const [deleteInboxConfirmation, setDeleteInboxConfirmation] = useState("");

  const selectedMailboxId = props.mailboxId;
  const mailbox = props.mailboxes.find((item) => item.id === selectedMailboxId) ?? null;

  useEffect(() => {
    setBaseInstructions(mailbox?.agent_instructions ?? "");
    setDeleteConfirmation(null);
    setLabelDeleteConfirmation(null);
    setDeleteInboxOpen(false);
    setDeleteInboxConfirmation("");
  }, [mailbox]);

  const playbooks = useQuery({
    queryKey: ["playbooks", selectedMailboxId],
    queryFn: () => fetchPlaybooks(selectedMailboxId!),
    enabled: selectedMailboxId !== null,
  });

  const labels = useQuery({
    queryKey: ["labels", selectedMailboxId],
    queryFn: () => fetchLabels(selectedMailboxId!),
    enabled: selectedMailboxId !== null,
  });

  const domains = useQuery({
    queryKey: ["domains"],
    queryFn: fetchDomains,
  });

  const addMailbox = useMutation({
    mutationFn: (input: { localPart: string; domainId: number }) =>
      createMailbox({ local_part: input.localPart, domain_id: input.domainId }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      setMailboxEditorOpen(false);
      setMailboxAddress("");
      setInboxSetup(null);
      setRoutingAddress(created.address);
      props.onSelectMailbox(created.id);
    },
  });

  const configureAndAddMailbox = useMutation({
    mutationFn: async (setup: InboxSetupState) => {
      let domain = await createDomain({ name: setup.domainName });
      if (domain.status !== "active") domain = await activateDomain(domain.id);
      return createMailbox({ local_part: setup.localPart, domain_id: domain.id });
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      await queryClient.invalidateQueries({ queryKey: ["domains"] });
      setMailboxEditorOpen(false);
      setMailboxAddress("");
      setInboxSetup(null);
      props.onSelectMailbox(created.id);
    },
  });

  const saveInstructions = useMutation({
    mutationFn: () =>
      updateMailbox(selectedMailboxId!, { agent_instructions: baseInstructions.trim() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
  });

  const toggleDrafting = useMutation({
    mutationFn: (enabled: boolean) =>
      updateMailbox(selectedMailboxId!, { agent_mode: enabled ? "draft" : "off" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
        queryClient.invalidateQueries({ queryKey: ["threads"] }),
      ]);
    },
  });

  const savePlaybook = useMutation({
    mutationFn: async (input: PlaybookEditorState) => {
      const payload = {
        mailbox_id: selectedMailboxId!,
        name: input.name.trim(),
        when_to_use: input.whenToUse.trim(),
        instructions: input.instructions.trim(),
        example_reply: input.exampleReply.trim() || null,
        enabled: input.enabled,
      };
      return input.id ? updatePlaybook(input.id, payload) : createPlaybook(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["playbooks", selectedMailboxId] });
      setEditor(null);
    },
  });

  const togglePlaybook = useMutation({
    mutationFn: (playbook: Playbook) =>
      updatePlaybook(playbook.id, { enabled: !playbook.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["playbooks", selectedMailboxId] }),
  });

  const removePlaybook = useMutation({
    mutationFn: (id: number) => deletePlaybook(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["playbooks", selectedMailboxId] });
      setDeleteConfirmation(null);
    },
  });

  const saveLabel = useMutation({
    mutationFn: async (input: LabelEditorState) => {
      const payload = {
        mailbox_id: selectedMailboxId!,
        name: input.name.trim(),
        condition: input.condition.trim(),
      };
      return input.id ? updateLabel(input.id, payload) : createLabel(payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      setLabelEditor(null);
    },
  });

  const removeLabel = useMutation({
    mutationFn: (id: number) => deleteLabel(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["labels"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      setLabelDeleteConfirmation(null);
    },
  });

  const openLabelEditor = (label?: Label) => {
    setLabelEditor(
      label
        ? { id: label.id, name: label.name, condition: label.condition }
        : { ...EMPTY_LABEL },
    );
  };

  const removeMailbox = useMutation({
    mutationFn: (input: { id: number; address: string }) =>
      deleteMailbox(input.id, deleteInboxConfirmation),
    onSuccess: async (_, deleted) => {
      const remainingMailboxes = props.mailboxes.filter((item) => item.id !== deleted.id);
      queryClient.setQueryData<Mailbox[]>(["mailboxes"], remainingMailboxes);
      queryClient.removeQueries({ queryKey: ["playbooks", deleted.id] });
      queryClient.removeQueries({ queryKey: ["threads"] });
      queryClient.removeQueries({ queryKey: ["thread"] });
      setDeleteInboxOpen(false);
      setDeleteInboxConfirmation("");
      props.onMailboxDeleted(remainingMailboxes[0]?.id ?? null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["mailboxes"] }),
        queryClient.invalidateQueries({ queryKey: ["domains"] }),
      ]);
    },
  });

  const instructionsDirty =
    baseInstructions.trim() !== (mailbox?.agent_instructions ?? "").trim();

  const openEditor = (playbook?: Playbook) => {
    setEditor(
      playbook
        ? {
            id: playbook.id,
            name: playbook.name,
            whenToUse: playbook.when_to_use,
            instructions: playbook.instructions,
            exampleReply: playbook.example_reply ?? "",
            enabled: Boolean(playbook.enabled),
          }
        : { ...EMPTY_PLAYBOOK },
    );
  };

  const openMailboxEditor = () => {
    addMailbox.reset();
    configureAndAddMailbox.reset();
    setMailboxAddress("");
    setMailboxValidationError(null);
    setInboxSetup(null);
    setRoutingConfirmed(false);
    setSendingConfirmed(false);
    setMailboxEditorOpen(true);
  };

  const prepareInbox = () => {
    const parsed = parseInboxAddress(mailboxAddress);
    if (!parsed) {
      setMailboxValidationError(t("Enter a valid email address"));
      return;
    }
    setMailboxValidationError(null);
    addMailbox.reset();
    configureAndAddMailbox.reset();

    const domain = domains.data?.find((item) => item.name === parsed.domainName);
    if (domain?.status === "active") {
      addMailbox.mutate({ localPart: parsed.localPart, domainId: domain.id });
      return;
    }
    setRoutingConfirmed(false);
    setSendingConfirmed(false);
    setInboxSetup(parsed);
  };

  const setupStepsRemaining = Number(!routingConfirmed) + Number(!sendingConfirmed);

  const activePlaybookCount = playbooks.data?.filter((item) => item.enabled).length ?? 0;

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="inboxes"
        onBack={props.onBack}
        onOpenGeneral={props.onOpenGeneral}
        onOpenInboxes={() => undefined}
      />

      <SettingsPage>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 sm:max-w-sm">
            <MailboxSelect
              mailboxes={props.mailboxes}
              selectedMailboxId={selectedMailboxId}
              onSelect={props.onSelectMailbox}
            />
          </div>
          <Button variant="outline" className="h-9 self-start sm:self-auto" onClick={openMailboxEditor}>
            <PlusIcon className="h-4 w-4" />
            {t("Add inbox")}
              </Button>
        </div>

        {mailbox ? (
          <>
            {!mailbox.has_received && (
              <SettingsBlock
                id="email-routing-heading"
                title={t("Email routing")}
                description={t("No mail has arrived yet. Make sure Email Routing sends this address to Mailroom, then send a test email.")}
              >
                <Button
                  variant="link"
                  className="h-auto p-0 underline decoration-muted-foreground/50 hover:decoration-current"
                  onClick={() => setRoutingAddress(mailbox.address)}
                >
                  {t("View setup steps")}
                </Button>
              </SettingsBlock>
            )}

            <SettingsBlock id="agent-drafting-heading" title={t("AI drafting")}>
              <SettingsPanel>
                <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="agent-drafting"
                      className="text-[13.5px] font-medium text-foreground"
                    >
                      {t("Draft replies to new messages")}
                    </label>
                    <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">
                      {t("Create a draft for new customer messages. Nothing is sent without your approval.")}
                    </p>
                    {toggleDrafting.isError && (
                      <p className="mt-2 text-xs text-destructive" role="alert">
                        {t("Couldn’t update AI drafting. Try again.")}
                      </p>
                    )}
                  </div>
                  <Switch
                    id="agent-drafting"
                    checked={
                      toggleDrafting.isPending
                        ? toggleDrafting.variables
                        : mailbox.agent_mode !== "off"
                    }
                    onCheckedChange={(checked) => toggleDrafting.mutate(checked)}
                    disabled={toggleDrafting.isPending}
                    aria-describedby="agent-drafting-description"
                    className="mt-0.5"
                  />
                  <span id="agent-drafting-description" className="sr-only">
                    {t("When enabled, the AI creates drafts that require your review before sending.")}
                  </span>
                </div>
              </SettingsPanel>
            </SettingsBlock>

            <SettingsBlock
              id="base-instructions-heading"
              title={t("Base Instructions")}
              description={t("Product context and guidance applied to every agent draft for this inbox.")}
            >
              <SettingsPanel className="transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
                <Textarea
                  value={baseInstructions}
                  onChange={(event) => setBaseInstructions(event.target.value)}
                  rows={4}
                  aria-labelledby="base-instructions-heading"
                  placeholder={t("Describe the product, the agent's role, voice, general rules, and signature…")}
                  className="max-h-[60dvh] min-h-32 resize-y rounded-none border-0 bg-transparent px-4 py-3.5 text-sm leading-6 shadow-none focus-visible:ring-0 sm:px-5 md:text-sm"
                />
                <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-4 py-2.5 sm:px-5">
                  <p className="min-w-0 text-xs text-muted-foreground" aria-live="polite">
                    {saveInstructions.isError ? (
                      <span className="text-destructive">{t("Couldn’t save these instructions. Try again.")}</span>
                    ) : instructionsDirty ? (
                      t("Unsaved changes")
                    ) : saveInstructions.isSuccess ? (
                      t("All changes saved")
                    ) : null}
                  </p>
                  <Button
                    size="sm"
                    onClick={() => saveInstructions.mutate()}
                    disabled={saveInstructions.isPending || !instructionsDirty}
                  >
                    {saveInstructions.isPending ? t("Saving…") : t("Save instructions")}
                  </Button>
                </div>
              </SettingsPanel>
            </SettingsBlock>

            <SettingsBlock
              id="labels-heading"
              title={t("Labels")}
              description={t("New conversations are automatically tagged with every label whose condition matches. Replies are not labeled.")}
              action={
                <Button variant="outline" size="sm" onClick={() => openLabelEditor()}>
                  <PlusIcon className="h-3.5 w-3.5" />
                  {t("New label")}
                </Button>
              }
            >
              <SettingsPanel>
                {labels.isLoading && <ListSkeleton />}
                {labels.isError && <ListMessage tone="error">{t("Couldn’t load labels.")}</ListMessage>}
                {labels.data?.length === 0 && (
                  <ListMessage icon={<TagIcon className="h-4 w-4" />}>{t("No labels yet")}</ListMessage>
                )}
                {labels.data && labels.data.length > 0 && (
                  <ul className="divide-y">
                    {labels.data.map((label) => (
                      <LabelRow
                        key={label.id}
                        label={label}
                        deleting={removeLabel.isPending && labelDeleteConfirmation === label.id}
                        confirmDelete={labelDeleteConfirmation === label.id}
                        onEdit={() => openLabelEditor(label)}
                        onRequestDelete={() => setLabelDeleteConfirmation(label.id)}
                        onCancelDelete={() => setLabelDeleteConfirmation(null)}
                        onDelete={() => removeLabel.mutate(label.id)}
                      />
                    ))}
                  </ul>
                )}
              </SettingsPanel>
            </SettingsBlock>

            <SettingsBlock
              id="playbooks-heading"
              title={t("Playbooks")}
              description={
                playbooks.data?.length
                  ? t("{active} of {total} active. A matching playbook is combined with Base Instructions.", { active: activePlaybookCount, total: playbooks.data.length })
                  : t("Guidance for specific support scenarios, combined with Base Instructions when a conversation matches.")
              }
              action={
                <Button variant="outline" size="sm" onClick={() => openEditor()}>
                  <PlusIcon className="h-3.5 w-3.5" />
                  {t("New playbook")}
                </Button>
              }
            >
              <SettingsPanel>
                {playbooks.isLoading && <ListSkeleton />}
                {playbooks.isError && <ListMessage tone="error">{t("Couldn’t load playbooks.")}</ListMessage>}
                {playbooks.data?.length === 0 && (
                  <ListMessage icon={<SparklesIcon className="h-4 w-4" />}>{t("No playbooks yet")}</ListMessage>
                )}
                {playbooks.data && playbooks.data.length > 0 && (
                  <ul className="divide-y">
                    {playbooks.data.map((playbook) => (
                      <PlaybookRow
                        key={playbook.id}
                        playbook={playbook}
                        toggling={togglePlaybook.isPending}
                        deleting={removePlaybook.isPending && deleteConfirmation === playbook.id}
                        confirmDelete={deleteConfirmation === playbook.id}
                        onToggle={() => togglePlaybook.mutate(playbook)}
                        onEdit={() => openEditor(playbook)}
                        onRequestDelete={() => setDeleteConfirmation(playbook.id)}
                        onCancelDelete={() => setDeleteConfirmation(null)}
                        onDelete={() => removePlaybook.mutate(playbook.id)}
                      />
                    ))}
                  </ul>
                )}
              </SettingsPanel>
            </SettingsBlock>

            <SettingsBlock id="danger-zone-heading" title={t("Danger zone")}>
              <SettingsPanel className="border-destructive/25">
                <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-medium text-foreground">{t("Delete inbox")}
                  </p>
                    <p className="mt-1 break-words text-[13px] leading-5 text-muted-foreground">
                      {t("Permanently deletes {address} and all of its conversations.", { address: mailbox.address })}
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    className="self-start sm:self-auto"
                    onClick={() => {
                      removeMailbox.reset();
                      setDeleteInboxConfirmation("");
                      setDeleteInboxOpen(true);
                    }}
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                    {t("Delete inbox")}
                  </Button>
                </div>
              </SettingsPanel>
            </SettingsBlock>
          </>
        ) : (
          <SettingsPanel>
            <div className="flex flex-col items-center px-6 py-12 text-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <SparklesIcon className="h-[18px] w-[18px]" />
              </span>
              <p className="mt-3 text-[13px] font-medium text-foreground">{t("No inbox to configure")}</p>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {t("Add an inbox before configuring the agent.")}
              </p>
              <Button className="mt-4" onClick={openMailboxEditor}>
                <PlusIcon className="h-4 w-4" />
                {t("Add inbox")}
              </Button>
            </div>
          </SettingsPanel>
        )}
      </SettingsPage>

      {editor && (
        <PlaybookEditor
          state={editor}
          saving={savePlaybook.isPending}
          error={savePlaybook.isError}
          onChange={setEditor}
          onClose={() => setEditor(null)}
          onSave={() => savePlaybook.mutate(editor)}
        />
      )}

      {labelEditor && (
        <LabelEditor
          state={labelEditor}
          saving={saveLabel.isPending}
          error={saveLabel.isError}
          errorMessage={
            saveLabel.error instanceof Error ? saveLabel.error.message : null
          }
          onChange={setLabelEditor}
          onClose={() => setLabelEditor(null)}
          onSave={() => saveLabel.mutate(labelEditor)}
        />
      )}

      <Dialog
        open={mailboxEditorOpen}
        onOpenChange={(open) => {
          if (addMailbox.isPending || configureAndAddMailbox.isPending) return;
          setMailboxEditorOpen(open);
          if (!open) {
            addMailbox.reset();
            configureAndAddMailbox.reset();
            setMailboxValidationError(null);
            setInboxSetup(null);
            setRoutingConfirmed(false);
            setSendingConfirmed(false);
          }
        }}
      >
        <DialogContent closeLabel={t("Close")}
          showCloseButton={!addMailbox.isPending && !configureAndAddMailbox.isPending}
          className={`max-h-[calc(100dvh-2rem)] overflow-y-auto ${inboxSetup ? "sm:max-w-[40rem]" : "sm:max-w-md"}`}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (inboxSetup) {
                if (setupStepsRemaining === 0) configureAndAddMailbox.mutate(inboxSetup);
              }
              else prepareInbox();
            }}
          >
            <DialogHeader>
              <DialogTitle>{inboxSetup ? t("Set up inbox") : t("Add inbox")}</DialogTitle>
            </DialogHeader>

            {!inboxSetup ? (
              <div className="py-5">
                <Field label={t("Email address")}>
                  <Input
                    type="email"
                    value={mailboxAddress}
                    onChange={(event) => {
                      setMailboxAddress(event.target.value);
                      setMailboxValidationError(null);
                      if (addMailbox.isError) addMailbox.reset();
                    }}
                    placeholder="support@example.com"
                    autoComplete="off"
                    autoFocus
                    required
                    aria-invalid={Boolean(mailboxValidationError || addMailbox.isError)}
                  />
                </Field>

                {domains.isError && (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                    <p className="text-sm text-destructive">{t("Couldn’t check email setup.")}</p>
                    <Button type="button" variant="outline" size="sm" onClick={() => domains.refetch()}>
                      {t("Retry")}
                    </Button>
                  </div>
                )}

                {(mailboxValidationError || addMailbox.isError) && (
                  <p className="mt-3 text-sm text-destructive" role="alert">
                    {mailboxValidationError ??
                      (addMailbox.error instanceof Error
                        ? errorMessage(addMailbox.error.message)
                        : t("Couldn’t add this inbox"))}
                  </p>
                )}
              </div>
            ) : (
              <div className="py-5">
                <div className="flex items-center justify-between gap-3 border-b pb-4">
                  <p className="min-w-0 truncate text-sm font-medium">{inboxSetup.address}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={configureAndAddMailbox.isPending}
                    onClick={() => {
                      configureAndAddMailbox.reset();
                      setInboxSetup(null);
                      setRoutingConfirmed(false);
                      setSendingConfirmed(false);
                    }}
                  >
                    {t("Edit")}
                  </Button>
                </div>

                <p className="pt-4 text-sm leading-5 text-muted-foreground">
                  {t("Finish these two steps in Cloudflare so this inbox can receive and send mail.")}
                </p>

                <ol className="divide-y">
                  <li className="flex items-start gap-3 py-4">
                    <SetupStepNumber number={1} done={routingConfirmed} />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium">{t("Route incoming mail to Mailroom")}</h3>
                      <ol className="mt-2 list-decimal space-y-1 pl-4 text-sm leading-5 text-muted-foreground marker:text-muted-foreground/70">
                        <li>
                          <Trans message="Open Email Routing for {domain} and go to Routing rules." values={{ domain: <span className="break-words font-medium text-foreground">{inboxSetup.domainName}</span> }} />
                        </li>
                        <li>
                          {t("Enable Catch-all. Mailroom still rejects addresses you haven’t added.")}
                        </li>
                        <li>
                          {t("Choose Send to a Worker, select the Worker running this Mailroom, and save.")}
                        </li>
                      </ol>
                      <details className="mt-2 text-sm leading-5">
                        <summary className="cursor-pointer rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                          {t("Using a subdomain or only this address?")}
                        </summary>
                        <p className="mt-1 text-muted-foreground">
                          <Trans message="Catch-all only works on root domains. Instead, add {address} as a custom address and send it to the same Worker." values={{ address: <span className="break-words font-medium text-foreground">{inboxSetup.address}</span> }} />
                        </p>
                      </details>
                      <Button asChild type="button" variant="outline" size="sm" className="mt-3">
                        <a href={CLOUDFLARE_EMAIL_ROUTING_URL} target="_blank" rel="noreferrer">
                          {t("Open Email Routing")}<ExternalLinkIcon />
                        </a>
                      </Button>
                      <SetupStepConfirm
                        id="confirm-email-routing"
                        checked={routingConfirmed}
                        onCheckedChange={setRoutingConfirmed}
                        label={t("I’ve set up routing")}
                      />
                    </div>
                  </li>
                  <li className="flex items-start gap-3 py-4">
                    <SetupStepNumber number={2} done={sendingConfirmed} />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium">{t("Turn on sending for this domain")}</h3>
                      <p className="mt-2 text-sm leading-5 text-muted-foreground">
                        <Trans message="In Email Sending, onboard {domain} and wait until its status is Active. This can take a few minutes." values={{ domain: <span className="break-words font-medium text-foreground">{inboxSetup.domainName}</span> }} />
                      </p>
                      <Button asChild type="button" variant="outline" size="sm" className="mt-3">
                        <a href={CLOUDFLARE_EMAIL_SENDING_URL} target="_blank" rel="noreferrer">
                          {t("Open Email Sending")}<ExternalLinkIcon />
                        </a>
                      </Button>
                      <SetupStepConfirm
                        id="confirm-email-sending"
                        checked={sendingConfirmed}
                        onCheckedChange={setSendingConfirmed}
                        label={t("Sending is active")}
                      />
                    </div>
                  </li>
                </ol>

                {configureAndAddMailbox.isError && (
                  <p className="text-sm text-destructive" role="alert">
                    {configureAndAddMailbox.error instanceof Error
                      ? errorMessage(configureAndAddMailbox.error.message)
                      : t("Couldn’t add this inbox")}
                  </p>
                )}
              </div>
            )}

            <DialogFooter className="flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              {inboxSetup && (
                <p className="mr-auto text-xs text-muted-foreground" aria-live="polite">
                  {setupStepsRemaining === 0
                    ? t("Ready to add")
                    : setupStepsRemaining === 1
                      ? t("1 step left")
                      : t("2 steps left")}
                </p>
              )}
              <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  disabled={addMailbox.isPending || configureAndAddMailbox.isPending}
                  onClick={() => setMailboxEditorOpen(false)}
                >
                  {t("Cancel")}
          </Button>
                <Button
                  type="submit"
                  disabled={
                    domains.isLoading ||
                    domains.isError ||
                    (!inboxSetup && !mailboxAddress.trim()) ||
                    (inboxSetup !== null && setupStepsRemaining > 0) ||
                    addMailbox.isPending ||
                    configureAndAddMailbox.isPending
                  }
                >
                  {addMailbox.isPending || configureAndAddMailbox.isPending
                    ? t("Adding…")
                    : t("Add inbox")}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={routingAddress !== null}
        onOpenChange={(open) => {
          if (!open) setRoutingAddress(null);
        }}
      >
        <DialogContent closeLabel={t("Close")} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("Set up email routing")}</DialogTitle>
            <DialogDescription>
              {t("If Catch-all or a rule for this address already sends mail to this Mailroom Worker, there’s nothing more to do.")}
            </DialogDescription>
          </DialogHeader>
          <div>
            <h3 className="text-sm font-medium">{t("Catch-all (recommended for root domains)")}</h3>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {t("Configure it once, then add future inboxes in Mailroom without extra routing rules.")}
            </p>
          </div>
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-6">
            <li>
              <Trans message="Open Email Routing for {domain} and go to Routing rules." values={{ domain: <span className="break-all font-medium">{routingAddress?.split("@")[1]}</span> }} />
            </li>
            <li>
              {t("Enable Catch-all.")}
            </li>
            <li>
              {t("Choose Send to a Worker and select the Worker running this Mailroom, then save the rule.")}
            </li>
          </ol>
          <p className="text-sm leading-5 text-muted-foreground">
            {t("Mailroom rejects addresses you haven’t added. Existing rules for specific addresses take priority over Catch-all.")}
          </p>
          <details className="text-sm leading-6">
            <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              {t("Route only this address, or use a subdomain")}
            </summary>
            <p className="mt-2 text-muted-foreground">
              <Trans message="Catch-all is only available for root domains. To route this address individually, add {address} as a custom address in Routing rules. Choose Send to a Worker, select the Worker running this Mailroom, and save." values={{ address: <span className="break-words font-medium text-foreground">{routingAddress}</span> }} />
            </p>
          </details>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoutingAddress(null)}>{t("Close")}</Button>
            <Button asChild>
              <a href={CLOUDFLARE_EMAIL_ROUTING_URL} target="_blank" rel="noreferrer">
                {t("Open Email Routing")}<ExternalLinkIcon />
              </a>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteInboxOpen}
        onOpenChange={(open) => {
          if (removeMailbox.isPending) return;
          setDeleteInboxOpen(open);
          if (!open) {
            setDeleteInboxConfirmation("");
            removeMailbox.reset();
          }
        }}
      >
        <DialogContent closeLabel={t("Close")} showCloseButton={!removeMailbox.isPending} className="sm:max-w-md">
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                mailbox &&
                deleteInboxConfirmation === mailbox.address &&
                !removeMailbox.isPending
              ) {
                removeMailbox.mutate({ id: mailbox.id, address: mailbox.address });
              }
            }}
          >
            <DialogHeader>
              <DialogTitle className="break-words">{t("Delete {name}?", { name: mailbox?.address ?? "" })}</DialogTitle>
              <DialogDescription>
                {t("This permanently deletes its conversations, drafts, and playbooks. This can’t be undone.")}
              </DialogDescription>
            </DialogHeader>

            {mailbox && (
              <Field label={t("Type {address} to confirm", { address: mailbox.address })}>
                <Input
                  value={deleteInboxConfirmation}
                  onChange={(event) => {
                    setDeleteInboxConfirmation(event.target.value);
                    if (removeMailbox.isError) removeMailbox.reset();
                  }}
                  autoComplete="off"
                  autoFocus
                  disabled={removeMailbox.isPending}
                  aria-invalid={removeMailbox.isError}
                />
              </Field>
            )}

            {removeMailbox.isError && (
              <p className="text-sm text-destructive" role="alert">
                {removeMailbox.error instanceof Error
                  ? errorMessage(removeMailbox.error.message)
                  : t("Couldn’t delete this inbox")}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDeleteInboxOpen(false)}
                disabled={removeMailbox.isPending}
              >
                {t("Cancel")}
          </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={
                  !mailbox ||
                  deleteInboxConfirmation !== mailbox.address ||
                  removeMailbox.isPending
                }
              >
                {removeMailbox.isPending ? t("Deleting…") : t("Delete inbox")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function parseInboxAddress(value: string): InboxSetupState | null {
  const address = value.trim().toLowerCase();
  const separator = address.lastIndexOf("@");
  if (separator <= 0 || separator === address.length - 1) return null;

  const localPart = address.slice(0, separator);
  const domainName = address.slice(separator + 1);
  const validLocalPart =
    localPart.length <= 64 &&
    !localPart.startsWith(".") &&
    !localPart.endsWith(".") &&
    !localPart.includes("..") &&
    /^[a-z0-9._+-]+$/.test(localPart);
  const validDomain =
    domainName.length <= 253 &&
    domainName.includes(".") &&
    domainName.split(".").every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );

  return validLocalPart && validDomain ? { address, localPart, domainName } : null;
}

function PlaybookRow(props: {
  playbook: Playbook;
  toggling: boolean;
  deleting: boolean;
  confirmDelete: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const enabled = Boolean(props.playbook.enabled);
  return (
    <ListRow
      title={props.playbook.name}
      badge={
        !enabled && (
          <Badge variant="secondary" className="h-5 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground">
            {t("Disabled")}
          </Badge>
        )
      }
      muted={!enabled}
      description={props.playbook.when_to_use}
      detail={props.playbook.instructions}
      entity="playbook"
      deleting={props.deleting}
      confirmDelete={props.confirmDelete}
      onEdit={props.onEdit}
      onRequestDelete={props.onRequestDelete}
      onCancelDelete={props.onCancelDelete}
      onDelete={props.onDelete}
      leading={
        <Switch
          aria-label={t(enabled ? "Disable {name}" : "Enable {name}", { name: props.playbook.name })}
          onCheckedChange={props.onToggle}
          checked={enabled}
          disabled={props.toggling}
          className="mt-0.5"
        />
      }
    />
  );
}

function ListRow(props: {
  title: string;
  badge?: React.ReactNode;
  description: string;
  detail?: string;
  muted?: boolean;
  entity: "playbook" | "label";
  leading: React.ReactNode;
  deleting: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className="group flex items-start gap-3 px-4 py-3.5 sm:px-5">
      <span className="flex h-6 shrink-0 items-center">{props.leading}</span>
      <div className={`min-w-0 flex-1 transition-opacity ${props.muted ? "opacity-60" : ""}`}>
        <div className="flex min-h-6 flex-wrap items-center gap-2">
          <h3 className="text-[13.5px] font-medium text-foreground">{props.title}</h3>
          {props.badge}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
          {props.description}
        </p>
        {props.detail && (
          <p className="mt-1 line-clamp-1 text-xs leading-5 text-muted-foreground/90">
            <span className="font-medium text-foreground/70">{t("How to reply · ")}</span>
            {props.detail}
          </p>
        )}
      </div>
      {props.confirmDelete ? (
        <div className="flex shrink-0 items-center gap-1.5" role="group" aria-label={t("Confirm delete {name}", { name: props.title })}>
          <span className="mr-1 hidden text-xs text-destructive sm:inline">{t(props.entity === "playbook" ? "Delete this playbook?" : "Delete this label?")}</span>
          <Button variant="ghost" size="sm" onClick={props.onCancelDelete}>
            {t("Cancel")}
          </Button>
          <Button variant="destructive" size="sm" onClick={props.onDelete} disabled={props.deleting}>
            {props.deleting ? t("Deleting…") : t("Delete")}
          </Button>
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onEdit}
            className="text-muted-foreground"
            aria-label={t("Edit {name}", { name: props.title })}
            title={t("Edit")}
          >
            <PencilIcon className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={props.onRequestDelete}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={t("Delete {name}", { name: props.title })}
            title={t("Delete")}
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </li>
  );
}

function ListMessage(props: { icon?: React.ReactNode; tone?: "error"; children: React.ReactNode }) {
  return (
    <div
      role={props.tone === "error" ? "alert" : undefined}
      className={`flex items-center gap-3 px-4 py-4 text-[13px] sm:px-5 ${
        props.tone === "error" ? "bg-destructive/5 text-destructive" : "text-muted-foreground"
      }`}
    >
      {props.icon && (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
          {props.icon}
        </span>
      )}
      {props.children}
    </div>
  );
}

function MailboxSelect(props: {
  mailboxes: Mailbox[];
  selectedMailboxId: number | null;
  onSelect: (id: number) => void;
}) {
  const { t } = useI18n();
  return (
    <Select
      value={props.selectedMailboxId === null ? undefined : String(props.selectedMailboxId)}
      onValueChange={(value) => props.onSelect(Number(value))}
    >
      <SelectTrigger className="h-9 w-full bg-background text-sm" aria-label={t("Inbox to configure")}>
        <SelectValue placeholder={t("Choose inbox")} />
      </SelectTrigger>
      <SelectContent>
        {props.mailboxes.map((item) => (
          <SelectItem key={item.id} value={String(item.id)}>
            {item.address}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PlaybookEditor(props: {
  state: PlaybookEditorState;
  saving: boolean;
  error: boolean;
  onChange: (state: PlaybookEditorState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const valid =
    props.state.name.trim() &&
    props.state.whenToUse.trim() &&
    props.state.instructions.trim();

  const update = (fields: Partial<PlaybookEditorState>) =>
    props.onChange({ ...props.state, ...fields });

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent closeLabel={t("Close")} className="max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{props.state.id ? t("Edit playbook") : t("New playbook")}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <Field label={t("Name")}>
            <Input
              value={props.state.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder={t("Refund requests")}
              autoFocus
            />
          </Field>

          <Field label={t("When to use")}>
            <Textarea
              value={props.state.whenToUse}
              onChange={(event) => update({ whenToUse: event.target.value })}
              placeholder={t("Use when a customer asks to cancel a charge, reverse a payment, or receive a refund.")}
              rows={3}
            />
          </Field>

          <Field label={t("How to reply")}>
            <Textarea
              value={props.state.instructions}
              onChange={(event) => update({ instructions: event.target.value })}
              placeholder={t("Acknowledge the request. Verify the payment before promising a refund. Do not promise an exact arrival date.")}
              rows={5}
            />
          </Field>

          <Field label={t("Example reply (optional)")}>
            <Textarea
              value={props.state.exampleReply}
              onChange={(event) => update({ exampleReply: event.target.value })}
              placeholder={t("Thanks for reaching out…")}
              rows={5}
            />
          </Field>

          <label className="flex cursor-pointer items-center justify-between rounded-lg border bg-muted/40 px-3.5 py-3">
            <span className="text-[13px] font-medium text-foreground">{t("Enabled")}</span>
            <Switch
              checked={props.state.enabled}
              onCheckedChange={(enabled) => update({ enabled })}
            />
          </label>

          {props.error && (
            <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
              {t("Couldn’t save this playbook. Check the fields and try again.")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={props.onClose}
          >
            {t("Cancel")}
          </Button>
          <Button
            onClick={props.onSave}
            disabled={!valid || props.saving}
          >
            {props.saving ? t("Saving…") : props.state.id ? t("Save changes") : t("Create playbook")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium text-foreground">{props.label}</span>
      <span className="mt-1.5 block">{props.children}</span>
    </label>
  );
}

function LabelRow(props: {
  label: Label;
  deleting: boolean;
  confirmDelete: boolean;
  onEdit: () => void;
  onRequestDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  return (
    <ListRow
      title={props.label.name}
      description={props.label.condition}
      entity="label"
      deleting={props.deleting}
      confirmDelete={props.confirmDelete}
      onEdit={props.onEdit}
      onRequestDelete={props.onRequestDelete}
      onCancelDelete={props.onCancelDelete}
      onDelete={props.onDelete}
      leading={<TagIcon className="h-4 w-4 text-muted-foreground" />}
    />
  );
}

function LabelEditor(props: {
  state: LabelEditorState;
  saving: boolean;
  error: boolean;
  errorMessage: string | null;
  onChange: (state: LabelEditorState) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t, errorMessage } = useI18n();
  const valid = props.state.name.trim() && props.state.condition.trim();

  const update = (fields: Partial<LabelEditorState>) =>
    props.onChange({ ...props.state, ...fields });

  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogContent closeLabel={t("Close")} className="max-h-[calc(100dvh-2rem)] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{props.state.id ? t("Edit label") : t("New label")}</DialogTitle>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <Field label={t("Name")}>
            <Input
              value={props.state.name}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="guest-post"
              autoFocus
            />
          </Field>

          <Field label={t("Match condition")}>
            <Textarea
              value={props.state.condition}
              onChange={(event) => update({ condition: event.target.value })}
              placeholder={t("Apply when the sender pitches writing a guest article for our blog, or asks us to publish their contributed post.")}
              rows={4}
            />
            <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
              {t("New incoming emails are checked against this description. Replies in existing conversations are not labeled.")}
            </span>
          </Field>

          {props.error && (
            <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
              {(props.errorMessage ? errorMessage(props.errorMessage) : null) ?? t("Couldn’t save this label. Check the fields and try again.")}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={props.onClose}
          >
            {t("Cancel")}
          </Button>
          <Button
            onClick={props.onSave}
            disabled={!valid || props.saving}
          >
            {props.saving ? t("Saving…") : props.state.id ? t("Save changes") : t("Create label")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ListSkeleton() {
  return (
    <div className="divide-y" aria-busy="true">
      {[0, 1].map((item) => (
        <div key={item} className="flex animate-pulse items-start gap-3 px-4 py-4 sm:px-5">
          <span className="h-5 w-5 rounded bg-muted" />
          <div className="flex-1 space-y-2">
            <span className="block h-3 w-1/4 rounded bg-muted" />
            <span className="block h-2.5 w-3/4 rounded bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SetupStepNumber(props: { number: number; done: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums transition-colors ${
        props.done ? "bg-foreground text-background" : "border text-muted-foreground"
      }`}
    >
      {props.number}
    </span>
  );
}

function SetupStepConfirm(props: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <Checkbox
        id={props.id}
        checked={props.checked}
        onCheckedChange={(checked) => props.onCheckedChange(checked === true)}
      />
      <label htmlFor={props.id} className="cursor-pointer text-sm">
        {props.label}
      </label>
    </div>
  );
}
