import { useCallback, useEffect, useMemo, useState } from "react";
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
} from "recharts";
import type { AppsDashboardBundle, AppsApp, AppsConnectedArtifact, DateRange } from "@/types/billing";
import { useAppsDashboardBundle } from "@/hooks/useBillingData";
import { KPITrendModal } from "./KPITrendModal";
import { formatIdentity } from "@/utils/identity";

interface AppsCostCenterProps {
  data: AppsDashboardBundle | undefined;
  isLoading: boolean;
  host?: string | null;
  startDate?: string;
  endDate?: string;
  dateRange?: DateRange;
  enableHostingComparison?: boolean;
  workspaceNameMap?: Record<string, string>;
}

const APP_COLORS = ["#1B5162", "#06B6D4", "#10B981", "#14B8A6", "#F59E0B", "#3B82F6", "#EC4899", "#EF4444", "#6B7280", "#3B82F6"];

const PIE_COLORS = {
  active: "#10B981",   // green
  inactive: "#F59E0B", // amber
  historical: "#9CA3AF", // gray
};

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

// ── App Hosting Cost Comparison (Experimental) ────────────────────────────
// TCO data from Databricks Apps vs DIY Infrastructure battlecard.
// Hidden costs that DIY cloud deployments incur per-app, annualized.

interface InfraCostLine {
  label: string;
  lowPerApp: number;   // low estimate per app per year
  highPerApp: number;  // high estimate per app per year
  description: string;
  oneTime?: boolean;   // true = amortised over Year 1 only
}

const DIY_INFRA_COSTS: InfraCostLine[] = [
  { label: "Compute (EC2 m5.large equivalent)", lowPerApp: 840, highPerApp: 840, description: "On-demand EC2 m5.large, 24×7 ($0.096/hr)" },
  { label: "Load Balancer (ALB)", lowPerApp: 200, highPerApp: 400, description: "Application Load Balancer + data processing fees" },
  { label: "NAT Gateway", lowPerApp: 200, highPerApp: 400, description: "NAT gateway for outbound traffic in private subnets" },
  { label: "DevOps & CI/CD Setup", lowPerApp: 8000, highPerApp: 15000, description: "Container orchestration, pipelines, IaC (Year 1)", oneTime: true },
  { label: "Ongoing Maintenance", lowPerApp: 12000, highPerApp: 25000, description: "Patching, upgrades, on-call, incident response" },
  { label: "Security & Compliance", lowPerApp: 5000, highPerApp: 10000, description: "WAF, secrets management, vulnerability scanning (Year 1)", oneTime: true },
  { label: "Observability Stack", lowPerApp: 2500, highPerApp: 5000, description: "APM, logging, dashboards, alerting" },
  { label: "Databricks Data Access Layer", lowPerApp: 7000, highPerApp: 15000, description: "VPN/peering, auth integration for data access (Year 1)", oneTime: true },
];

function AppHostingComparison({
  appSpend,
  daysInRange,
  appName,
}: {
  appSpend: number;
  daysInRange: number;
  appName: string;
}) {
  const [expanded, setExpanded] = useState(false);

  // Annualize this single app's spend from the selected range
  const annualDatabricksSpend = daysInRange > 0 ? (appSpend / daysInRange) * 365 : appSpend * 12;

  // DIY cost estimates for 1 app (Year 1 — includes one-time costs)
  const diyLow = DIY_INFRA_COSTS.reduce((sum, c) => sum + c.lowPerApp, 0);
  const diyHigh = DIY_INFRA_COSTS.reduce((sum, c) => sum + c.highPerApp, 0);
  const diyMid = (diyLow + diyHigh) / 2;

  // Savings
  const savingsLow = diyLow - annualDatabricksSpend;
  const savingsHigh = diyHigh - annualDatabricksSpend;
  const savingsPercent = diyMid > 0 ? ((diyMid - annualDatabricksSpend) / diyMid) * 100 : 0;

  // Bar widths relative to diyHigh
  const maxVal = Math.max(diyHigh, annualDatabricksSpend);
  const databricksBarPct = maxVal > 0 ? (annualDatabricksSpend / maxVal) * 100 : 0;
  const diyLowBarPct = maxVal > 0 ? (diyLow / maxVal) * 100 : 0;
  const diyHighBarPct = maxVal > 0 ? (diyHigh / maxVal) * 100 : 0;

  return (
    <div className="rounded-lg border-2 border-dashed border-amber-300 bg-amber-50/50 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100">
            <svg className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-gray-900">App Hosting Cost Comparison</h3>
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700 border border-amber-200">
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                </svg>
                Experimental
              </span>
            </div>
            <p className="text-sm text-gray-500">
              What would it cost to self-host <strong>{appName}</strong>?
            </p>
          </div>
        </div>
      </div>

      {/* Visual comparison bars */}
      <div className="mt-5 space-y-3">
        {/* Databricks Apps bar */}
        <div>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium text-gray-700">Databricks Apps (Actual)</span>
            <span className="font-semibold text-gray-900">{formatCurrency(annualDatabricksSpend)}<span className="text-xs font-normal text-gray-500">/yr</span></span>
          </div>
          <div className="h-8 w-full rounded-md bg-gray-100 overflow-hidden">
            <div
              className="flex h-full items-center rounded-md px-3 transition-all duration-500"
              style={{ width: `${Math.max(databricksBarPct, 5)}%`, backgroundColor: '#FF3621' }}
            >
              <span className="text-xs font-medium text-white whitespace-nowrap">
                All-inclusive
              </span>
            </div>
          </div>
        </div>

        {/* DIY bar (range) */}
        <div>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium text-gray-700">Self-Hosted DIY (Estimated)</span>
            <span className="font-semibold text-gray-900">{formatCurrency(diyLow)} – {formatCurrency(diyHigh)}<span className="text-xs font-normal text-gray-500">/yr</span></span>
          </div>
          <div className="relative h-8 w-full rounded-md bg-gray-100 overflow-hidden">
            {/* Low end */}
            <div
              className="absolute inset-y-0 left-0 rounded-md bg-gray-400 opacity-50"
              style={{ width: `${Math.max(diyHighBarPct, 5)}%` }}
            />
            <div
              className="absolute inset-y-0 left-0 flex items-center rounded-md bg-gray-500 px-3"
              style={{ width: `${Math.max(diyLowBarPct, 5)}%` }}
            >
              <span className="text-xs font-medium text-white whitespace-nowrap">
                Compute + infra + people
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Savings callout */}
      {savingsLow > 0 && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm font-medium text-green-800">
              Estimated savings: {formatCurrency(savingsLow)} – {formatCurrency(savingsHigh)}/yr ({savingsPercent.toFixed(0)}% lower TCO with Databricks Apps)
            </p>
          </div>
        </div>
      )}

      {/* Expand / collapse detail */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-4 flex items-center gap-1 text-sm font-medium text-amber-700 hover:text-amber-900"
      >
        {expanded ? "Hide" : "Show"} cost breakdown
        <svg className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-3 animate-fade-in">
          {/* Infrastructure cost breakdown table */}
          <div className="overflow-hidden rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Infrastructure Component</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Est. Cost/yr</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {DIY_INFRA_COSTS.map((cost) => (
                  <tr key={cost.label} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-800">
                      {cost.label}
                      {cost.oneTime && (
                        <span className="ml-1.5 inline-flex rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 border border-blue-200">
                          Year 1
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-medium text-gray-900">
                      {formatCurrency(cost.lowPerApp)}{cost.lowPerApp !== cost.highPerApp ? ` – ${formatCurrency(cost.highPerApp)}` : ""}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">{cost.description}</td>
                  </tr>
                ))}
                {/* Totals row */}
                <tr className="bg-gray-50 font-semibold">
                  <td className="px-4 py-2 text-gray-900">DIY Total (Year 1)</td>
                  <td className="px-4 py-2 text-right text-gray-900">
                    {formatCurrency(diyLow)} – {formatCurrency(diyHigh)}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">Includes one-time + recurring</td>
                </tr>
                {/* Databricks Apps row */}
                <tr style={{ backgroundColor: '#FFF7ED' }}>
                  <td className="px-4 py-2 font-semibold" style={{ color: '#FF3621' }}>Databricks Apps (Actual)</td>
                  <td className="px-4 py-2 text-right font-semibold" style={{ color: '#FF3621' }}>
                    {formatCurrency(annualDatabricksSpend)}
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">Compute, infra, security, data access — all included</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Explanatory note */}
          <div className="mt-3 rounded-lg border border-gray-200 bg-white px-4 py-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">What's included in Databricks Apps</h4>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-600">
              <div className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                Managed compute & auto-scaling
              </div>
              <div className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                Built-in load balancing
              </div>
              <div className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                Zero DevOps overhead
              </div>
              <div className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                Native data access (Unity Catalog)
              </div>
              <div className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                Enterprise security & SSO
              </div>
              <div className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                Observability & audit logging
              </div>
            </div>
          </div>

          <p className="mt-3 text-[11px] text-gray-500 italic">
            Estimates based on AWS EC2 (m5.large) on-demand pricing and typical enterprise infrastructure costs.
            Year 1 includes one-time setup costs for DevOps, security, and data access layers.
            Actual costs vary by organization size, compliance requirements, and engineering team rates.
          </p>
        </div>
      )}
    </div>
  );
}

export function AppsCostCenter({ data: initialData, isLoading: initialLoading, host, startDate, endDate, dateRange, enableHostingComparison, workspaceNameMap }: AppsCostCenterProps) {
  const MINIMIZE_KEY = "cost-obs-minimize-apps-info";

  const [infoMinimized, setInfoMinimized] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(MINIMIZE_KEY) === "true";
    }
    return false;
  });

  const [selectedKPI, setSelectedKPI] = useState<{kpi: string; label: string} | null>(null);
  const [selectedApp, setSelectedApp] = useState<AppsApp | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<string[]>([]);
  const [wsFilterOpen, setWsFilterOpen] = useState(false);
  const [wsFilterSearch, setWsFilterSearch] = useState("");
  const [appsPage, setAppsPage] = useState(1);
  const APPS_PAGE_SIZE = 40;
  const [artifactTypeFilter, setArtifactTypeFilter] = useState<string | null>(null);
  const [artifactSearch, setArtifactSearch] = useState("");
  const [artifactPage, setArtifactPage] = useState(1);
  const artifactsPerPage = 10;

  const { data: freshData, isLoading: freshLoading } = useAppsDashboardBundle(dateRange, true);

  const data = freshData ?? initialData;
  const isLoading = freshLoading || initialLoading;

  // Close workspace filter dropdown on outside click
  useEffect(() => {
    if (!wsFilterOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-ws-filter-dropdown]")) {
        setWsFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [wsFilterOpen]);

  const handleToggleWorkspace = useCallback((ws: string) => {
    setSelectedWorkspaces(prev =>
      prev.includes(ws) ? prev.filter(w => w !== ws) : [...prev, ws]
    );
  }, []);

  // Pre-warm trend queries so modals open instantly (uses apps-specific endpoint)
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!startDate || !endDate) return;
    for (const kpi of ["apps_spend", "apps_dbus", "apps_count"]) {
      queryClient.prefetchQuery({
        queryKey: ["apps-kpi-trend", kpi, startDate, endDate, "daily"],
        queryFn: async () => {
          const params = new URLSearchParams({ kpi, start_date: startDate, end_date: endDate, granularity: "daily" });
          const res = await fetch(`/api/apps/kpi-trend?${params}`);
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

  // Build stable color map for app names across charts
  const appColorMap = useMemo(() => {
    const map: Record<string, string> = {};
    let idx = 0;
    const allNames = new Set<string>();
    for (const app of data?.apps?.apps || []) {
      allNames.add(app.app_name);
    }
    for (const cat of data?.timeseries?.categories || []) {
      if (cat !== "Other") allNames.add(cat);
    }
    for (const name of allNames) {
      map[name] = APP_COLORS[idx % APP_COLORS.length];
      idx++;
    }
    map["Other"] = "#D1D5DB";
    return map;
  }, [data?.apps, data?.timeseries]);

  // Resolve workspace names: prefer backend name, then billing data map, then raw ID
  const resolveWsName = useCallback((wsId: string) => {
    // Check backend workspace objects first
    const backendWs = data?.workspaces?.find(w => w.id === wsId);
    if (backendWs?.name && backendWs.name !== wsId) return backendWs.name;
    // Fall back to billing data name map
    return workspaceNameMap?.[wsId] || wsId;
  }, [data?.workspaces, workspaceNameMap]);

  // Available workspaces for filtering (resolved to names)
  const availableWorkspaces = useMemo(() => {
    if (!data?.workspaces) return [];
    return data.workspaces.map(ws => ({
      id: ws.id,
      name: (ws.name && ws.name !== ws.id) ? ws.name : (workspaceNameMap?.[ws.id] || ws.id),
    })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data?.workspaces, workspaceNameMap]);

  // Filter apps by search query and workspace
  const filteredApps = useMemo(() => {
    if (!data?.apps?.apps) return [];
    let apps = data.apps.apps;
    if (selectedWorkspaces.length > 0) {
      apps = apps.filter(a =>
        a.workspace_names?.some(ws => selectedWorkspaces.includes(ws))
      );
    }
    if (!searchQuery.trim()) return apps;
    const q = searchQuery.toLowerCase();
    return apps.filter(
      (a) => a.app_name.toLowerCase().includes(q) || a.app_id.toLowerCase().includes(q)
    );
  }, [data?.apps, searchQuery, selectedWorkspaces]);

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setAppsPage(1);
  }, [searchQuery, selectedWorkspaces]);

  const totalAppsPages = Math.ceil(filteredApps.length / APPS_PAGE_SIZE);
  const effectiveAppsPage = Math.min(appsPage, Math.max(1, totalAppsPages));
  const paginatedApps = filteredApps.slice((effectiveAppsPage - 1) * APPS_PAGE_SIZE, effectiveAppsPage * APPS_PAGE_SIZE);

  // Build pie chart data: Active vs Inactive vs Historical (unregistered)
  const pieData = useMemo(() => {
    if (!data?.apps) return [];
    const appsData = data.apps;
    const slices: { name: string; value: number; fill: string; count: number }[] = [];

    if (appsData.active_count > 0) {
      slices.push({
        name: "Active",
        value: appsData.active_count,
        fill: PIE_COLORS.active,
        count: appsData.active_count,
      });
    }
    if (appsData.inactive_count > 0) {
      slices.push({
        name: "Inactive",
        value: appsData.inactive_count,
        fill: PIE_COLORS.inactive,
        count: appsData.inactive_count,
      });
    }
    if (appsData.unregistered_summary.count > 0) {
      slices.push({
        name: "Historical",
        value: appsData.unregistered_summary.count,
        fill: PIE_COLORS.historical,
        count: appsData.unregistered_summary.count,
      });
    }
    return slices;
  }, [data?.apps]);

  // Daily timeseries (raw from API, matches date picker range)
  const dailyTimeseries = useMemo(() => {
    if (!data?.timeseries?.timeseries?.length) return [];
    return data.timeseries.timeseries;
  }, [data?.timeseries]);

  if (isLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
        <p className="text-sm text-gray-500">Loading Apps data...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-6">
        <div className="flex flex-col items-center justify-center gap-2 py-4">
          <p className="text-base font-medium text-yellow-800">No Apps cost data available</p>
          <p className="text-sm text-yellow-700">Try expanding the date range, or check that Databricks Apps are deployed and active</p>
        </div>
      </div>
    );
  }

  const summary = data.summary;
  const appsData = data.apps;
  const unregisteredSummary = appsData.unregistered_summary;

  const hostBase = host ? (host.startsWith("http") ? host.replace(/\/$/, "") : `https://${host.replace(/\/$/, "")}`) : null;

  /** Live app endpoint URL (the running frontend). */
  const liveEndpoint = (app: AppsApp) => app.app_url || null;

  /** Backend deployment page in the Databricks workspace. */
  const deploymentUrl = (app: AppsApp) =>
    hostBase ? `${hostBase}/apps/${app.app_name}` : null;

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Apps</h1>
          <p className="text-sm text-gray-500">Databricks Apps compute cost attribution and trends</p>
        </div>
      </div>

      {/* Info Banner */}
      <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
        <div className="flex">
          <div className="shrink-0">
            <svg className="h-5 w-5 text-orange-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3 flex-1">
            <button className="flex w-full items-center justify-between" onClick={() => handleMinimizeToggle(!infoMinimized)}>
              <h3 className="text-sm font-medium text-orange-800">About Databricks Apps Costs</h3>
              <svg className={`h-4 w-4 text-orange-500 transition-transform ${infoMinimized ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {!infoMinimized && (
              <>
                <div className="mt-2 text-sm text-orange-700">
                  <ul className="list-inside list-disc space-y-1">
                    <li><strong>Databricks Apps</strong>: Custom web applications deployed and hosted on Databricks</li>
                    <li><strong>Active apps</strong>: Apps with compute usage in the last 7 days of the selected range</li>
                    <li><strong>Inactive apps</strong>: Deployed but no recent compute usage (may still be running at idle)</li>
                    <li><strong>Historical apps</strong>: Billing entries with no matching deployed app (deleted or from other workspaces)</li>
                    <li>Costs tracked per-app from <code className="bg-orange-100 px-1 rounded">system.billing.usage</code></li>
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

      {/* Summary Cards with click-to-trend */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({kpi: "apps_spend", label: "Total Apps Spend"})}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Apps Spend</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(summary.total_spend)}</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({kpi: "apps_dbus", label: "Total DBUs"})}
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
          onClick={() => startDate && endDate && setSelectedKPI({kpi: "apps_count", label: "Active Apps"})}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Apps</p>
              <p className="text-2xl font-semibold text-gray-900">{formatNumber(summary.app_count)}</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({kpi: "apps_spend", label: "Avg Daily Spend"})}
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
          variant="apps"
        />
      )}

      {/* App Status Breakdown + Spend Over Time — side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* App Status Breakdown — Pie Chart */}
        {pieData.length > 0 && (
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">App Status Breakdown</h3>
            <div className="flex flex-col items-center gap-6 md:flex-row md:items-start">
              <ResponsiveContainer width="100%" height={250} className="max-w-xs">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={2}
                    dataKey="value"
                    nameKey="name"
                    label={false}
                    labelLine={false}
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number | undefined) => formatNumber(value ?? 0)} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-col gap-3 text-sm">
                <div className="flex items-center gap-3">
                  <div className="h-3 w-3 rounded-full" style={{ backgroundColor: PIE_COLORS.active }} />
                  <div>
                    <span className="font-medium text-gray-900">{formatNumber(appsData.active_count)} Active</span>
                    <p className="text-xs text-gray-500">Apps with compute usage in the last 7 days</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-3 w-3 rounded-full" style={{ backgroundColor: PIE_COLORS.inactive }} />
                  <div>
                    <span className="font-medium text-gray-900">{formatNumber(appsData.inactive_count)} Inactive</span>
                    <p className="text-xs text-gray-500">Deployed but no recent compute usage (may still be running at idle)</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-3 w-3 rounded-full" style={{ backgroundColor: PIE_COLORS.historical }} />
                  <div>
                    <span className="font-medium text-gray-900">{formatNumber(unregisteredSummary.count)} Historical</span>
                    <p className="text-xs text-gray-500">Deleted or unregistered — exist in billing system tables only</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Spend Over Time — daily */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Apps Spend Over Time</h3>
          {dailyTimeseries.length > 0 ? (
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={dailyTimeseries} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) => {
                    const d = new Date(date);
                    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  }}
                  stroke="#9ca3af"
                  fontSize={12}
                  tickMargin={8}
                />
                <YAxis
                  tickFormatter={(value) => formatCurrency(value)}
                  width={70}
                  stroke="#9ca3af"
                  fontSize={12}
                />
                <Tooltip
                  formatter={(value: any) => formatCurrency(Number(value))}
                  labelFormatter={(label) => {
                    const d = new Date(label);
                    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="Total"
                  stroke="#FF3621"
                  fill="#FF3621"
                  fillOpacity={0.15}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-gray-500">No timeseries data</div>
          )}
        </div>
      </div>

      {/* App Grid — each app is a clickable tile */}
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="shrink-0 text-lg font-semibold text-gray-900">
            Apps by Spend
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({appsData.total_app_count} app{appsData.total_app_count !== 1 ? "s" : ""})
            </span>
          </h3>
          <div className="flex items-center gap-2">
            {/* Workspace filter */}
            {availableWorkspaces.length > 1 && (
              <div className="relative" data-ws-filter-dropdown>
                <button
                  onClick={() => { setWsFilterOpen(!wsFilterOpen); setWsFilterSearch(""); }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                  </svg>
                  Workspace
                  {selectedWorkspaces.length > 0 && (
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: '#FF3621' }}>
                      {selectedWorkspaces.length}
                    </span>
                  )}
                </button>
                {wsFilterOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg">
                    <div className="p-2">
                      <input
                        type="text"
                        value={wsFilterSearch}
                        onChange={(e) => setWsFilterSearch(e.target.value)}
                        placeholder="Search workspaces..."
                        className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-60 overflow-y-auto py-1">
                      {availableWorkspaces
                        .filter(ws => !wsFilterSearch || ws.name.toLowerCase().includes(wsFilterSearch.toLowerCase()))
                        .map(ws => (
                          <button
                            key={ws.id}
                            onClick={() => handleToggleWorkspace(ws.id)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                          >
                            <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selectedWorkspaces.includes(ws.id) ? "border-orange-500 bg-orange-500" : "border-gray-300"}`}>
                              {selectedWorkspaces.includes(ws.id) && (
                                <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                            <span className="truncate text-xs text-gray-700">{ws.name}</span>
                          </button>
                        ))}
                      {availableWorkspaces.filter(ws => !wsFilterSearch || ws.name.toLowerCase().includes(wsFilterSearch.toLowerCase())).length === 0 && (
                        <div className="px-3 py-2 text-sm text-gray-500">No matching workspaces</div>
                      )}
                    </div>
                    {selectedWorkspaces.length > 0 && (
                      <div className="border-t border-gray-200 p-2">
                        <button onClick={() => setSelectedWorkspaces([])} className="w-full rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100">
                          Clear all
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {/* Search */}
            <div className="relative">
              <svg className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search apps..."
                className="w-48 rounded-md border border-gray-300 py-1.5 pl-8 pr-3 text-xs text-gray-700 placeholder-gray-400 focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            {selectedApp && (
              <button
                onClick={() => setSelectedApp(null)}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                ← Back to grid
              </button>
            )}
          </div>
        </div>
        {/* Workspace filter pills */}
        {selectedWorkspaces.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {selectedWorkspaces.map(wsId => (
              <span key={wsId} className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: '#FF3621' }}>
                {resolveWsName(wsId)}
                <button onClick={() => handleToggleWorkspace(wsId)} className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-white/20">
                  <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
            <button onClick={() => setSelectedWorkspaces([])} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
          </div>
        )}

        {/* Detail panel — shown when an app is selected */}
        {selectedApp && (
          <div className="mb-6 animate-fade-in rounded-lg border border-gray-200 bg-gray-50 p-5">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div
                  className="flex h-12 w-12 items-center justify-center rounded-lg text-white text-sm font-bold"
                  style={{ backgroundColor: appColorMap[selectedApp.app_name] || APP_COLORS[0] }}
                >
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                  </svg>
                </div>
                <div>
                  <h4 className="text-base font-semibold text-gray-900">{selectedApp.app_name}</h4>
                  {selectedApp.app_name !== selectedApp.app_id && (
                    <p className="text-[10px] text-gray-500 font-mono">{selectedApp.app_id}</p>
                  )}
                  <div className="flex items-center gap-3">
                    {liveEndpoint(selectedApp) && (
                      <a
                        href={liveEndpoint(selectedApp)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-[#FF3621] hover:underline"
                      >
                        Live App Endpoint →
                      </a>
                    )}
                    {deploymentUrl(selectedApp) && (
                      <a
                        href={deploymentUrl(selectedApp)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-600 hover:underline"
                      >
                        Backend Deployment →
                      </a>
                    )}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedApp(null)}
                className="rounded p-1 text-gray-500 hover:bg-gray-200 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-md bg-white p-3 border border-gray-200">
                <p className="text-xs text-gray-500">Spend</p>
                <p className="text-lg font-semibold text-gray-900">{formatCurrency(selectedApp.total_spend)}</p>
              </div>
              <div className="rounded-md bg-white p-3 border border-gray-200">
                <p className="text-xs text-gray-500">DBUs</p>
                <p className="text-lg font-semibold text-gray-900">{formatNumber(selectedApp.total_dbus)}</p>
              </div>
              <div className="rounded-md bg-white p-3 border border-gray-200">
                <p className="text-xs text-gray-500">Days Active</p>
                <p className="text-lg font-semibold text-gray-900">{selectedApp.days_active}</p>
              </div>
              <div className="rounded-md bg-white p-3 border border-gray-200">
                <p className="text-xs text-gray-500">Last Usage</p>
                <p className="text-lg font-semibold text-gray-900">
                  {selectedApp.last_usage_date
                    ? new Date(selectedApp.last_usage_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                    : "—"}
                </p>
              </div>
            </div>

            {/* SKU Cost Breakdown */}
            {selectedApp.sku_breakdown && selectedApp.sku_breakdown.length > 0 && (
              <div className="mt-4">
                <h5 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Cost Breakdown by SKU</h5>
                <div className="space-y-2">
                  {selectedApp.sku_breakdown.map((sku) => (
                    <div key={sku.sku_name} className="rounded-md border border-gray-200 bg-white px-3 py-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-gray-800">{sku.sku_name}</span>
                        <span className="text-xs font-semibold text-gray-900">{formatCurrency(sku.total_spend)}</span>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <div className="h-1.5 flex-1 rounded-full bg-gray-100">
                          <div
                            className="h-1.5 rounded-full"
                            style={{ width: `${Math.min(sku.percentage, 100)}%`, backgroundColor: '#FF3621' }}
                          />
                        </div>
                        <span className="text-[10px] text-gray-500">{sku.percentage.toFixed(1)}%</span>
                      </div>
                      <p className="mt-0.5 text-[10px] text-gray-500">{formatNumber(sku.total_dbus)} DBUs</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Per-app hosting cost comparison — experimental */}
            {enableHostingComparison && (
              <div className="mt-4 space-y-3">
                <div className="flex items-start gap-3 rounded-lg border border-orange-300 bg-orange-50 px-4 py-3">
                  <svg className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                  </svg>
                  <div>
                    <p className="text-sm font-semibold text-orange-800">Experimental Feature</p>
                    <p className="mt-0.5 text-xs text-orange-700">
                      Hosting cost comparisons are estimates based on industry benchmarks and may not reflect actual infrastructure costs.
                    </p>
                  </div>
                </div>
                <AppHostingComparison
                  appSpend={selectedApp.total_spend}
                  daysInRange={summary.days_in_range}
                  appName={selectedApp.app_name}
                />
              </div>
            )}

            <div className="mt-3 flex items-center gap-4 text-xs text-gray-500">
              <span>{selectedApp.percentage.toFixed(1)}% of total spend</span>
              <span>Workspace count: {selectedApp.workspace_count}</span>
              {!selectedApp.is_registered && (
                <span className="rounded bg-yellow-100 px-1.5 py-0.5 text-yellow-700">Not in Apps registry — may be deleted</span>
              )}
            </div>
          </div>
        )}

        {/* Tile grid */}
        {filteredApps.length > 0 ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
            {paginatedApps.map((app, idx) => {
              const isSelected = selectedApp?.app_id === app.app_id;
              const color = appColorMap[app.app_name] || APP_COLORS[idx % APP_COLORS.length];
              const isResolved = app.app_name !== app.app_id;

              // Scale icon size linearly based on spend (min 32px, max 56px)
              const maxSpend = filteredApps[0]?.total_spend || 1;
              const minSize = 32;
              const maxSize = 56;
              const ratio = maxSpend > 0 ? app.total_spend / maxSpend : 0;
              const iconSize = Math.round(minSize + ratio * (maxSize - minSize));

              return (
                <button
                  key={app.app_id}
                  onClick={() => setSelectedApp(isSelected ? null : app)}
                  className={`group relative flex flex-col items-center justify-center rounded-lg border-2 p-3 transition-all hover:shadow-md ${
                    isSelected
                      ? "border-[#FF3621] shadow-md scale-105"
                      : "border-gray-200 hover:border-gray-300"
                  }`}
                  title={`${app.app_name}${isResolved ? ` (${app.app_id})` : ""}\n${formatCurrency(app.total_spend)} · ${app.days_active}d active`}
                >
                  {/* App icon — letter avatar */}
                  <div
                    className="flex items-center justify-center rounded-md text-white transition-transform group-hover:scale-110"
                    style={{ backgroundColor: color, width: iconSize, height: iconSize }}
                  >
                    <span className="font-bold select-none" style={{ fontSize: Math.max(14, iconSize * 0.4) }}>
                      {(app.app_name || app.app_id || "?").charAt(0).toUpperCase()}
                    </span>
                  </div>
                  {/* App name */}
                  <span className="mt-1.5 w-full truncate text-center text-[10px] font-medium text-gray-700">
                    {app.app_name}
                  </span>
                  {/* Spend label */}
                  <span className="text-[9px] text-gray-500">
                    {formatCurrency(app.total_spend)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center text-gray-500">
            {searchQuery ? `No apps matching "${searchQuery}"` : "No apps found"}
          </div>
        )}

        {/* Pagination */}
        {filteredApps.length > 0 && (
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {filteredApps.length} app{filteredApps.length !== 1 ? "s" : ""}
              {searchQuery ? ` matching "${searchQuery}"` : ""}
            </span>
            {totalAppsPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setAppsPage(p => Math.max(1, p - 1))}
                  disabled={effectiveAppsPage === 1}
                  className="rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ‹ Prev
                </button>
                <span className="px-2 text-xs text-gray-500">{effectiveAppsPage} / {totalAppsPages}</span>
                <button
                  onClick={() => setAppsPage(p => Math.min(totalAppsPages, p + 1))}
                  disabled={effectiveAppsPage >= totalAppsPages}
                  className="rounded border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next ›
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Connected Artifacts */}
      {data?.connected_artifacts && data.connected_artifacts.length > 0 && (() => {
        const artifactTypes = [...new Set(data.connected_artifacts.map((a: AppsConnectedArtifact) => a.artifact_type))].filter((t: string) => t && t !== 'UNKNOWN' && t !== 'Unknown').sort();
        let filteredArtifacts = artifactTypeFilter
          ? data.connected_artifacts.filter((a: AppsConnectedArtifact) => a.artifact_type === artifactTypeFilter)
          : data.connected_artifacts;
        if (artifactSearch) {
          const q = artifactSearch.toLowerCase();
          filteredArtifacts = filteredArtifacts.filter((a: AppsConnectedArtifact) =>
            a.app_name?.toLowerCase().includes(q) ||
            a.artifact_name?.toLowerCase().includes(q) ||
            a.artifact_type?.toLowerCase().includes(q) ||
            a.artifact_description?.toLowerCase().includes(q)
          );
        }
        const totalArtifactPages = Math.ceil(filteredArtifacts.length / artifactsPerPage);
        const safePage = Math.min(artifactPage, totalArtifactPages || 1);
        const paginatedArtifacts = filteredArtifacts.slice((safePage - 1) * artifactsPerPage, safePage * artifactsPerPage);

        return (
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Connected Artifacts</h3>
            <p className="mb-3 text-xs text-gray-500">Model serving endpoints, SQL warehouses, and other Databricks resources used by deployed apps.</p>

            {/* Filter buttons */}
            <div className="mb-4 flex flex-wrap gap-2">
              <button
                onClick={() => { setArtifactTypeFilter(null); setArtifactPage(1); }}
                className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  !artifactTypeFilter ? 'text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
                style={!artifactTypeFilter ? { backgroundColor: '#FF3621' } : undefined}
              >
                All ({data.connected_artifacts.length})
              </button>
              {artifactTypes.map((type: string) => {
                const count = data.connected_artifacts.filter((a: AppsConnectedArtifact) => a.artifact_type === type).length;
                const isActive = artifactTypeFilter === type;
                return (
                  <button
                    key={type}
                    onClick={() => { setArtifactTypeFilter(isActive ? null : type); setArtifactPage(1); }}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      isActive ? 'text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                    style={isActive ? { backgroundColor: '#FF3621' } : undefined}
                  >
                    {type.replace(/_/g, ' ')} ({count})
                  </button>
                );
              })}
            </div>

            {/* Search */}
            <div className="mb-4 relative">
              <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                value={artifactSearch}
                onChange={(e) => { setArtifactSearch(e.target.value); setArtifactPage(1); }}
                placeholder="Search artifacts..."
                className="w-full rounded-md border border-gray-300 py-2 pl-10 pr-3 text-sm text-gray-700 placeholder-gray-400 focus:border-[#FF3621] focus:outline-none focus:ring-1 focus:ring-[#FF3621]"
              />
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full">
                <thead className="bg-gray-50">
                  <tr className="border-b border-gray-200">
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">App</th>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Artifact Name</th>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Artifact Type</th>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {paginatedArtifacts.map((artifact: AppsConnectedArtifact, idx: number) => {
                    const artifactUrl = hostBase ? (
                      artifact.artifact_type === 'SERVING_ENDPOINT' ? `${hostBase}/ml/endpoints/${artifact.artifact_name}` :
                      artifact.artifact_type === 'SQL_WAREHOUSE' ? `${hostBase}/sql/warehouses/${artifact.artifact_name}` :
                      artifact.artifact_type === 'JOB' ? `${hostBase}/jobs/${artifact.artifact_name}` :
                      artifact.artifact_type === 'SECRET' ? `${hostBase}/secrets/scopes` :
                      null
                    ) : null;

                    const na = (v: string | null | undefined) => (!v || v === 'Unknown' || v === 'UNKNOWN') ? 'N/A' : v;
                    const displayType = na(artifact.artifact_type);
                    const appBackendUrl = hostBase && artifact.app_name ? `${hostBase}/apps/${artifact.app_name}` : null;

                    const isSP = artifact.artifact_type === 'SERVICE_PRINCIPAL';
                    const displayName = isSP ? formatIdentity(artifact.artifact_name) : na(artifact.artifact_name);

                    return (
                      <tr key={`${artifact.app_id}-${artifact.artifact_name}-${idx}`} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-3 py-3 text-sm font-medium">
                          {appBackendUrl ? (
                            <a href={appBackendUrl} target="_blank" rel="noopener noreferrer" className="group flex items-center gap-1 text-[#FF3621] hover:text-[#E02F1C]">
                              <span>{na(artifact.app_name)}</span>
                              <svg className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                            </a>
                          ) : (
                            <span className="text-gray-900">{na(artifact.app_name)}</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-sm">
                          <div className="flex flex-col gap-0.5">
                            {artifactUrl ? (
                              <a href={artifactUrl} target="_blank" rel="noopener noreferrer" className="group flex items-center gap-1 font-medium text-[#FF3621] hover:text-[#E02F1C]">
                                <span title={artifact.artifact_name}>{displayName}</span>
                                <svg className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                </svg>
                              </a>
                            ) : (
                              <span className="text-gray-700" title={artifact.artifact_name}>{displayName}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${
                            artifact.artifact_type === 'SERVING_ENDPOINT' ? 'bg-blue-50 text-blue-700' :
                            artifact.artifact_type === 'SQL_WAREHOUSE' ? 'bg-blue-100 text-blue-700' :
                            artifact.artifact_type === 'SECRET' ? 'bg-yellow-100 text-yellow-700' :
                            artifact.artifact_type === 'JOB' ? 'bg-green-100 text-green-700' :
                            artifact.artifact_type === 'SERVICE_PRINCIPAL' ? 'bg-orange-100 text-orange-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>
                            {displayType.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-sm text-gray-500">{na(artifact.artifact_description)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalArtifactPages > 1 && (
              <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
                <p className="text-sm text-gray-500">
                  Showing {(safePage - 1) * artifactsPerPage + 1}–{Math.min(safePage * artifactsPerPage, filteredArtifacts.length)} of {filteredArtifacts.length}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setArtifactPage(Math.max(1, safePage - 1))}
                    disabled={safePage === 1}
                    className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Previous
                  </button>
                  {Array.from({ length: totalArtifactPages }, (_, i) => i + 1)
                    .filter((p) => p === 1 || p === totalArtifactPages || (p >= safePage - 1 && p <= safePage + 1))
                    .map((p, idx, arr) => {
                      const prev = arr[idx - 1];
                      const showEllipsis = prev && p - prev > 1;
                      return (
                        <span key={p} className="flex items-center">
                          {showEllipsis && <span className="px-2 py-1 text-gray-500">...</span>}
                          <button
                            onClick={() => setArtifactPage(p)}
                            className={`rounded px-3 py-1 text-sm font-medium ${
                              safePage === p ? 'text-white' : 'border border-gray-300 text-gray-700 hover:bg-gray-50'
                            }`}
                            style={safePage === p ? { backgroundColor: '#FF3621' } : undefined}
                          >
                            {p}
                          </button>
                        </span>
                      );
                    })}
                  <button
                    onClick={() => setArtifactPage(Math.min(totalArtifactPages, safePage + 1))}
                    disabled={safePage === totalArtifactPages}
                    className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })()}

    </div>
  );
}
