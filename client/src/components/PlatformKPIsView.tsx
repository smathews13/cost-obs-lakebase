import { useState, useEffect, memo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PlatformKPIsResponse, SpendAnomaliesResponse } from "@/types/billing";
import { SpendAnomalies } from "@/components/SpendAnomalies";
import { KPITrendModal } from "@/components/KPITrendModal";
import { formatNumber, formatBytes, formatDurationSeconds } from "@/utils/formatters";

interface PlatformKPIsViewProps {
  data: PlatformKPIsResponse | undefined;
  isLoading: boolean;
  spendAnomalies: SpendAnomaliesResponse | undefined;
  anomaliesLoading: boolean;
  startDate?: string;
  endDate?: string;
  enableAIFeatures?: boolean;
}

interface KPICardProps {
  title: string;
  value: string;
  subtitle?: string;
  infoTooltip?: string;
  icon: React.ReactNode;
  color: string;
  onClick?: () => void;
}

// Memoize KPICard to prevent unnecessary re-renders when parent state changes
const KPICard = memo(function KPICard({ title, value, subtitle, infoTooltip, icon, color, onClick }: KPICardProps) {
  return (
    <div
      className={`rounded-lg bg-white p-6 border shadow-sm transition-all ${
        onClick ? "cursor-pointer hover:shadow-md hover:scale-[1.01]" : ""
      }`}
      style={{ borderColor: '#E5E5E5' }}
      onClick={onClick}
    >
      <div className="flex items-center">
        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg ${color}`}>
          {icon}
        </div>
        <div className="ml-4 flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
          {subtitle && !infoTooltip && (
            <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>
          )}
          {infoTooltip && (
            <div className="mt-0.5 flex items-center gap-1.5">
              <div className="group relative inline-flex">
                <div className="flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-[10px] font-semibold text-gray-500 cursor-help">
                  i
                </div>
                <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-normal opacity-0 transition-opacity group-hover:opacity-100">
                  <div className="w-56 rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg">
                    {infoTooltip}
                    <div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                  </div>
                </div>
              </div>
              {subtitle && (
                <span className="text-sm text-gray-500">{subtitle}</span>
              )}
            </div>
          )}
          {onClick && (
            <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
          )}
        </div>
      </div>
    </div>
  );
});

const PLATFORM_KPI_KEYS = [
  "total_queries", "total_rows_read", "total_bytes_read", "total_compute_seconds",
  "total_jobs", "total_job_runs", "successful_runs", "active_notebooks",
  "active_workspaces", "models_served", "total_users",
] as const;

export function PlatformKPIsView({ data, isLoading, spendAnomalies, anomaliesLoading, startDate, endDate, enableAIFeatures = true }: PlatformKPIsViewProps) {
  const queryClient = useQueryClient();
  const [selectedKPI, setSelectedKPI] = useState<{
    kpi: "total_queries" | "total_rows_read" | "total_bytes_read" | "total_compute_seconds" | "total_jobs" | "total_job_runs" | "successful_runs" | "active_notebooks" | "active_workspaces" | "models_served" | "total_users" | "avg_query_duration" | "unique_warehouses";
    label: string;
  } | null>(null);

  // Pre-warm trend data in the background once dates are available
  useEffect(() => {
    if (!startDate || !endDate) return;
    for (const kpi of PLATFORM_KPI_KEYS) {
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
  const MINIMIZE_KEY = "cost-obs-minimize-kpis-info";
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

  if (isLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
        <p className="text-sm text-gray-500">Loading platform KPIs...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="flex h-32 flex-col items-center justify-center gap-2 text-gray-500">
          <p className="text-base font-medium">No platform KPI data available</p>
          <p className="text-sm">Try adjusting the date range or verify system tables are accessible</p>
        </div>
      </div>
    );
  }

  // Success rate requires job result state data from system.lakeflow tables
  // If successful_runs is 0 but we have job runs, it means we don't have the result state data
  const hasSuccessRateData = data.successful_runs > 0;

  const handleKPIClick = (kpi: "total_queries" | "total_rows_read" | "total_bytes_read" | "total_compute_seconds" | "total_jobs" | "total_job_runs" | "successful_runs" | "active_notebooks" | "active_workspaces" | "models_served" | "total_users" | "avg_query_duration" | "unique_warehouses", label: string) => {
    setSelectedKPI({ kpi, label });
  };

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Platform KPIs & Trends</h1>
          <p className="text-sm text-gray-500">Platform health, usage metrics, and adoption tracking</p>
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
            <button
              className="flex w-full items-center justify-between"
              onClick={() => handleMinimizeToggle(!infoMinimized)}
            >
              <h3 className="text-sm font-medium text-orange-800">Platform Health & Usage Metrics</h3>
              <svg className={`h-4 w-4 text-orange-500 transition-transform ${infoMinimized ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {!infoMinimized && (
              <>
                <div className="mt-2 text-sm text-orange-700">
                  <ul className="list-inside list-disc space-y-1">
                    <li><strong>Query & Data Processing</strong>: SQL query execution, data scanned, and compute time across all warehouses</li>
                    <li><strong>Jobs & Workflows</strong>: Automated job executions, success rates, and notebook usage</li>
                    <li><strong>Platform Utilization</strong>: Active workspaces, model serving endpoints, and overall user adoption</li>
                    <li>Click any metric card to view historical trends and patterns</li>
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

      {/* Query & Data Processing Metrics */}
      <div>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Query & Data Processing</h3>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <KPICard
            title="Total Queries Executed"
            value={formatNumber(data.total_queries)}
            subtitle={`${data.unique_query_users} unique users`}
            color="bg-orange-100"
            onClick={startDate && endDate ? () => handleKPIClick("total_queries", "Total Queries Executed") : undefined}
            icon={
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
              </svg>
            }
          />

          <KPICard
            title="Rows Processed"
            value={formatNumber(data.total_rows_read)}
            subtitle="Total data scanned"
            color="bg-orange-100"
            onClick={startDate && endDate ? () => handleKPIClick("total_rows_read", "Rows Processed") : undefined}
            icon={
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
            }
          />

          <KPICard
            title="Data Processed"
            value={formatBytes(data.total_bytes_read)}
            subtitle="Total throughput"
            color="bg-orange-100"
            onClick={startDate && endDate ? () => handleKPIClick("total_bytes_read", "Data Processed") : undefined}
            icon={
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            }
          />

          <KPICard
            title="Compute Time"
            value={formatDurationSeconds(data.total_compute_seconds)}
            subtitle="Total processing time"
            color="bg-orange-100"
            onClick={startDate && endDate ? () => handleKPIClick("total_compute_seconds", "Compute Time") : undefined}
            icon={
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />
        </div>
      </div>

      {/* Jobs & Workflows */}
      <div>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Jobs & Workflows</h3>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <KPICard
            title="Total Jobs"
            value={formatNumber(data.total_jobs)}
            subtitle={`${data.unique_job_owners} unique owners`}
            color="bg-orange-100"
            onClick={startDate && endDate ? () => handleKPIClick("total_jobs", "Total Jobs") : undefined}
            icon={
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            }
          />

          <KPICard
            title="Job Runs"
            value={formatNumber(data.total_job_runs)}
            subtitle="Total executions"
            color="bg-orange-100"
            onClick={startDate && endDate ? () => handleKPIClick("total_job_runs", "Job Runs") : undefined}
            icon={
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            }
          />

          <KPICard
            title="Successful Runs"
            value={hasSuccessRateData ? formatNumber(data.successful_runs) : "N/A"}
            subtitle={hasSuccessRateData ? `of ${formatNumber(data.total_job_runs)} total runs` : "Result states unavailable"}
            color={hasSuccessRateData ? "bg-orange-100" : "bg-gray-100"}
            onClick={startDate && endDate && hasSuccessRateData ? () => handleKPIClick("successful_runs", "Successful Runs") : undefined}
            icon={
              <svg className={`h-6 w-6 ${hasSuccessRateData ? "text-[#FF3621]" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            }
          />

          <KPICard
            title="Active Clusters"
            value={formatNumber(data.active_notebooks)}
            subtitle="Unique clusters with usage"
            color="bg-orange-100"
            onClick={startDate && endDate ? () => handleKPIClick("active_notebooks", "Active Clusters") : undefined}
            icon={
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            }
          />
        </div>
      </div>

      {/* Platform Utilization */}
      <div>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Platform Utilization</h3>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <KPICard
            title="Active Workspaces"
            value={formatNumber(data.active_workspaces)}
            subtitle="Collaborative environments"
            color="bg-orange-100"
            onClick={startDate && endDate ? () => handleKPIClick("active_workspaces", "Active Workspaces") : undefined}
            icon={
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
            }
          />

          {data.models_served > 0 && (
            <KPICard
              title="Models Served"
              value={formatNumber(data.models_served)}
              subtitle={`${formatNumber(data.total_serving_dbus)} DBUs`}
              color="bg-orange-100"
              onClick={startDate && endDate ? () => handleKPIClick("models_served", "Models Served") : undefined}
              icon={
                <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
              }
            />
          )}

          <KPICard
            title="Total Users"
            value={formatNumber(data.unique_query_users + data.unique_job_owners)}
            subtitle="Unique active users"
            infoTooltip="Distinct users who ran queries or jobs in the selected period. Counts unique query executors and unique job owners."
            color="bg-orange-100"
            onClick={startDate && endDate ? () => handleKPIClick("total_users", "Total Users") : undefined}
            icon={
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            }
          />
        </div>
      </div>

      {/* Spend Changes & Trends */}
      <SpendAnomalies data={spendAnomalies} isLoading={anomaliesLoading} enableAIFeatures={enableAIFeatures} />

      {/* Platform KPI Trend Modal */}
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
    </div>
  );
}
