import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface UserPermissions {
  admins: string[];
  consumers: string[];
  table_location?: string | null;
  current_user?: string | null;
}

interface AuthStatus {
  user_token_active: boolean;
  identity: "user_oauth" | "service_principal";
  locked_to_sp: boolean;
  has_sql_scope: boolean | null;
  auth_mode: "unknown" | "user" | "sp";
  token_present: boolean;
  token_scopes: string[];
  user_email: string | null;
  override_mode: "sp" | "auto" | null;
  sp_client_id: string;
  sp_display_name: string;
  catalog: string;
  schema: string;
}

export function SettingsPermissions() {
  const queryClient = useQueryClient();
  const [newAdmin, setNewAdmin] = useState("");
  const [newConsumer, setNewConsumer] = useState("");
  const [modeError, setModeError] = useState<string | null>(null);
  const [modeSuccess, setModeSuccess] = useState<string | null>(null);
  const [grantRunning, setGrantRunning] = useState(false);
  const [grantResult, setGrantResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data: permissions, isLoading } = useQuery<UserPermissions>({
    queryKey: ["user-permissions"],
    queryFn: async () => {
      const res = await fetch("/api/settings/user-permissions");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
  });

  const { data: authStatus, isLoading: authLoading, refetch: refetchAuth } = useQuery<AuthStatus>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()),
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  });

  const saveMutation = useMutation({
    mutationFn: async (data: UserPermissions) => {
      const res = await fetch("/api/settings/user-permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? "Failed to save");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-permissions"] });
      queryClient.refetchQueries({ queryKey: ["user"] });
    },
  });

  const setAuthMode = async (mode: "sp" | "auto") => {
    setModeError(null);
    setModeSuccess(null);
    try {
      const res = await fetch("/api/settings/auth-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setModeError(body.detail ?? "Failed to update auth mode");
        return;
      }
      await refetchAuth();
      queryClient.invalidateQueries({ queryKey: ["settings-auth-status"] });
      setModeSuccess(
        mode === "sp"
          ? "Switched to Service Principal mode. All queries now run as the app SP."
          : "Auto-detect enabled. OAuth will be used on the next request if the SQL scope is active."
      );
    } catch (e) {
      setModeError(`Network error: ${e}`);
    }
  };

  const runSpGrants = async () => {
    setGrantRunning(true);
    setGrantResult(null);
    try {
      const res = await fetch("/api/setup/grant-sp-system-access", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (body.ok || (res.ok && body.status === "ok")) {
        const detail = body.applied != null
          ? `${body.applied} grant(s) applied for ${body.sp_client_id}.`
          : `Grants applied for ${body.sp_client_id}.`;
        setGrantResult({ ok: true, message: detail });
        queryClient.invalidateQueries({ queryKey: ["settings-auth-status"] });
        await refetchAuth();
      } else {
        const err = body.errors?.[0] ?? body.reason ?? body.detail ?? "Grant run completed — check server logs.";
        const extra = body.failed ? ` (${body.failed} failed, ${body.applied ?? 0} applied)` : "";
        setGrantResult({ ok: false, message: err + extra });
      }
    } catch {
      setGrantResult({ ok: false, message: "Network error running grants." });
    } finally {
      setGrantRunning(false);
    }
  };

  const addAdmin = () => {
    const email = newAdmin.trim();
    if (!email) return;
    saveMutation.mutate({
      admins: [...(permissions?.admins ?? []), email],
      consumers: (permissions?.consumers ?? []).filter((e) => e !== email),
    });
    setNewAdmin("");
  };

  const removeAdmin = (email: string) => {
    saveMutation.mutate({
      admins: (permissions?.admins ?? []).filter((e) => e !== email),
      consumers: permissions?.consumers ?? [],
    });
  };

  const addConsumer = () => {
    const email = newConsumer.trim();
    if (!email) return;
    saveMutation.mutate({
      admins: (permissions?.admins ?? []).filter((e) => e !== email),
      consumers: [...(permissions?.consumers ?? []), email],
    });
    setNewConsumer("");
  };

  const removeConsumer = (email: string) => {
    saveMutation.mutate({
      admins: permissions?.admins ?? [],
      consumers: (permissions?.consumers ?? []).filter((e) => e !== email),
    });
  };

  const isOAuth = authStatus?.identity === "user_oauth";
  const isSP = authStatus?.identity === "service_principal";
  const isOverriddenSP = authStatus?.override_mode === "sp";
  const noToken = !authStatus?.token_present;

  if (isLoading) {
    return <div className="py-8 text-center text-sm text-gray-500">Loading permissions...</div>;
  }

  return (
    <div className="space-y-6">

      {/* ── App-level user/role permissions ── */}
      {saveMutation.isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <strong>Save failed:</strong> {saveMutation.error instanceof Error ? saveMutation.error.message : "Unknown error"}. Check that the app service principal has INSERT/DELETE access to the permissions table.
        </div>
      )}
      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-700">
        <strong>Default access:</strong> Any user not explicitly listed is treated as a <strong>Consumer</strong>. Add users to <em>Admins</em> to grant settings access.
      </div>

      {permissions?.table_location && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
          <span className="font-medium">Permissions table: </span>
          <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-800">{permissions.table_location}</code>
          <span className="ml-2 text-gray-500">— stored in Unity Catalog, persists across deploys</span>
        </div>
      )}

      {/* Admins */}
      <div>
        <h4 className="mb-1 text-sm font-semibold text-gray-800">Admins</h4>
        <p className="mb-3 text-xs text-gray-500">Admins can view all data and change app settings.</p>
        <div className="mb-3 space-y-2">
          {(permissions?.admins ?? []).length === 0 ? (
            <div className="space-y-2">
              {permissions?.current_user && (
                <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2 opacity-60">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">Admin</span>
                    <span className="text-sm text-gray-800">{permissions.current_user}</span>
                    <span className="text-xs text-gray-400 italic">(you — default admin)</span>
                  </div>
                </div>
              )}
              <p className="text-xs text-gray-500 italic">No admins explicitly configured. All users are admins by default. Add specific users below to restrict admin access to only those listed.</p>
            </div>
          ) : (
            (permissions?.admins ?? []).map((email) => (
              <div key={email} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600">Admin</span>
                  <span className="text-sm text-gray-800">{email}</span>
                </div>
                <button onClick={() => removeAdmin(email)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
              </div>
            ))
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="email"
            placeholder="user@example.com"
            value={newAdmin}
            onChange={(e) => setNewAdmin(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addAdmin()}
            className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-[#FF3621] focus:outline-none"
          />
          <button
            onClick={addAdmin}
            disabled={!newAdmin.trim() || saveMutation.isPending}
            className="btn-brand rounded-md px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Add Admin
          </button>
        </div>
      </div>

      {/* Consumers */}
      <div>
        <h4 className="mb-1 text-sm font-semibold text-gray-800">Consumers</h4>
        <p className="mb-3 text-xs text-gray-500">Consumers can view dashboards but cannot change app settings.</p>
        <div className="mb-3 space-y-2">
          {(permissions?.consumers ?? []).length === 0 ? (
            <p className="text-xs text-gray-500 italic">No consumers listed.</p>
          ) : (
            (permissions?.consumers ?? []).map((email) => (
              <div key={email} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-500">Consumer</span>
                  <span className="text-sm text-gray-800">{email}</span>
                </div>
                <button onClick={() => removeConsumer(email)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
              </div>
            ))
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="email"
            placeholder="user@example.com"
            value={newConsumer}
            onChange={(e) => setNewConsumer(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addConsumer()}
            className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-[#FF3621] focus:outline-none"
          />
          <button
            onClick={addConsumer}
            disabled={!newConsumer.trim() || saveMutation.isPending}
            className="btn-brand rounded-md px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            Add Consumer
          </button>
        </div>
      </div>

      {/* ── Auth Mode Panel ── */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
            <h4 className="text-sm font-semibold text-gray-900">Query Authentication Mode</h4>
          </div>
          {!authLoading && authStatus && (
            <div className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
              isOAuth ? "bg-green-50 text-green-700 border border-green-200" : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${isOAuth ? "bg-green-500" : "bg-amber-500"}`} />
              {isOAuth ? "OAuth Active" : "Service Principal"}
            </div>
          )}
        </div>

        <div className="p-5 space-y-5">

          {/* Architecture diagram */}
          <div className="grid grid-cols-2 gap-3">
            {/* OAuth path */}
            <div className={`rounded-lg border-2 p-4 space-y-2 transition-colors ${
              isOAuth ? "border-green-300 bg-green-50" : "border-gray-200 bg-gray-50 opacity-70"
            }`}>
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${isOAuth ? "bg-green-500" : "bg-gray-300"}`} />
                <span className="text-xs font-semibold text-gray-800">OAuth (User Identity)</span>
                {isOAuth && <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">Active</span>}
              </div>
              <div className="space-y-1 text-[11px] text-gray-600">
                <div className="flex items-start gap-1.5">
                  <svg className="mt-0.5 h-3 w-3 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                  <span>Queries run as the <strong>logged-in user</strong> — their UC identity and permissions apply</span>
                </div>
                <div className="flex items-start gap-1.5">
                  <svg className="mt-0.5 h-3 w-3 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                  <span>No SP grants needed on the app catalog or schema</span>
                </div>
                <div className="flex items-start gap-1.5">
                  <svg className="mt-0.5 h-3 w-3 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                  <span>System tables accessible if the user is a workspace or account admin</span>
                </div>
                <div className="flex items-start gap-1.5">
                  <svg className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z" /></svg>
                  <span>Requires <strong>SQL scope</strong> enabled in App user authorization settings</span>
                </div>
              </div>
              <div className="mt-2 rounded bg-white border border-gray-200 px-2 py-1.5 font-mono text-[10px] text-gray-500 leading-relaxed">
                Browser → <span className="text-blue-600">x-forwarded-access-token</span> → User SQL connection
              </div>
            </div>

            {/* SP path */}
            <div className={`rounded-lg border-2 p-4 space-y-2 transition-colors ${
              isSP ? "border-amber-300 bg-amber-50" : "border-gray-200 bg-gray-50 opacity-70"
            }`}>
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${isSP ? "bg-amber-500" : "bg-gray-300"}`} />
                <span className="text-xs font-semibold text-gray-800">Service Principal</span>
                {isSP && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">{isOverriddenSP ? "Forced" : "Active"}</span>}
              </div>
              <div className="space-y-1 text-[11px] text-gray-600">
                <div className="flex items-start gap-1.5">
                  <svg className="mt-0.5 h-3 w-3 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                  <span>Consistent identity for all users — all queries run as the app's SP</span>
                </div>
                <div className="flex items-start gap-1.5">
                  <svg className="mt-0.5 h-3 w-3 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                  <span>Works without SQL scope — any deployment configuration</span>
                </div>
                <div className="flex items-start gap-1.5">
                  <svg className="mt-0.5 h-3 w-3 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  <span>SP requires explicit <strong>GRANT</strong> on every system table and app schema</span>
                </div>
                <div className="flex items-start gap-1.5">
                  <svg className="mt-0.5 h-3 w-3 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  <span>Grants must be re-applied after each git deploy (new SP per deploy)</span>
                </div>
              </div>
              <div className="mt-2 rounded bg-white border border-gray-200 px-2 py-1.5 font-mono text-[10px] text-gray-500 leading-relaxed">
                Browser → SP credentials → SP SQL connection
              </div>
            </div>
          </div>

          {/* Current status detail */}
          {authLoading ? (
            <div className="h-16 animate-pulse rounded-lg bg-gray-100" />
          ) : authStatus ? (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 space-y-2">
              <p className="text-xs font-medium text-gray-700">Current status</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[11px]">
                <StatusRow label="Auth mode" value={
                  authStatus.auth_mode === "user" ? "OAuth (locked)" :
                  authStatus.auth_mode === "sp" ? "Service Principal (locked)" :
                  "Auto-detecting…"
                } />
                <StatusRow label="OAuth token received" value={authStatus.token_present ? "Yes" : "No"} ok={authStatus.token_present} />
                <StatusRow label="SQL scope granted" value={
                  authStatus.has_sql_scope === true ? "Yes" :
                  authStatus.has_sql_scope === false ? "No (token present, scope missing)" :
                  authStatus.token_present ? "Unknown" : "N/A"
                } ok={authStatus.has_sql_scope === true} warn={authStatus.has_sql_scope === false} />
                <StatusRow label="Running as" value={authStatus.user_email ?? (isOAuth ? "OAuth user" : "Service Principal")} />
                {authStatus.token_scopes.length > 0 && (
                  <StatusRow label="Token scopes" value={authStatus.token_scopes.join(", ")} />
                )}
                {isOverriddenSP && (
                  <StatusRow label="Override" value="Forced to SP (manual override active)" warn />
                )}
              </div>
            </div>
          ) : null}

          {/* Mode switch */}
          {modeError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{modeError}</div>
          )}
          {modeSuccess && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-700">{modeSuccess}</div>
          )}

          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 space-y-3">
            <p className="text-xs font-medium text-gray-700">Manual override</p>
            <p className="text-[11px] text-gray-500">
              Force a specific mode regardless of what the app auto-detects. Use this if you need to
              troubleshoot permission issues or lock the app to a known-working identity.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setAuthMode("auto")}
                disabled={!isOverriddenSP && authStatus?.auth_mode !== "sp"}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  !isOverriddenSP && authStatus?.auth_mode !== "sp"
                    ? "border-green-300 bg-green-50 text-green-700 cursor-default"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                {!isOverriddenSP && authStatus?.auth_mode !== "sp" ? "Auto-detect (current)" : "Switch to Auto-detect (OAuth)"}
              </button>
              <button
                onClick={() => setAuthMode("sp")}
                disabled={isOverriddenSP}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                  isOverriddenSP
                    ? "border-amber-300 bg-amber-50 text-amber-700 cursor-default"
                    : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                }`}
              >
                {isOverriddenSP ? "Forced to Service Principal (current)" : "Force Service Principal"}
              </button>
            </div>
            {noToken && !isOverriddenSP && (
              <p className="text-[11px] text-amber-600">
                No OAuth token detected. The app is in SP mode by default because the SQL scope is not configured
                or user authorization is not enabled on this Databricks App.
              </p>
            )}
          </div>

          {/* Re-run SP grants button — always visible, needed after every git deploy */}
          <div className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 space-y-2">
              <p className="text-xs font-medium text-amber-800">After a git deploy, re-apply SP grants</p>
              <p className="text-[11px] text-amber-700">
                Each git deploy creates a new service principal. Run this (as a metastore or account admin) to
                grant the new SP access to all system tables and the app schema — fixes 0s in dashboards after deploy.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={runSpGrants}
                  disabled={grantRunning}
                  className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                >
                  {grantRunning ? "Running grants…" : "Re-run SP grants"}
                </button>
                {grantResult && (
                  <span className={`text-[11px] font-medium ${grantResult.ok ? "text-green-700" : "text-red-600"}`}>
                    {grantResult.ok ? "✓ " : "✗ "}{grantResult.message}
                  </span>
                )}
              </div>
            </div>

          {/* SP grants reference */}
          {(isSP || noToken) && authStatus && (
            <details className="rounded-lg border border-gray-200 bg-gray-50 text-xs">
              <summary className="cursor-pointer px-4 py-2.5 font-medium text-gray-700 hover:text-gray-900">
                Required SP grants (run as metastore admin)
              </summary>
              <div className="border-t border-gray-200 px-4 py-3 space-y-2">
                {(() => {
                  const spName = authStatus.sp_display_name || authStatus.sp_client_id || "<service-principal>";
                  const userEmail = authStatus.user_email;
                  const principals = userEmail && userEmail !== spName
                    ? `\`${userEmail}\`, \`${spName}\``
                    : `\`${spName}\``;
                  const cat = authStatus.catalog || "<your_catalog>";
                  const sch = authStatus.schema || "<your_schema>";
                  return (
                    <>
                      <p className="text-gray-500 text-[11px]">
                        Grants for <strong>{spName}</strong>{userEmail ? <> and <strong>{userEmail}</strong></> : null}.
                        Run in a SQL editor as metastore admin.
                      </p>
                      <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                        <strong>Note:</strong> Warehouse access cannot be granted via SQL. Grant <strong>CAN USE</strong> to the SP via: SQL Warehouses → [warehouse name] → Permissions tab. The app also grants this automatically on startup.
                      </p>
                      <pre className="rounded bg-gray-900 px-4 py-3 text-[11px] text-green-400 overflow-x-auto leading-relaxed whitespace-pre">{
`-- System tables (billing + query history)
GRANT USE CATALOG ON CATALOG system TO ${principals};
GRANT USE SCHEMA ON SCHEMA system.billing TO ${principals};
GRANT SELECT ON TABLE system.billing.usage TO ${principals};
GRANT SELECT ON TABLE system.billing.list_prices TO ${principals};
GRANT SELECT ON TABLE system.billing.account_prices TO ${principals};
GRANT USE SCHEMA ON SCHEMA system.query TO ${principals};
GRANT SELECT ON TABLE system.query.history TO ${principals};
GRANT USE SCHEMA ON SCHEMA system.compute TO ${principals};
GRANT SELECT ON TABLE system.compute.clusters TO ${principals};
GRANT USE SCHEMA ON SCHEMA system.lakeflow TO ${principals};
GRANT SELECT ON TABLE system.lakeflow.pipelines TO ${principals};

-- App schema (materialized views)
GRANT USE CATALOG ON CATALOG \`${cat}\` TO ${principals};
GRANT USE SCHEMA ON SCHEMA \`${cat}\`.\`${sch}\` TO ${principals};
GRANT CREATE TABLE ON SCHEMA \`${cat}\`.\`${sch}\` TO ${principals};
GRANT SELECT ON SCHEMA \`${cat}\`.\`${sch}\` TO ${principals};`
                      }</pre>
                    </>
                  );
                })()}
              </div>
            </details>
          )}
        </div>
      </div>

    </div>
  );
}

function StatusRow({ label, value, ok, warn }: { label: string; value: string; ok?: boolean; warn?: boolean }) {
  return (
    <>
      <span className="text-gray-500">{label}</span>
      <span className={`font-medium ${ok ? "text-green-700" : warn ? "text-amber-700" : "text-gray-800"}`}>{value}</span>
    </>
  );
}
