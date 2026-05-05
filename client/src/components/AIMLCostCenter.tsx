import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import type { AIMLDashboardBundle } from "@/types/billing";
import { KPITrendModal } from "./KPITrendModal";
import { formatIdentity } from "@/utils/identity";

interface AIMLCostCenterProps {
  data: AIMLDashboardBundle | undefined;
  isLoading: boolean;
  startDate?: string;
  endDate?: string;
  host?: string | null;
}

// Stable category-to-color mapping for consistent colors across pie + timeseries
const CATEGORY_COLORS: Record<string, string> = {
  "Serverless Inference": "#06B6D4",
  "Model Training": "#1B5162",
  "Feature Engineering": "#14B8A6",
  "GPU Clusters": "#EF4444",
  "Model Serving": "#EC4899",
  "MLflow": "#06B6D4",
  "OpenAI": "#10B981",
  "Anthropic": "#F59E0B",
  "Gemini": "#6B7280",
  "Vector Search": "#3B82F6",
  "Fine Tuning": "#F97316",
};
const FALLBACK_COLORS = ["#1B5162", "#06B6D4", "#10B981", "#14B8A6", "#F59E0B", "#3B82F6", "#EC4899", "#EF4444", "#6B7280"];
const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

function getEndpointUrl(host: string | null | undefined, endpointName: string | null, workspaceId?: string | null): string | null {
  if (!host || !endpointName) return null;
  const wsParam = workspaceId ? `?o=${workspaceId}` : '';
  return `https://${host}/ml/endpoints/${endpointName}${wsParam}`;
}

function getClusterUrl(host: string | null | undefined, clusterId: string, workspaceId: string | null): string | null {
  if (!host || !clusterId) return null;
  const wsParam = workspaceId ? `?o=${workspaceId}` : '';
  return `https://${host}/compute/interactive${wsParam}`;
}

export function AIMLCostCenter({ data, isLoading, startDate, endDate, host }: AIMLCostCenterProps) {
  const [endpointsPage, setEndpointsPage] = useState(1);
  const [modelsPage, setModelsPage] = useState(1);
  const [selectedAgent, setSelectedAgent] = useState<import("@/types/billing").AIMLAgentBrick | null>(null);
  const [showHistoricalAgents, setShowHistoricalAgents] = useState(false);
  const [agentTypeFilter, setAgentTypeFilter] = useState<string>("all");
  const [agentsPage, setAgentsPage] = useState(1);
  const [mlClustersPage, setMlClustersPage] = useState(1);
  const [showHistoricalMlClusters, setShowHistoricalMlClusters] = useState(false);
  const [mlClusterSearch, setMlClusterSearch] = useState("");
  const [mlRuntimeFilter, setMlRuntimeFilter] = useState<string | null>(null);
  const [mlRuntimeFilterOpen, setMlRuntimeFilterOpen] = useState(false);
  const mlRuntimeFilterRef = useRef<HTMLDivElement>(null);
  const [agentSearch, setAgentSearch] = useState("");
  const PAGE_SIZE = 10;

  // Info box minimize state with localStorage persistence
  const MINIMIZE_KEY = "cost-obs-minimize-aiml-info";
  const [infoMinimized, setInfoMinimized] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(MINIMIZE_KEY) === "true";
    }
    return false;
  });

  const [selectedKPI, setSelectedKPI] = useState<{kpi: string; label: string} | null>(null);

  // Close runtime filter dropdown on outside click
  useEffect(() => {
    if (!mlRuntimeFilterOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (mlRuntimeFilterRef.current && !mlRuntimeFilterRef.current.contains(e.target as Node)) {
        setMlRuntimeFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [mlRuntimeFilterOpen]);

  // Pre-warm trend queries so modals open instantly
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!startDate || !endDate) return;
    for (const kpi of ["aiml_spend", "aiml_dbus", "aiml_endpoints"]) {
      queryClient.prefetchQuery({
        queryKey: ["kpi-trend", kpi, startDate, endDate, "daily"],
        queryFn: async () => {
          const params = new URLSearchParams({ kpi, start_date: startDate, end_date: endDate, granularity: "daily" });
          const res = await fetch(`/api/billing/kpi-trend?${params}`);
          if (!res.ok) throw new Error("prefetch failed");
          return res.json();
        },
        staleTime: 5 * 60 * 1000,
      });
    }
  }, [startDate, endDate, queryClient]);

  const handleMinimizeToggle = (checked: boolean) => {
    setInfoMinimized(checked);
    if (checked) {
      localStorage.setItem(MINIMIZE_KEY, "true");
    } else {
      localStorage.removeItem(MINIMIZE_KEY);
    }
  };

  // Build a single stable color map from ALL category names so pie + timeseries match
  const categoryColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    let fallbackIdx = 0;
    const allNames = new Set<string>();
    // Gather from pie categories (strip "FMAPI - " prefix)
    for (const cat of data?.categories?.categories || []) allNames.add(cat.category.replace(/^FMAPI\s*-\s*/, ""));
    // Gather from timeseries categories
    for (const cat of data?.timeseries?.categories || []) allNames.add(cat);
    // Assign colors: known names get their fixed color, others get fallback in stable order
    for (const name of allNames) {
      if (CATEGORY_COLORS[name]) {
        map[name] = CATEGORY_COLORS[name];
      } else {
        map[name] = FALLBACK_COLORS[fallbackIdx % FALLBACK_COLORS.length];
        fallbackIdx++;
      }
    }
    return map;
  }, [data?.categories, data?.timeseries]);

  const pieData = useMemo(() => {
    if (!data?.categories?.categories) return [];
    return data.categories.categories.map((cat) => {
      const name = cat.category.replace(/^FMAPI\s*-\s*/, "");
      return {
        name,
        value: cat.total_spend,
        percentage: cat.percentage,
        fill: categoryColorMap[name] || FALLBACK_COLORS[0],
      };
    });
  }, [data?.categories, categoryColorMap]);

  const endpointsData = useMemo(() => {
    if (!data?.endpoints?.endpoints) return [];
    // Aggregate by endpoint
    const byEndpoint: Record<string, { endpoint_name: string; total_spend: number; total_dbus: number; days_active: number }> = {};
    for (const e of data.endpoints.endpoints) {
      if (!byEndpoint[e.endpoint_name]) {
        byEndpoint[e.endpoint_name] = { endpoint_name: e.endpoint_name, total_spend: 0, total_dbus: 0, days_active: e.days_active };
      }
      byEndpoint[e.endpoint_name].total_spend += e.total_spend;
      byEndpoint[e.endpoint_name].total_dbus += e.total_dbus;
    }
    return Object.values(byEndpoint).sort((a, b) => b.total_spend - a.total_spend);
  }, [data?.endpoints]);

  if (isLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
        <p className="text-sm text-gray-500">Loading AI/ML data...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-6">
        <div className="flex flex-col items-center justify-center gap-2 py-4">
          <p className="text-base font-medium text-yellow-800">No AI/ML cost data available</p>
          <p className="text-sm text-yellow-700">Try expanding the date range, or check that model serving and inference endpoints are active</p>
        </div>
      </div>
    );
  }

  const summary = data.summary;

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI/ML</h1>
          <p className="text-sm text-gray-500">AI and machine learning cost attribution and trends</p>
        </div>
      </div>

      {/* Info Banner */}
      <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
        <div className="flex">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-orange-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3 flex-1">
            <button className="flex w-full items-center justify-between" onClick={() => handleMinimizeToggle(!infoMinimized)}>
              <h3 className="text-sm font-medium text-orange-800">AI/ML Cost Categories</h3>
              <svg className={`h-4 w-4 text-orange-500 transition-transform ${infoMinimized ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {!infoMinimized && (
              <>
                <div className="mt-2 text-sm text-orange-700">
                  <ul className="list-inside list-disc space-y-1">
                    <li><strong>Foundation Models</strong>: Pay-per-token usage via Databricks Model Serving (Anthropic, OpenAI, Gemini, Llama)</li>
                    <li><strong>Serverless Inference</strong>: Custom model/agent endpoints on Databricks managed infrastructure</li>
                    <li><strong>Batch Inference</strong>: Batch inference jobs for large-scale offline predictions</li>
                    <li><strong>Fine-Tuning</strong>: Model fine-tuning runs using Databricks Mosaic AI</li>
                    <li><strong>Vector Search</strong>: Databricks Vector Search index compute costs</li>
                    <li><strong>Model Serving</strong>: Other model serving workloads not captured above</li>
                  </ul>
                </div>
                <div className="mt-3 flex justify-start">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={infoMinimized}
                      onChange={(e) => handleMinimizeToggle(e.target.checked)}
                      className="h-3.5 w-3.5 rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                    />
                    <span className="text-xs text-orange-600">Minimize from now on</span>
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({kpi: "aiml_spend", label: "Total AI/ML Spend"})}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total AI/ML Spend</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(summary.total_spend)}</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({kpi: "aiml_dbus", label: "Total DBUs"})}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total DBUs</p>
              <p className="text-2xl font-semibold text-gray-900">{formatNumber(summary.total_dbus)}</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({kpi: "aiml_endpoints", label: "Active Endpoints"})}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Avg Active Endpoints / Day</p>
              <p className="text-2xl font-semibold text-gray-900">{formatNumber(summary.endpoint_count)}</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({kpi: "aiml_spend", label: "Avg Daily Spend"})}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Avg Daily Spend</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(summary.avg_daily_spend)}</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>
      </div>

      {selectedKPI && startDate && endDate && (
        <KPITrendModal
          kpi={selectedKPI.kpi as any}
          kpiLabel={selectedKPI.label}
          isOpen={!!selectedKPI}
          onClose={() => setSelectedKPI(null)}
          startDate={startDate}
          endDate={endDate}
        />
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Spend Over Time */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">AI/ML Spend Over Time</h3>
          {data.timeseries?.timeseries?.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={data.timeseries.timeseries} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) => new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                />
                <YAxis tickFormatter={(value) => formatCurrency(value)} width={80} />
                <Tooltip
                  formatter={(value) => formatCurrency(value as number)}
                  labelFormatter={(label) => new Date(label).toLocaleDateString()}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {data.timeseries.categories.map((category, idx) => (
                  <Area
                    key={category}
                    type="monotone"
                    dataKey={category}
                    stackId="1"
                    stroke={categoryColorMap[category] || FALLBACK_COLORS[idx % FALLBACK_COLORS.length]}
                    fill={categoryColorMap[category] || FALLBACK_COLORS[idx % FALLBACK_COLORS.length]}
                    fillOpacity={0.6}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-gray-500">No timeseries data</div>
          )}
        </div>

        {/* Category Breakdown Pie Chart */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Cost by Category</h3>
          {pieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {pieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatCurrency(value as number)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-gray-500">No category data</div>
          )}
        </div>
      </div>

      {/* Top Endpoints & Top Models Side-by-Side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Top Endpoints Table */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <div className="mb-4 flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">Top Serverless Endpoints</h3>
            <div className="group relative">
              <svg className="h-4 w-4 text-gray-500 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="absolute left-0 top-6 z-50 hidden w-72 rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-600 shadow-lg group-hover:block">
                <p className="font-medium text-gray-900 mb-1">Serverless Endpoints</p>
                <p>Endpoints deployed via Databricks Model Serving using serverless compute. These are pay-per-request inference endpoints that auto-scale to zero. Costs include both steady-state compute and scale-from-zero launch overhead.</p>
              </div>
            </div>
          </div>
          {endpointsData.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Endpoint
                      </th>
                      <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                        DBUs
                      </th>
                      <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                        Spend
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {endpointsData.slice((endpointsPage - 1) * PAGE_SIZE, endpointsPage * PAGE_SIZE).map((endpoint, idx) => (
                      <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                        <td className="px-3 py-2 text-sm font-medium text-gray-900 truncate max-w-[200px]" title={endpoint.endpoint_name || "UNKNOWN"}>
                          {endpoint.endpoint_name || "UNKNOWN"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right text-sm text-gray-500">
                          {formatNumber(endpoint.total_dbus)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-right text-sm text-gray-900">
                          {formatCurrency(endpoint.total_spend)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {endpointsData.length > PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-between border-t border-gray-200 pt-3">
                  <p className="text-xs text-gray-500">
                    {(endpointsPage - 1) * PAGE_SIZE + 1}–{Math.min(endpointsPage * PAGE_SIZE, endpointsData.length)} of {endpointsData.length}
                  </p>
                  <div className="flex gap-1">
                    <button onClick={() => setEndpointsPage(p => Math.max(1, p - 1))} disabled={endpointsPage === 1} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40">Prev</button>
                    <button onClick={() => setEndpointsPage(p => Math.min(Math.ceil(endpointsData.length / PAGE_SIZE), p + 1))} disabled={endpointsPage >= Math.ceil(endpointsData.length / PAGE_SIZE)} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40">Next</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-32 items-center justify-center text-gray-500">No endpoint data available</div>
          )}
        </div>

        {/* Top Models Table */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <div className="mb-4 flex items-center gap-2">
            <h3 className="text-lg font-semibold text-gray-900">Top Models</h3>
            <div className="group relative">
              <svg className="h-4 w-4 text-gray-500 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="absolute left-0 top-6 z-50 hidden w-72 rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-600 shadow-lg group-hover:block">
                <p className="font-medium text-gray-900 mb-1">Top Models</p>
                <p>Foundation Model API calls (Anthropic, OpenAI, Gemini, etc.), Feature Store lookups, and model training jobs. Unlike serverless endpoints above, these are billed by token usage or feature access rather than compute time.</p>
              </div>
            </div>
          </div>
          {data.models?.models && data.models.models.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Model
                      </th>
                      <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Type
                      </th>
                      <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                        Spend
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {data.models.models.slice((modelsPage - 1) * PAGE_SIZE, modelsPage * PAGE_SIZE).map((model, idx) => {
                      const typeColors: Record<string, string> = {
                        "Feature Store": "bg-teal-50 text-teal-700",
                        "Model Training": "bg-blue-50 text-blue-700",
                        "Foundation Model API": "bg-amber-50 text-amber-700",
                      };
                      const colorClass = typeColors[model.model_type] || "bg-gray-50 text-gray-700";
                      return (
                        <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                          <td className="px-3 py-2 text-sm font-medium text-gray-900 truncate max-w-45" title={model.model_name}>
                            {model.model_name}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-sm">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${colorClass}`}>
                              {model.model_type}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right text-sm text-gray-900">
                            {formatCurrency(model.total_spend)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {(data.models?.models?.length || 0) > PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-between border-t border-gray-200 pt-3">
                  <p className="text-xs text-gray-500">
                    {(modelsPage - 1) * PAGE_SIZE + 1}–{Math.min(modelsPage * PAGE_SIZE, data.models?.models?.length || 0)} of {data.models?.models?.length || 0}
                  </p>
                  <div className="flex gap-1">
                    <button onClick={() => setModelsPage(p => Math.max(1, p - 1))} disabled={modelsPage === 1} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40">Prev</button>
                    <button onClick={() => setModelsPage(p => Math.min(Math.ceil((data.models?.models?.length || 0) / PAGE_SIZE), p + 1))} disabled={modelsPage >= Math.ceil((data.models?.models?.length || 0) / PAGE_SIZE)} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40">Next</button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-32 items-center justify-center text-gray-500">No model data available</div>
          )}
        </div>
      </div>

      {/* ML Runtime Clusters Table */}
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        {(() => {
          const allMlClusters = data.ml_clusters?.clusters || [];
          const isHistoricalMlCluster = (c: typeof allMlClusters[0]) => !c.cluster_name || c.cluster_name === c.cluster_id || c.cluster_name === "Unknown";
          const historicalMlCount = allMlClusters.filter(isHistoricalMlCluster).length;
          const availableRuntimes = Array.from(new Set(allMlClusters.map(c => c.runtime_version).filter(Boolean))).sort();
          const searchedMlClusters = allMlClusters.filter(c => showHistoricalMlClusters || !isHistoricalMlCluster(c));
          const runtimeFilteredClusters = mlRuntimeFilter
            ? searchedMlClusters.filter(c => c.runtime_version === mlRuntimeFilter)
            : searchedMlClusters;
          const filteredMlClusters = mlClusterSearch
            ? runtimeFilteredClusters.filter(c =>
                (c.cluster_name || "").toLowerCase().includes(mlClusterSearch.toLowerCase()) ||
                (c.cluster_id || "").toLowerCase().includes(mlClusterSearch.toLowerCase()) ||
                (c.owner || "").toLowerCase().includes(mlClusterSearch.toLowerCase())
              )
            : runtimeFilteredClusters;
          const mlTotalPages = Math.ceil(filteredMlClusters.length / PAGE_SIZE);
          const mlStart = (mlClustersPage - 1) * PAGE_SIZE;
          const paginatedMlClusters = filteredMlClusters.slice(mlStart, mlStart + PAGE_SIZE);

          return (
            <>
              <div className="mb-4 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">ML Runtime Clusters</h3>
                    <p className="text-xs text-gray-500">Clusters running the Databricks ML Runtime ({filteredMlClusters.length} clusters)</p>
                  </div>
                  {allMlClusters.length > 0 && (
                    <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                      <input type="checkbox" checked={showHistoricalMlClusters}
                        onChange={(e) => { setShowHistoricalMlClusters(e.target.checked); setMlClustersPage(1); }}
                        className="rounded border-gray-300 text-orange-600 focus:ring-orange-500" />
                      Show historical ({historicalMlCount})
                      <span className="relative group ml-0.5">
                        <svg className="inline h-3 w-3 text-gray-500 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block w-56 rounded-lg bg-gray-900 px-2 py-1.5 text-[10px] text-white shadow-lg z-20">Clusters whose names could not be resolved — likely terminated or from inaccessible workspaces</span>
                      </span>
                    </label>
                  )}
                </div>
                <div className="flex items-center justify-end gap-3">
                  {availableRuntimes.length > 0 && (
                    <div className="relative flex items-center gap-1.5" ref={mlRuntimeFilterRef}>
                      <button
                        onClick={() => setMlRuntimeFilterOpen(o => !o)}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${mlRuntimeFilter ? "border-transparent text-white" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`}
                        style={mlRuntimeFilter ? { backgroundColor: '#FF3621' } : {}}
                      >
                        {mlRuntimeFilter ? (mlRuntimeFilter.length > 18 ? mlRuntimeFilter.substring(0, 18) + "…" : mlRuntimeFilter) : "Runtime"}
                        {mlRuntimeFilter ? (
                          <span className="opacity-75 hover:opacity-100 ml-0.5" onClick={(e) => { e.stopPropagation(); setMlRuntimeFilter(null); setMlClustersPage(1); }}>×</span>
                        ) : (
                          <svg className={`h-3 w-3 text-gray-500 transition-transform ${mlRuntimeFilterOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                        )}
                      </button>
                      {mlRuntimeFilterOpen && (
                        <div className="absolute right-0 top-full z-10 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                          <button
                            onClick={() => { setMlRuntimeFilter(null); setMlClustersPage(1); setMlRuntimeFilterOpen(false); }}
                            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${!mlRuntimeFilter ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700 hover:bg-gray-50"}`}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${!mlRuntimeFilter ? "bg-orange-500" : "bg-transparent"}`} />
                            All Runtimes
                          </button>
                          {availableRuntimes.map(r => (
                            <button
                              key={r}
                              onClick={() => { setMlRuntimeFilter(r); setMlClustersPage(1); setMlRuntimeFilterOpen(false); }}
                              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${mlRuntimeFilter === r ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700 hover:bg-gray-50"}`}
                            >
                              <span className={`h-1.5 w-1.5 rounded-full ${mlRuntimeFilter === r ? "bg-orange-500" : "bg-transparent"}`} />
                              {r}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <input
                    type="text"
                    placeholder="Search..."
                    value={mlClusterSearch}
                    onChange={(e) => { setMlClusterSearch(e.target.value); setMlClustersPage(1); }}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 w-44"
                  />
                </div>
              </div>
              {paginatedMlClusters.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Cluster Name</th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Runtime</th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Owner</th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">DBUs</th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Spend</th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Days Active</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {paginatedMlClusters.map((cluster, idx) => {
                        const clusterUrl = getClusterUrl(host, cluster.cluster_id, (cluster as any).workspace_id);
                        return (
                          <tr key={idx} className={idx % 2 === 0 ? "bg-white hover:bg-gray-50" : "bg-gray-50 hover:bg-gray-100"}>
                            <td className="px-4 py-4 text-sm">
                              <div className="flex flex-col gap-0.5">
                                {clusterUrl ? (
                                  <a href={clusterUrl} target="_blank" rel="noopener noreferrer"
                                    className="group flex items-center gap-1 font-medium text-[#FF3621] hover:text-[#E02F1C]">
                                    <span className="truncate max-w-[250px]">{cluster.cluster_name}</span>
                                    <svg className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                    </svg>
                                  </a>
                                ) : (
                                  <span className="font-medium text-gray-900 truncate max-w-[250px]">{cluster.cluster_name}</span>
                                )}
                                <div className="flex items-center gap-2">
                                  {isHistoricalMlCluster(cluster) && <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Historical</span>}
                                  <span className="text-xs text-gray-500 truncate max-w-[200px]">{cluster.cluster_id}</span>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-4 text-sm text-gray-500 max-w-[200px] truncate" title={cluster.runtime_version}>{cluster.runtime_version}</td>
                            <td className="px-4 py-4">
                              {cluster.owner ? (
                                <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 max-w-40 truncate" title={cluster.owner}>
                                  {formatIdentity(cluster.owner)}
                                </span>
                              ) : <span className="text-sm text-gray-500">—</span>}
                            </td>
                            <td className="whitespace-nowrap px-4 py-4 text-right text-sm text-gray-500">{formatNumber(cluster.total_dbus)}</td>
                            <td className="whitespace-nowrap px-4 py-4 text-right text-sm text-gray-900">{formatCurrency(cluster.total_spend)}</td>
                            <td className="whitespace-nowrap px-4 py-4 text-right text-sm text-gray-500">{cluster.days_active}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {mlTotalPages > 1 && (
                    <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
                      <p className="text-sm text-gray-700">
                        Showing <span className="font-medium">{mlStart + 1}</span> to <span className="font-medium">{Math.min(mlStart + PAGE_SIZE, filteredMlClusters.length)}</span> of <span className="font-medium">{filteredMlClusters.length}</span>
                      </p>
                      <div className="flex gap-2">
                        <button onClick={() => setMlClustersPage(p => Math.max(1, p - 1))} disabled={mlClustersPage === 1}
                          className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
                        <button onClick={() => setMlClustersPage(p => Math.min(mlTotalPages, p + 1))} disabled={mlClustersPage === mlTotalPages}
                          className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">Next</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-32 items-center justify-center text-gray-500">No ML runtime cluster data available</div>
              )}
            </>
          );
        })()}
      </div>

      {/* Agent Bricks Table */}
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        {(() => {
          const allAgents = data.agent_bricks?.agents || [];
          const isHistoricalAgent = (a: typeof allAgents[0]) => a.agent_name === "Unknown" || a.agent_name === a.endpoint_id;
          const historicalAgentCount = allAgents.filter(isHistoricalAgent).length;
          const agentTypes = Array.from(new Set(allAgents.map(a => (a as any).agent_type || "Agent")));
          const filteredAgents = allAgents
            .filter(a => showHistoricalAgents || !isHistoricalAgent(a))
            .filter(a => agentTypeFilter === "all" || ((a as any).agent_type || "Agent") === agentTypeFilter)
            .filter(a => !agentSearch || a.agent_name.toLowerCase().includes(agentSearch.toLowerCase()) || (a.endpoint_id || "").toLowerCase().includes(agentSearch.toLowerCase()));
          const agentTotalPages = Math.ceil(filteredAgents.length / PAGE_SIZE);
          const agentStart = (agentsPage - 1) * PAGE_SIZE;
          const paginatedAgents = filteredAgents.slice(agentStart, agentStart + PAGE_SIZE);

          return (
            <>
              <div className="mb-4 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900">Agent Bricks</h3>
                    <p className="text-xs text-gray-500">Databricks agents and their cost attribution</p>
                  </div>
                  {allAgents.length > 0 && (
                    <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showHistoricalAgents}
                        onChange={(e) => { setShowHistoricalAgents(e.target.checked); setAgentsPage(1); }}
                        className="rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                      />
                      Show historical ({historicalAgentCount})
                      <span className="relative group ml-0.5">
                        <svg className="inline h-3 w-3 text-gray-500 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block w-56 rounded-lg bg-gray-900 px-2 py-1.5 text-[10px] text-white shadow-lg z-20">Agents whose names could not be resolved — likely deleted or renamed</span>
                      </span>
                    </label>
                  )}
                </div>
                <div className="flex items-center justify-end">
                  <input
                    type="text"
                    placeholder="Search..."
                    value={agentSearch}
                    onChange={(e) => { setAgentSearch(e.target.value); setAgentsPage(1); }}
                    className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 w-44"
                  />
                </div>
                {agentTypes.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setAgentTypeFilter("all"); setAgentsPage(1); }}
                      className={`rounded-full px-3 py-1 text-xs font-medium ${agentTypeFilter === "all" ? "text-white" : "bg-orange-50 text-orange-700 hover:bg-orange-100"}`}
                      style={agentTypeFilter === "all" ? { backgroundColor: '#FF3621' } : undefined}
                    >All ({allAgents.filter(a => showHistoricalAgents || !isHistoricalAgent(a)).length})</button>
                    {agentTypes.map(t => {
                      const count = allAgents.filter(a => ((a as any).agent_type || "Agent") === t && (showHistoricalAgents || !isHistoricalAgent(a))).length;
                      return (
                        <button
                          key={t}
                          onClick={() => { setAgentTypeFilter(t); setAgentsPage(1); }}
                          className={`rounded-full px-3 py-1 text-xs font-medium ${agentTypeFilter === t ? "text-white" : "bg-orange-50 text-orange-700 hover:bg-orange-100"}`}
                          style={agentTypeFilter === t ? { backgroundColor: '#FF3621' } : undefined}
                        >{t} ({count})</button>
                      );
                    })}
                  </div>
                )}
              </div>
              {paginatedAgents.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Agent</th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Type</th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">DBUs</th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Spend</th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Avg Daily</th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Days Active</th>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Last Active</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {paginatedAgents.map((agent, idx) => {
                        const isSelected = selectedAgent?.agent_name === agent.agent_name;
                        const endpointUrl = getEndpointUrl(host, agent.agent_name, agent.workspace_id);
                        return (
                          <React.Fragment key={idx}>
                            <tr
                              className={`cursor-pointer transition-colors ${isSelected ? "bg-orange-50" : idx % 2 === 0 ? "bg-white hover:bg-gray-50" : "bg-gray-50 hover:bg-gray-100"}`}
                              onClick={() => setSelectedAgent(isSelected ? null : agent)}
                            >
                              <td className="px-4 py-4 text-sm">
                                <div className="flex flex-col gap-0.5">
                                  <span className="font-medium text-[#FF3621] max-w-[250px] truncate" title={agent.agent_name}>
                                    {agent.agent_name}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    {isHistoricalAgent(agent) && (
                                      <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Historical</span>
                                    )}
                                    {agent.endpoint_id && agent.endpoint_id !== agent.agent_name && (
                                      <span className="max-w-[200px] truncate text-xs text-gray-500">{agent.endpoint_id}</span>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="whitespace-nowrap px-4 py-4 text-sm text-gray-600">
                                <span className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                                  {(agent as any).agent_type || "Agent"}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-4 py-4 text-right text-sm text-gray-500">
                                {formatNumber(agent.total_dbus)}
                              </td>
                              <td className="whitespace-nowrap px-4 py-4 text-right text-sm text-gray-900">
                                {formatCurrency(agent.total_spend)}
                              </td>
                              <td className="whitespace-nowrap px-4 py-4 text-right text-sm text-gray-500">
                                {formatCurrency(agent.avg_daily_spend)}
                              </td>
                              <td className="whitespace-nowrap px-4 py-4 text-right text-sm text-gray-500">
                                {agent.days_active}
                              </td>
                              <td className="whitespace-nowrap px-4 py-4 text-sm text-gray-500">
                                {agent.last_seen || "—"}
                              </td>
                            </tr>
                            {isSelected && (
                              <tr>
                                <td colSpan={7} className="bg-orange-50 px-4 py-4">
                                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                                    <div className="rounded-lg bg-white p-3 border border-orange-200">
                                      <p className="text-xs text-gray-500">Total Spend</p>
                                      <p className="text-lg font-semibold text-gray-900">{formatCurrency(agent.total_spend)}</p>
                                    </div>
                                    <div className="rounded-lg bg-white p-3 border border-orange-200">
                                      <p className="text-xs text-gray-500">Total DBUs</p>
                                      <p className="text-lg font-semibold text-gray-900">{formatNumber(agent.total_dbus)}</p>
                                    </div>
                                    <div className="rounded-lg bg-white p-3 border border-orange-200">
                                      <p className="text-xs text-gray-500">First Seen</p>
                                      <p className="text-lg font-semibold text-gray-900">{agent.first_seen || "—"}</p>
                                    </div>
                                    <div className="rounded-lg bg-white p-3 border border-orange-200">
                                      <p className="text-xs text-gray-500">Workspaces</p>
                                      <p className="text-lg font-semibold text-gray-900">{agent.workspace_count}</p>
                                    </div>
                                  </div>
                                  {endpointUrl && (
                                    <div className="mt-3">
                                      <a href={endpointUrl} target="_blank" rel="noopener noreferrer"
                                        className="btn-brand inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium text-white transition-colors">
                                        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                        </svg>
                                        View in Databricks
                                      </a>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  {agentTotalPages > 1 && (
                    <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
                      <p className="text-sm text-gray-700">
                        Showing <span className="font-medium">{agentStart + 1}</span> to <span className="font-medium">{Math.min(agentStart + PAGE_SIZE, filteredAgents.length)}</span> of <span className="font-medium">{filteredAgents.length}</span>
                      </p>
                      <div className="flex gap-2">
                        <button onClick={() => setAgentsPage(p => Math.max(1, p - 1))} disabled={agentsPage === 1}
                          className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
                        <button onClick={() => setAgentsPage(p => Math.min(agentTotalPages, p + 1))} disabled={agentsPage === agentTotalPages}
                          className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">Next</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-32 items-center justify-center text-gray-500">No agent bricks data available</div>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}
