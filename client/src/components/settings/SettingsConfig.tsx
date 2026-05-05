import { useState, useRef } from "react";
import { useQuery, type UseMutationResult } from "@tanstack/react-query";
import type { AppSettings } from "../SettingsDialog";

interface WarehouseInfo {
  id: string;
  name: string;
  size: string | null;
  state: string;
  is_current: boolean;
}

interface AppConfigInfo {
  warehouse: { id: string; name: string | null; size: string | null; state: string } | null;
  identity: { display_name: string | null; user_name: string | null } | null;
  storage_location: { catalog: string; schema: string } | null;
}

interface TelemetryConfig {
  catalog: string;
  schema_name: string;
  table_prefix: string;
  is_default?: boolean;
}

interface SettingsConfigProps {
  configLoading: boolean;
  appConfig: AppConfigInfo | undefined;
  warehouses: WarehouseInfo[];
  warehousesLoading: boolean;
  pendingWarehouseSwitch: { id: string; name: string; state: string } | null;
  setPendingWarehouseSwitch: (v: { id: string; name: string; state: string } | null) => void;
  switchWarehouseMutation: UseMutationResult<any, Error, string, unknown>;
  saveStatus: string | null;
  localSettings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function SettingsConfig({
  configLoading,
  appConfig,
  warehouses,
  warehousesLoading,
  pendingWarehouseSwitch,
  setPendingWarehouseSwitch,
  switchWarehouseMutation,
  saveStatus,
  localSettings,
  updateSetting,
}: SettingsConfigProps) {
  const [mvRefreshing, setMvRefreshing] = useState(false);
  const [lookbackDays, setLookbackDays] = useState(730);

  // Catalog/schema location override
  const { data: catalogInfo = null, isLoading: catalogLoading, refetch: refetchCatalog } = useQuery<{
    catalog: string;
    schema: string;
    source: "env" | "override";
    env_catalog: string;
    env_schema: string;
  } | null>({
    queryKey: ["settings-catalog"],
    queryFn: () => fetch("/api/settings/catalog").then(r => r.json()).catch(() => null),
    staleTime: 30 * 1000,
  });
  const { data: authStatus = null } = useQuery<{
    user_token_active: boolean;
    identity: "user_oauth" | "service_principal";
    locked_to_sp: boolean;
    has_sql_scope: boolean | null;
  } | null>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });

  const [catalogEditing, setCatalogEditing] = useState(false);
  const [catalogDraft, setCatalogDraft] = useState({ catalog: "", schema: "" });
  const [catalogSaving, setCatalogSaving] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const { data: telemetry = null, isLoading: telemetryLoading, refetch: refetchTelemetry } = useQuery<TelemetryConfig | null>({
    queryKey: ["settings-telemetry"],
    queryFn: () => fetch("/api/settings/telemetry").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });
  const [telemetryEditing, setTelemetryEditing] = useState(false);
  const [telemetryDraft, setTelemetryDraft] = useState<TelemetryConfig>({ catalog: "", schema_name: "", table_prefix: "" });
  const [telemetrySaving, setTelemetrySaving] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const { data: tablesStatus = null, isLoading: tablesLoading, refetch: refetchTables } = useQuery<{
    catalog: string | null;
    schema: string | null;
    auth_error?: string | null;
    refresh_status?: {
      last_refresh_utc: string;
      duration_seconds: number | null;
      hours_since_refresh: number;
      stale: boolean;
      status: string;
      error?: string;
    } | null;
    tables: Array<{
      name: string;
      table_type: string | null;
      exists: boolean | null;
      optional?: boolean;
      row_count: number | null;
      min_date: string | null;
      max_date: string | null;
      days_behind: number | null;
      error?: string;
    }>;
  } | null>({
    queryKey: ["settings-tables-status"],
    queryFn: () => fetch("/api/settings/tables").then(r => r.json()).catch(() => null),
    staleTime: 2 * 60 * 1000,
  });

  async function handleMvRefresh() {
    setMvRefreshing(true);
    try {
      await fetch(`/api/settings/refresh-mvs?lookback_days=${lookbackDays}`, { method: "POST" });
      await refetchTables();
    } finally {
      setMvRefreshing(false);
    }
  }
  const [genieCreating, setGenieCreating] = useState(false);
  const [genieCreateStatus, setGenieCreateStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const genieCreateStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  const createGenieSpace = async () => {
    setGenieCreating(true);
    setGenieCreateStatus(null);
    try {
      const res = await fetch("/api/setup/create-genie-space", { method: "POST" });
      const data = await res.json();
      if (data.space_id) {
        updateSetting("genieSpaceId", data.space_id);
        updateSetting("enableGenie", true);
        setGenieCreateStatus({ type: "success", message: `Genie Space created (${data.space_id})` });
      } else if (data.status === "already_exists") {
        updateSetting("genieSpaceId", data.space_id || "");
        updateSetting("enableGenie", true);
        setGenieCreateStatus({ type: "success", message: "Using existing Genie Space" });
      } else {
        setGenieCreateStatus({ type: "error", message: data.message || "Failed to create Genie Space" });
      }
    } catch {
      setGenieCreateStatus({ type: "error", message: "Request failed — check server logs" });
    } finally {
      setGenieCreating(false);
      if (genieCreateStatusTimer.current) clearTimeout(genieCreateStatusTimer.current);
      genieCreateStatusTimer.current = setTimeout(() => setGenieCreateStatus(null), 6000);
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-500">
        Runtime configuration for this app instance. Change the SQL warehouse to switch compute resources.
      </p>

      {saveStatus && (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2 text-sm text-green-700">
          {saveStatus}
        </div>
      )}

      {configLoading ? (
        <div className="py-8 text-center text-sm text-gray-500">Loading configuration...</div>
      ) : (
        <>
          {/* SQL Warehouse */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">SQL Warehouse</h4>
            </div>
            {appConfig?.warehouse && (
              <div className="mb-3 space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3">
                  <div className="text-sm text-gray-500">Current Warehouse</div>
                  <div className="flex items-center gap-2">
                    <span className={`inline-block h-2 w-2 rounded-full ${appConfig.warehouse.state === "RUNNING" ? "bg-green-500" : appConfig.warehouse.state === "STOPPED" ? "bg-gray-400" : "bg-yellow-500"}`} />
                    <span className="text-sm font-medium text-gray-900">{appConfig.warehouse.name || appConfig.warehouse.id}</span>
                    <span className="text-xs text-gray-500">({appConfig.warehouse.size || "—"}) · {appConfig.warehouse.state}</span>
                  </div>
                </div>
              </div>
            )}
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              <div className="mb-2">
                <div className="text-sm font-medium text-gray-900">Switch Warehouse</div>
                <div className="text-xs text-gray-500">Select a different SQL warehouse to power the app</div>
              </div>
              {warehousesLoading ? (
                <div className="py-3 text-center text-sm text-gray-500">Loading warehouses...</div>
              ) : warehouses.length === 0 ? (
                <div className="py-3 text-center text-sm text-gray-500">No warehouses found</div>
              ) : (
                <>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {warehouses.map((wh) => (
                    <button
                      key={wh.id}
                      onClick={() => {
                        if (!wh.is_current) setPendingWarehouseSwitch({ id: wh.id, name: wh.name, state: wh.state });
                      }}
                      disabled={wh.is_current || switchWarehouseMutation.isPending}
                      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                        wh.is_current
                          ? "border-orange-200 bg-orange-50"
                          : pendingWarehouseSwitch?.id === wh.id
                            ? "border-orange-300 bg-orange-50"
                            : "border-gray-200 bg-white hover:border-orange-200 hover:bg-orange-50/50"
                      } ${switchWarehouseMutation.isPending ? "opacity-50 cursor-wait" : ""}`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${wh.state === "RUNNING" ? "bg-green-500" : wh.state === "STOPPED" ? "bg-gray-400" : "bg-yellow-500"}`} />
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 truncate">{wh.name}</div>
                          <div className="text-xs text-gray-500">{wh.size || "—"} · {wh.state}</div>
                        </div>
                      </div>
                      {wh.is_current ? (
                        <span className="shrink-0 rounded px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: '#FF362120', color: '#FF3621' }}>
                          Active
                        </span>
                      ) : (
                        <span className="shrink-0 text-xs text-gray-500">
                          {wh.state === "STOPPED" ? "Will start" : "Select"}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {pendingWarehouseSwitch && (
                  <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50 p-3">
                    <div className="flex items-start gap-2">
                      <svg className="h-5 w-5 shrink-0 text-orange-500 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                      <div className="flex-1">
                        <div className="text-sm font-medium text-gray-900">
                          Switch to {pendingWarehouseSwitch.name}?
                        </div>
                        <div className="text-xs text-gray-600 mt-0.5">
                          {pendingWarehouseSwitch.state === "STOPPED"
                            ? "This warehouse is stopped and will be started automatically. It may take a few minutes to become available."
                            : "All queries will be routed to this warehouse immediately."}
                        </div>
                        <div className="flex gap-2 mt-2">
                          <button
                            onClick={() => setPendingWarehouseSwitch(null)}
                            className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={() => switchWarehouseMutation.mutate(pendingWarehouseSwitch.id)}
                            disabled={switchWarehouseMutation.isPending}
                            className="rounded-md px-3 py-1 text-xs font-medium text-white transition-colors disabled:opacity-50"
                            style={{ backgroundColor: '#FF3621' }}
                          >
                            {switchWarehouseMutation.isPending ? "Switching..." : "Confirm Switch"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                </>
              )}
            </div>
          </div>

          {/* App Identity */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">App Identity</h4>
            </div>
            <div className="space-y-2">
              <div className="rounded-lg border border-gray-200 bg-white p-3">
                <div className="text-sm font-medium text-gray-900 mb-1">Display Name</div>
                <input
                  type="text"
                  value={localSettings.appDisplayName}
                  onChange={(e) => updateSetting("appDisplayName", e.target.value)}
                  placeholder={appConfig?.identity?.display_name || "e.g., Cost Observability"}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  Overrides the app name shown in the header. Leave blank to use the default ({appConfig?.identity?.display_name || "service principal name"}).
                </p>
              </div>
              {appConfig?.identity && (
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3">
                  <div className="text-sm text-gray-500">Service Principal</div>
                  <div className="text-sm font-medium text-gray-900">{appConfig.identity.user_name || "—"}</div>
                </div>
              )}
              {authStatus && (
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white p-3">
                  <div className="text-sm text-gray-500">Auth Mode</div>
                  <div className="flex items-center gap-1.5">
                    {authStatus.identity === "user_oauth" ? (
                      <>
                        <span className="inline-block h-2 w-2 rounded-full bg-green-500" />
                        <span className="text-sm font-medium text-green-700">User OAuth</span>
                      </>
                    ) : authStatus.locked_to_sp ? (
                      <>
                        <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                        <span className="text-sm font-medium text-amber-700">Service principal (token failed scope check)</span>
                      </>
                    ) : (
                      <>
                        <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                        <span className="text-sm font-medium text-amber-700">Service principal</span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Enable AI Features */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">AI Features</h4>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localSettings.enableAIFeatures}
                  onChange={(e) => {
                    updateSetting("enableAIFeatures", e.target.checked);
                    if (!e.target.checked) updateSetting("enableGenie", false);
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                />
                <div>
                  <div className="text-sm font-medium text-gray-900">Enable AI Features</div>
                  <div className="mt-0.5 text-xs text-gray-500">
                    Enables AI-powered features across the app, including the Genie Assistant and AI-assisted analysis of cost spikes on the KPIs tab. Disable to turn off all AI capabilities for this deployment.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Genie Assistant */}
          <div className={localSettings.enableAIFeatures ? "" : "opacity-50 pointer-events-none"}>
            <div className="flex items-center gap-2 mb-3">
              <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
              <h4 className="text-sm font-semibold text-gray-900">Genie Assistant</h4>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={localSettings.enableGenie}
                  onChange={(e) => updateSetting("enableGenie", e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                />
                <div className="flex-1">
                  <div className="text-sm font-medium text-gray-900">Enable Genie Assistant</div>
                  <div className="mt-0.5 text-xs text-gray-500">
                    Show the Genie AI assistant on the DBU Overview tab for natural language questions about your cost data.
                  </div>
                </div>
              </label>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Genie Space ID</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={localSettings.genieSpaceId}
                    onChange={(e) => updateSetting("genieSpaceId", e.target.value)}
                    placeholder="e.g. 01f0abcd1234..."
                    className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500"
                  />
                  {!localSettings.genieSpaceId && (
                    <button
                      onClick={createGenieSpace}
                      disabled={genieCreating}
                      className="rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-wait whitespace-nowrap transition-colors"
                    >
                      {genieCreating ? "Creating…" : "Auto-Create"}
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-gray-500">
                  Enter an existing Genie Space ID, or click Auto-Create to deploy one automatically using your workspace's billing tables.
                </p>
                {genieCreateStatus && (
                  <div className={`mt-2 rounded-md px-3 py-2 text-xs ${genieCreateStatus.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
                    {genieCreateStatus.message}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Storage Location & Tables */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
                </svg>
                <h4 className="text-sm font-semibold text-gray-900">Storage Location & Tables</h4>
              </div>
              <div className="flex items-center gap-2">
                {/* Last refresh indicator */}
                {tablesStatus?.refresh_status === null || tablesStatus?.refresh_status === undefined ? (
                  <span className="text-xs text-gray-500">Last refresh: unknown</span>
                ) : tablesStatus.refresh_status.status === "error" ? (
                  <span className="text-xs text-red-500">Last refresh failed</span>
                ) : tablesStatus.refresh_status.stale ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                    Stale (&gt;26h)
                  </span>
                ) : (
                  <span className="text-xs text-gray-500">
                    {tablesStatus.refresh_status.hours_since_refresh < 1
                      ? "Refreshed &lt;1h ago"
                      : `Refreshed ${tablesStatus.refresh_status.hours_since_refresh}h ago`}
                  </span>
                )}
                <select
                  value={lookbackDays}
                  onChange={e => setLookbackDays(Number(e.target.value))}
                  disabled={mvRefreshing}
                  className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 bg-white focus:outline-none focus:ring-1 focus:ring-[#FF3621] disabled:opacity-50"
                  title="Lookback period for rebuild (default 2 years)"
                >
                  <option value={180}>6 months</option>
                  <option value={365}>1 year</option>
                  <option value={730}>2 years (default)</option>
                  <option value={1095}>3 years</option>
                  <option value={1825}>5 years</option>
                </select>
                <button
                  onClick={handleMvRefresh}
                  disabled={mvRefreshing}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Rebuild materialized views with selected lookback period"
                >
                  <svg className={`h-3.5 w-3.5 ${mvRefreshing ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {mvRefreshing ? "Rebuilding…" : "Rebuild"}
                </button>
              </div>
            </div>

            {/* Lookback period note */}
            <p className="mb-3 text-xs text-gray-500">
              Tables are built from <strong className="text-gray-500">2 years</strong> of history by default.
              Use the period selector above to rebuild with a different window — shorter periods rebuild faster, longer periods capture more historical trend data.
            </p>

            {/* Catalog / Schema location */}
            <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3 space-y-2">
              {catalogLoading ? (
                <div className="text-xs text-gray-500">Loading...</div>
              ) : catalogEditing ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="w-14 text-xs text-gray-500 shrink-0">Catalog</label>
                    <input
                      type="text"
                      value={catalogDraft.catalog}
                      onChange={e => setCatalogDraft(d => ({ ...d, catalog: e.target.value }))}
                      className="flex-1 rounded border border-gray-200 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                      placeholder="e.g. main"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="w-14 text-xs text-gray-500 shrink-0">Schema</label>
                    <input
                      type="text"
                      value={catalogDraft.schema}
                      onChange={e => setCatalogDraft(d => ({ ...d, schema: e.target.value }))}
                      className="flex-1 rounded border border-gray-200 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                      placeholder="e.g. cost_obs"
                    />
                  </div>
                  {catalogError && <p className="text-xs text-red-500">{catalogError}</p>}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      disabled={catalogSaving}
                      onClick={async () => {
                        setCatalogError(null);
                        setCatalogSaving(true);
                        try {
                          const res = await fetch("/api/settings/catalog", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(catalogDraft),
                          });
                          if (!res.ok) {
                            const d = await res.json();
                            setCatalogError(d.detail || "Save failed");
                          } else {
                            setCatalogEditing(false);
                            await refetchCatalog();
                            await refetchTables();
                          }
                        } finally {
                          setCatalogSaving(false);
                        }
                      }}
                      className="rounded bg-[#FF3621] px-3 py-1 text-xs font-medium text-white hover:bg-[#e02e1a] disabled:opacity-50"
                    >
                      {catalogSaving ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => { setCatalogEditing(false); setCatalogError(null); }}
                      className="rounded px-3 py-1 text-xs text-gray-500 hover:bg-gray-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-gray-500">Catalog</span>
                    <span className="rounded-md bg-orange-50 border border-orange-200 px-2 py-0.5 text-xs font-mono font-medium text-orange-800">
                      {catalogInfo?.catalog ?? appConfig?.storage_location?.catalog ?? "—"}
                    </span>
                    <span className="text-gray-300">·</span>
                    <span className="text-xs text-gray-500">Schema</span>
                    <span className="rounded-md bg-orange-50 border border-orange-200 px-2 py-0.5 text-xs font-mono font-medium text-orange-800">
                      {catalogInfo?.schema ?? appConfig?.storage_location?.schema ?? "—"}
                    </span>
                    {catalogInfo?.source === "override" && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 border border-amber-200 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                        Override active
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => {
                        setCatalogDraft({ catalog: catalogInfo?.catalog ?? "", schema: catalogInfo?.schema ?? "" });
                        setCatalogError(null);
                        setCatalogEditing(true);
                      }}
                      className="rounded px-2 py-1 text-xs text-gray-500 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                    >
                      Change
                    </button>
                    {catalogInfo?.source === "override" && (
                      <button
                        onClick={async () => {
                          await fetch("/api/settings/catalog", { method: "DELETE" });
                          await refetchCatalog();
                          await refetchTables();
                        }}
                        className="rounded px-2 py-1 text-xs text-amber-600 hover:bg-amber-50 transition-colors"
                        title={`Revert to env vars (${catalogInfo.env_catalog}.${catalogInfo.env_schema})`}
                      >
                        Reset to default
                      </button>
                    )}
                  </div>
                </div>
              )}
              {catalogInfo?.source === "override" && !catalogEditing && (
                <p className="text-[10px] text-amber-600">
                  This override is stored locally and will be lost if the app is redeployed.
                  Default from app.yaml: <span className="font-mono">{catalogInfo.env_catalog}.{catalogInfo.env_schema}</span>
                </p>
              )}
            </div>

            {/* Auth error banner */}
            {tablesStatus?.auth_error && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 flex gap-2 items-start">
                <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <span>{tablesStatus.auth_error}</span>
              </div>
            )}

            {/* Table list */}
            {tablesLoading ? (
              <div className="py-3 text-center text-xs text-gray-500">Checking tables...</div>
            ) : tablesStatus?.tables?.length ? (
              <div className="rounded-lg border border-gray-200 overflow-hidden">
                <table className="min-w-full divide-y divide-gray-100 text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-gray-500">Table</th>
                      <th className="px-3 py-2 text-left font-medium text-gray-500">Type</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500">Rows</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500">History</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500">Latest date</th>
                      <th className="px-3 py-2 text-right font-medium text-gray-500">Freshness</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {tablesStatus.tables.map((t) => {
                      const stale = t.days_behind != null && t.days_behind > 1;
                      const missing = t.exists === false && !t.optional;
                      const notConfigured = t.exists === false && t.optional;
                      const unknown = t.exists === null;
                      return (
                        <tr key={t.name} className={missing ? "bg-red-50" : stale ? "bg-amber-50" : ""}>
                          <td className="px-3 py-2 font-mono text-gray-700 flex items-center gap-1.5">
                            {missing ? (
                              <span className="text-red-400">✗</span>
                            ) : notConfigured ? (
                              <span className="text-gray-300">–</span>
                            ) : unknown ? (
                              <span className="text-gray-300">?</span>
                            ) : (
                              <span className="text-green-500">✓</span>
                            )}
                            {t.name}
                            {t.error && (
                              <span className="ml-1 text-red-400" title={t.error}>⚠</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-gray-500">
                            {t.table_type ? (
                              <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                t.table_type === "Materialized View" ? "bg-blue-50 text-blue-600" :
                                t.table_type === "Telemetry" ? "bg-gray-100 text-gray-600" :
                                "bg-gray-100 text-gray-500"
                              }`}>
                                {t.table_type}
                              </span>
                            ) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-500 tabular-nums">
                            {t.row_count != null ? t.row_count.toLocaleString() : "—"}
                          </td>
                          <td className="px-3 py-2 text-right text-gray-500 tabular-nums">
                            {t.min_date && t.max_date ? (() => {
                              const start = new Date(t.min_date.slice(0, 10));
                              const end = new Date(t.max_date.slice(0, 10));
                              const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
                              const years = Math.floor(months / 12);
                              const remMonths = months % 12;
                              if (years > 0 && remMonths > 0) return `${years}yr ${remMonths}mo`;
                              if (years > 0) return `${years}yr`;
                              return `${months}mo`;
                            })() : "—"}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-gray-500">
                            {t.max_date ? t.max_date.slice(0, 10) : "—"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {t.days_behind == null ? (
                              <span className="text-gray-300">—</span>
                            ) : t.days_behind === 0 ? (
                              <span className="text-green-600 font-medium">Today</span>
                            ) : t.days_behind === 1 ? (
                              <span className="text-green-600">1d behind</span>
                            ) : t.days_behind <= 3 ? (
                              <span className="text-amber-600 font-medium">{t.days_behind}d behind</span>
                            ) : (
                              <span className="text-red-600 font-medium">{t.days_behind}d behind</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">Could not retrieve table status</div>
            )}
          </div>

          {/* App Telemetry */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <h4 className="text-sm font-semibold text-gray-900">App Telemetry</h4>
                <span className="inline-flex items-center rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-600">OpenTelemetry</span>
              </div>
              {!telemetryEditing && !telemetryLoading && (
                <button
                  onClick={() => {
                    setTelemetryDraft({ catalog: telemetry?.catalog ?? "", schema_name: telemetry?.schema_name ?? "", table_prefix: telemetry?.table_prefix ?? "" });
                    setTelemetryError(null);
                    setTelemetryEditing(true);
                  }}
                  className="rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  {telemetry?.is_default ? "Override" : "Edit"}
                </button>
              )}
            </div>

            {/* What is OTel telemetry */}
            <div className="mb-3 rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
              <p className="text-xs font-medium text-gray-900">How Databricks Apps telemetry works</p>
              <p className="text-[11px] text-gray-600 leading-relaxed">
                Databricks Apps automatically collects OpenTelemetry (OTel) data from every app and writes it to Delta tables in your Unity Catalog.
                This is handled entirely by the <strong>Databricks Apps platform</strong> — the app itself does not write these tables.
              </p>
              <div className="grid grid-cols-3 gap-2 pt-1">
                {[
                  { table: "otel_spans", label: "Traces", desc: "HTTP request spans, latency, endpoints hit, response codes, errors" },
                  { table: "otel_metrics", label: "Metrics", desc: "CPU/memory usage, request rates, active connections, queue depth" },
                  { table: "otel_logs", label: "Logs", desc: "Structured log lines from uvicorn and all Python loggers" },
                ].map(({ table, label, desc }) => (
                  <div key={table} className="rounded border border-gray-200 bg-white px-2.5 py-2 space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-400" />
                      <code className="text-[10px] font-mono font-semibold text-gray-700">{table}</code>
                    </div>
                    <p className="text-[10px] font-medium text-gray-700">{label}</p>
                    <p className="text-[10px] text-gray-500 leading-snug">{desc}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-600 pt-1">
                <strong>Different from Storage:</strong> The Storage section above shows tables <em>this app creates</em> (materialized views of system.billing data). The OTel tables below are created by Databricks and contain telemetry about the app itself — not cost data.
                Configure the catalog/schema below so the Storage section can show their status alongside your materialized views.
              </p>
            </div>

            {/* Location config — same pattern as Storage Location */}
            <div className="rounded-lg border border-gray-200 bg-white p-3">
              {telemetryLoading ? (
                <div className="text-xs text-gray-500">Loading...</div>
              ) : telemetryEditing ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="w-14 text-xs text-gray-500 shrink-0">Catalog</label>
                    <input
                      type="text"
                      value={telemetryDraft.catalog}
                      onChange={e => setTelemetryDraft(d => ({ ...d, catalog: e.target.value }))}
                      className="flex-1 rounded border border-gray-200 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                      placeholder={appConfig?.storage_location?.catalog || "e.g. main"}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="w-14 text-xs text-gray-500 shrink-0">Schema</label>
                    <input
                      type="text"
                      value={telemetryDraft.schema_name}
                      onChange={e => setTelemetryDraft(d => ({ ...d, schema_name: e.target.value }))}
                      className="flex-1 rounded border border-gray-200 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                      placeholder={appConfig?.storage_location?.schema || "e.g. default"}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="w-14 text-xs text-gray-500 shrink-0">Prefix</label>
                    <input
                      type="text"
                      value={telemetryDraft.table_prefix}
                      onChange={e => setTelemetryDraft(d => ({ ...d, table_prefix: e.target.value }))}
                      className="flex-1 rounded border border-gray-200 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                      placeholder="optional, e.g. cost_obs_"
                    />
                    <span className="text-[10px] text-gray-500 shrink-0">→ {telemetryDraft.table_prefix || ""}otel_spans</span>
                  </div>
                  {telemetryError && <p className="text-xs text-red-500">{telemetryError}</p>}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      disabled={telemetrySaving}
                      onClick={async () => {
                        setTelemetryError(null);
                        setTelemetrySaving(true);
                        try {
                          const res = await fetch("/api/settings/telemetry", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(telemetryDraft),
                          });
                          if (!res.ok) {
                            const d = await res.json().catch(() => ({}));
                            setTelemetryError(d.detail || "Save failed");
                          } else {
                            setTelemetryEditing(false);
                            await refetchTelemetry();
                            await refetchTables();
                          }
                        } finally {
                          setTelemetrySaving(false);
                        }
                      }}
                      className="rounded bg-[#FF3621] px-3 py-1 text-xs font-medium text-white hover:bg-[#e02e1a] disabled:opacity-50"
                    >
                      {telemetrySaving ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => { setTelemetryEditing(false); setTelemetryError(null); }}
                      className="rounded px-3 py-1 text-xs text-gray-500 hover:bg-gray-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-gray-500">Catalog</span>
                  <span className="rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-xs font-mono font-medium text-gray-700">{telemetry?.catalog || "—"}</span>
                  <span className="text-gray-300">·</span>
                  <span className="text-xs text-gray-500">Schema</span>
                  <span className="rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-xs font-mono font-medium text-gray-700">{telemetry?.schema_name || "—"}</span>
                  {telemetry?.table_prefix && (
                    <>
                      <span className="text-gray-300">·</span>
                      <span className="text-xs text-gray-500">Prefix</span>
                      <span className="rounded-md bg-gray-50 border border-gray-200 px-2 py-0.5 text-xs font-mono font-medium text-gray-700">{telemetry.table_prefix}</span>
                    </>
                  )}
                  {telemetry?.is_default && (
                    <span className="rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-[10px] text-gray-500">App default</span>
                  )}
                </div>
              )}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
