import { useEffect, useState } from "react";
import {
  notifyHostsChanged,
  useToast,
  useTranslation,
  type TabProps,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  EmptyState,
  Field,
  FieldPair,
  FormFooter,
  ListBadge,
  ListRow,
  NumberField,
  PanelList,
  PanelShell,
  SecretField,
  SectionCard,
  Segmented,
  SelectField,
  StatRow,
  SwitchRow,
  TagInput,
  TextAreaField,
  TextField,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import {
  DEFAULT_CONFIG,
  FOLDER_SOURCES,
  MISSING_ACTIONS,
  type SyncConfig,
} from "../backend/config";
import {
  readFailure,
  type ConfigResponse,
  type PlanEntry,
  type SyncResult,
} from "./api";
import {
  ClockIcon,
  FilterIcon,
  ListIcon,
  NetworkIcon,
  PlugIcon,
  RefreshIcon,
  ServerIcon,
} from "./icons";

type Busy = null | "load" | "save" | "test" | "preview" | "sync" | "forget";

const COUNTS = [
  "found",
  "created",
  "updated",
  "adopted",
  "unchanged",
  "skipped",
  "missing",
  "deleted",
] as const;

const ACTION_TONE: Record<
  PlanEntry["action"],
  "destructive" | "muted" | "brand" | "warning" | "success"
> = {
  create: "success",
  update: "brand",
  adopt: "brand",
  unchanged: "muted",
  skip: "muted",
  missing: "warning",
  delete: "destructive",
};

/** A TagInput that keeps its own half typed text. */
function TagField({
  label,
  hint,
  placeholder,
  tags,
  onChange,
}: {
  label: string;
  hint?: string;
  placeholder: string;
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = useState("");
  return (
    <Field label={label} hint={hint}>
      <TagInput
        tags={tags}
        input={input}
        placeholder={placeholder}
        onTagsChange={onChange}
        onInputChange={setInput}
      />
    </Field>
  );
}

function ResultView({
  result,
  at,
}: {
  result: SyncResult | null;
  at: string | null;
}) {
  const { t } = useTranslation();
  if (!result) return <EmptyState title={t("result.never")} />;
  const changed = (result.entries ?? []).filter(
    (entry) => entry.action !== "unchanged",
  );
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        {result.dryRun
          ? t("result.preview")
          : at
            ? t("result.at", { at: new Date(at).toLocaleString() })
            : null}
      </p>
      <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
        {COUNTS.map((key) => (
          <StatRow key={key} label={t(`result.${key}`)} value={result[key]} />
        ))}
      </div>
      {result.errors.length > 0 && (
        <div className="flex flex-col gap-1 border border-destructive/40 p-2 text-xs text-destructive">
          <span className="font-medium">{t("result.errors")}</span>
          {result.errors.map((error, index) => (
            <span key={index}>{error}</span>
          ))}
        </div>
      )}
      {result.entries &&
        (changed.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("result.empty")}</p>
        ) : (
          <PanelList>
            {changed.map((entry) => (
              <ListRow
                key={`${entry.action}:${entry.kind}:${entry.netboxId}`}
                title={entry.name}
                badges={
                  <>
                    <ListBadge tone={ACTION_TONE[entry.action]}>
                      {t(`result.action.${entry.action}`)}
                    </ListBadge>
                    <ListBadge tone="muted">
                      {t(`result.kind.${entry.kind}`)}
                    </ListBadge>
                  </>
                }
                meta={
                  entry.reason
                    ? t(`result.reason.${entry.reason}`)
                    : entry.changes?.length
                      ? `${entry.ip ?? ""} · ${t("result.changes", {
                          fields: entry.changes.join(", "),
                        })}`
                      : (entry.ip ?? undefined)
                }
              />
            ))}
          </PanelList>
        ))}
    </div>
  );
}

export function createNetboxSyncTab(app: TermixApp) {
  return function NetboxSyncTab({ isVisible }: TabProps) {
    const { t } = useTranslation();
    const toast = useToast();
    const confirm = useConfirm();

    const [loaded, setLoaded] = useState<ConfigResponse | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [config, setConfig] = useState<SyncConfig>(DEFAULT_CONFIG);
    const [token, setToken] = useState("");
    const [dirty, setDirty] = useState(false);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState<Busy>(null);
    const [result, setResult] = useState<SyncResult | null>(null);
    const [resultAt, setResultAt] = useState<string | null>(null);

    const load = async () => {
      setBusy("load");
      try {
        const { data } = await app.api.get<ConfigResponse>("/config");
        setLoaded(data);
        setConfig(data.config);
        setResult(data.lastResult);
        setResultAt(data.lastSyncAt);
        setToken("");
        setDirty(false);
        setErrors({});
        setLoadFailed(false);
      } catch {
        setLoadFailed(true);
      } finally {
        setBusy(null);
      }
    };

    useEffect(() => {
      if (isVisible) void load();
    }, [isVisible]);

    const update = <K extends keyof SyncConfig>(
      key: K,
      value: SyncConfig[K],
    ) => {
      setConfig((current) => ({ ...current, [key]: value }));
      setErrors((current) => {
        if (!current[key]) return current;
        const { [key]: _removed, ...rest } = current;
        return rest;
      });
      setDirty(true);
    };

    const fail = (error: unknown) => {
      const failure = readFailure(error);
      const fields = Object.entries(failure.fieldErrors);
      if (fields.length) {
        setErrors(failure.fieldErrors);
        // Name each field: one can sit in a section scrolled out of view,
        // like a deleted SSH key under New hosts.
        toast.error(
          t("errors.invalidSettings", {
            detail: fields
              .map(
                ([field, code]) =>
                  `${t(`fields.${field}.label`, { defaultValue: field })}: ${t(
                    `errors.${code}`,
                    { defaultValue: code },
                  )}`,
              )
              .join(" "),
          }),
        );
        return;
      }
      const known =
        failure.code === "unknown"
          ? ""
          : t(`errors.${failure.code}`, {
              defaultValue: "",
              detail: failure.detail,
            });
      toast.error(known || failure.message || t("errors.unknown"));
    };

    const errorText = (key: string) =>
      errors[key] ? t(`errors.${errors[key]}`) : undefined;

    const save = async (): Promise<boolean> => {
      setBusy("save");
      try {
        await app.api.put("/config", {
          config,
          token: token.trim() || undefined,
        });
        toast.success(t("toast.saved"));
        await load();
        return true;
      } catch (error) {
        fail(error);
        return false;
      } finally {
        setBusy(null);
      }
    };

    const test = async () => {
      setBusy("test");
      try {
        const { data } = await app.api.post<{ version: string | null }>(
          "/test",
          { config, token: token.trim() || undefined },
        );
        toast.success(t("toast.testOk", { version: data.version ?? "" }));
      } catch (error) {
        fail(error);
      } finally {
        setBusy(null);
      }
    };

    const preview = async () => {
      if (dirty && !(await save())) return;
      setBusy("preview");
      try {
        const { data } = await app.api.post<SyncResult>("/preview");
        setResult(data);
        setResultAt(null);
      } catch (error) {
        fail(error);
      } finally {
        setBusy(null);
      }
    };

    const syncNow = async () => {
      if (dirty && !(await save())) return;
      if (config.missingAction === "delete" || config.autoRemove) {
        setBusy("preview");
        let planned: SyncResult;
        try {
          planned = (await app.api.post<SyncResult>("/preview")).data;
        } catch (error) {
          fail(error);
          return;
        } finally {
          setBusy(null);
        }
        if (
          planned.deleted > 0 &&
          !(await confirm({
            title: t("confirm.deleteHosts.title"),
            description: t("confirm.deleteHosts.description", {
              count: planned.deleted,
            }),
            confirmLabel: t("confirm.deleteHosts.confirm"),
          }))
        ) {
          setResult(planned);
          setResultAt(null);
          return;
        }
      }
      setBusy("sync");
      try {
        const { data } = await app.api.post<SyncResult>("/sync");
        setResult(data);
        setResultAt(new Date().toISOString());
        notifyHostsChanged();
        toast.success(
          t("toast.synced", {
            created: data.created,
            updated: data.updated + data.adopted,
            deleted: data.deleted,
            missing: data.missing,
          }),
        );
      } catch (error) {
        fail(error);
      } finally {
        setBusy(null);
      }
    };

    const forget = async () => {
      const ok = await confirm({
        title: t("confirm.forget.title"),
        description: t("confirm.forget.description"),
        confirmLabel: t("confirm.forget.confirm"),
      });
      if (!ok) return;
      setBusy("forget");
      try {
        await app.api.delete("/config");
        toast.success(t("toast.forgotten"));
        await load();
      } catch (error) {
        fail(error);
      } finally {
        setBusy(null);
      }
    };

    if (!loaded) {
      return (
        <PanelShell
          icon={<NetworkIcon className="size-4" />}
          title={t("tab.title")}
        >
          <EmptyState
            title={loadFailed ? t("tab.loadError") : t("tab.loading")}
          />
        </PanelShell>
      );
    }

    const working = busy !== null;
    const credentialOptions = loaded.credentials.map((credential) => ({
      value: String(credential.id),
      label: credential.name,
    }));

    return (
      <PanelShell
        icon={<NetworkIcon className="size-4" />}
        title={t("tab.title")}
        status={
          busy === "sync" || loaded.running ? t("tab.running") : undefined
        }
        actions={
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={working || !loaded.configured}
              onClick={() => void preview()}
            >
              {t("actions.preview")}
            </Button>
            <Button
              size="sm"
              disabled={working || !loaded.configured}
              onClick={() => void syncNow()}
            >
              <RefreshIcon className="size-3.5" />
              {t("actions.sync")}
            </Button>
          </div>
        }
        scroll
      >
        <div className="flex flex-col gap-2 p-2.5">
          {!loaded.configured && (
            <p className="text-xs text-muted-foreground">
              {t("tab.notConfigured")}
            </p>
          )}

          <SectionCard
            title={t("sections.connection")}
            icon={<PlugIcon className="size-4" />}
            action={
              <Button
                size="sm"
                variant="outline"
                disabled={working}
                onClick={() => void test()}
              >
                {t("actions.test")}
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              <TextField
                label={t("fields.netboxUrl.label")}
                hint={t("fields.netboxUrl.hint")}
                value={config.netboxUrl}
                placeholder="https://netbox.example.com"
                onChange={(value) => update("netboxUrl", value)}
                error={errorText("netboxUrl")}
                mono
              />
              <SecretField
                label={t("fields.token.label")}
                hint={
                  loaded.hasToken
                    ? t("fields.token.saved")
                    : t("fields.token.hint")
                }
                value={token}
                placeholder={t("fields.token.placeholder")}
                onChange={(value) => {
                  setToken(value);
                  setDirty(true);
                }}
                error={errorText("token")}
              />
              <TextAreaField
                label={t("fields.caCert.label")}
                hint={t("fields.caCert.hint")}
                value={config.caCert}
                rows={3}
                placeholder="-----BEGIN CERTIFICATE-----"
                onChange={(value) => update("caCert", value)}
                error={errorText("caCert")}
                mono
              />
            </div>
          </SectionCard>

          <SectionCard
            title={t("sections.filters")}
            icon={<FilterIcon className="size-4" />}
          >
            <div className="flex flex-col gap-3">
              <SwitchRow
                label={t("fields.devices.label")}
                description={t("fields.devices.description")}
                checked={config.devices}
                onChange={(value) => update("devices", value)}
              />
              <SwitchRow
                label={t("fields.virtualMachines.label")}
                description={t("fields.virtualMachines.description")}
                checked={config.virtualMachines}
                onChange={(value) => update("virtualMachines", value)}
              />
              <SwitchRow
                label={t("fields.ipAddresses.label")}
                description={t("fields.ipAddresses.description")}
                checked={config.ipAddresses}
                onChange={(value) => update("ipAddresses", value)}
              />
              {errorText("devices") && (
                <p className="text-xs text-destructive">
                  {errorText("devices")}
                </p>
              )}
              <TagField
                label={t("fields.tags.label")}
                hint={t("fields.tags.hint")}
                placeholder={t("fields.tags.placeholder")}
                tags={config.tags}
                onChange={(value) => update("tags", value)}
              />
              <Field label={t("fields.tagMatch.label")}>
                <Segmented
                  value={config.tagMatch}
                  onChange={(value) => update("tagMatch", value)}
                  options={[
                    { value: "any", label: t("fields.tagMatch.any") },
                    { value: "all", label: t("fields.tagMatch.all") },
                  ]}
                />
              </Field>
              <TagField
                label={t("fields.excludeTags.label")}
                placeholder={t("fields.excludeTags.placeholder")}
                tags={config.excludeTags}
                onChange={(value) => update("excludeTags", value)}
              />
              <TagField
                label={t("fields.statuses.label")}
                hint={t("fields.statuses.hint")}
                placeholder={t("fields.statuses.placeholder")}
                tags={config.statuses}
                onChange={(value) => update("statuses", value)}
              />
            </div>
          </SectionCard>

          <SectionCard
            title={t("sections.hosts")}
            icon={<ServerIcon className="size-4" />}
          >
            <div className="flex flex-col gap-3">
              <FieldPair>
                <TextField
                  label={t("fields.username.label")}
                  value={config.username}
                  onChange={(value) => update("username", value)}
                />
                <NumberField
                  label={t("fields.port.label")}
                  value={config.port}
                  min={1}
                  max={65535}
                  onChange={(value) => update("port", value)}
                  error={errorText("port")}
                />
              </FieldPair>
              <FieldPair>
                <SelectField
                  label={t("fields.authType.label")}
                  value={config.authType}
                  onChange={(value) => update("authType", value)}
                  options={[
                    { value: "none", label: t("fields.authType.none") },
                    {
                      value: "credential",
                      label: t("fields.authType.credential"),
                    },
                  ]}
                />
                {config.authType === "credential" ? (
                  <SelectField
                    label={t("fields.credentialId.label")}
                    value={
                      config.credentialId ? String(config.credentialId) : ""
                    }
                    placeholder={t("fields.credentialId.placeholder")}
                    onChange={(value) =>
                      update("credentialId", value ? Number(value) : null)
                    }
                    options={credentialOptions}
                    hint={
                      credentialOptions.length === 0
                        ? t("fields.credentialId.empty")
                        : undefined
                    }
                    error={errorText("credentialId")}
                  />
                ) : (
                  <div />
                )}
              </FieldPair>
              <TagField
                label={t("fields.credentialTagPrefixes.label")}
                hint={t("fields.credentialTagPrefixes.hint")}
                placeholder={t("fields.credentialTagPrefixes.placeholder")}
                tags={config.credentialTagPrefixes}
                onChange={(value) => update("credentialTagPrefixes", value)}
              />
              <SwitchRow
                label={t("fields.passwordWithoutCredential.label")}
                description={t("fields.passwordWithoutCredential.description")}
                checked={config.passwordWithoutCredential}
                onChange={(value) => update("passwordWithoutCredential", value)}
              />
              <FieldPair>
                <SelectField
                  label={t("fields.folderSource.label")}
                  value={config.folderSource}
                  onChange={(value) => update("folderSource", value)}
                  options={FOLDER_SOURCES.map((value) => ({
                    value,
                    label: t(`fields.folderSource.${value}`),
                  }))}
                />
                <TextField
                  label={t("fields.folder.label")}
                  hint={t("fields.folder.hint")}
                  value={config.folder}
                  onChange={(value) => update("folder", value)}
                  error={errorText("folder")}
                />
              </FieldPair>
              <FieldPair>
                <TextField
                  label={t("fields.portCustomField.label")}
                  hint={t("fields.portCustomField.hint")}
                  value={config.portCustomField}
                  onChange={(value) => update("portCustomField", value)}
                  mono
                />
                <TextField
                  label={t("fields.usernameCustomField.label")}
                  hint={t("fields.usernameCustomField.hint")}
                  value={config.usernameCustomField}
                  onChange={(value) => update("usernameCustomField", value)}
                  mono
                />
              </FieldPair>
            </div>
          </SectionCard>

          <SectionCard
            title={t("sections.updates")}
            icon={<RefreshIcon className="size-4" />}
          >
            <div className="flex flex-col gap-3">
              <SwitchRow
                label={t("fields.copyNetboxTags.label")}
                description={t("fields.copyNetboxTags.description")}
                checked={config.copyNetboxTags}
                onChange={(value) => update("copyNetboxTags", value)}
              />
              <TextField
                label={t("fields.syncTag.label")}
                hint={t("fields.syncTag.hint")}
                value={config.syncTag}
                onChange={(value) => update("syncTag", value)}
              />
              <SwitchRow
                label={t("fields.syncNotes.label")}
                description={t("fields.syncNotes.description")}
                checked={config.syncNotes}
                onChange={(value) => update("syncNotes", value)}
              />
              <SwitchRow
                label={t("fields.adoptExisting.label")}
                description={t("fields.adoptExisting.description")}
                checked={config.adoptExisting}
                onChange={(value) => update("adoptExisting", value)}
              />
              <SelectField
                label={t("fields.missingAction.label")}
                value={config.missingAction}
                onChange={(value) => update("missingAction", value)}
                options={MISSING_ACTIONS.map((value) => ({
                  value,
                  label: t(`fields.missingAction.${value}`),
                }))}
              />
              {config.missingAction !== "delete" && (
                <SwitchRow
                  label={t("fields.autoRemove.label")}
                  description={t("fields.autoRemove.description")}
                  checked={config.autoRemove}
                  onChange={(value) => update("autoRemove", value)}
                />
              )}
              {config.missingAction !== "delete" && config.autoRemove && (
                <NumberField
                  label={t("fields.removeAfterDays.label")}
                  hint={t("fields.removeAfterDays.hint")}
                  value={config.removeAfterDays}
                  min={0}
                  max={365}
                  onChange={(value) => update("removeAfterDays", value)}
                  error={errorText("removeAfterDays")}
                />
              )}
            </div>
          </SectionCard>

          <SectionCard
            title={t("sections.schedule")}
            icon={<ClockIcon className="size-4" />}
          >
            <div className="flex flex-col gap-3">
              <SwitchRow
                label={t("fields.autoSync.label")}
                description={t("fields.autoSync.description")}
                checked={config.autoSync}
                onChange={(value) => update("autoSync", value)}
              />
              {config.autoSync && (
                <NumberField
                  label={t("fields.intervalMinutes.label")}
                  value={config.intervalMinutes}
                  min={5}
                  max={10080}
                  onChange={(value) => update("intervalMinutes", value)}
                  error={errorText("intervalMinutes")}
                />
              )}
            </div>
          </SectionCard>

          <FormFooter
            onSave={() => void save()}
            saveLabel={t("actions.save")}
            saving={busy === "save"}
            dirty={dirty}
            disabled={working}
            onDelete={loaded.configured ? () => void forget() : undefined}
            deleteLabel={t("actions.forget")}
          />

          <SectionCard
            title={t("sections.result")}
            icon={<ListIcon className="size-4" />}
          >
            <ResultView result={result} at={resultAt} />
          </SectionCard>
        </div>
      </PanelShell>
    );
  };
}
