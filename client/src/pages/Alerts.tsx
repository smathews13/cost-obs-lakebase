import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { format, parseISO, subDays } from "date-fns";
import { Bell, TrendingUp, TrendingDown, AlertTriangle, Settings, Trash2, X, Calendar, Plus } from "lucide-react";
import { formatCurrency, workspaceUrl } from "@/utils/formatters";
import { useReportConfig } from "@/hooks/useBillingData";

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

// ── Add Weekly Report Modal ───────────────────────────────────────────────────

function AddReportModal({ onClose, onSave }: { onClose: () => void; onSave: (d: { email: string; name: string; send_day: string }) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [day, setDay] = useState("monday");

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Add Weekly Report Recipient</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Email *</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
              placeholder="user@company.com" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Display name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
              placeholder="Jane Smith" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Send on</label>
            <select value={day} onChange={e => setDay(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]">
              {["monday","tuesday","wednesday","thursday","friday","saturday","sunday"].map(d => (
                <option key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
          <button onClick={() => { if (email) { onSave({ email, name, send_day: day }); onClose(); } }}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: '#FF3621' }} disabled={!email}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ── Add User Alert Modal ──────────────────────────────────────────────────────

function AddUserAlertModal({ onClose, onSave }: { onClose: () => void; onSave: (d: { email: string; name: string; threshold_amount: number | null; spike_percent: number | null }) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [threshold, setThreshold] = useState("");
  const [spike, setSpike] = useState("");

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Add User Spend Alert</h3>
        <p className="text-xs text-gray-500 mb-4">Send an email when a user's spend exceeds a threshold or spikes unexpectedly.</p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">User email *</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
              placeholder="user@company.com" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Alert recipient name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
              placeholder="Jane Smith" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Spend threshold ($) — alert when period spend exceeds this</label>
            <input type="number" value={threshold} onChange={e => setThreshold(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
              placeholder="e.g. 5000" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Spike % — alert when daily spend increases by this %</label>
            <input type="number" value={spike} onChange={e => setSpike(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
              placeholder="e.g. 50" />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
          <button
            onClick={() => {
              if (email) {
                onSave({ email, name, threshold_amount: threshold ? parseFloat(threshold) : null, spike_percent: spike ? parseFloat(spike) : null });
                onClose();
              }
            }}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: '#FF3621' }} disabled={!email}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

interface Alert {
  usage_date: string;
  daily_spend: number;
  prev_day_spend?: number;
  change_amount?: number;
  change_percent?: number;
  threshold?: number;
  excess_amount?: number;
  alert_type: "spike" | "threshold";
  severity: "high" | "medium";
}

interface RecentAlertsResponse {
  spikes: Alert[];
  total_alerts: number;
  date_range: {
    start: string;
    end: string;
  };
}

interface DatabricksAlert {
  id: string;
  name: string;
  query_id: string;
  parent: string;
  state: string;
}

interface DatabricksAlertsResponse {
  alerts: DatabricksAlert[];
  count: number;
  databricks_host?: string;
}

interface SetupAlertsResponse {
  created: string[];
  skipped: string[];
  errors: Array<{ alert?: string; error?: string }>;
}

interface SkuDetail { sku_name: string; dbus: number; spend: number }
interface ClusterDetail { cluster_id: string; dbus: number; spend: number }
interface WorkspaceDetail { workspace_id: string; dbus: number; spend: number }

interface AlertDetailsResponse {
  usage_date: string;
  skus: SkuDetail[];
  clusters: ClusterDetail[];
  workspaces: WorkspaceDetail[];
  prev_usage_date?: string;
  prev_skus?: SkuDetail[];
  prev_clusters?: ClusterDetail[];
  prev_workspaces?: WorkspaceDetail[];
}

// Alert Detail Modal Component
function AlertDetailModal({
  alert,
  isOpen,
  onClose,
}: {
  alert: Alert | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  // Compute previous date for comparison (day before the alert date)
  const prevDate = alert?.usage_date
    ? format(subDays(parseISO(alert.usage_date), 1), "yyyy-MM-dd")
    : null;

  const { data: details, isLoading } = useQuery<AlertDetailsResponse>({
    queryKey: ["alert-details", alert?.usage_date, prevDate],
    queryFn: async () => {
      const params = prevDate ? `?prev_usage_date=${prevDate}` : "";
      const response = await fetch(`/api/alerts/details/${alert?.usage_date}${params}`);
      if (!response.ok) throw new Error("Failed to fetch alert details");
      return response.json();
    },
    enabled: isOpen && !!alert?.usage_date,
  });

  // Handle escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen || !alert) return null;

  const isSpike = alert.alert_type === "spike";
  const isIncrease = isSpike && (alert.change_amount || 0) > 0;

  return createPortal(
    <div
      className="animate-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex min-h-full items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="animate-dialog relative w-full max-w-3xl rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-6 py-4 rounded-t-xl">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">
              {isSpike ? (isIncrease ? "Spend Spike Details" : "Spend Reduction Details") : "Threshold Breach Details"}
            </h2>
            <p className="text-sm text-gray-500">
              {format(parseISO(alert.usage_date), "MMMM d, yyyy")}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Summary Stats */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-xs font-medium uppercase text-gray-500">Daily Spend</p>
              <p className="mt-1 text-lg font-semibold text-gray-900">
                {formatCurrency(alert.daily_spend)}
              </p>
            </div>
            {isSpike && (
              <>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase text-gray-500">Previous Day</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">
                    {formatCurrency(alert.prev_day_spend || 0)}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase text-gray-500">Change</p>
                  <p className={`mt-1 text-lg font-semibold ${isIncrease ? "text-red-600" : "text-green-600"}`}>
                    {isIncrease ? "+" : ""}{formatCurrency(alert.change_amount || 0)}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase text-gray-500">% Change</p>
                  <p className={`mt-1 text-lg font-semibold ${isIncrease ? "text-red-600" : "text-green-600"}`}>
                    {isIncrease ? "+" : ""}{alert.change_percent?.toFixed(1)}%
                  </p>
                </div>
              </>
            )}
            {!isSpike && (
              <>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase text-gray-500">Threshold</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">
                    {formatCurrency(alert.threshold || 0)}
                  </p>
                </div>
                <div className="rounded-lg border border-red-200 bg-red-50 p-4">
                  <p className="text-xs font-medium uppercase text-red-600">Excess</p>
                  <p className="mt-1 text-lg font-semibold text-red-600">
                    {formatCurrency(alert.excess_amount || 0)}
                  </p>
                </div>
              </>
            )}
          </div>

          {isLoading ? (
            <div className="flex h-48 items-center justify-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200" style={{ borderTopColor: '#FF3621' }} />
            </div>
          ) : details ? (
            <>
              {/* SKU Breakdown */}
              <div>
                <h3 className="mb-3 text-lg font-semibold text-gray-900">Top SKUs</h3>
                <div className="overflow-hidden rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">SKU</th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Spend</th>
                        {details.prev_skus && (
                          <>
                            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Prev Day</th>
                            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Change</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {details.skus.length > 0 ? (
                        details.skus.map((sku, idx) => {
                          const prev = details.prev_skus?.find(p => p.sku_name === sku.sku_name);
                          const delta = prev ? sku.spend - prev.spend : null;
                          return (
                            <tr key={idx}>
                              <td className="px-4 py-3 text-sm text-gray-900">{sku.sku_name}</td>
                              <td className="px-4 py-3 text-right text-sm font-medium text-gray-900">{formatCurrency(sku.spend)}</td>
                              {details.prev_skus && (
                                <>
                                  <td className="px-4 py-3 text-right text-sm text-gray-500">
                                    {prev ? formatCurrency(prev.spend) : "--"}
                                  </td>
                                  <td className={`px-4 py-3 text-right text-sm font-medium ${delta !== null ? (delta > 0 ? "text-red-600" : delta < 0 ? "text-green-600" : "text-gray-500") : "text-gray-500"}`}>
                                    {delta !== null ? `${delta > 0 ? "+" : ""}${formatCurrency(delta)}` : "new"}
                                  </td>
                                </>
                              )}
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={details.prev_skus ? 4 : 2} className="px-4 py-3 text-sm text-gray-500 text-center">No SKU data available</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Cluster Breakdown */}
              <div>
                <h3 className="mb-3 text-lg font-semibold text-gray-900">Top Clusters</h3>
                <div className="overflow-hidden rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Cluster ID</th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Spend</th>
                        {details.prev_clusters && (
                          <>
                            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Prev Day</th>
                            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Change</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {details.clusters.length > 0 ? (
                        details.clusters.map((cluster, idx) => {
                          const prev = details.prev_clusters?.find(p => p.cluster_id === cluster.cluster_id);
                          const delta = prev ? cluster.spend - prev.spend : null;
                          return (
                            <tr key={idx}>
                              <td className="px-4 py-3 text-sm font-mono text-gray-900">{cluster.cluster_id}</td>
                              <td className="px-4 py-3 text-right text-sm font-medium text-gray-900">{formatCurrency(cluster.spend)}</td>
                              {details.prev_clusters && (
                                <>
                                  <td className="px-4 py-3 text-right text-sm text-gray-500">
                                    {prev ? formatCurrency(prev.spend) : "--"}
                                  </td>
                                  <td className={`px-4 py-3 text-right text-sm font-medium ${delta !== null ? (delta > 0 ? "text-red-600" : delta < 0 ? "text-green-600" : "text-gray-500") : "text-gray-500"}`}>
                                    {delta !== null ? `${delta > 0 ? "+" : ""}${formatCurrency(delta)}` : "new"}
                                  </td>
                                </>
                              )}
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={details.prev_clusters ? 4 : 2} className="px-4 py-3 text-sm text-gray-500 text-center">No cluster data available</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Workspace Breakdown */}
              <div>
                <h3 className="mb-3 text-lg font-semibold text-gray-900">Top Workspaces</h3>
                <div className="overflow-hidden rounded-lg border border-gray-200">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Workspace ID</th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Spend</th>
                        {details.prev_workspaces && (
                          <>
                            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Prev Day</th>
                            <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">Change</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {details.workspaces.length > 0 ? (
                        details.workspaces.map((ws, idx) => {
                          const prev = details.prev_workspaces?.find(p => p.workspace_id === ws.workspace_id);
                          const delta = prev ? ws.spend - prev.spend : null;
                          return (
                            <tr key={idx}>
                              <td className="px-4 py-3 text-sm font-mono text-gray-900">{ws.workspace_id}</td>
                              <td className="px-4 py-3 text-right text-sm font-medium text-gray-900">{formatCurrency(ws.spend)}</td>
                              {details.prev_workspaces && (
                                <>
                                  <td className="px-4 py-3 text-right text-sm text-gray-500">
                                    {prev ? formatCurrency(prev.spend) : "--"}
                                  </td>
                                  <td className={`px-4 py-3 text-right text-sm font-medium ${delta !== null ? (delta > 0 ? "text-red-600" : delta < 0 ? "text-green-600" : "text-gray-500") : "text-gray-500"}`}>
                                    {delta !== null ? `${delta > 0 ? "+" : ""}${formatCurrency(delta)}` : "new"}
                                  </td>
                                </>
                              )}
                            </tr>
                          );
                        })
                      ) : (
                        <tr>
                          <td colSpan={details.prev_workspaces ? 4 : 2} className="px-4 py-3 text-sm text-gray-500 text-center">No workspace data available</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="flex h-48 items-center justify-center text-gray-500">
              Failed to load details
            </div>
          )}
        </div>
      </div>
      </div>
    </div>,
    document.body
  );
}

// Create Alert Modal Component
function CreateAlertModal({
  isOpen,
  onClose,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [alertName, setAlertName] = useState("");
  const [alertType, setAlertType] = useState<"threshold" | "spike">("threshold");
  const [thresholdAmount, setThresholdAmount] = useState("");
  const [spikePercent, setSpikePercent] = useState("20");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, handleKeyDown]);

  const handleSubmit = async () => {
    if (!alertName.trim()) {
      setError("Please enter an alert name");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/alerts/create-custom-alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: alertName,
          alert_type: alertType,
          threshold_amount: alertType === "threshold" ? parseFloat(thresholdAmount) : undefined,
          spike_percent: alertType === "spike" ? parseFloat(spikePercent) : undefined,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || "Failed to create alert");
      }

      onSuccess();
      onClose();
      setAlertName("");
      setThresholdAmount("");
      setSpikePercent("20");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create alert");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) return null;

  return createPortal(
    <div
      className="animate-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex min-h-full items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="animate-dialog relative w-full max-w-md rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-xl font-semibold text-gray-900">Create New Alert</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Alert Name
            </label>
            <input
              type="text"
              value={alertName}
              onChange={(e) => setAlertName(e.target.value)}
              placeholder="e.g., Daily spend threshold alert"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Alert Type
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="alertType"
                  checked={alertType === "threshold"}
                  onChange={() => setAlertType("threshold")}
                  className="text-orange-600 focus:ring-orange-500"
                />
                <span className="text-sm text-gray-700">Spend Threshold</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="alertType"
                  checked={alertType === "spike"}
                  onChange={() => setAlertType("spike")}
                  className="text-orange-600 focus:ring-orange-500"
                />
                <span className="text-sm text-gray-700">Spend Spike</span>
              </label>
            </div>
          </div>

          {alertType === "threshold" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Daily Threshold Amount ($)
              </label>
              <input
                type="number"
                value={thresholdAmount}
                onChange={(e) => setThresholdAmount(e.target.value)}
                placeholder="e.g., 1000"
                min="0"
                step="100"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                Alert when daily spend exceeds this amount
              </p>
            </div>
          )}

          {alertType === "spike" && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Spike Percentage (%)
              </label>
              <input
                type="number"
                value={spikePercent}
                onChange={(e) => setSpikePercent(e.target.value)}
                placeholder="e.g., 20"
                min="0"
                max="100"
                step="5"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
              <p className="mt-1 text-xs text-gray-500">
                Alert when daily spend changes by this percentage
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 border-t border-gray-200 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
            style={{ backgroundColor: '#FF3621' }}
          >
            {isSubmitting ? "Creating..." : "Create Alert"}
          </button>
        </div>
      </div>
      </div>
    </div>,
    document.body
  );
}

function AlertCard({ alert, onClick }: { alert: Alert; onClick?: () => void }) {
  const isSpike = alert.alert_type === "spike";
  const isIncrease = isSpike && (alert.change_amount || 0) > 0;

  return (
    <div
      className={`rounded-lg border p-4 transition-all ${
        alert.severity === "high"
          ? "border-red-200 bg-red-50"
          : "border-amber-200 bg-amber-50"
      } ${onClick ? "cursor-pointer hover:shadow-sm hover:scale-[1.01]" : ""}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div
            className={`mt-1 rounded-full p-2 ${
              alert.severity === "high"
                ? "bg-red-100"
                : "bg-yellow-100"
            }`}
          >
            {isSpike ? (
              isIncrease ? (
                <TrendingUp className="h-5 w-5 text-red-600" />
              ) : (
                <TrendingDown className="h-5 w-5 text-green-600" />
              )
            ) : (
              <AlertTriangle className="h-5 w-5 text-red-600" />
            )}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-gray-900">
                {isSpike ? (isIncrease ? "Spend Spike" : "Spend Reduction") : "Threshold Breach"}
              </h3>
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium uppercase ${
                  alert.severity === "high"
                    ? "bg-red-100 text-red-800"
                    : "bg-yellow-100 text-yellow-800"
                }`}
              >
                {alert.severity}
              </span>
            </div>
            <p className="mt-1 text-sm text-gray-600">
              {format(parseISO(alert.usage_date), "MMMM d, yyyy")}
            </p>
            {isSpike && (
              <div className="mt-2 space-y-1">
                <p className="text-sm">
                  <span className="text-gray-600">Daily spend:</span>{" "}
                  <span className="font-medium text-gray-900">
                    {formatCurrency(alert.daily_spend)}
                  </span>
                </p>
                <p className="text-sm">
                  <span className="text-gray-600">Previous day:</span>{" "}
                  <span className="font-medium text-gray-900">
                    {formatCurrency(alert.prev_day_spend || 0)}
                  </span>
                </p>
                <p className="text-sm">
                  <span className="text-gray-600">Change:</span>{" "}
                  <span
                    className={`font-medium ${
                      isIncrease ? "text-red-600" : "text-green-600"
                    }`}
                  >
                    {isIncrease ? "+" : ""}
                    {formatCurrency(Math.abs(alert.change_amount || 0))} (
                    {isIncrease ? "+" : ""}
                    {alert.change_percent?.toFixed(1)}%)
                  </span>
                </p>
              </div>
            )}
            {!isSpike && (
              <div className="mt-2 space-y-1">
                <p className="text-sm">
                  <span className="text-gray-600">Daily spend:</span>{" "}
                  <span className="font-medium text-gray-900">
                    {formatCurrency(alert.daily_spend)}
                  </span>
                </p>
                <p className="text-sm">
                  <span className="text-gray-600">Threshold:</span>{" "}
                  <span className="font-medium text-gray-900">
                    {formatCurrency(alert.threshold || 0)}
                  </span>
                </p>
                <p className="text-sm">
                  <span className="text-gray-600">Excess:</span>{" "}
                  <span className="font-medium text-red-600">
                    {formatCurrency(alert.excess_amount || 0)}
                  </span>
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Default alert names that are created by the setup
const DEFAULT_ALERT_NAMES = [
  "Cost Observability - Daily Spend Spike",
  "Cost Observability - Daily Spend Threshold",
  "Cost Observability - High Workspace Spend",
];

export default function Alerts() {
  const [daysBack, setDaysBack] = useState(30);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showUserAlertModal, setShowUserAlertModal] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(true);
  const [sendingTest, setSendingTest] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ email: string; success: boolean } | null>(null);
  const queryClient = useQueryClient();
  const databricksAlertsRef = useRef<HTMLDivElement>(null);

  const { data: reportConfig, isLoading: configLoading } = useReportConfig();

  const addWeeklyReport = useMutation({
    mutationFn: (d: { email: string; name: string; send_day: string }) =>
      fetch("/api/users-groups/report-config/weekly-report", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d),
      }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users-groups", "report-config"] }),
  });

  const deleteWeeklyReport = useMutation({
    mutationFn: (email: string) =>
      fetch(`/api/users-groups/report-config/weekly-report/${encodeURIComponent(email)}`, { method: "DELETE" }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users-groups", "report-config"] }),
  });

  const addUserAlert = useMutation({
    mutationFn: (d: { email: string; name: string; threshold_amount: number | null; spike_percent: number | null }) =>
      fetch("/api/users-groups/report-config/user-alert", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d),
      }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users-groups", "report-config"] }),
  });

  const deleteUserAlert = useMutation({
    mutationFn: (email: string) =>
      fetch(`/api/users-groups/report-config/user-alert/${encodeURIComponent(email)}`, { method: "DELETE" }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users-groups", "report-config"] }),
  });

  async function sendTestReport(email: string, startDate: string, endDate: string) {
    setSendingTest(email);
    setTestResult(null);
    try {
      const res = await fetch(`/api/users-groups/send-test-report?email=${encodeURIComponent(email)}&start_date=${startDate}&end_date=${endDate}`, { method: "POST" });
      const json = await res.json();
      setTestResult({ email, success: json.success });
    } catch {
      setTestResult({ email, success: false });
    } finally {
      setSendingTest(null);
    }
  }

  const { data, isLoading, isError: alertsError } = useQuery<RecentAlertsResponse>({
    queryKey: ["alerts", "recent", daysBack],
    queryFn: async () => {
      const response = await fetch(`/api/alerts/recent?days_back=${daysBack}`);
      if (!response.ok) return { spikes: [], total_alerts: 0, date_range: { start: "", end: "" } };
      return response.json();
    },
    retry: false,
  });

  const { data: databricksAlerts, isLoading: databricksLoading, isError: dbAlertsError } = useQuery<DatabricksAlertsResponse>({
    queryKey: ["alerts", "databricks"],
    queryFn: async () => {
      const response = await fetch("/api/alerts/databricks-alerts");
      if (!response.ok) return { alerts: [], total: 0 };
      return response.json();
    },
    retry: false,
  });

  const setupAlertsMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/alerts/setup-databricks-alerts", {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Failed to setup alerts");
      }
      return response.json() as Promise<SetupAlertsResponse>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts", "databricks"] });
    },
  });

  const deleteAlertMutation = useMutation({
    mutationFn: async (alertId: string) => {
      const response = await fetch(`/api/alerts/databricks-alerts/${alertId}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Failed to delete alert");
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts", "databricks"] });
      setDeleteConfirmId(null);
      setDeleteError(null);
    },
    onError: (err: Error) => {
      setDeleteError(err.message);
      setDeleteConfirmId(null);
    },
  });

  // Check if all default alerts are configured
  const configuredAlertNames = databricksAlerts?.alerts.map(a => a.name) || [];
  const allDefaultAlertsConfigured = DEFAULT_ALERT_NAMES.every(name =>
    configuredAlertNames.includes(name)
  );

  if (isLoading || databricksLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
        <p className="text-sm text-gray-500">Loading alerts...</p>
      </div>
    );
  }

  if (alertsError && dbAlertsError) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg bg-white border p-8" style={{ borderColor: '#E5E5E5' }}>
        <AlertTriangle className="h-10 w-10 text-gray-500" />
        <p className="text-base font-medium text-gray-700">Alerts data unavailable</p>
        <p className="text-sm text-gray-500 text-center max-w-md">
          Could not load alert data. This may happen if the system tables are not accessible or the workspace is not configured yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
            <Bell className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Alerts</h1>
            <p className="text-sm text-gray-600">
              Proactive cost anomaly detection and notifications
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="btn-brand inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Alert
        </button>
      </div>

      {/* Summary stats - moved above Databricks SQL Alerts */}
      {data && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <div className="flex items-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
                <AlertTriangle className="h-6 w-6 text-orange-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Recent Anomalies</p>
                <p className="text-2xl font-semibold text-gray-900">{data.total_alerts}</p>
              </div>
            </div>
          </div>
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <div className="flex items-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
                <Calendar className="h-6 w-6 text-orange-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Date Range</p>
                <p className="text-2xl font-semibold text-gray-900">
                  {data?.date_range?.start ? format(parseISO(data.date_range.start), "MMM d") : "—"} - {data?.date_range?.end ? format(parseISO(data.date_range.end), "MMM d") : "—"}
                </p>
              </div>
            </div>
          </div>
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <div className="flex items-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
                <Bell className="h-6 w-6 text-orange-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-500">Databricks Alerts</p>
                <p className="text-2xl font-semibold text-gray-900">{databricksAlerts?.count || 0} configured</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Databricks SQL Alerts Section */}
      <div ref={databricksAlertsRef} className="rounded-lg bg-white p-6 shadow">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Databricks SQL Alerts</h2>
            <p className="mt-1 text-sm text-gray-600">
              Native Databricks alerts that run automatically and send notifications
            </p>
          </div>
          <button
            onClick={() => setupAlertsMutation.mutate()}
            disabled={setupAlertsMutation.isPending || allDefaultAlertsConfigured}
            className={`${allDefaultAlertsConfigured ? 'bg-gray-400' : 'btn-brand'} inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <Settings className="h-4 w-4" />
            {setupAlertsMutation.isPending ? "Setting up..." : "Setup Default Alerts"}
          </button>
        </div>

        {setupAlertsMutation.isSuccess && setupAlertsMutation.data && (
          <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4">
            <p className="text-sm font-medium text-green-800">
              Alert Setup Complete
            </p>
            <ul className="mt-2 space-y-1 text-sm text-green-700">
              {setupAlertsMutation.data.created.length > 0 && (
                <li>Created {setupAlertsMutation.data.created.length} new alerts</li>
              )}
              {setupAlertsMutation.data.skipped.length > 0 && (
                <li>Skipped {setupAlertsMutation.data.skipped.length} existing alerts</li>
              )}
            </ul>
          </div>
        )}

        {deleteError && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 flex items-center justify-between">
            <p className="text-sm text-red-700">Failed to delete alert: {deleteError}</p>
            <button onClick={() => setDeleteError(null)} className="text-red-500 hover:text-red-700 text-sm font-medium ml-4">Dismiss</button>
          </div>
        )}

        {databricksLoading ? (
          <div className="mt-4 flex h-32 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
          </div>
        ) : databricksAlerts && databricksAlerts.alerts.length > 0 ? (
          <div className="mt-4 space-y-2">
            {databricksAlerts.alerts.map((alert) => {
              const alertUrl = databricksAlerts.databricks_host
                ? workspaceUrl(databricksAlerts.databricks_host, `/sql/alerts/${alert.id}`)
                : null;
              const isDeleting = deleteAlertMutation.isPending && deleteConfirmId === alert.id;

              return (
                <div
                  key={alert.id}
                  className="flex items-center justify-between rounded-lg border border-gray-200 p-3 transition-colors hover:bg-gray-50 hover:border-gray-300"
                >
                  <div className="flex items-center gap-3">
                    <div className="rounded-full p-2 bg-green-100">
                      <Bell className="h-4 w-4 text-green-600" />
                    </div>
                    <div>
                      <p className="font-medium text-gray-900">{alert.name}</p>
                      <p className="text-xs text-gray-500">
                        Status: {alert.state.replace('AlertState.', '')} • ID: {alert.id}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {deleteConfirmId === alert.id ? (
                      <>
                        <span className="text-sm text-red-600">Delete?</span>
                        <button
                          onClick={() => deleteAlertMutation.mutate(alert.id)}
                          disabled={isDeleting}
                          className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {isDeleting ? "..." : "Yes"}
                        </button>
                        <button
                          onClick={() => setDeleteConfirmId(null)}
                          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                        >
                          No
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => setDeleteConfirmId(alert.id)}
                          className="rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-red-600 transition-colors"
                          title="Delete alert"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                        {alertUrl && (
                          <a
                            href={alertUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                            title="Open in Databricks"
                          >
                            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                          </a>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-lg border-2 border-dashed border-gray-300 p-8 text-center">
            <Settings className="mx-auto h-12 w-12 text-gray-500" />
            <p className="mt-2 text-sm font-medium text-gray-900">
              No Databricks SQL Alerts configured
            </p>
            <p className="mt-1 text-sm text-gray-500">
              Click "Setup Default Alerts" to create default cost monitoring alerts
            </p>
          </div>
        )}
      </div>

      {/* Alerts list */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Cost Alerts in the Last {daysBack} Days</h2>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700">Look back:</span>
            <div className="flex gap-2">
              {[7, 14, 30, 90].map((days) => (
                <button
                  key={days}
                  onClick={() => setDaysBack(days)}
                  className={`rounded px-3 py-1 text-sm font-medium ${
                    daysBack === days
                      ? "text-white"
                      : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                  }`}
                  style={daysBack === days ? { backgroundColor: '#FF3621' } : {}}
                >
                  {days} days
                </button>
              ))}
            </div>
          </div>
        </div>
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
          </div>
        ) : data && data.spikes.length > 0 ? (
          <div className="space-y-3">
            {data.spikes.map((alert, index) => (
              <AlertCard key={index} alert={alert} onClick={() => setSelectedAlert(alert)} />
            ))}
          </div>
        ) : (
          <div className="flex h-64 flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50">
            <Bell className="h-12 w-12 text-gray-500" />
            <p className="mt-2 text-sm font-medium text-gray-900">
              No alerts found
            </p>
            <p className="mt-1 text-sm text-gray-500">
              No cost anomalies detected in the selected time period
            </p>
          </div>
        )}
      </div>

      {/* Reports & Alerts section */}
      <div className="rounded-xl border border-gray-200 bg-white">
        <button
          onClick={() => setReportsOpen(o => !o)}
          className="flex w-full items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors rounded-xl"
        >
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-4 w-4 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Reports & User Alerts</h2>
              <p className="text-xs text-gray-500">Configure weekly spend reports and user-level spend alerts</p>
            </div>
          </div>
          <svg className={`h-5 w-5 text-gray-500 transition-transform ${reportsOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {reportsOpen && (
          <div className="border-t border-gray-100 px-5 pb-5 pt-4 space-y-6">
            {/* Weekly Reports */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-800">Weekly Spend Reports</h3>
                  <p className="text-xs text-gray-500">Send a weekly top-users digest to selected recipients</p>
                </div>
                <button onClick={() => setShowReportModal(true)}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white"
                  style={{ backgroundColor: '#FF3621' }}>
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add recipient
                </button>
              </div>
              {configLoading ? (
                <p className="text-sm text-gray-500">Loading…</p>
              ) : (reportConfig?.weekly_reports ?? []).length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
                  No weekly report recipients configured yet.
                </div>
              ) : (
                <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                  {(reportConfig?.weekly_reports ?? []).map(r => (
                    <div key={r.id} className="flex items-center justify-between px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-orange-100 text-orange-700 text-xs font-semibold">
                          {r.name.charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-800">{r.name}</p>
                          <p className="text-xs text-gray-500">{r.email} · every {r.send_day.charAt(0).toUpperCase() + r.send_day.slice(1)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => sendTestReport(r.email, format(subDays(new Date(), 7), "yyyy-MM-dd"), format(new Date(), "yyyy-MM-dd"))}
                          disabled={sendingTest === r.email}
                          className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                          {sendingTest === r.email ? "Sending…" : "Test send"}
                        </button>
                        {testResult?.email === r.email && (
                          <span className={`text-xs ${testResult.success ? "text-green-600" : "text-red-500"}`}>
                            {testResult.success ? "✓ Sent" : "✗ Failed"}
                          </span>
                        )}
                        <button onClick={() => deleteWeeklyReport.mutate(r.email)}
                          className="rounded-lg p-1 text-gray-500 hover:text-red-500 hover:bg-red-50">
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* User Alerts */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-gray-800">User Spend Alerts</h3>
                  <p className="text-xs text-gray-500">Alert specific users when their spend exceeds a threshold or spikes</p>
                </div>
                <button onClick={() => setShowUserAlertModal(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add alert
                </button>
              </div>
              {configLoading ? (
                <p className="text-sm text-gray-500">Loading…</p>
              ) : (reportConfig?.user_alerts ?? []).length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-500">
                  No user-level alerts configured yet.
                </div>
              ) : (
                <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
                  {(reportConfig?.user_alerts ?? []).map(a => (
                    <div key={a.id} className="flex items-center justify-between px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-red-50 text-red-600 text-xs font-semibold">
                          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                          </svg>
                        </div>
                        <div>
                          <p className="text-sm font-medium text-gray-800">{a.name}</p>
                          <p className="text-xs text-gray-500">
                            {a.email}
                            {a.threshold_amount != null && ` · Threshold: ${fmt(a.threshold_amount)}`}
                            {a.spike_percent != null && ` · Spike: ${a.spike_percent}%`}
                          </p>
                        </div>
                      </div>
                      <button onClick={() => deleteUserAlert.mutate(a.email)}
                        className="rounded-lg p-1 text-gray-500 hover:text-red-500 hover:bg-red-50">
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Alert Detail Modal */}
      <AlertDetailModal
        alert={selectedAlert}
        isOpen={!!selectedAlert}
        onClose={() => setSelectedAlert(null)}
      />

      {/* Create Alert Modal */}
      <CreateAlertModal
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: ["alerts", "databricks"] })}
      />

      {showReportModal && (
        <AddReportModal onClose={() => setShowReportModal(false)} onSave={d => addWeeklyReport.mutate(d)} />
      )}
      {showUserAlertModal && (
        <AddUserAlertModal onClose={() => setShowUserAlertModal(false)} onSave={d => addUserAlert.mutate(d)} />
      )}
    </div>
  );
}
