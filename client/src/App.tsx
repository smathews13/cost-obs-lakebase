import React, { useState, useEffect, useMemo, lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { TabRefreshButton } from "@/components/TabRefreshButton";
import { SetupWizard } from "@/components/SetupWizard";
import { SummaryCards } from "@/components/SummaryCards";
import { PermissionsDialog } from "@/components/PermissionsDialog";
import { SpendChart } from "@/components/SpendChart";
import { ProductBreakdown } from "@/components/ProductBreakdown";
import { WorkspaceTable } from "@/components/WorkspaceTable";
import { PipelineObjectsTable } from "@/components/PipelineObjectsTable";
import { DateRangePicker } from "@/components/DateRangePicker";
import { SKUBreakdown } from "@/components/SKUBreakdown";
import { ExportDialog, type ExportSections } from "@/components/ExportDialog";
import { SettingsDialog, loadTabVisibility, loadAppSettings, type TabVisibility, type AppSettings } from "@/components/SettingsDialog";
import { PricingProvider, usePricing } from "@/context/PricingContext";
import { Footer } from "@/components/Footer";
import awsLogo from "@/assets/aws.png";
import azureLogo from "@/assets/azure.png";
import gcpLogo from "@/assets/gcp.svg";

// Retry a dynamic import once on failure (handles cold-start chunk load errors)
function lazyWithRetry<T>(factory: () => Promise<T>): Promise<T> {
  return factory().catch(() => factory());
}

// Lazy-loaded tab views — only downloaded when the user first visits that tab
const InteractiveBreakdown = lazy(() => lazyWithRetry(() => import("@/components/InteractiveBreakdown").then(m => ({ default: m.InteractiveBreakdown }))));
const CloudCostsView = lazy(() => lazyWithRetry(() => import("@/components/CloudCostsView").then(m => ({ default: m.CloudCostsView }))));
const GenieChatView = lazy(() => lazyWithRetry(() => import("@/components/GenieChatView").then(m => ({ default: m.GenieChatView }))));
const PlatformKPIsView = lazy(() => lazyWithRetry(() => import("@/components/PlatformKPIsView").then(m => ({ default: m.PlatformKPIsView }))));
const AIMLCostCenter = lazy(() => lazyWithRetry(() => import("@/components/AIMLCostCenter").then(m => ({ default: m.AIMLCostCenter }))));
const AppsCostCenter = lazy(() => lazyWithRetry(() => import("@/components/AppsCostCenter").then(m => ({ default: m.AppsCostCenter }))));
const TaggingHub = lazy(() => lazyWithRetry(() => import("@/components/TaggingHub").then(m => ({ default: m.TaggingHub }))));
const SQLWarehousing360 = lazy(() => lazyWithRetry(() => import("@/components/SQLWarehousing360").then(m => ({ default: m.SQLWarehousing360 }))));
const ForecastingView = lazy(() => lazyWithRetry(() => import("@/components/ForecastingView").then(m => ({ default: m.ForecastingView }))));
const ContractBurndown = lazy(() => lazyWithRetry(() => import("@/components/ContractBurndown").then(m => ({ default: m.ContractBurndown }))));
const Alerts = lazy(() => lazyWithRetry(() => import("@/pages/Alerts")));
const UseCases = lazy(() => lazyWithRetry(() => import("@/pages/UseCases")));
const UsersGroups = lazy(() => lazyWithRetry(() => import("@/pages/UsersGroups")));
import {
  useAccountInfo,
  useAWSActualCosts,
  useAzureActualCosts,
  useGCPActualCosts,
  useDashboardBundleFast,
  useSqlBreakdown,
  usePipelineObjects,
  useInteractiveBreakdown,
  useSKUBreakdown,
  useDefaultDateRange,
  useAIMLDashboardBundle,
  useAppsDashboardBundle,
  useTaggingDashboardBundle,
  useDBSQLQueryCosts,
  useInfraBundle,
  useKPIsBundle,
  useUsersGroupsBundle,
} from "@/hooks/useBillingData";
import type { DateRange } from "@/types/billing";
import { generateCostReport } from "@/utils/pdfExport";

type ViewTab = "dbu" | "sql" | "infra" | "kpis" | "aiml" | "apps" | "tagging" | "use-cases" | "alerts" | "forecasting" | "users-groups" | "contract";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 60 * 1000, // 30 minutes - data doesn't change often
      gcTime: 60 * 60 * 1000, // 1 hour cache
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: 1,
    },
  },
});

interface User {
  email: string;
  name: string;
  role?: "admin" | "consumer";
}

function AccountPricingBanner() {
  const { useAccountPrices, discountPercent, skuCount, available } = usePricing();
  if (!useAccountPrices) return null;
  return (
    <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium text-white" style={{ backgroundColor: '#10B981' }}>
      <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {available
        ? `Account prices active — ${discountPercent.toFixed(1)}% discount applied across ${skuCount} SKUs (from system.billing.account_prices)`
        : "Account prices mode active — system.billing.account_prices not available, showing list prices"}
    </div>
  );
}

function SpGrantsBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem("coc-sp-grants-dismissed") === "1");

  const { data: authStatus } = useQuery<{ user_token_active: boolean; identity: string } | null>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()).catch(() => null),
    staleTime: 60_000,
  });

  const spMode = authStatus && !authStatus.user_token_active && authStatus.identity === "service_principal";

  const { data: billingAccess } = useQuery<{ ok: boolean; reason?: string } | null>({
    queryKey: ["settings-billing-access"],
    queryFn: () => fetch("/api/settings/billing-access").then(r => r.json()).catch(() => null),
    staleTime: 5 * 60_000,
    enabled: !!spMode,
  });

  if (dismissed || !spMode || !billingAccess || billingAccess.ok !== false || billingAccess.reason !== "grants_missing") return null;

  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5 bg-amber-50 border-b border-amber-200">
      <div className="flex items-center gap-2 min-w-0">
        <svg className="h-4 w-4 shrink-0 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        </svg>
        <span className="text-xs text-amber-800">
          <strong>SP grants missing</strong> — the service principal lacks access to billing data after the last git deploy.
          A metastore admin must re-run SP grants to restore the dashboard.
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => { onOpenSettings(); }}
          className="text-xs font-medium px-3 py-1.5 rounded"
          style={{ background: "#FF3621", color: "#fff" }}
        >
          Open Settings → Permissions
        </button>
        <button
          onClick={() => { sessionStorage.setItem("coc-sp-grants-dismissed", "1"); setDismissed(true); }}
          className="text-xs text-amber-600 hover:text-amber-800 px-1"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function Dashboard() {
  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings);
  const defaultRange = useDefaultDateRange(appSettings.defaultDateRangeDays);
  const [dateRange, setDateRange] = useState<DateRange>(defaultRange);
  const [activeTab, setActiveTab] = useState<ViewTab>("dbu");
  const [showGenie, setShowGenie] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tabVisibility, setTabVisibility] = useState<TabVisibility>(loadTabVisibility);
  // "pending" = checking, "initializing" = auto-creating MVs, true = wizard, false = dashboard
  const [showSetupWizard, setShowSetupWizard] = useState<boolean | "pending" | "initializing">(
    localStorage.getItem("coc-setup-complete") === "true" ? false : "pending"
  );
  const rqClient = useQueryClient();

  // Per-tab query key prefixes — used by the refresh button to invalidate only
  // the queries relevant to the currently visible tab.
  const TAB_QUERY_KEYS: Record<ViewTab, string[][]> = {
    "dbu":          [["billing", "dashboard-bundle-fast"]],
    "infra":        [["billing", "infra-bundle"], ["aws-actual", "dashboard-bundle"], ["billing", "aws-costs"]],
    "kpis":         [["billing", "kpis-bundle"], ["billing", "spend-anomalies"]],
    "aiml":         [["aiml", "dashboard-bundle"]],
    "apps":         [["apps", "dashboard-bundle"]],
    "tagging":      [["tagging", "dashboard-bundle"]],
    "sql":          [["dbsql", "dashboard-bundle"], ["billing", "sql-breakdown"]],
    "users-groups": [["users-groups"]],
    "use-cases":    [["use-cases"], ["use-cases-summary"], ["monthly-consumption"]],
    "alerts":       [["alerts"]],
    "forecasting":  [["billing", "dashboard-bundle-fast"]],
    "contract":     [["contract-burndown"]],
  };

  const handleTabRefresh = async () => {
    // Clear server-side cache for this tab first, then invalidate React Query cache
    fetch(`/api/cache/clear?tab=${activeTab}`, { method: "POST" }).catch(() => {});
    const keys = TAB_QUERY_KEYS[activeTab] ?? [];
    for (const key of keys) {
      await rqClient.invalidateQueries({ queryKey: key });
    }
  };

  // Auto-launch setup wizard on first deploy if materialized views don't exist yet.
  // If the server returns "initializing", the server is auto-creating MVs using the
  // user's OAuth token — show a spinner and poll until ready (no wizard needed).
  useEffect(() => {
    if (localStorage.getItem("coc-setup-complete") === "true") return;
    fetch("/api/setup/status")
      .then((r) => r.json())
      .then((status) => {
        if (status?.status === "setup_required") {
          setShowSetupWizard(true);
        } else if (status?.status === "initializing") {
          setShowSetupWizard("initializing");
        } else {
          setShowSetupWizard(false);
        }
      })
      .catch(() => { setShowSetupWizard(false); });
  }, []);

  // Poll while auto-initializing (server is building MVs in background)
  useEffect(() => {
    if (showSetupWizard !== "initializing") return;
    const interval = setInterval(() => {
      fetch("/api/setup/status")
        .then(r => r.json())
        .then(status => {
          if (status?.status === "ready") {
            localStorage.setItem("coc-setup-complete", "true");
            fetch("/api/setup/bootstrap-admin", { method: "POST" }).catch(() => {});
            setShowSetupWizard(false);
            queryClient.invalidateQueries();
          } else if (status?.status === "setup_required") {
            // Auto-create failed or no longer has user token — fall back to wizard
            setShowSetupWizard(true);
          }
          // keep polling if still "initializing"
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [showSetupWizard]);

  const handleSetupComplete = () => {
    localStorage.setItem("coc-setup-complete", "true");
    // Save the deploying user as admin (fire-and-forget)
    fetch("/api/setup/bootstrap-admin", { method: "POST" }).catch(() => {});
    setShowSetupWizard(false);
    queryClient.invalidateQueries();
  };

  // On first load after each new deploy, reset all info banner minimize flags so users
  // see best-practice guidance at least once. After that, their collapse preference persists.
  useEffect(() => {
    const BANNER_RESET_VERSION = "2026-03-12";
    const BANNER_RESET_KEY = "coc-banner-reset-v";
    if (localStorage.getItem(BANNER_RESET_KEY) !== BANNER_RESET_VERSION) {
      [
        "cost-obs-minimize-tagging-info",
        "cost-obs-minimize-sql-info",
        "cost-obs-minimize-infra-info",
        "cost-obs-minimize-aiml-info",
        "cost-obs-minimize-kpis-info",
      ].forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(BANNER_RESET_KEY, BANNER_RESET_VERSION);
    }
  }, []);

  // Trigger cache prewarm immediately on mount (runs while permissions dialog is shown)
  useEffect(() => {
    fetch("/api/prewarm", { method: "POST" }).catch(() => {
      // Ignore errors - prewarm is best-effort
    });
  }, []);

  // Auto-refresh interval based on settings
  useEffect(() => {
    if (appSettings.refreshIntervalMinutes <= 0) return;
    const interval = setInterval(() => {
      queryClient.invalidateQueries();
    }, appSettings.refreshIntervalMinutes * 60 * 1000);
    return () => clearInterval(interval);
  }, [appSettings.refreshIntervalMinutes]);

  // Compact mode - toggle CSS class on root
  useEffect(() => {
    document.documentElement.classList.toggle("compact-mode", appSettings.compactMode);
  }, [appSettings.compactMode]);

  // Dark mode - toggle CSS class on root
  useEffect(() => {
    document.documentElement.classList.toggle("dark-mode", appSettings.darkMode);
  }, [appSettings.darkMode]);

  const { data: user } = useQuery<User>({
    queryKey: ["user"],
    queryFn: async () => {
      const response = await fetch("/api/user/me");
      if (!response.ok) throw new Error("Failed to fetch user");
      return response.json();
    },
  });

  const { data: accountInfo } = useAccountInfo();

  const { data: authStatus } = useQuery<{
    user_token_active: boolean;
    identity: "user_oauth" | "service_principal";
    locked_to_sp: boolean;
    has_sql_scope: boolean | null;
  } | null>({
    queryKey: ["settings-auth-status"],
    queryFn: () => fetch("/api/settings/auth-status").then(r => r.json()).catch(() => null),
    staleTime: 60 * 1000,
  });

  // Detect cloud from browser URL instantly (no API call needed)
  const detectedCloudFromUrl = useMemo(() => {
    const host = window.location.hostname.toLowerCase();
    if (host.includes("azure") || host.includes(".azure.")) return "AZURE";
    if (host.includes(".gcp.") || host.includes("gcp.databricks")) return "GCP";
    return "AWS";
  }, []);

  const { applyPricing, multiplier: pricingMultiplier } = usePricing();

  // Fast bundle for quick initial load (uses materialized views)
  const { data: bundle, isLoading: bundleLoading } = useDashboardBundleFast(dateRange);

  // Extract data from fast bundle — apply pricing multiplier when account prices are active
  const summary = useMemo(() => {
    const s = bundle?.summary;
    if (!s || pricingMultiplier === 1.0) return s;
    return {
      ...s,
      total_spend: applyPricing(s.total_spend ?? 0),
      total_dbus: s.total_dbus, // DBUs don't scale with price
    };
  }, [bundle?.summary, pricingMultiplier, applyPricing]);

  const products = useMemo(() => {
    const p = bundle?.products;
    if (!p || pricingMultiplier === 1.0) return p;
    return {
      ...p,
      products: p.products?.map((prod) => ({
        ...prod,
        total_spend: applyPricing(prod.total_spend ?? 0),
      })),
    };
  }, [bundle?.products, pricingMultiplier, applyPricing]);

  const workspaces = useMemo(() => {
    const w = bundle?.workspaces;
    if (!w || pricingMultiplier === 1.0) return w;
    return {
      ...w,
      workspaces: w.workspaces?.map((ws) => ({
        ...ws,
        total_spend: applyPricing(ws.total_spend ?? 0),
      })),
    };
  }, [bundle?.workspaces, pricingMultiplier, applyPricing]);

  const timeseries = useMemo(() => {
    const t = bundle?.timeseries;
    if (!t || pricingMultiplier === 1.0) return t;
    return {
      ...t,
      timeseries: t.timeseries?.map((row) => {
        const scaled: typeof row = { ...row };
        for (const key of Object.keys(row)) {
          if (key !== "date" && typeof row[key] === "number") {
            scaled[key] = applyPricing(row[key] as number);
          }
        }
        return scaled;
      }),
    };
  }, [bundle?.timeseries, pricingMultiplier, applyPricing]);

  // Load detailed breakdowns only when needed (lazy loading by tab)
  const isDbuTab = activeTab === "dbu";
  const isKpisTab = activeTab === "kpis";

  // DBU tab data - only load when tab is active
  const { data: sqlBreakdown, isLoading: sqlLoading } = useSqlBreakdown(dateRange, isDbuTab);
  const { data: pipelineObjects, isLoading: pipelineLoading } = usePipelineObjects(dateRange, isDbuTab);
  const { data: interactiveBreakdown, isLoading: interactiveLoading } = useInteractiveBreakdown(dateRange, isDbuTab);
  const { data: skuBreakdown, isLoading: skuLoading } = useSKUBreakdown(dateRange, isDbuTab);
  // Infra tab data - single bundled request (clusters + families + timeseries in parallel)
  const { data: infraBundle, isLoading: infraBundleLoading } = useInfraBundle(dateRange, true);
  const infraCosts = infraBundle?.infra_costs;
  const infraCostsTimeseries = infraBundle?.infra_timeseries;

  // KPIs + anomalies - single bundled request (KPIs + anomalies in parallel)
  const { data: kpisBundle, isLoading: kpisBundleLoading } = useKPIsBundle(dateRange, isDbuTab || isKpisTab);
  const spendAnomalies = kpisBundle?.anomalies;
  const platformKPIs = kpisBundle?.kpis;
  const anomaliesLoading = kpisBundleLoading;
  const kpisLoading = kpisBundleLoading;

  // AI/ML tab data - prefetch for fast tab switching
  const { data: aimlData, isLoading: aimlLoading } = useAIMLDashboardBundle(dateRange, true);

  // Apps tab data
  const { data: appsData, isLoading: appsLoading } = useAppsDashboardBundle(dateRange, true);

  // Tagging tab data - prefetch for fast tab switching
  const { data: taggingData, isLoading: taggingLoading } = useTaggingDashboardBundle(dateRange, true);

  // Cloud actual costs — fetch all clouds; CloudCostsView shows tabs when multiple have data
  const { data: awsActualData, isLoading: awsActualLoading } = useAWSActualCosts(dateRange, activeTab === "infra");
  const { data: azureActualData, isLoading: azureActualLoading } = useAzureActualCosts(dateRange, activeTab === "infra");
  const { data: gcpActualData, isLoading: gcpActualLoading } = useGCPActualCosts(dateRange, activeTab === "infra");

  // DBSQL/SQL Warehousing tab data - prefetch for fast tab switching
  const { data: dbsqlData, isLoading: dbsqlLoading } = useDBSQLQueryCosts(dateRange, true);

  // Users & Groups tab data - prefetch for fast tab switching
  const { data: usersGroupsData } = useUsersGroupsBundle(dateRange, true);

  // Use Cases tab data - only fetch when feature is enabled
  const useCasesEnabled = appSettings.enableUseCaseTracking;
  useQuery({ queryKey: ["use-cases"], queryFn: async () => { const r = await fetch("/api/use-cases/use-cases?status=active"); if (!r.ok) throw new Error("Failed"); return r.json(); }, enabled: useCasesEnabled });
  const { data: useCasesSummaryData } = useQuery({ queryKey: ["use-cases-summary"], queryFn: async () => { const r = await fetch("/api/use-cases/analytics/summary"); if (!r.ok) throw new Error("Failed"); return r.json(); }, enabled: useCasesEnabled });
  useQuery({ queryKey: ["monthly-consumption"], queryFn: async () => { const r = await fetch("/api/use-cases/monthly-consumption"); if (!r.ok) throw new Error("Failed"); return r.json(); }, enabled: useCasesEnabled });
  useQuery({ queryKey: ["available-tags"], queryFn: async () => { const r = await fetch("/api/tagging/available-tags"); if (!r.ok) return { tags: {}, count: 0 }; return r.json(); } });

  // Alerts tab data - prefetch immediately on app load for fast tab switching
  const { data: alertsData } = useQuery({ queryKey: ["alerts", "recent", 30], queryFn: async () => { const r = await fetch("/api/alerts/recent?days_back=30"); if (!r.ok) throw new Error("Failed"); return r.json(); } });
  useQuery({ queryKey: ["alerts", "databricks"], queryFn: async () => { const r = await fetch("/api/alerts/databricks-alerts"); if (!r.ok) throw new Error("Failed"); return r.json(); } });

  // Settings data - prefetch in background so permissions/config tabs load instantly
  useQuery({ queryKey: ["user-permissions"], queryFn: async () => { const r = await fetch("/api/settings/user-permissions"); if (!r.ok) throw new Error("Failed"); return r.json(); }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["app-config"], queryFn: async () => { const r = await fetch("/api/settings/config"); if (!r.ok) throw new Error("Failed"); return r.json(); }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["warehouses"], queryFn: async () => { const r = await fetch("/api/settings/warehouses"); if (!r.ok) throw new Error("Failed"); return r.json(); }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["cloud-provider"], queryFn: async () => { const r = await fetch("/api/settings/cloud-provider"); if (!r.ok) throw new Error("Failed"); return r.json(); }, staleTime: 30 * 60 * 1000 });
  useQuery({ queryKey: ["cloud-connections"], queryFn: async () => { const r = await fetch("/api/settings/cloud-connections"); if (!r.ok) throw new Error("Failed"); return r.json(); }, staleTime: 5 * 60 * 1000 });
  useQuery({ queryKey: ["settings-account-prices"], queryFn: async () => { const r = await fetch("/api/settings/account-prices"); return r.ok ? r.json() : { available: false, prices: [], source: null, count: 0 }; }, staleTime: 5 * 60 * 1000 });

  // Memoize infra data transformations to avoid re-creating arrays on every render
  const infraViewData = useMemo(() => infraCosts ? {
    clusters: (infraCosts.clusters || []).map(c => ({
      cluster_id: c.cluster_id,
      cluster_name: c.cluster_name,
      driver_instance_type: c.driver_instance_type,
      worker_instance_type: c.worker_instance_type,
      cluster_source: c.cluster_source,
      total_dbu_hours: c.total_dbu_hours,
      days_active: c.days_active,
      percentage: c.percentage,
      workspace_id: (c as any).workspace_id || "",
      state: null,
      estimated_aws_cost: c.estimated_cost,
    })),
    instance_families: infraCosts.instance_families,
    total_estimated_cost: infraCosts.total_estimated_cost,
    total_dbu_hours: infraCosts.total_dbu_hours,
    billing_summary: (infraCosts as any).billing_summary,
    start_date: infraCosts.start_date,
    end_date: infraCosts.end_date,
    disclaimer: infraCosts.disclaimer,
    error: infraCosts.error,
  } : undefined, [infraCosts]);

  const infraViewTimeseries = useMemo(() => infraCostsTimeseries ? {
    timeseries: (infraCostsTimeseries.timeseries || []).map(t => ({
      date: t.date,
      "AWS Cost": t["Infrastructure Cost"],
    })),
    categories: ["AWS Cost"],
    start_date: infraCostsTimeseries.start_date,
    end_date: infraCostsTimeseries.end_date,
  } : undefined, [infraCostsTimeseries]);

  const handleExportPDF = (sections: ExportSections) => {
    generateCostReport(
      {
        summary,
        products,
        workspaces,
        skus: skuBreakdown,
        anomalies: spendAnomalies,
        pipelineObjects,
        interactiveBreakdown,
        awsCosts: infraCosts ? {
          clusters: infraCosts.clusters.map(c => ({
            cluster_id: c.cluster_id,
            cluster_name: c.cluster_name,
            driver_instance_type: c.driver_instance_type,
            worker_instance_type: c.worker_instance_type,
            cluster_source: c.cluster_source,
            total_dbu_hours: c.total_dbu_hours,
            days_active: c.days_active,
            percentage: c.percentage,
            workspace_id: (c as any).workspace_id || "",
            state: null,
            estimated_aws_cost: c.estimated_cost,
          })),
          instance_families: infraCosts.instance_families,
          total_estimated_cost: infraCosts.total_estimated_cost,
          total_dbu_hours: infraCosts.total_dbu_hours,
          start_date: infraCosts.start_date,
          end_date: infraCosts.end_date,
          disclaimer: infraCosts.disclaimer,
          error: infraCosts.error,
        } : undefined,
        aiml: aimlData,
        apps: appsData,
        tagging: taggingData,
        platformKPIs,
        query360: dbsqlData,
        users: usersGroupsData,
        useCases: useCasesSummaryData,
        alerts: alertsData,
        dateRange: {
          start: dateRange.startDate,
          end: dateRange.endDate,
        },
      },
      sections
    );
  };

  if (showSetupWizard === "pending" || showSetupWizard === "initializing" || showSetupWizard === true) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ backgroundColor: '#F9F7F4' }}>
        {showSetupWizard === true && (
          <SetupWizard onComplete={handleSetupComplete} onClose={() => setShowSetupWizard(false)} />
        )}
        {(showSetupWizard === "pending" || showSetupWizard === "initializing") && (
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full" style={{ border: '3px solid #e5e7eb', borderTopColor: '#FF3621' }} />
            <p className="text-sm text-gray-500">
              {showSetupWizard === "initializing"
                ? "Setting up your workspace — this takes a few minutes on first deploy…"
                : "Loading..."}
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: appSettings.darkMode ? '#1B1F23' : '#F9F7F4' }}>
      {/* Permissions Check Dialog */}
      <PermissionsDialog />

      {/* Account Info Banner */}
      <div className="text-white" style={{ backgroundColor: '#1B3139' }}>
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="white">
                  <path d="M20 4H4L7 8L4 12H20L17 8L20 4Z" opacity="0.9"/>
                  <path d="M20 8H4L7 12L4 16H20L17 12L20 8Z" opacity="0.7"/>
                  <path d="M20 12H4L7 16L4 20H20L17 16L20 12Z" opacity="0.5"/>
                </svg>
                <span className="text-sm opacity-75">Databricks Account</span>
              </div>
              {accountInfo ? (
                <div className="flex items-center gap-3">
                  {accountInfo.account_name && (
                    <span className="rounded px-2 py-0.5 text-xs font-mono" style={{ backgroundColor: 'rgba(255, 255, 255, 0.15)' }}>
                      {accountInfo.account_name}
                    </span>
                  )}
                  <img
                    src={detectedCloudFromUrl === "AZURE" ? azureLogo : detectedCloudFromUrl === "GCP" ? gcpLogo : awsLogo}
                    alt={detectedCloudFromUrl}
                    className="h-5 w-5 object-contain"
                  />
                  {authStatus && (
                    <span
                      title={authStatus.identity === "user_oauth" ? "Queries running as your OAuth token" : authStatus.locked_to_sp ? "Locked to service principal (token failed scope check)" : "Queries running as service principal"}
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${authStatus.identity === "user_oauth" ? "bg-green-500/20 text-green-200" : "bg-amber-400/20 text-amber-200"}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${authStatus.identity === "user_oauth" ? "bg-green-400" : "bg-amber-400"}`} />
                      {authStatus.identity === "user_oauth" ? "OAuth" : "SP"}
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-sm opacity-75">Loading account info...</span>
                  <img
                    src={detectedCloudFromUrl === "AZURE" ? azureLogo : detectedCloudFromUrl === "GCP" ? gcpLogo : awsLogo}
                    alt={detectedCloudFromUrl}
                    className="h-5 w-5 object-contain"
                  />
                </div>
              )}
            </div>
            {user && (
              <div className="flex items-center gap-2">
                <span className="text-sm opacity-90">
                  {user.email}
                </span>
                {user.role && (
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${user.role === "admin" ? "bg-white/20 text-white" : "bg-white/10 text-white/70"}`}>
                    {user.role === "admin" ? "Admin" : "Consumer"}
                  </span>
                )}
                <button
                  onClick={() => setShowSettings(true)}
                  className="rounded-md p-1.5 text-white opacity-75 transition-opacity hover:opacity-100 hover:bg-white/10"
                  title="App Settings"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
                <button
                  onClick={() => setShowExportDialog(true)}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white opacity-75 transition-opacity hover:opacity-100 hover:bg-white/10 border border-white/20"
                  title="Export PDF"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Export PDF
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <AccountPricingBanner />
      <SpGrantsBanner onOpenSettings={() => setShowSettings(true)} />

      <header className="bg-white shadow">
        <div className="mx-auto max-w-7xl px-4 pt-8 pb-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-3 items-center gap-4">
            <div>
              <h1 className="text-3xl font-black tracking-wide text-gray-900" style={{ fontFamily: "'Orbitron', sans-serif" }}>
                COST-OBS
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                $DBU mission control + analytics center{appSettings.companyName ? ` for ${appSettings.companyName}'s Databricks spend` : ""}
              </p>
            </div>
            <div className="flex justify-center">
              <DateRangePicker value={dateRange} onChange={setDateRange} />
            </div>
            <div />
          </div>
          {/* Tab Navigation */}
          <div className="mt-4 border-b border-gray-200 overflow-x-auto overflow-y-hidden">
            <nav className="-mb-px flex justify-center space-x-4 min-w-max">
              {tabVisibility.dbu && (
              <button
                onClick={() => setActiveTab("dbu")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "dbu"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 4H4L7 8L4 12H20L17 8L20 4Z" opacity="0.9"/>
                  <path d="M20 8H4L7 12L4 16H20L17 12L20 8Z" opacity="0.7"/>
                  <path d="M20 12H4L7 16L4 20H20L17 16L20 12Z" opacity="0.5"/>
                </svg>
                $DBU Spend
              </button>
              )}
              {tabVisibility.infra && (
              <button
                onClick={() => setActiveTab("infra")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "infra"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                </svg>
                Cloud Costs
              </button>
              )}
              {tabVisibility.kpis && (
              <button
                onClick={() => setActiveTab("kpis")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "kpis"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                KPIs & Trends
              </button>
              )}
              {tabVisibility.aiml && (
              <button
                onClick={() => setActiveTab("aiml")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "aiml"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                AI/ML
              </button>
              )}
              {tabVisibility.sql && (
              <button
                onClick={() => setActiveTab("sql")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "sql"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                </svg>
                SQL
              </button>
              )}
              {tabVisibility.apps && (
              <button
                onClick={() => setActiveTab("apps")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "apps"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                </svg>
                Apps
              </button>
              )}
              {tabVisibility.tagging && (
              <button
                onClick={() => setActiveTab("tagging")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "tagging"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                Tagging
              </button>
              )}
              {tabVisibility["users-groups"] && (
              <button
                onClick={() => setActiveTab("users-groups")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "users-groups"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                Users
              </button>
              )}
              {appSettings.enableUseCaseTracking && tabVisibility["use-cases"] && (
              <button
                onClick={() => setActiveTab("use-cases")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "use-cases"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
                Use Cases
              </button>
              )}
              {appSettings.enableAlerts && tabVisibility.alerts && (
              <button
                onClick={() => setActiveTab("alerts")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "alerts"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                Alerts
              </button>
              )}
              {appSettings.enableForecasting && tabVisibility.forecasting && (
              <button
                onClick={() => setActiveTab("forecasting")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "forecasting"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
                Forecasting
              </button>
              )}
              {appSettings.enableContractTracking && (
              <button
                onClick={() => setActiveTab("contract")}
                className={`whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-gray-400 ${
                  activeTab === "contract"
                    ? "border-[#FF3621] text-[#FF3621]"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                <svg className="mr-2 -mt-0.5 inline h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Contract
              </button>
              )}
            </nav>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        <div key={activeTab} className="animate-fade-in relative">
          {/* Per-tab refresh button — top-right corner, across from each tab's title.
              Hidden on infra (cloud costs) tab. */}
          {activeTab !== "infra" && (
            <div className="absolute right-0 top-1 z-20">
              <TabRefreshButton onRefresh={handleTabRefresh} />
            </div>
          )}
        <Suspense fallback={
          <div className="flex h-64 flex-col items-center justify-center gap-3">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200" style={{ borderTopColor: '#FF3621' }} />
            <p className="text-sm text-gray-500">Loading...</p>
          </div>
        }>
        {activeTab === "dbu" ? (
          bundleLoading ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
              <p className="text-sm text-gray-500">Loading DBU spend data...</p>
            </div>
          ) : (
          <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center gap-3">
              <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
                <svg className="h-6 w-6 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20 4H4L7 8L4 12H20L17 8L20 4Z" opacity="0.9"/>
                  <path d="M20 8H4L7 12L4 16H20L17 12L20 8Z" opacity="0.7"/>
                  <path d="M20 12H4L7 16L4 20H20L17 16L20 12Z" opacity="0.5"/>
                </svg>
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">$DBU Spend</h1>
                <p className="text-sm text-gray-500">Databricks Unit consumption and cost breakdown</p>
              </div>
            </div>

            {/* Genie Chat Section */}
            {appSettings.enableGenie && (
            <div className="rounded-lg border bg-white shadow" style={{ borderColor: '#E5E5E5' }}>
              <button
                onClick={() => setShowGenie(!showGenie)}
                className="flex w-full items-center justify-between px-6 py-4 text-left transition-colors"
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = appSettings.darkMode ? '#3A3D41' : '#F9F7F4'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: '#FFF0ED' }}>
                    <svg
                      className="h-5 w-5" style={{ color: '#FF3621' }}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                      />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">Genie Assistant</h2>
                    <p className="text-xs text-gray-500">
                      Ask questions about your cost data in natural language
                    </p>
                  </div>
                </div>
                <svg
                  className={`h-5 w-5 text-gray-500 transition-transform ${showGenie ? "rotate-180" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {showGenie && (
                <div className="animate-slide-down border-t" style={{ borderColor: '#E5E5E5' }}>
                  <GenieChatView />
                </div>
              )}
            </div>
            )}

            <SummaryCards
              data={summary}
              isLoading={false}
              startDate={dateRange.startDate}
              endDate={dateRange.endDate}
            />

            <SpendChart data={timeseries} isLoading={false} />

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <ProductBreakdown data={products} isLoading={false} workspaces={workspaces?.workspaces} dateRange={dateRange} />
              <SKUBreakdown data={skuBreakdown} isLoading={skuLoading} workspaces={workspaces?.workspaces} dateRange={dateRange} />
            </div>

            <WorkspaceTable data={workspaces} isLoading={false} host={accountInfo?.host} />

            <InteractiveBreakdown data={interactiveBreakdown} isLoading={interactiveLoading} host={accountInfo?.host} />

            <PipelineObjectsTable data={pipelineObjects} isLoading={pipelineLoading} host={accountInfo?.host} />
          </div>
          )
        ) : activeTab === "infra" ? (
          <TabErrorBoundary tabName="Cloud Costs">
          <CloudCostsView
            data={infraViewData}
            isLoading={infraBundleLoading}
            timeseriesData={infraViewTimeseries}
            timeseriesLoading={infraBundleLoading}
            host={accountInfo?.host}
            actualData={awsActualData}
            actualLoading={awsActualLoading}
            azureActualData={azureActualData}
            azureActualLoading={azureActualLoading}
            gcpActualData={gcpActualData}
            gcpActualLoading={gcpActualLoading}
            infraData={infraCosts}
            infraLoading={infraBundleLoading}
            infraTimeseriesData={infraCostsTimeseries}
            infraTimeseriesLoading={infraBundleLoading}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            detectedCloud={accountInfo?.cloud || undefined}
            workspaceNameMap={workspaces?.workspaces?.reduce((m, w) => { m[w.workspace_id] = w.workspace_name || w.workspace_id; return m; }, {} as Record<string, string>)}
          />
          </TabErrorBoundary>
        ) : activeTab === "kpis" ? (
          <TabErrorBoundary tabName="KPIs & Trends">
          <PlatformKPIsView
            data={platformKPIs}
            isLoading={kpisLoading}
            spendAnomalies={spendAnomalies}
            anomaliesLoading={anomaliesLoading}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            enableAIFeatures={appSettings.enableAIFeatures}
          />
          </TabErrorBoundary>
        ) : activeTab === "aiml" ? (
          <TabErrorBoundary tabName="AI/ML">
          <AIMLCostCenter
            data={aimlData}
            isLoading={aimlLoading}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            host={accountInfo?.host}
          />
          </TabErrorBoundary>
        ) : activeTab === "apps" ? (
          <TabErrorBoundary tabName="Apps">
          <AppsCostCenter
            data={appsData}
            isLoading={appsLoading}
            host={accountInfo?.host}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            dateRange={dateRange}
            enableHostingComparison={appSettings.enableAppHostingComparison}
            workspaceNameMap={workspaces?.workspaces?.reduce((m, w) => { m[w.workspace_id] = w.workspace_name || w.workspace_id; return m; }, {} as Record<string, string>)}
          />
          </TabErrorBoundary>
        ) : activeTab === "tagging" ? (
          <TabErrorBoundary tabName="Tagging">
          <TaggingHub
            data={taggingData}
            isLoading={taggingLoading}
            host={accountInfo?.host}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
          />
          </TabErrorBoundary>
        ) : activeTab === "sql" ? (
          <TabErrorBoundary tabName="SQL">
          <SQLWarehousing360
            sqlBreakdownData={sqlBreakdown}
            queryData={dbsqlData}
            isLoading={sqlLoading || dbsqlLoading}
            host={accountInfo?.host}
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
          />
          </TabErrorBoundary>
        ) : activeTab === "use-cases" ? (
          <TabErrorBoundary tabName="Use Cases"><UseCases /></TabErrorBoundary>
        ) : activeTab === "alerts" ? (
          <TabErrorBoundary tabName="Alerts"><Alerts /></TabErrorBoundary>
        ) : activeTab === "forecasting" ? (
          <TabErrorBoundary tabName="Forecasting">
          <ForecastingView
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
          />
          </TabErrorBoundary>
        ) : activeTab === "users-groups" ? (
          <TabErrorBoundary tabName="Users">
          <UsersGroups
            startDate={dateRange.startDate}
            endDate={dateRange.endDate}
            dateRange={dateRange}
            anonymizeUsers={appSettings.anonymizeUsers}
          />
          </TabErrorBoundary>
        ) : activeTab === "contract" ? (
          <TabErrorBoundary tabName="Contract">
          <ContractBurndown />
          </TabErrorBoundary>
        ) : null}
        </Suspense>
        </div>
      </main>

      <Footer />

      <ExportDialog
        isOpen={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        onExport={handleExportPDF}
        tabVisibility={{
          ...tabVisibility,
          "use-cases": tabVisibility["use-cases"] && appSettings.enableUseCaseTracking,
          alerts: tabVisibility.alerts && appSettings.enableAlerts,
          forecasting: tabVisibility.forecasting && appSettings.enableForecasting,
        }}
      />

      <SettingsDialog
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        tabVisibility={tabVisibility}
        appSettings={appSettings}
        onTabVisibilityChange={(v) => {
          setTabVisibility(v);
          // If the active tab was hidden, switch to the first visible tab.
          // "contract" is not in TabVisibility (it's purely settings-gated), so skip the check for it.
          if (activeTab !== "contract" && !v[activeTab as keyof typeof v]) {
            const firstVisible = (Object.keys(v) as ViewTab[]).find((k) => v[k as keyof typeof v]);
            if (firstVisible) setActiveTab(firstVisible);
          }
        }}
        onSettingsChange={setAppSettings}
        onRerunWizard={() => {
          setShowSettings(false);
          setShowSetupWizard(true);
        }}
      />
    </div>
  );
}

class TabErrorBoundary extends React.Component<
  { children: React.ReactNode; tabName?: string },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center py-16 px-8 rounded-lg bg-white border " style={{ borderColor: '#E5E5E5' }}>
          <div className="text-3xl mb-3">⚠️</div>
          <h3 className="text-lg font-semibold text-gray-900 mb-1">
            {this.props.tabName ? `${this.props.tabName} encountered an error` : "Something went wrong"}
          </h3>
          <p className="text-sm text-gray-500 text-center max-w-md mb-4">
            This may happen when data is loading or system tables are not accessible. Other tabs should still work.
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-4 py-2 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: '#FF3621' }}
          >
            Try Again
          </button>
          <details className="mt-4 text-xs text-gray-500">
            <summary className="cursor-pointer">Error details</summary>
            <pre className="mt-2 whitespace-pre-wrap">{this.state.error.message}</pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: "sans-serif", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
          <h1 style={{ color: "#f97316", marginBottom: 16 }}>Something went wrong</h1>
          <p style={{ color: "#94a3b8", marginBottom: 24 }}>The app encountered an error. This usually happens when data is still loading or system tables are not accessible.</p>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{ padding: "10px 24px", background: "#f97316", color: "#000", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600, marginBottom: 24 }}
          >
            Reload App
          </button>
          <details style={{ marginTop: 16 }}>
            <summary style={{ cursor: "pointer", color: "#64748b" }}>Error details</summary>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#64748b", marginTop: 8 }}>
              {this.state.error.message}
              {"\n\n"}
              {this.state.error.stack}
            </pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <PricingProvider>
          <Dashboard />
        </PricingProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
