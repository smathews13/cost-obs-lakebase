import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import type { ContractBurndownResponse, ContractTerms } from "@/types/billing";

const DB_RED = "#FF3621";

function fmt(n: number | null | undefined, decimals = 0): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtUSD(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

interface KPICardProps {
  label: string;
  value: string;
  sub?: string;
  highlight?: "green" | "red" | "amber" | null;
}
function KPICard({ label, value, sub, highlight }: KPICardProps) {
  const color = highlight === "green" ? "text-green-600" : highlight === "red" ? "text-red-600" : highlight === "amber" ? "text-amber-600" : "text-gray-900";
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 flex flex-col gap-1">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

export function ContractBurndown() {
  const rqClient = useQueryClient();
  const [form, setForm] = useState<Partial<ContractTerms>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const { data: contractSettings, isLoading: settingsLoading } = useQuery<ContractTerms | null>({
    queryKey: ["contract-settings"],
    queryFn: () => fetch("/api/settings/contract").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });

  const { data: burndown, isLoading: burndownLoading } = useQuery<ContractBurndownResponse | null>({
    queryKey: ["contract-burndown"],
    queryFn: () => fetch("/api/billing/contract-burndown").then(r => r.json()).catch(() => null),
    staleTime: 5 * 60 * 1000,
    enabled: !!(contractSettings?.start_date),
  });

  const handleEdit = () => {
    setForm({
      start_date: contractSettings?.start_date ?? "",
      end_date: contractSettings?.end_date ?? "",
      total_commit_usd: contractSettings?.total_commit_usd ?? undefined,
      notes: contractSettings?.notes ?? "",
    });
    setEditing(true);
    setSaveError(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/settings/contract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSaveError(err.detail || "Failed to save contract settings");
        return;
      }
      await rqClient.invalidateQueries({ queryKey: ["contract-settings"] });
      await rqClient.invalidateQueries({ queryKey: ["contract-burndown"] });
      setEditing(false);
    } catch (e) {
      setSaveError("Network error saving contract settings");
    } finally {
      setSaving(false);
    }
  };

  const configured = burndown?.configured === true;
  const kpis = burndown?.kpis;
  const series = burndown?.daily_series ?? [];

  const paceLabel = kpis?.pace_status === "under" ? "UNDER PACE" : kpis?.pace_status === "over" ? "OVER PACE" : "ON PACE";
  const paceColor = kpis?.pace_status === "under" ? "bg-amber-50 text-amber-700 border-amber-200" : kpis?.pace_status === "over" ? "bg-red-50 text-red-700 border-red-200" : "bg-green-50 text-green-700 border-green-200";

  // projected_end_date = when the commit is exhausted at current burn rate.
  // If that date is BEFORE the contract end, spend will run out early — that's the risk case.
  const projectedEarlyExhaustion = kpis?.projected_end_date && burndown?.contract?.end_date
    ? kpis.projected_end_date < burndown.contract.end_date
    : false;

  // Chart data: downsample to ~200 points for performance
  const chartData = (() => {
    if (!series.length) return [];
    const step = Math.max(1, Math.floor(series.length / 200));
    const sampled = series.filter((_, i) => i % step === 0 || i === series.length - 1);
    // Add projected line: from today's actual to projected end
    const today = new Date().toISOString().slice(0, 10);
    const todayPoint = series.find(p => p.date === today);
    const projEnd = kpis?.projected_end_date;
    return sampled.map(p => ({
      ...p,
      projected_cumulative:
        projEnd && todayPoint && p.date >= today
          ? (() => {
              const totalDays = (new Date(projEnd).getTime() - new Date(today).getTime()) / 86400000;
              const daysFromToday = (new Date(p.date).getTime() - new Date(today).getTime()) / 86400000;
              const slope = ((burndown?.contract?.total_commit_usd ?? 0) - (todayPoint.actual_cumulative ?? 0)) / totalDays;
              return Math.min(round2((todayPoint.actual_cumulative ?? 0) + slope * daysFromToday), burndown?.contract?.total_commit_usd ?? Infinity);
            })()
          : null,
    }));
  })();

  function round2(n: number) { return Math.round(n * 100) / 100; }

  const yMax = burndown?.contract?.total_commit_usd
    ? Math.ceil(burndown.contract.total_commit_usd * 1.05 / 100000) * 100000
    : undefined;

  return (
    <div className="space-y-6 p-6">
      {/* Contract Form */}
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Contract Terms</h2>
            <p className="mt-0.5 text-xs text-gray-500">Enter your Databricks contract commit to enable burn-down tracking.</p>
          </div>
          {!editing && contractSettings?.start_date && (
            <button onClick={handleEdit} className="rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
              Edit
            </button>
          )}
        </div>

        {(editing || !contractSettings?.start_date) && !settingsLoading ? (
          <div className="p-5 space-y-4">
            {saveError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{saveError}</div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Contract Start Date</label>
                <input
                  type="date"
                  value={form.start_date ?? ""}
                  onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Contract End Date</label>
                <input
                  type="date"
                  value={form.end_date ?? ""}
                  onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Total Committed Spend (USD)</label>
                <input
                  type="number"
                  min={0}
                  value={form.total_commit_usd ?? ""}
                  onChange={e => setForm(f => ({ ...f, total_commit_usd: parseFloat(e.target.value) || undefined }))}
                  placeholder="e.g. 500000"
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={form.notes ?? ""}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  placeholder="e.g. FY2025 Enterprise Agreement"
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-md bg-[#FF3621] px-4 py-1.5 text-sm font-medium text-white hover:bg-[#e02d1a] disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save Contract"}
              </button>
              {editing && (
                <button onClick={() => setEditing(false)} className="rounded-md border border-gray-200 px-4 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50">
                  Cancel
                </button>
              )}
            </div>
          </div>
        ) : contractSettings?.start_date && !editing ? (
          <div className="px-5 py-4 grid grid-cols-2 gap-3 text-sm">
            <div className="flex justify-between"><span className="text-gray-500">Start</span><span className="font-medium">{contractSettings.start_date}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">End</span><span className="font-medium">{contractSettings.end_date}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Committed</span><span className="font-medium">{fmtUSD(contractSettings.total_commit_usd)}</span></div>
            {contractSettings.notes && <div className="flex justify-between col-span-2"><span className="text-gray-500">Notes</span><span className="font-medium">{contractSettings.notes}</span></div>}
          </div>
        ) : null}
      </div>

      {/* Empty state */}
      {!contractSettings?.start_date && !settingsLoading && !editing && (
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 py-12 text-center">
          <p className="text-sm text-gray-500">No contract configured. Fill in the form above to start tracking.</p>
        </div>
      )}

      {/* Burn-down content */}
      {configured && kpis && (
        <>
          {/* Pace badge */}
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold tracking-wide ${paceColor}`}>
              {paceLabel}
            </span>
            <span className="text-xs text-gray-500">
              {kpis.pace_status === "under" ? "Spending slower than the ideal straight-line pace — full commit may not be utilized by contract end." : kpis.pace_status === "over" ? "Spending faster than the ideal straight-line pace — commit may be exhausted before contract end." : "Spending on track with the ideal straight-line pace."}
            </span>
          </div>

          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <KPICard label="Total Committed" value={fmtUSD(kpis.total_commit_usd)} />
            <KPICard label="Spent to Date" value={fmtUSD(kpis.spent_to_date)} />
            <KPICard label="Remaining" value={fmtUSD(kpis.remaining)} highlight={kpis.remaining < 0 ? "red" : null} />
            <KPICard label="Days Elapsed" value={fmt(kpis.days_elapsed)} sub="of contract" />
            <KPICard label="Days Remaining" value={fmt(kpis.days_remaining)} />
            <KPICard
              label="Commit Exhausted"
              value={kpis.projected_end_date}
              highlight={projectedEarlyExhaustion ? "red" : "green"}
              sub={projectedEarlyExhaustion ? "Commit exhausted before contract end" : "Commit lasts through contract end"}
            />
          </div>

          {/* Burn chart */}
          {chartData.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <h3 className="mb-4 text-sm font-semibold text-gray-900">Cumulative Spend vs. Ideal Pace</h3>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={chartData} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    tickFormatter={d => d.slice(5)}
                    interval={Math.max(1, Math.floor(chartData.length / 8))}
                  />
                  <YAxis
                    tickFormatter={v => fmtUSD(v)}
                    tick={{ fontSize: 11 }}
                    domain={[0, yMax ?? "auto"]}
                    width={70}
                  />
                  <Tooltip
                    formatter={(value, name) => [value != null ? fmtUSD(value as number) : "—", name as string]}
                    labelFormatter={l => `Date: ${l}`}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {burndown?.contract?.total_commit_usd && (
                    <ReferenceLine
                      y={burndown.contract.total_commit_usd}
                      stroke="#9ca3af"
                      strokeDasharray="4 4"
                      label={{ value: "Commit", position: "right", fontSize: 11, fill: "#9ca3af" }}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="ideal_cumulative"
                    name="Ideal Pace"
                    stroke="#9ca3af"
                    strokeDasharray="6 3"
                    dot={false}
                    strokeWidth={1.5}
                    connectNulls
                  />
                  <Line
                    type="stepAfter"
                    dataKey="actual_cumulative"
                    name="Actual Spend"
                    stroke={DB_RED}
                    dot={false}
                    strokeWidth={2}
                    connectNulls={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="projected_cumulative"
                    name="Projected"
                    stroke="#f59e0b"
                    strokeDasharray="5 3"
                    dot={false}
                    strokeWidth={1.5}
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}

      {burndownLoading && contractSettings?.start_date && (
        <div className="text-center py-12 text-sm text-gray-500">Loading burn-down data…</div>
      )}
    </div>
  );
}
