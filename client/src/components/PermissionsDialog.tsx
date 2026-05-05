import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle, XCircle, AlertTriangle, Shield, ExternalLink, Copy, Check, Eye, X, Loader2 } from "lucide-react";

interface Permission {
  table: string;
  name: string;
  description: string;
  required: boolean;
  granted: boolean;
}

interface PermissionsResponse {
  permissions: Permission[];
  summary: {
    total: number;
    granted: number;
    required_count: number;
    required_granted: number;
    all_required_granted: boolean;
    ready_to_use: boolean;
  };
  user: {
    email: string;
    name: string;
  };
  help_url: string;
}

const STORAGE_KEY = "coc-permissions-dont-show-again";

export function PermissionsDialog() {
  // Check if user previously selected "don't show again"
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem(STORAGE_KEY) === "true";
  });

  // Check auth mode — if OAuth is active, SP permissions are irrelevant
  const { data: authStatus } = useQuery<{ identity: string }>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()),
    staleTime: 30 * 1000,
    enabled: !dismissed,
  });
  const isOAuth = authStatus?.identity === "user_oauth";

  // Checkbox state for acknowledgment (required)
  const [acknowledged, setAcknowledged] = useState(false);

  // Checkbox state for "don't show this again"
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Track which permission's GRANT was just copied
  const [copiedTable, setCopiedTable] = useState<string | null>(null);

  // Track which permission's GRANT preview is shown
  const [previewTable, setPreviewTable] = useState<string | null>(null);

  // Generate GRANT SQL for a table
  const getGrantSQL = (table: string, userEmail: string) => {
    return `GRANT SELECT ON TABLE ${table} TO \`${userEmail}\`;`;
  };

  // Copy GRANT SQL to clipboard
  const copyGrantSQL = async (table: string, userEmail: string) => {
    const grantSQL = getGrantSQL(table, userEmail);
    try {
      await navigator.clipboard.writeText(grantSQL);
      setCopiedTable(table);
      setTimeout(() => setCopiedTable(null), 2000);
    } catch {
      // Clipboard API may not be available in all contexts
    }
  };

  const { data, isLoading, error } = useQuery<PermissionsResponse>({
    queryKey: ["permissions-check"],
    queryFn: async () => {
      const response = await fetch("/api/permissions/check");
      if (!response.ok) throw new Error("Failed to check permissions");
      return response.json();
    },
    enabled: !dismissed && !isOAuth,
    staleTime: 0,
    gcTime: 0,
    retry: 1,
    retryDelay: 1000,
  });

  // Don't show if user dismissed this session
  if (dismissed) {
    return null;
  }

  // OAuth active — SP permissions are irrelevant; show a lightweight acknowledgment instead
  if (isOAuth) {
    return createPortal(
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4"
        style={{ backgroundColor: "rgba(0, 0, 0, 0.6)" }}
      >
        <div className="relative w-full max-w-md rounded-xl bg-white shadow-2xl">
          <div className="flex items-center gap-4 rounded-t-xl px-6 py-5" style={{ backgroundColor: "#1B3139" }}>
            <div className="rounded-full bg-white/10 p-3">
              <Shield className="h-6 w-6 text-white" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-semibold text-white">OAuth Active</h2>
              <p className="text-sm text-white/70">Queries run as your Databricks user identity.</p>
            </div>
          </div>
          <div className="p-6 space-y-4">
            <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-4">
              <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
              <div>
                <p className="text-sm font-medium text-green-800">No SP grants required</p>
                <p className="text-sm text-green-700 mt-0.5">
                  All queries run under your own Unity Catalog identity — system table access follows your personal permissions, not the service principal's.
                </p>
              </div>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              <span className="font-medium text-gray-600">Important Disclaimer:</span> This application is a reference implementation and is not official production software from Databricks. It is not covered by Databricks support SLAs. Treat your deployment like OSS software.
            </p>
          </div>
          <div className="flex flex-col gap-3 border-t border-gray-200 px-6 py-4">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-sm font-semibold text-gray-700">I acknowledge the disclaimer above.</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="text-sm font-semibold text-gray-700">Don't show this again.</span>
            </label>
            <div className="flex justify-end">
              <button
                onClick={() => {
                  if (dontShowAgain) localStorage.setItem(STORAGE_KEY, "true");
                  setDismissed(true);
                }}
                disabled={!acknowledged}
                className={`rounded-lg px-5 py-2 text-sm font-medium text-white transition-colors ${!acknowledged ? "opacity-50 cursor-not-allowed" : ""}`}
                style={{ backgroundColor: acknowledged ? "#10b981" : "#9ca3af" }}
              >
                Continue to Dashboard
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  // Show loading or error states inside the modal overlay
  if (isLoading || error || !data) {
    return createPortal(
      <div
        className="fixed inset-0 z-[100] flex items-start justify-center pt-36 p-4"
        style={{ backgroundColor: "rgba(255, 255, 255, 1)" }}
      >
        <div className="w-full max-w-md rounded-xl bg-white p-8 text-center shadow-2xl border border-gray-200">
          {isLoading ? (
            <Loader2 className="mx-auto h-10 w-10 text-gray-500 mb-4 animate-spin" />
          ) : (
            <Shield className="mx-auto h-10 w-10 text-gray-500 mb-4" />
          )}
          <p className="text-lg font-medium text-gray-700">
            {isLoading ? "Post-deployment initial setup — this could take a few minutes" : "Unable to check permissions"}
          </p>
          {(error || !data) && !isLoading && (
            <button
              onClick={() => setDismissed(true)}
              className="mt-4 rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ backgroundColor: "#FF3621" }}
            >
              Continue Anyway
            </button>
          )}
        </div>
      </div>,
      document.body
    );
  }

  const handleDismiss = () => {
    // Only persist if user checked "don't show again"
    if (dontShowAgain) {
      localStorage.setItem(STORAGE_KEY, "true");
    }
    setDismissed(true);
  };

  const handleRecheck = () => {
    localStorage.removeItem(STORAGE_KEY);
    window.location.reload();
  };

  const requiredPermissions = data.permissions.filter(p => p.required);
  const optionalPermissions = data.permissions.filter(p => !p.required);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0, 0, 0, 0.6)" }}
    >
      <div className="relative w-full max-w-2xl rounded-xl bg-white shadow-2xl">
        {/* Header */}
        <div
          className="flex items-center gap-4 rounded-t-xl px-6 py-5"
          style={{ backgroundColor: "#1B3139" }}
        >
          <div className="rounded-full bg-white/10 p-3">
            <Shield className="h-6 w-6 text-white" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-semibold text-white">System Table Permissions</h2>
            <p className="text-sm text-white/70">
              Welcome, {data.user.name}. Let's verify your access to required data sources.
            </p>
          </div>
        </div>

        {/* Summary Banner */}
        <div
          className={`px-6 py-4 ${
            data.summary.all_required_granted
              ? "bg-green-50 border-b border-green-100"
              : "bg-amber-50 border-b border-amber-100"
          }`}
        >
          <div className="flex items-center gap-3">
            {data.summary.all_required_granted ? (
              <>
                <CheckCircle className="h-5 w-5 text-green-600" />
                <div>
                  <p className="font-medium text-green-800">All Required Permissions Granted</p>
                  <p className="text-sm text-green-700">
                    You have access to all required system tables ({data.summary.granted}/{data.summary.total} total).
                  </p>
                </div>
              </>
            ) : (
              <>
                <AlertTriangle className="h-5 w-5 text-amber-600" />
                <div>
                  <p className="font-medium text-amber-800">Missing Required Permissions</p>
                  <p className="text-sm text-amber-700">
                    You need access to {data.summary.required_count - data.summary.required_granted} more required table(s) to use this app.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Permissions Lists */}
        <div className="max-h-[50vh] overflow-y-auto p-6 space-y-6">
          {/* Required Permissions */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
              Required Permissions
            </h3>
            <div className="space-y-2">
              {requiredPermissions.map((perm) => (
                <div
                  key={perm.table}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${
                    perm.granted
                      ? "border-green-200 bg-green-50"
                      : "border-red-200 bg-red-50"
                  }`}
                >
                  {perm.granted ? (
                    <CheckCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600" />
                  ) : (
                    <XCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-600" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-900">{perm.name}</p>
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                          perm.granted
                            ? "bg-green-100 text-green-800"
                            : "bg-red-100 text-red-800"
                        }`}
                      >
                        {perm.granted ? "Granted" : "Missing"}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600">{perm.description}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs font-mono text-gray-700">
                        {perm.table}
                      </code>
                      <button
                        onClick={() => setPreviewTable(perm.table)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-200 transition-colors"
                        title="Preview GRANT SQL"
                      >
                        <Eye className="h-3 w-3" />
                        <span>Preview</span>
                      </button>
                      <button
                        onClick={() => copyGrantSQL(perm.table, data.user.email)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-200 transition-colors"
                        title="Copy GRANT SQL to clipboard"
                      >
                        {copiedTable === perm.table ? (
                          <>
                            <Check className="h-3 w-3 text-green-600" />
                            <span className="text-green-600">Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Optional Permissions */}
          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-500">
              Optional Permissions (Enhanced Features)
            </h3>
            <div className="space-y-2">
              {optionalPermissions.map((perm) => (
                <div
                  key={perm.table}
                  className={`flex items-start gap-3 rounded-lg border p-3 ${
                    perm.granted
                      ? "border-green-200 bg-green-50"
                      : "border-red-200 bg-red-50"
                  }`}
                >
                  {perm.granted ? (
                    <CheckCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-600" />
                  ) : (
                    <div className="mt-0.5 h-5 w-5 flex-shrink-0 rounded-full border-2 border-red-300" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-900">{perm.name}</p>
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                          perm.granted
                            ? "bg-green-100 text-green-800"
                            : "bg-red-100 text-red-800"
                        }`}
                      >
                        {perm.granted ? "Granted" : "Not Granted"}
                      </span>
                    </div>
                    <p className="text-sm text-gray-600">{perm.description}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="inline-block rounded bg-gray-100 px-2 py-0.5 text-xs font-mono text-gray-700">
                        {perm.table}
                      </code>
                      <button
                        onClick={() => setPreviewTable(perm.table)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-200 transition-colors"
                        title="Preview GRANT SQL"
                      >
                        <Eye className="h-3 w-3" />
                        <span>Preview</span>
                      </button>
                      <button
                        onClick={() => copyGrantSQL(perm.table, data.user.email)}
                        className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-gray-600 hover:bg-gray-200 transition-colors"
                        title="Copy GRANT SQL to clipboard"
                      >
                        {copiedTable === perm.table ? (
                          <>
                            <Check className="h-3 w-3 text-green-600" />
                            <span className="text-green-600">Copied!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="h-3 w-3" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* GRANT Preview Dialog */}
        {previewTable && (
          <div
            className="fixed inset-0 z-[110] flex items-center justify-center p-4"
            style={{ backgroundColor: "rgba(0, 0, 0, 0.5)" }}
            onClick={() => setPreviewTable(null)}
          >
            <div
              className="w-full max-w-lg rounded-lg bg-white shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b px-4 py-3">
                <h3 className="font-semibold text-gray-900">GRANT SQL Preview</h3>
                <button
                  onClick={() => setPreviewTable(null)}
                  className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-600"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="p-4">
                <p className="mb-3 text-sm text-gray-600">
                  Run this SQL in a Databricks notebook or SQL editor with admin privileges:
                </p>
                <pre className="rounded-lg bg-gray-900 p-4 text-sm text-green-400 font-mono overflow-x-auto">
                  {getGrantSQL(previewTable, data.user.email)}
                </pre>
              </div>
              <div className="flex justify-end gap-2 border-t px-4 py-3">
                <button
                  onClick={() => setPreviewTable(null)}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Close
                </button>
                <button
                  onClick={() => {
                    copyGrantSQL(previewTable, data.user.email);
                    setPreviewTable(null);
                  }}
                  className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white"
                  style={{ backgroundColor: "#1B3139" }}
                >
                  <Copy className="h-4 w-4" />
                  Copy to Clipboard
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Disclaimer */}
        <div className="border-t border-gray-200 bg-gray-50 px-6 py-4">
          <p className="text-xs text-gray-500 leading-relaxed">
            <span className="font-medium text-gray-600">Important Disclaimer:</span> This application is provided as a
            reference implementation and is not official production software from Databricks. It is not covered
            by Databricks support SLAs. If you encounter issues or have questions, your Solutions Architect (SA)
            and account team are available to assist. We encourage you to customize and tune this application
            to meet your organization's specific requirements. Databricks customers using this reference architecture
            should treat their deployment and use like OSS software.
          </p>
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 border-t border-gray-200 px-6 py-4">
          {/* Acknowledgment checkbox (required) */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span className="text-sm text-gray-700 font-semibold">
              I acknowledge the disclaimer above.
            </span>
          </label>

          {/* Don't show again checkbox */}
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => setDontShowAgain(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
            />
            <span className="text-sm text-gray-700 font-semibold">Don't show this permission box again.</span>
          </label>

          {/* Actions row */}
          <div className="flex items-center justify-between">
            <a
              href={data.help_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
            >
              <ExternalLink className="h-4 w-4" />
              System Tables Documentation
            </a>
            <div className="flex gap-3">
              {!data.summary.all_required_granted && (
                <button
                  onClick={handleRecheck}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Recheck Permissions
                </button>
              )}
              <button
                onClick={handleDismiss}
                disabled={!acknowledged}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
                  !acknowledged ? "opacity-50 cursor-not-allowed" : ""
                }`}
                style={{ backgroundColor: !acknowledged ? "#9ca3af" : (data.summary.all_required_granted ? "#10b981" : "#FF3621") }}
                onMouseEnter={(e) => {
                  if (acknowledged) {
                    e.currentTarget.style.backgroundColor = data.summary.all_required_granted ? "#059669" : "#E02F1C";
                  }
                }}
                onMouseLeave={(e) => {
                  if (acknowledged) {
                    e.currentTarget.style.backgroundColor = data.summary.all_required_granted ? "#10b981" : "#FF3621";
                  }
                }}
              >
                {data.summary.all_required_granted ? "Continue to Dashboard" : "Continue Anyway"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
