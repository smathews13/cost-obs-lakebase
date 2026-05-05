import { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";

interface SetupWizardProps {
  onComplete: () => void;
  onClose?: () => void;
}

interface ConfigData {
  warehouse: { id: string; name: string | null; size: string | null; state: string } | null;
  identity: { display_name: string; user_name: string } | null;
  storage_location: { catalog: string; schema: string } | null;
}

interface CloudData {
  provider: "aws" | "azure" | "gcp";
  host: string;
}

interface PermissionEntry {
  table: string;
  name: string;
  description: string;
  required: boolean;
  granted: boolean;
}

interface PermissionsData {
  permissions: PermissionEntry[];
  summary: {
    total: number;
    granted: number;
    required_count: number;
    required_granted: number;
    all_required_granted: boolean;
    ready_to_use: boolean;
  };
  user: { email: string; name: string };
  sp: { client_id: string; display_name: string };
  help_url: string;
}

interface SetupStatus {
  catalog: string;
  schema: string;
  tables: Record<string, boolean>;
  all_tables_exist: boolean;
  missing_tables: string[];
  status: "ready" | "setup_required";
  task?: { status: string; error: string | null };
}

type WizardStep = "welcome" | "permissions" | "create-tables" | "complete";

const STEPS: WizardStep[] = ["welcome", "permissions", "create-tables", "complete"];

const STEP_LABELS: Record<WizardStep, string> = {
  welcome: "Environment",
  permissions: "Permissions",
  "create-tables": "Create Tables",
  complete: "Complete",
};

const CLOUD_LABELS: Record<string, string> = {
  aws: "Amazon Web Services",
  azure: "Microsoft Azure",
  gcp: "Google Cloud Platform",
};

export function SetupWizard({ onComplete, onClose }: SetupWizardProps) {
  const [step, setStep] = useState<WizardStep>("welcome");
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [cloud, setCloud] = useState<CloudData | null>(null);
  const [permissions, setPermissions] = useState<PermissionsData | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load initial data
  useEffect(() => {
    async function loadData() {
      setLoading(true);
      setError(null);
      try {
        const [configRes, cloudRes] = await Promise.all([
          fetch("/api/settings/config"),
          fetch("/api/settings/cloud-provider"),
        ]);
        if (configRes.ok) setConfig(await configRes.json());
        if (cloudRes.ok) setCloud(await cloudRes.json());
      } catch (e) {
        setError(`Failed to load environment info: ${e}`);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  const loadPermissions = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = forceRefresh ? "/api/permissions/check?refresh=true" : "/api/permissions/check";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPermissions(await res.json());
    } catch (e) {
      setError(`Failed to check permissions: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const pollSetupStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/status");
      if (res.ok) {
        const data: SetupStatus = await res.json();
        setSetupStatus(data);
        return data;
      }
    } catch {
      // ignore polling errors
    }
    return null;
  }, []);

  const handleCreateTables = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/create-tables?run_in_background=true", { method: "POST", signal: AbortSignal.timeout(30000) });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      // Poll for completion
      const poll = setInterval(async () => {
        const status = await pollSetupStatus();
        if (status?.all_tables_exist) {
          clearInterval(poll);
          setCreating(false);
          setStep("complete");
        } else if (status?.task?.status === "error" && status.task.error) {
          clearInterval(poll);
          setCreating(false);
          setError(`Table creation failed: ${status.task.error}`);
        } else if (status?.task?.status === "error" || (status?.task?.status === "done" && !status.all_tables_exist)) {
          clearInterval(poll);
          setCreating(false);
          const detail = status?.task?.error || "unknown error";
          setError(`Table creation failed: ${detail}`);
        }
      }, 2000);

      // Safety timeout after 10 minutes
      setTimeout(() => {
        clearInterval(poll);
        setCreating(false);
        setError("Table creation is taking longer than expected. Check /api/setup/status for progress.");
      }, 600000);
    } catch (e) {
      setCreating(false);
      setError(`Failed to create tables: ${e}`);
    }
  };

  const goNext = () => {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) {
      const next = STEPS[idx + 1];
      setStep(next);
      if (next === "permissions") loadPermissions();
      if (next === "create-tables") pollSetupStatus();
    }
  };

  const goBack = () => {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  };

  const currentIdx = STEPS.indexOf(step);

  return createPortal(
    <div className="animate-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/50">
      <div className="flex min-h-full items-center justify-center p-4">
      <div className="animate-dialog mx-4 w-full max-w-2xl rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div className="relative rounded-t-xl px-8 py-6" style={{ backgroundColor: '#1B3139' }}>
          {onClose && (
            <button
              onClick={onClose}
              className="absolute right-4 top-4 rounded-full p-1 text-white/60 hover:bg-white/10 hover:text-white transition-colors"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          <h2 className="text-xl font-bold text-white">Cost Observability & Control Setup</h2>
          <p className="mt-1 text-sm text-white/70">Configure your environment to get started</p>
        </div>

        {/* Step indicator */}
        <div className="flex border-b px-8 py-3" style={{ borderColor: '#E5E5E5' }}>
          {STEPS.map((s, i) => (
            <div key={s} className="flex flex-1 items-center">
              <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                i < currentIdx ? "bg-green-500 text-white" :
                i === currentIdx ? "text-white" : "bg-gray-200 text-gray-500"
              }`} style={i === currentIdx ? { backgroundColor: '#FF3621' } : undefined}>
                {i < currentIdx ? (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                ) : i + 1}
              </div>
              <span className={`ml-2 text-xs font-medium ${i === currentIdx ? "text-gray-900" : "text-gray-500"}`}>
                {STEP_LABELS[s]}
              </span>
              {i < STEPS.length - 1 && <div className="mx-3 h-px flex-1 bg-gray-200" />}
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="min-h-[320px] px-8 py-6">
          {error && (() => {
            // If the error contains GRANT SQL, split it out into a code block
            const grantMatch = error.match(/^(.*?)(GRANT [^.]+(?:;\s*GRANT [^.]+)*)$/s);
            if (grantMatch) {
              const [, msg, grants] = grantMatch;
              return (
                <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 space-y-2">
                  <p>{msg.trim()}</p>
                  <pre className="rounded bg-gray-800 px-3 py-2 font-mono text-xs text-green-400 whitespace-pre-wrap overflow-x-auto">
                    {grants.trim().replace(/;\s*/g, ';\n')}
                  </pre>
                  <p className="text-xs">Run these in your workspace SQL editor as a catalog owner or metastore admin, then click <strong>Create Tables</strong> again.</p>
                </div>
              );
            }
            return (
              <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                {error}
              </div>
            );
          })()}

          {step === "welcome" && (
            <WelcomeStep config={config} cloud={cloud} loading={loading} onWarehouseSelected={() => {
              setConfig(null);
              setLoading(true);
              fetch("/api/settings/config").then(r => r.json()).then(d => { setConfig(d); setLoading(false); }).catch(() => setLoading(false));
            }} />
          )}

          {step === "permissions" && (
            <PermissionsStep permissions={permissions} loading={loading} onRetry={() => loadPermissions(true)} />
          )}

          {step === "create-tables" && (
            <CreateTablesStep
              setupStatus={setupStatus}
              creating={creating}
            />
          )}

          {step === "complete" && <CompleteStep />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between rounded-b-xl border-t px-8 py-4" style={{ borderColor: '#E5E5E5' }}>
          <div>
            {currentIdx > 0 && step !== "complete" && (
              <button
                onClick={goBack}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
              >
                Back
              </button>
            )}
          </div>
          <div>
            {step === "complete" ? (
              <button
                onClick={onComplete}
                className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors"
              >
                Go to Dashboard
              </button>
            ) : step === "create-tables" ? (
              creating ? null
              : setupStatus?.all_tables_exist ? (
                <button
                  onClick={goNext}
                  className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors"
                >
                  Next
                </button>
              ) : (
                <button
                  onClick={handleCreateTables}
                  className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors"
                >
                  Create Tables
                </button>
              )
            ) : step === "permissions" ? (
              <button
                onClick={goNext}
                disabled={loading || (permissions != null && !permissions.summary.all_required_granted)}
                className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next
              </button>
            ) : (
              <button
                onClick={goNext}
                disabled={loading || (config !== null && !config.warehouse)}
                className="btn-brand rounded-lg px-6 py-2 text-sm font-bold text-white transition-colors disabled:opacity-50"
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>,
    document.body
  );
}

function WelcomeStep({ config, cloud, loading, onWarehouseSelected }: { config: ConfigData | null; cloud: CloudData | null; loading: boolean; onWarehouseSelected: () => void }) {
  const [devOpen, setDevOpen] = useState(false);
  const [warehouses, setWarehouses] = useState<{id: string; name: string; size: string | null; state: string}[]>([]);
  const [warehousesLoading, setWarehousesLoading] = useState(false);
  const [selectingWarehouse, setSelectingWarehouse] = useState(false);
  const [creatingWarehouse, setCreatingWarehouse] = useState(false);
  const [warehouseError, setWarehouseError] = useState<string | null>(null);
  const [newWarehouseName, setNewWarehouseName] = useState("Cost Observability App");
  const [warehouseSearch, setWarehouseSearch] = useState("");

  useEffect(() => {
    if (!config || config.warehouse) return;
    setWarehousesLoading(true);
    fetch("/api/settings/warehouses")
      .then(r => r.json())
      .then(data => { setWarehouses(data); setWarehousesLoading(false); })
      .catch(() => setWarehousesLoading(false));
  }, [config]);

  const handleSelectWarehouse = async (warehouseId: string) => {
    setSelectingWarehouse(true);
    setWarehouseError(null);
    try {
      const res = await fetch(`/api/setup/select-warehouse?warehouse_id=${warehouseId}`, { method: "POST" });
      const data = await res.json();
      if (data.status === "ok") onWarehouseSelected();
      else setWarehouseError(data.message || "Failed to select warehouse");
    } finally {
      setSelectingWarehouse(false);
    }
  };

  const handleCreateWarehouse = async () => {
    setCreatingWarehouse(true);
    setWarehouseError(null);
    try {
      const name = newWarehouseName.trim() || "Cost Observability App";
      const res = await fetch(`/api/setup/create-warehouse?name=${encodeURIComponent(name)}`, { method: "POST", signal: AbortSignal.timeout(120000) });
      const data = await res.json();
      if (data.status === "ok") onWarehouseSelected();
      else {
        const msg = data.message || "";
        if (msg.includes("not authorized") || msg.includes("create SQL Endpoint")) {
          setWarehouseError("The app's service principal doesn't have permission to create warehouses. Select an existing warehouse above, or ask an admin to grant warehouse creation rights to the service principal.");
        } else {
          setWarehouseError(msg || "Failed to create warehouse");
        }
      }
    } catch (e) {
      setWarehouseError(`Request failed: ${e}`);
    } finally {
      setCreatingWarehouse(false);
    }
  };

  const [generating, setGenerating] = useState(false);
  const [generatedToken, setGeneratedToken] = useState<{ token: string; host: string } | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "host" | "env" | null>(null);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = (text: string, key: "token" | "host" | "env") => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      if (copyTimeout.current) clearTimeout(copyTimeout.current);
      copyTimeout.current = setTimeout(() => setCopied(null), 2000);
    });
  };

  const handleGenerateToken = async () => {
    setGenerating(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/setup/generate-token", { method: "POST" });
      const data = await res.json();
      if (data.status === "created") {
        setGeneratedToken({ token: data.token, host: data.host });
      } else {
        setTokenError(data.message || "Failed to generate token");
      }
    } catch (e) {
      setTokenError(`Request failed: ${e}`);
    } finally {
      setGenerating(false);
    }
  };

  if (loading) return <LoadingSpinner text="Detecting environment..." />;

  const envFileContent = generatedToken
    ? `DATABRICKS_HOST=${generatedToken.host}\nDATABRICKS_TOKEN=${generatedToken.token}\nDATABRICKS_HTTP_PATH=auto`
    : "";

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        We detected the following environment. Verify this looks correct before proceeding.
      </p>

      <div className="space-y-3">
        <InfoRow
          label="Cloud Provider"
          value={cloud ? CLOUD_LABELS[cloud.provider] || cloud.provider : "Unknown"}
        />
        <InfoRow
          label="Workspace"
          value={cloud?.host || "Unknown"}
        />
        {config?.warehouse ? (
          <InfoRow
            label="SQL Warehouse"
            value={`${config.warehouse.name || config.warehouse.id} (${config.warehouse.state})`}
            status={config.warehouse.state === "RUNNING" ? "ok" : "warn"}
          />
        ) : (
          <div className="rounded-lg bg-amber-50 px-4 py-3">
            <p className="text-sm font-medium text-amber-800 mb-2">No SQL warehouse configured</p>
            <p className="text-xs text-amber-700 mb-3">Select an existing warehouse or create a new one to continue.</p>
            {warehouseError && (
              <p className="text-xs text-red-600 mb-2">{warehouseError}</p>
            )}
            {warehousesLoading ? (
              <p className="text-xs text-amber-600">Loading warehouses...</p>
            ) : warehouses.length === 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-red-700 font-medium">No warehouses visible to this app.</p>
                <p className="text-xs text-amber-700">A workspace admin needs to grant the app's service principal <span className="font-mono font-semibold">CAN USE</span> on at least one SQL warehouse.</p>
                <p className="text-xs text-amber-600">Grant <strong>CAN USE</strong> to the service principal via the Databricks UI: SQL Warehouses → [warehouse name] → Permissions tab. Warehouse access cannot be granted via SQL.</p>
                <p className="text-xs text-amber-600">After granting access, restart the app and try again. Alternatively, set <span className="font-mono">DATABRICKS_HTTP_PATH</span> directly in app.yaml.</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <input
                  type="text"
                  value={warehouseSearch}
                  onChange={e => setWarehouseSearch(e.target.value)}
                  placeholder="Search warehouses..."
                  className="w-full rounded border border-amber-200 bg-white px-2 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                />
                <div className="max-h-[180px] overflow-y-auto space-y-1">
                  {warehouses
                    .filter(wh => wh.name.toLowerCase().includes(warehouseSearch.toLowerCase()))
                    .map(wh => (
                    <button
                      key={wh.id}
                      onClick={() => handleSelectWarehouse(wh.id)}
                      disabled={selectingWarehouse || creatingWarehouse}
                      className="flex w-full items-center justify-between rounded-lg border border-amber-200 bg-white px-3 py-2 text-left text-sm hover:bg-amber-50 disabled:opacity-50 transition-colors"
                    >
                      <span className="font-medium text-gray-800">{wh.name}</span>
                      <span className="text-xs text-gray-500">{wh.size} · {wh.state}</span>
                    </button>
                  ))}
                  {warehouses.filter(wh => wh.name.toLowerCase().includes(warehouseSearch.toLowerCase())).length === 0 && (
                    <p className="text-xs text-gray-500 px-2 py-1">No warehouses match "{warehouseSearch}"</p>
                  )}
                </div>
                <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 space-y-2">
                  <p className="text-xs text-amber-700 font-medium">Create a new serverless Pro warehouse</p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newWarehouseName}
                      onChange={e => setNewWarehouseName(e.target.value)}
                      placeholder="Warehouse name"
                      disabled={creatingWarehouse}
                      className="flex-1 rounded border border-amber-200 bg-white px-2 py-1 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:opacity-50"
                    />
                    <button
                      onClick={handleCreateWarehouse}
                      disabled={selectingWarehouse || creatingWarehouse || !newWarehouseName.trim()}
                      className="inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm font-medium text-amber-900 bg-amber-200 hover:bg-amber-300 disabled:opacity-50 transition-colors"
                    >
                      {creatingWarehouse ? (
                        <><div className="h-3.5 w-3.5 animate-spin rounded-full border border-amber-700 border-t-transparent" /> Creating...</>
                      ) : "Create"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        <InfoRow
          label="Identity"
          value={config?.identity ? `${config.identity.display_name} (${config.identity.user_name})` : "Unknown"}
        />
        <InfoRow
          label="Catalog"
          value={config?.storage_location?.catalog || "Not configured"}
        />
        <InfoRow
          label="Schema"
          value={config?.storage_location?.schema || "Not configured"}
        />
      </div>

      {/* Local development token section */}
      <div className="rounded-lg border border-gray-200">
        <button
          onClick={() => setDevOpen(!devOpen)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <span className="text-sm font-medium text-gray-700">Local development setup</span>
          <svg className={`h-4 w-4 text-gray-500 transition-transform ${devOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {devOpen && (
          <div className="border-t border-gray-200 px-4 pb-4 pt-3 space-y-3">
            <p className="text-xs text-gray-500">
              The deployed app uses OAuth automatically — no token needed here. If you want to run this app locally, generate a token to use in your <span className="font-mono">.env.local</span> file.
            </p>
            {!generatedToken ? (
              <button
                onClick={handleGenerateToken}
                disabled={generating}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {generating ? (
                  <><div className="h-3 w-3 animate-spin rounded-full border border-gray-400 border-t-transparent" /> Generating...</>
                ) : (
                  <><svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>Generate Token</>
                )}
              </button>
            ) : (
              <div className="space-y-2">
                <div className="rounded-lg bg-green-50 px-3 py-2 text-xs text-green-700">
                  Token generated — valid for 90 days. Copy the env block below into your <span className="font-mono">.env.local</span>.
                </div>
                <div className="relative rounded-lg bg-gray-900 px-4 py-3">
                  <pre className="text-xs text-green-400 overflow-x-auto whitespace-pre">{envFileContent}</pre>
                  <button
                    onClick={() => handleCopy(envFileContent, "env")}
                    className="absolute right-2 top-2 rounded px-2 py-1 text-xs text-gray-500 hover:bg-white/10 hover:text-white transition-colors"
                  >
                    {copied === "env" ? "Copied!" : "Copy"}
                  </button>
                </div>
                <p className="text-xs text-gray-500">Keep this token secure — treat it like a password.</p>
              </div>
            )}
            {tokenError && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{tokenError}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PermissionsStep({ permissions, loading, onRetry }: { permissions: PermissionsData | null; loading: boolean; onRetry: () => void }) {
  const [grantRunning, setGrantRunning] = useState(false);
  const [grantResult, setGrantResult] = useState<{ ok: boolean; applied: number; failed: number; errors: string[] } | null>(null);

  const applyGrants = async () => {
    setGrantRunning(true);
    setGrantResult(null);
    try {
      const res = await fetch("/api/setup/grant-sp-system-access", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      setGrantResult({
        ok: body.ok ?? res.ok,
        applied: body.applied ?? 0,
        failed: body.failed ?? 0,
        errors: body.errors ?? [],
      });
      if (body.ok || res.ok) {
        setTimeout(() => onRetry(), 800);
      }
    } catch {
      setGrantResult({ ok: false, applied: 0, failed: 1, errors: ["Network error — check server logs"] });
    } finally {
      setGrantRunning(false);
    }
  };

  if (loading) return <LoadingSpinner text="Checking permissions and setting up — this could take a minute" />;

  if (!permissions) return <div className="text-sm text-gray-500">Failed to load permissions.</div>;

  const { summary } = permissions;
  const missingRequired = permissions.permissions.filter((p) => !p.granted && p.required);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          System table access required for cost analytics. Results shown as your current user identity.
        </p>
        <button onClick={onRetry} className="text-xs text-blue-600 hover:underline">Recheck</button>
      </div>

      {summary.all_required_granted ? (
        <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
          All required permissions granted ({summary.granted}/{summary.total} total).
        </div>
      ) : (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
          Missing {summary.required_count - summary.required_granted} required permission(s) for the app's service principal.
          {missingRequired.some(p => p.table.startsWith("system.billing")) && (
            <span className="block mt-1 text-xs">Billing tables require metastore admin access to grant — your own account may already have access, but the SP needs explicit grants for nightly data refresh.</span>
          )}
        </div>
      )}

      <div className="max-h-48 space-y-1 overflow-y-auto">
        {permissions.permissions.map((p) => (
          <div key={p.table} className="flex items-center justify-between rounded px-3 py-1.5 text-sm">
            <div className="flex items-center gap-2">
              {p.granted ? (
                <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              ) : (
                <svg className="h-4 w-4 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              )}
              <span className="font-mono text-xs">{p.table}</span>
              {p.required && <span className="text-xs text-red-500">*</span>}
            </div>
            <span className={`text-xs ${p.granted ? "text-green-600" : "text-red-500"}`}>
              {p.granted ? "Granted" : "Missing"}
            </span>
          </div>
        ))}
      </div>

      {!summary.all_required_granted && (
        <div className="space-y-3">
          {/* Auto-apply */}
          <div className="rounded-lg border border-[#FF3621]/20 bg-orange-50 p-3 space-y-2">
            <p className="text-xs font-medium text-gray-800">Apply SP grants automatically</p>
            <p className="text-[11px] text-gray-600">
              Grants the app's service principal access to all required system tables using your current identity.
              You must be a <strong>metastore admin</strong> for this to succeed.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={applyGrants}
                disabled={grantRunning}
                className="rounded-md bg-[#FF3621] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#e02e1a] disabled:opacity-50 transition-colors"
              >
                {grantRunning ? "Applying grants…" : "Apply SP Grants"}
              </button>
              {grantResult && (
                <span className={`text-[11px] font-medium ${grantResult.ok ? "text-green-700" : "text-red-600"}`}>
                  {grantResult.ok
                    ? `✓ ${grantResult.applied} grant(s) applied — rechecking…`
                    : `${grantResult.failed} failed. ${grantResult.errors[0] ?? "Check server logs."}`}
                </span>
              )}
            </div>
          </div>

          {/* SQL fallback */}
          <details className="rounded-lg border border-gray-200 bg-gray-50 text-xs">
            <summary className="cursor-pointer px-3 py-2 font-medium text-gray-600 hover:text-gray-800">
              Manual SQL (if you prefer to run grants yourself)
            </summary>
            <div className="border-t border-gray-200 px-3 py-2">
              <pre className="overflow-x-auto text-xs text-gray-800">
                {(() => {
                  const userEmail = permissions.user.email;
                  const spName = permissions.sp?.display_name || permissions.sp?.client_id || "app-service-principal";
                  const principals = userEmail && spName && userEmail !== spName
                    ? `\`${userEmail}\`, \`${spName}\``
                    : `\`${spName || userEmail}\``;
                  const lines: string[] = [];
                  const seenCatalogs = new Set<string>();
                  const seenSchemas = new Set<string>();
                  for (const p of missingRequired) {
                    const parts = p.table.split(".");
                    const catalog = parts[0];
                    const schema = parts.slice(0, 2).join(".");
                    if (!seenCatalogs.has(catalog)) {
                      lines.push(`GRANT USE CATALOG ON CATALOG ${catalog} TO ${principals};`);
                      seenCatalogs.add(catalog);
                    }
                    if (!seenSchemas.has(schema)) {
                      lines.push(`GRANT USE SCHEMA ON SCHEMA ${schema} TO ${principals};`);
                      seenSchemas.add(schema);
                    }
                    lines.push(`GRANT SELECT ON TABLE ${p.table} TO ${principals};`);
                  }
                  return lines.join("\n");
                })()}
              </pre>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function CreateTablesStep({ setupStatus, creating }: {
  setupStatus: SetupStatus | null;
  creating: boolean;
}) {
  if (creating) {
    return (
      <div className="space-y-4">
        <LoadingSpinner text="Creating materialized views... This may take a few minutes." />
        {setupStatus && (
          <div className="space-y-1">
            {Object.entries(setupStatus.tables).map(([table, exists]) => (
              <div key={table} className="flex items-center gap-2 px-3 py-1 text-sm">
                {exists ? (
                  <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                ) : (
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-blue-500" />
                )}
                <span className="font-mono text-xs">{table}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (setupStatus?.all_tables_exist) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-green-50 p-3 text-sm text-green-700">
          All materialized views are ready.
        </div>
        <div className="space-y-1">
          {Object.entries(setupStatus.tables).map(([table, exists]) => (
            <div key={table} className="flex items-center gap-2 px-3 py-1 text-sm">
              <svg className={`h-4 w-4 ${exists ? "text-green-500" : "text-red-400"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={exists ? "M5 13l4 4L19 7" : "M6 18L18 6M6 6l12 12"} />
              </svg>
              <span className="font-mono text-xs">{table}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        The app uses pre-aggregated materialized views for fast dashboard loading.
        This step creates them with 365 days of historical data.
      </p>

      {setupStatus && setupStatus.missing_tables.length > 0 && (
        <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
          {setupStatus.missing_tables.length} table(s) need to be created in{" "}
          <span className="font-mono">{setupStatus.catalog}.{setupStatus.schema}</span>.
        </div>
      )}

      <p className="text-xs text-gray-500">
        This typically takes 2-5 minutes depending on data volume.
        Click "Create Tables" to begin.
      </p>
    </div>
  );
}

function CompleteStep() {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
        <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h3 className="text-lg font-bold text-gray-900">Setup Complete</h3>
      <p className="mt-2 max-w-sm text-sm text-gray-600">
        Your environment is configured and materialized views are ready.
        Click below to start exploring your cost data.
      </p>
    </div>
  );
}

function LoadingSpinner({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <div className="h-8 w-8 animate-spin rounded-full" style={{ border: '3px solid #e5e7eb', borderTopColor: '#FF3621' }} />
      <p className="mt-3 text-sm text-gray-500">{text}</p>
    </div>
  );
}

function InfoRow({ label, value, status }: { label: string; value: string; status?: "ok" | "warn" | "error" }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-gray-50 px-4 py-2.5">
      <span className="text-sm font-medium text-gray-500">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{value}</span>
        {status === "ok" && <span className="h-2 w-2 rounded-full bg-green-500" />}
        {status === "warn" && <span className="h-2 w-2 rounded-full bg-amber-500" />}
        {status === "error" && <span className="h-2 w-2 rounded-full bg-red-500" />}
      </div>
    </div>
  );
}
