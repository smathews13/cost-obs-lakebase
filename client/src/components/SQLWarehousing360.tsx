import { useEffect, useMemo, useState, useRef } from "react";
import { formatIdentity } from "@/utils/identity";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  Legend,
  BarChart,
  Bar,
  LabelList,
} from "recharts";
import { format, parseISO } from "date-fns";
import type { GranularBreakdownResponse, DBSQLDashboardBundle } from "@/types/billing";
import { KPITrendModal } from "./KPITrendModal";

interface SQLWarehousing360Props {
  sqlBreakdownData: GranularBreakdownResponse | undefined;
  queryData: DBSQLDashboardBundle | undefined;
  isLoading: boolean;
  host?: string | null;
  startDate?: string;
  endDate?: string;
}

// Colors for query source types
const SOURCE_TYPE_COLORS: Record<string, string> = {
  "GENIE SPACE": "#3B82F6",
  "AI/BI DASHBOARD": "#1B5162",
  "LEGACY DASHBOARD": "#06B6D4",
  "SQL QUERY": "#10B981",
  "NOTEBOOK": "#F59E0B",
  "JOB": "#EF4444",
  "ALERT": "#EC4899",
  Unknown: "#6B7280",
};

const COLORS = ["#1B5162", "#06B6D4", "#10B981", "#14B8A6", "#F59E0B", "#3B82F6", "#EC4899", "#EF4444", "#6B7280"];

const formatCurrency = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value);

const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);

const formatDuration = (seconds: number) => {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};

const formatDate = (dateStr: string) => {
  try {
    return format(parseISO(dateStr), "MMM d");
  } catch {
    return dateStr;
  }
};

type SortField = "cost" | "dbus" | "duration_seconds" | "executed_by";
type SortDirection = "asc" | "desc";

// InfoTooltip component removed - not currently used in this view

interface SourceQuery {
  statement_id: string;
  query_source_type: string;
  executed_by: string;
  statement_preview: string;
  duration_seconds: number;
  cost: number;
  dbus: number;
  query_profile_url: string | null;
  source_url: string | null;
}

export function SQLWarehousing360({ sqlBreakdownData: _sqlBreakdownData, queryData, isLoading, host, startDate, endDate }: SQLWarehousing360Props) {
  const [sortField, setSortField] = useState<SortField>("cost");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [queriesPage, setQueriesPage] = useState(1);
  const [showHistoricalQueries, setShowHistoricalQueries] = useState(false);
  const [setupStatus, setSetupStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [setupMessage, setSetupMessage] = useState<string>("");
  const [selectedKPI, setSelectedKPI] = useState<{kpi: string; label: string} | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [sourceQueriesCache, setSourceQueriesCache] = useState<Record<string, SourceQuery[]>>({});
  const [sourceQueriesLoading, setSourceQueriesLoading] = useState(false);
  const [querySourceFilter, setQuerySourceFilter] = useState<string | null>(null);
  const [querySearch, setQuerySearch] = useState("");
  const [warehouseSizeWsFilter, setWarehouseSizeWsFilter] = useState<string>("all");
  const [whSizeDropdownOpen, setWhSizeDropdownOpen] = useState(false);
  const whSizeDropdownRef = useRef<HTMLDivElement>(null);

  // Warehouse Health state
  const [warehouseHealth, setWarehouseHealth] = useState<{
    available: boolean;
    recommendations: Array<{
      warehouse_id: string;
      warehouse_name: string | null;
      warehouse_size: string | null;
      workspace_id: string;
      recommendation_type: string;
      recommendation_text: string;
      max_clusters_observed?: number;
      max_concurrent?: number;
      avg_queue_ms?: number;
      median_duration_seconds?: number;
      last_event_time?: string;
      query_count?: number;
    }>;
    warehouses_analyzed: number;
  } | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [healthIssueFilter, setHealthIssueFilter] = useState<string>("");
  const [healthPage, setHealthPage] = useState(1);
  const HEALTH_PAGE_SIZE = 10;

  // Close warehouse size dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (whSizeDropdownRef.current && !whSizeDropdownRef.current.contains(e.target as Node)) {
        setWhSizeDropdownOpen(false);
      }
    };
    if (whSizeDropdownOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [whSizeDropdownOpen]);

  // Derive current source queries from cache
  const sourceQueries = selectedSource ? (sourceQueriesCache[selectedSource] || []) : [];

  // Prefetch top queries for ALL source types when data loads
  const prefetchSourceTypes = queryData?.by_source?.sources?.map((s) => s.query_source_type) || [];
  useEffect(() => {
    if (!startDate || !endDate || prefetchSourceTypes.length === 0) return;
    let cancelled = false;
    const fetchAll = async () => {
      const results: Record<string, SourceQuery[]> = {};
      await Promise.all(
        prefetchSourceTypes.map(async (sourceType) => {
          try {
            const params = new URLSearchParams({ source_type: sourceType, limit: "5" });
            params.set("start_date", startDate);
            params.set("end_date", endDate);
            const res = await fetch(`/api/dbsql/top-queries-by-source?${params}`);
            const result = await res.json();
            results[sourceType] = result.queries || [];
          } catch {
            results[sourceType] = [];
          }
        })
      );
      if (!cancelled) setSourceQueriesCache(results);
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [startDate, endDate, prefetchSourceTypes.join(",")]);

  const handleSourceClick = (sourceType: string) => {
    setSelectedSource(sourceType);
    // If not in cache yet, fetch on demand
    if (!sourceQueriesCache[sourceType]) {
      setSourceQueriesLoading(true);
      const params = new URLSearchParams({ source_type: sourceType, limit: "5" });
      if (startDate) params.set("start_date", startDate);
      if (endDate) params.set("end_date", endDate);
      fetch(`/api/dbsql/top-queries-by-source?${params}`)
        .then((res) => res.json())
        .then((result) => {
          setSourceQueriesCache((prev) => ({ ...prev, [sourceType]: result.queries || [] }));
        })
        .catch(() => {
          setSourceQueriesCache((prev) => ({ ...prev, [sourceType]: [] }));
        })
        .finally(() => setSourceQueriesLoading(false));
    }
  };

  // Fetch warehouse health (not date-dependent)
  useEffect(() => {
    setHealthLoading(true);
    fetch("/api/sql/warehouse-health")
      .then(r => r.json())
      .then(d => setWarehouseHealth(d))
      .catch(() => setWarehouseHealth(null))
      .finally(() => setHealthLoading(false));
  }, []);

  // Pre-warm trend queries so modals open instantly
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!startDate || !endDate) return;
    for (const kpi of ["total_queries", "total_users", "avg_query_duration"]) {
      queryClient.prefetchQuery({
        queryKey: ["platform-kpi-trend", kpi, startDate, endDate, "daily"],
        queryFn: async () => {
          const params = new URLSearchParams({ kpi, start_date: startDate, end_date: endDate, granularity: "daily" });
          const res = await fetch(`/api/billing/platform-kpi-trend?${params}`);
          if (!res.ok) throw new Error("prefetch failed");
          return res.json();
        },
        staleTime: 5 * 60 * 1000,
      });
    }
  }, [startDate, endDate, queryClient]);

  // Info box minimize state with localStorage persistence
  const MINIMIZE_KEY = "cost-obs-minimize-sql-info";
  const [infoMinimized, setInfoMinimized] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(MINIMIZE_KEY) === "true";
    }
    return false;
  });

  const handleMinimizeToggle = (checked: boolean) => {
    setInfoMinimized(checked);
    if (checked) {
      localStorage.setItem(MINIMIZE_KEY, "true");
    } else {
      localStorage.removeItem(MINIMIZE_KEY);
    }
  };

  const handleCreateTables = async () => {
    setSetupStatus("loading");
    setSetupMessage("Creating materialized views (this may take a few minutes)...");
    try {
      const response = await fetch("/api/setup/create-tables?run_in_background=true", {
        method: "POST",
      });
      const result = await response.json();
      if (response.ok) {
        setSetupStatus("success");
        setSetupMessage("Materialized views creation started. Refresh the page in a few minutes to see query cost data.");
      } else {
        setSetupStatus("error");
        setSetupMessage(result.message || "Failed to create materialized views");
      }
    } catch (err) {
      setSetupStatus("error");
      setSetupMessage("Failed to connect to setup API");
    }
  };

  const userBarData = useMemo(() => {
    if (!queryData?.by_user?.users) return [];
    const byUser: Record<string, { user: string; total_spend: number; query_count: number }> = {};
    for (const u of queryData.by_user.users) {
      if (!byUser[u.executed_by]) {
        byUser[u.executed_by] = { user: u.executed_by, total_spend: 0, query_count: 0 };
      }
      byUser[u.executed_by].total_spend += u.total_spend;
      byUser[u.executed_by].query_count += u.query_count;
    }
    return Object.values(byUser)
      .sort((a, b) => b.total_spend - a.total_spend)
      .slice(0, 10)
      .map(u => ({ ...u, user: formatIdentity(u.user) }));
  }, [queryData?.by_user]);

  const timeseriesData = useMemo(() => {
    if (!queryData?.timeseries?.timeseries) return [];
    return queryData.timeseries.timeseries.map((point) => ({
      ...point,
      date: formatDate(point.date as string),
    }));
  }, [queryData?.timeseries]);

  const querySourceTypes = useMemo(() => {
    if (!queryData?.top_queries?.queries) return [];
    const types = new Set(queryData.top_queries.queries.map((q) => q.query_source_type));
    return Array.from(types).sort();
  }, [queryData?.top_queries]);

  const isHistoricalQuery = (q: { executed_by: string; statement_preview: string }) =>
    !q.executed_by || q.executed_by === "Unknown" || q.statement_preview === "N/A";
  const allQueries = queryData?.top_queries?.queries || [];
  const historicalQueryCount = allQueries.filter(isHistoricalQuery).length;

  const filteredQueries = useMemo(() => {
    if (!queryData?.top_queries?.queries) return [];
    let queries = [...queryData.top_queries.queries];
    if (!showHistoricalQueries) {
      queries = queries.filter((q) => !isHistoricalQuery(q));
    }
    if (querySourceFilter) {
      queries = queries.filter((q) => q.query_source_type === querySourceFilter);
    }
    queries.sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;
      switch (sortField) {
        case "cost":
          aVal = a.cost;
          bVal = b.cost;
          break;
        case "dbus":
          aVal = a.dbus;
          bVal = b.dbus;
          break;
        case "duration_seconds":
          aVal = a.duration_seconds;
          bVal = b.duration_seconds;
          break;
        case "executed_by":
          aVal = a.executed_by.toLowerCase();
          bVal = b.executed_by.toLowerCase();
          break;
      }
      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortDirection === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDirection === "asc" ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number);
    });
    return queries;
  }, [queryData?.top_queries, sortField, sortDirection, showHistoricalQueries, querySourceFilter]);

  const searchedQueries = querySearch
    ? filteredQueries.filter(q =>
        (q.executed_by || "").toLowerCase().includes(querySearch.toLowerCase()) ||
        (q.query_source_type || "").toLowerCase().includes(querySearch.toLowerCase()) ||
        (q.statement_preview || "").toLowerCase().includes(querySearch.toLowerCase())
      )
    : filteredQueries;
  const queryTotalPages = Math.ceil(searchedQueries.length / 10);
  const queryStart = (queriesPage - 1) * 10;
  const sortedQueries = searchedQueries.slice(queryStart, queryStart + 10);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
        <p className="text-sm text-gray-500">Loading query analytics...</p>
      </div>
    );
  }

  const summary = queryData?.summary;
  const sourceTypes = queryData?.timeseries?.source_types || [];
  const hasQueryData = queryData?.available;

  return (
    <div className="space-y-6">
      {/* Query-level Cost Attribution */}
      {!hasQueryData ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-6">
          <h3 className="text-lg font-semibold text-gray-900">Query-level Cost Attribution Not Available</h3>
          <p className="mt-2 text-sm text-gray-600">
            The <code className="rounded bg-orange-100 px-1">dbsql_cost_per_query</code> table has not been created yet.
          </p>
          <p className="mt-2 text-sm text-gray-600">
            This feature provides granular query-level cost attribution for all DBSQL queries, including:
          </p>
          <ul className="mt-2 list-inside list-disc text-sm text-gray-600">
            <li>Cost breakdown by query source (Genie, Dashboards, SQL Editor, Jobs)</li>
            <li>Per-user query spend analysis</li>
            <li>Most expensive query identification</li>
            <li>Deep links to query profiles</li>
          </ul>

          <div className="mt-4 rounded-lg bg-white p-4 border border-amber-100">
            <h4 className="font-medium text-gray-900">Create Materialized Views</h4>
            <p className="mt-1 text-sm text-gray-600">
              Click the button below to create all required materialized views. This process runs in the background and may take a few minutes.
            </p>

            <div className="mt-4">
              {setupStatus === "idle" && (
                <button
                  onClick={handleCreateTables}
                  className="btn-brand inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                  </svg>
                  Create Materialized Views
                </button>
              )}
              {setupStatus === "loading" && (
                <div className="flex items-center gap-2 text-gray-600">
                  <svg className="h-5 w-5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span className="text-sm">{setupMessage}</span>
                </div>
              )}
              {setupStatus === "success" && (
                <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-green-700">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm">{setupMessage}</span>
                </div>
              )}
              {setupStatus === "error" && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 p-3 text-red-700">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="text-sm">{setupMessage}</span>
                  <button
                    onClick={() => setSetupStatus("idle")}
                    className="ml-auto text-sm text-red-600 hover:text-red-800 underline"
                  >
                    Try again
                  </button>
                </div>
              )}
            </div>

            <p className="mt-3 text-xs text-gray-500">
              The tables will be automatically refreshed daily after initial creation.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
              <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Query</h1>
              <p className="text-sm text-gray-500">Query-level cost attribution and warehouse analytics</p>
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
                  <h3 className="text-sm font-medium text-orange-800">SQL Warehousing — What's on this tab</h3>
                  <svg className={`h-4 w-4 text-orange-500 transition-transform ${infoMinimized ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {!infoMinimized && (
                  <>
                    <div className="mt-2 text-sm text-orange-700">
                      <ul className="list-inside list-disc space-y-1">
                        <li><strong>Spend by Source</strong>: Click any source (Genie, AI/BI, SQL Editor, Jobs, Notebooks) to drill into the top queries from that source</li>
                        <li><strong>Warehouse Spend</strong>: Breakdown by warehouse type and utilization patterns</li>
                        <li><strong>SKU Breakdown</strong>: Spend split across Serverless, Pro, Classic, and other SQL SKUs</li>
                        <li><strong>Top Users by Query Spend</strong>: Human users and service principals ranked by SQL query cost</li>
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

          {/* Stale data warning — shown when MV exists but has no data in the selected range */}
          {summary?.total_queries === 0 && (summary?.data_range?.total_rows ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <div className="flex items-start gap-3">
                <svg className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-amber-800">No data in selected date range</p>
                  <p className="mt-1 text-sm text-amber-700">
                    The Query materialized view has data from{" "}
                    <strong>{summary.data_range?.earliest_date ?? "unknown"}</strong> to{" "}
                    <strong>{summary.data_range?.latest_date ?? "unknown"}</strong>, but the current date range
                    ({startDate} – {endDate}) falls outside that window. Adjust the date range to see data.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Summary Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all" onClick={() => startDate && endDate && setSelectedKPI({kpi: "total_queries", label: "Total Query Spend"})}>
              <div className="flex items-center">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
                  <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="ml-4">
                  <div className="text-sm font-medium text-gray-500">Total Query Spend</div>
                  <div className="text-2xl font-semibold text-gray-900">
                    {formatCurrency(summary?.total_spend || 0)}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    {formatNumber(summary?.total_dbus || 0)} DBUs
                  </div>
                  <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend &rarr;</p>
                </div>
              </div>
            </div>
            <div className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all" onClick={() => startDate && endDate && setSelectedKPI({kpi: "total_queries", label: "Total Queries"})}>
              <div className="flex items-center">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
                  <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                  </svg>
                </div>
                <div className="ml-4">
                  <div className="text-sm font-medium text-gray-500">Total Queries</div>
                  <div className="text-2xl font-semibold text-gray-900">
                    {formatNumber(summary?.total_queries || 0)}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Avg: {formatCurrency(summary?.avg_cost_per_query || 0)}/query
                  </div>
                  <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend &rarr;</p>
                </div>
              </div>
            </div>
            <div className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all" onClick={() => startDate && endDate && setSelectedKPI({kpi: "total_users", label: "Unique Users"})}>
              <div className="flex items-center">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
                  <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                  </svg>
                </div>
                <div className="ml-4">
                  <div className="text-sm font-medium text-gray-500">Unique Users</div>
                  <div className="text-2xl font-semibold text-gray-900">
                    {formatNumber(summary?.unique_users || 0)}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Across {formatNumber(summary?.unique_warehouses || 0)} warehouses
                  </div>
                  <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend &rarr;</p>
                </div>
              </div>
            </div>
            <div className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all" onClick={() => startDate && endDate && setSelectedKPI({kpi: "avg_query_duration", label: "Avg Query Duration"})}>
              <div className="flex items-center">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
                  <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="ml-4">
                  <div className="text-sm font-medium text-gray-500">Avg Query Duration</div>
                  <div className="text-2xl font-semibold text-gray-900">
                    {formatDuration(summary?.avg_duration_seconds || 0)}
                  </div>
                  <div className="mt-1 text-xs text-gray-500">
                    Per query execution
                  </div>
                  <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend &rarr;</p>
                </div>
              </div>
            </div>
          </div>

          {selectedKPI && startDate && endDate && (
            <KPITrendModal
              variant="platform"
              kpi={selectedKPI.kpi}
              kpiLabel={selectedKPI.label}
              isOpen={!!selectedKPI}
              onClose={() => setSelectedKPI(null)}
              startDate={startDate}
              endDate={endDate}
            />
          )}

          {/* Daily Query Costs + Top Users — side by side */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Timeseries Chart */}
            <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
              <h3 className="mb-4 text-lg font-semibold text-gray-900">Query Spend by Source</h3>
              {timeseriesData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={timeseriesData}>
                    <XAxis dataKey="date" stroke="#9ca3af" fontSize={12} tickMargin={8} />
                    <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} stroke="#9ca3af" fontSize={12} tickMargin={8} />
                    <Tooltip
                      formatter={(value) => formatCurrency(value as number)}
                      labelFormatter={(label) => `Date: ${label}`}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {sourceTypes.map((type, idx) => (
                      <Area
                        key={type}
                        type="monotone"
                        dataKey={type}
                        stackId="1"
                        stroke={SOURCE_TYPE_COLORS[type] || COLORS[idx % COLORS.length]}
                        fill={SOURCE_TYPE_COLORS[type] || COLORS[idx % COLORS.length]}
                        fillOpacity={0.6}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-[300px] items-center justify-center text-gray-500">
                  No timeseries data available
                </div>
              )}
            </div>

            {/* Top Users Bar Chart */}
            <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
              <h3 className="mb-4 text-lg font-semibold text-gray-900">Top Users by Query Spend</h3>
              {userBarData.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={userBarData} layout="vertical" margin={{ left: 0, right: 70 }}>
                    <XAxis type="number" tickFormatter={(v) => formatCurrency(v)} stroke="#9ca3af" fontSize={12} tickMargin={8} />
                    <YAxis
                      type="category"
                      dataKey="user"
                      width={160}
                      stroke="#9ca3af"
                      fontSize={12}
                      tickMargin={8}
                    />
                    <Tooltip
                      formatter={(value) => formatCurrency(value as number)}
                      labelFormatter={(label) => `User: ${label}`}
                    />
                    <Bar dataKey="total_spend" radius={[0, 4, 4, 0]}>
                      {userBarData.map((_entry, idx) => (
                        <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                      ))}
                      <LabelList dataKey="total_spend" position="right" formatter={(v: unknown) => `$${Math.round(v as number).toLocaleString()}`} style={{ fontSize: 11, fill: "#6b7280" }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-[300px] items-center justify-center text-gray-500">
                  No user data available
                </div>
              )}
            </div>
          </div>

          {/* Warehouse Spend by Type + Warehouse Count by Size — side by side */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
              <h3 className="mb-4 text-lg font-semibold text-gray-900">Warehouse Spend by Type</h3>
              {(() => {
                const whTypeTs = (queryData as any)?.warehouse_type_timeseries;
                const tsData = whTypeTs?.timeseries || [];
                const whTypes: string[] = whTypeTs?.warehouse_types || [];
                if (tsData.length === 0) {
                  return (
                    <div className="flex h-[300px] items-center justify-center text-gray-500">
                      No warehouse type timeseries data available
                    </div>
                  );
                }
                const typeColors: Record<string, string> = { SERVERLESS: "#1B5162", PRO: "#06B6D4", CLASSIC: "#F59E0B" };
                return (
                  <ResponsiveContainer width="100%" height={300}>
                    <AreaChart data={tsData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                      <XAxis
                        dataKey="date"
                        tickFormatter={(d) => {
                          try { return format(parseISO(d), "MMM d"); } catch { return d; }
                        }}
                        stroke="#9ca3af" fontSize={11}
                      />
                      <YAxis tickFormatter={(v) => formatCurrency(v)} stroke="#9ca3af" fontSize={11} width={70} />
                      <Tooltip
                        formatter={(value: number | undefined) => formatCurrency(value ?? 0)}
                        labelFormatter={(label) => {
                          try { return format(parseISO(label as string), "MMM d, yyyy"); } catch { return label as string; }
                        }}
                        contentStyle={{ backgroundColor: "white", border: "1px solid #e5e7eb", borderRadius: "8px" }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      {whTypes.map((wt) => (
                        <Area
                          key={wt}
                          type="monotone"
                          dataKey={wt}
                          stroke={typeColors[wt] || "#6B7280"}
                          fill={typeColors[wt] || "#6B7280"}
                          fillOpacity={0.15}
                          strokeWidth={2}
                        />
                      ))}
                    </AreaChart>
                  </ResponsiveContainer>
                );
              })()}
          </div>

          {/* Warehouse Count by Size */}
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5', overflow: 'visible' }}>
              {(() => {
                const allWh = queryData?.by_warehouse?.warehouses || [];
                // Build workspace list with names
                const wsMap = new Map<string, string>();
                for (const w of allWh) {
                  const wsId = (w as any).workspace_id;
                  const wsName = (w as any).workspace_name;
                  if (wsId && !wsMap.has(wsId)) {
                    wsMap.set(wsId, wsName || wsId);
                  }
                }
                const wsEntries = Array.from(wsMap.entries());
                const selectedWsName = warehouseSizeWsFilter !== "all" ? (wsMap.get(warehouseSizeWsFilter) || warehouseSizeWsFilter) : null;

                let warehouses = allWh;
                if (warehouseSizeWsFilter !== "all") {
                  warehouses = warehouses.filter((w: any) => w.workspace_id === warehouseSizeWsFilter);
                }

                const bySize: Record<string, number> = {};
                for (const w of warehouses) {
                  const s = (w as any).warehouse_size || "UNKNOWN";
                  if (s === "UNKNOWN") continue;
                  bySize[s] = (bySize[s] || 0) + 1;
                }
                const sizeColors = ["#1B5162", "#06B6D4", "#10B981", "#F59E0B", "#FF3621", "#3B82F6", "#EC4899", "#EF4444"];
                const chartData = Object.entries(bySize)
                  .sort((a, b) => b[1] - a[1])
                  .map(([name, count]) => ({ name: name.replace(/_/g, " "), count }));

                return (
                  <>
                    <div className="mb-4 flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900">Warehouse Count by Size</h3>
                        {selectedWsName && (
                          <p className="text-sm text-orange-600 font-medium mt-0.5">Filtered to: {selectedWsName}</p>
                        )}
                      </div>
                      {wsEntries.length > 1 && (
                        <div className="relative" ref={whSizeDropdownRef}>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setWhSizeDropdownOpen(!whSizeDropdownOpen)}
                              className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                            >
                              <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                              </svg>
                              Filter
                              <svg className={`h-3 w-3 text-gray-500 transition-transform ${whSizeDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </button>
                            {selectedWsName && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-white cursor-pointer"
                                style={{ backgroundColor: '#FF3621' }}
                                onClick={() => setWarehouseSizeWsFilter("all")}
                                title="Click to clear filter"
                              >
                                {selectedWsName.length > 15 ? selectedWsName.substring(0, 15) + "..." : selectedWsName}
                                <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                </svg>
                              </span>
                            )}
                          </div>
                          {whSizeDropdownOpen && (
                            <div className="absolute right-0 top-full z-50 mt-1 max-h-64 w-72 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                              <button
                                onClick={() => { setWarehouseSizeWsFilter("all"); setWhSizeDropdownOpen(false); }}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${warehouseSizeWsFilter === "all" ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700 hover:bg-gray-50"}`}
                              >
                                <span className={`h-2 w-2 rounded-full ${warehouseSizeWsFilter === "all" ? "bg-orange-500" : "bg-transparent"}`} />
                                All Workspaces
                              </button>
                              {wsEntries.map(([wsId, wsName]) => (
                                <button
                                  key={wsId}
                                  onClick={() => { setWarehouseSizeWsFilter(wsId); setWhSizeDropdownOpen(false); }}
                                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${warehouseSizeWsFilter === wsId ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700 hover:bg-gray-50"}`}
                                >
                                  <span className={`h-2 w-2 rounded-full ${warehouseSizeWsFilter === wsId ? "bg-orange-500" : "bg-transparent"}`} />
                                  <span className="truncate">{wsName}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {chartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={chartData} layout="vertical" margin={{ left: 20, right: 40 }}>
                          <XAxis type="number" stroke="#9ca3af" fontSize={12} tickMargin={8} />
                          <YAxis type="category" dataKey="name" width={80} stroke="#9ca3af" fontSize={12} tickMargin={8} />
                          <Tooltip contentStyle={{ backgroundColor: "white", border: "1px solid #e5e7eb", borderRadius: "8px" }} />
                          <Bar dataKey="count" name="Warehouses" radius={[0, 4, 4, 0]}>
                            {chartData.map((_, idx) => (
                              <Cell key={idx} fill={sizeColors[idx % sizeColors.length]} />
                            ))}
                            <LabelList dataKey="count" position="right" style={{ fontSize: 11, fill: "#6b7280" }} />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="flex h-[300px] items-center justify-center text-gray-500">No warehouse data available</div>
                    )}
                  </>
                );
              })()}
          </div>
          </div>

          {/* Query Source Breakdown — full width */}
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
              <h3 className="mb-4 text-lg font-semibold text-gray-900">Query Source Breakdown</h3>
              {queryData.by_source?.sources && queryData.by_source.sources.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                          Source Type
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                          Query Count
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                          Total Spend
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                          Avg Cost/Query
                        </th>
                        <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                          Share
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200 bg-white">
                      {queryData.by_source.sources.map((source) => (
                        <tr
                          key={source.query_source_type}
                          className="cursor-pointer hover:bg-gray-50"
                          onClick={() => handleSourceClick(source.query_source_type)}
                        >
                          <td className="whitespace-nowrap px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div
                                className="h-3 w-3 rounded-full"
                                style={{ backgroundColor: SOURCE_TYPE_COLORS[source.query_source_type] || "#6b7280" }}
                              />
                              <span className="font-medium text-gray-900">{source.query_source_type}</span>
                              <svg className="h-3 w-3 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                              </svg>
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-500">
                            {formatNumber(source.query_count)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                            {formatCurrency(source.total_spend)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-500">
                            {formatCurrency(source.avg_cost_per_query)}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <div className="h-2 w-16 overflow-hidden rounded-full bg-gray-200">
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${source.percentage}%`,
                                    backgroundColor: SOURCE_TYPE_COLORS[source.query_source_type] || "#6b7280",
                                  }}
                                />
                              </div>
                              <span className="text-sm text-gray-500">{source.percentage.toFixed(1)}%</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex h-40 items-center justify-center text-gray-500">
                  No source breakdown available
                </div>
              )}
          </div>

          {/* Top Expensive Queries Table */}
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <div className="mb-4 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-semibold text-gray-900">Most Expensive Queries</h3>
                <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                  <input type="checkbox" checked={showHistoricalQueries}
                    onChange={(e) => { setShowHistoricalQueries(e.target.checked); setQueriesPage(1); }}
                    className="rounded border-gray-300 text-orange-600 focus:ring-orange-500" />
                  Show historical ({historicalQueryCount})
                  <span className="relative group ml-0.5">
                    <svg className="inline h-3 w-3 text-gray-500 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block w-56 rounded-lg bg-gray-900 px-2 py-1.5 text-[10px] text-white shadow-lg z-20">Queries with unknown users or unavailable previews</span>
                  </span>
                </label>
              </div>
              <div className="flex items-center justify-end">
                <input
                  type="text"
                  placeholder="Search..."
                  value={querySearch}
                  onChange={(e) => { setQuerySearch(e.target.value); setQueriesPage(1); }}
                  className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 w-44"
                />
              </div>
              {querySourceTypes.length > 1 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setQuerySourceFilter(null)}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      querySourceFilter === null
                        ? "text-white"
                        : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                    }`}
                    style={querySourceFilter === null ? { backgroundColor: '#FF3621' } : undefined}
                  >
                    All
                  </button>
                  {querySourceTypes.map((type) => (
                    <button
                      key={type}
                      onClick={() => setQuerySourceFilter(querySourceFilter === type ? null : type)}
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        querySourceFilter === type
                          ? "text-white"
                          : "text-gray-700 hover:opacity-80"
                      }`}
                      style={
                        querySourceFilter === type
                          ? { backgroundColor: SOURCE_TYPE_COLORS[type] || "#6b7280" }
                          : { backgroundColor: `${SOURCE_TYPE_COLORS[type] || "#6b7280"}20`, color: SOURCE_TYPE_COLORS[type] || "#6b7280" }
                      }
                    >
                      {type}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {sortedQueries.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Source
                      </th>
                      <th
                        className="cursor-pointer px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                        onClick={() => handleSort("executed_by")}
                      >
                        User {sortField === "executed_by" && (sortDirection === "asc" ? "↑" : "↓")}
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                        Query Preview
                      </th>
                      <th
                        className="cursor-pointer px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                        onClick={() => handleSort("duration_seconds")}
                      >
                        Duration {sortField === "duration_seconds" && (sortDirection === "asc" ? "↑" : "↓")}
                      </th>
                      <th
                        className="cursor-pointer px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                        onClick={() => handleSort("cost")}
                      >
                        Cost {sortField === "cost" && (sortDirection === "asc" ? "↑" : "↓")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {sortedQueries.map((query, idx) => (
                      <tr key={query.statement_id || idx} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-4 py-3">
                          <span
                            className="inline-flex rounded-full px-2 py-1 text-xs font-medium"
                            style={{
                              backgroundColor: `${SOURCE_TYPE_COLORS[query.query_source_type] || "#6b7280"}20`,
                              color: SOURCE_TYPE_COLORS[query.query_source_type] || "#6b7280",
                            }}
                          >
                            {query.query_source_type}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 max-w-40 truncate" title={query.executed_by}>
                            {formatIdentity(query.executed_by)}
                          </span>
                        </td>
                        <td className="max-w-md px-4 py-3 text-sm text-gray-500">
                          {query.query_profile_url ? (
                            <a
                              href={query.query_profile_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block truncate font-mono text-xs text-blue-600 hover:text-blue-800 hover:underline"
                              title="Click to view query profile"
                            >
                              {query.statement_preview}
                            </a>
                          ) : (
                            <div className="truncate font-mono text-xs">
                              {query.statement_preview}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-500">
                          {formatDuration(query.duration_seconds)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                          {formatCurrency(query.cost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {queryTotalPages > 1 && (
                  <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
                    <p className="text-sm text-gray-700">
                      Showing <span className="font-medium">{queryStart + 1}</span> to <span className="font-medium">{Math.min(queryStart + 10, filteredQueries.length)}</span> of <span className="font-medium">{filteredQueries.length}</span>
                    </p>
                    <div className="flex gap-2">
                      <button onClick={() => setQueriesPage(p => Math.max(1, p - 1))} disabled={queriesPage === 1}
                        className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">Previous</button>
                      <button onClick={() => setQueriesPage(p => Math.min(queryTotalPages, p + 1))} disabled={queriesPage === queryTotalPages}
                        className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50">Next</button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center text-gray-500">
                No query data available
              </div>
            )}
          </div>

        </>
      )}

      {/* ── Warehouse Rightsizing Recommendations ───────────────────────────── */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-gray-900">Warehouse Rightsizing</h3>
            <p className="text-xs text-gray-500 mt-0.5">Idle, over-scaled, and oversized warehouse recommendations</p>
          </div>
          <div className="flex items-center gap-3">
            {warehouseHealth && (
              <span className="text-xs text-gray-500">{warehouseHealth.warehouses_analyzed} warehouse{warehouseHealth.warehouses_analyzed !== 1 ? "s" : ""} analyzed</span>
            )}
            {/* Issue type filter */}
            {warehouseHealth?.recommendations?.length ? (
              <select
                value={healthIssueFilter}
                onChange={(e) => { setHealthIssueFilter(e.target.value); setHealthPage(1); }}
                className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
              >
                <option value="">All Issues</option>
                <option value="IDLE_RUNNING">Idle Running</option>
                <option value="OVER_SCALED">Over-Scaled</option>
                <option value="OVERSIZED">Oversized</option>
              </select>
            ) : null}
          </div>
        </div>

        {healthLoading ? (
          <div className="flex h-24 items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-300" style={{ borderTopColor: "#FF3621" }} />
          </div>
        ) : !warehouseHealth?.available || !warehouseHealth.recommendations.length ? (
          <div className="rounded-lg border border-gray-100 bg-gray-50 p-4 text-sm text-gray-500">
            {warehouseHealth?.available === false
              ? "Warehouse health data unavailable. Requires system.compute.warehouse_events access."
              : "No rightsizing recommendations — all warehouses appear appropriately sized."}
          </div>
        ) : (() => {
          const badgeColor: Record<string, string> = {
            IDLE_RUNNING: "bg-red-100 text-red-700",
            OVER_SCALED: "bg-amber-100 text-amber-700",
            OVERSIZED: "bg-orange-100 text-orange-700",
          };
          const badgeLabel: Record<string, string> = {
            IDLE_RUNNING: "Idle Running",
            OVER_SCALED: "Over-Scaled",
            OVERSIZED: "Oversized",
          };
          const filtered = healthIssueFilter
            ? warehouseHealth.recommendations.filter((r) => r.recommendation_type === healthIssueFilter)
            : warehouseHealth.recommendations;
          const totalPages = Math.max(1, Math.ceil(filtered.length / HEALTH_PAGE_SIZE));
          const safePage = Math.min(healthPage, totalPages);
          const pageRecs = filtered.slice((safePage - 1) * HEALTH_PAGE_SIZE, safePage * HEALTH_PAGE_SIZE);
          return (
            <>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Warehouse</th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Size</th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Issue</th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Recommendation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {pageRecs.map((rec, i) => (
                      <tr key={`${rec.warehouse_id}-${rec.recommendation_type}-${i}`} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {host ? (
                            <a
                              href={`https://${host}/sql/warehouses/${rec.warehouse_id}/edit`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              {rec.warehouse_name || rec.warehouse_id}
                            </a>
                          ) : (
                            rec.warehouse_name || rec.warehouse_id
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-500">{rec.warehouse_size || "—"}</td>
                        <td className="px-4 py-3">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badgeColor[rec.recommendation_type] || "bg-gray-100 text-gray-700"}`}>
                            {badgeLabel[rec.recommendation_type] || rec.recommendation_type}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600 text-xs max-w-sm">{rec.recommendation_text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                  <span>{filtered.length} recommendation{filtered.length !== 1 ? "s" : ""}{healthIssueFilter ? ` (filtered)` : ""}</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setHealthPage((p) => Math.max(1, p - 1))}
                      disabled={safePage <= 1}
                      className="rounded px-2 py-1 disabled:opacity-40 hover:bg-gray-100"
                    >
                      ‹ Prev
                    </button>
                    <span className="px-2">Page {safePage} of {totalPages}</span>
                    <button
                      onClick={() => setHealthPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage >= totalPages}
                      className="rounded px-2 py-1 disabled:opacity-40 hover:bg-gray-100"
                    >
                      Next ›
                    </button>
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* Source Drilldown Modal — rendered via portal to avoid stacking context issues */}
      {selectedSource && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={() => setSelectedSource(null)}>
          <div className="mx-4 w-full max-w-3xl rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="h-4 w-4 rounded-full"
                  style={{ backgroundColor: SOURCE_TYPE_COLORS[selectedSource] || "#6b7280" }}
                />
                <h3 className="text-lg font-semibold text-gray-900">
                  Top 5 Queries — {selectedSource}
                </h3>
              </div>
              <button onClick={() => setSelectedSource(null)} className="rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-600">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {sourceQueriesLoading ? (
              <div className="flex h-40 items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
              </div>
            ) : sourceQueries.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">User</th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Query Preview</th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Duration</th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Cost</th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Links</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {sourceQueries.map((q, idx) => (
                      <tr key={q.statement_id || idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 max-w-40 truncate" title={q.executed_by}>
                            {formatIdentity(q.executed_by)}
                          </span>
                        </td>
                        <td className="max-w-sm px-4 py-3 text-sm text-gray-500">
                          <div className="truncate font-mono text-xs">{q.statement_preview}</div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-500">
                          {formatDuration(q.duration_seconds)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                          {formatCurrency(q.cost)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right">
                          <div className="flex items-center gap-2 justify-end">
                            {q.query_profile_url && (
                              <a href={q.query_profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-[#FF3621] hover:underline">
                                Profile
                              </a>
                            )}
                            {q.source_url && (
                              <a href={q.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-[#FF3621] hover:underline">
                                Source
                              </a>
                            )}
                            {!q.query_profile_url && !q.source_url && (
                              <span className="text-xs text-gray-500">-</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center text-gray-500">
                No queries found for this source type
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
