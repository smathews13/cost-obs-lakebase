import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import awsLogo from "@/assets/aws.png";
import azureLogo from "@/assets/azure.png";
import gcpLogo from "@/assets/gcp.svg";
import { KPITrendModal } from "./KPITrendModal";
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  Legend,
} from "recharts";
import { format, parseISO } from "date-fns";
import type {
  AWSCostsResponse,
  TimeseriesResponse,
  AWSActualDashboardBundle,
  AzureActualDashboardBundle,
  GCPActualDashboardBundle,
  InfraCostsResponse,
  InfraCostsTimeseriesResponse,
} from "@/types/billing";
import { formatCurrency, workspaceUrl } from "@/utils/formatters";
import { StatusIndicator } from "./StatusIndicator";

type CostMode = "estimated" | "actual";

interface CloudCostsViewProps {
  data: AWSCostsResponse | undefined;
  isLoading: boolean;
  timeseriesData: TimeseriesResponse | undefined;
  timeseriesLoading: boolean;
  host: string | null | undefined;
  actualData?: AWSActualDashboardBundle;
  actualLoading?: boolean;
  azureActualData?: AzureActualDashboardBundle;
  azureActualLoading?: boolean;
  gcpActualData?: GCPActualDashboardBundle;
  gcpActualLoading?: boolean;
  // Multi-cloud infrastructure data
  infraData?: InfraCostsResponse;
  infraLoading?: boolean;
  infraTimeseriesData?: InfraCostsTimeseriesResponse;
  infraTimeseriesLoading?: boolean;
  startDate?: string;
  endDate?: string;
  detectedCloud?: string;
  workspaceNameMap?: Record<string, string>;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

type SortField = "cluster_name" | "estimated_aws_cost" | "total_dbu_hours" | "days_active";
type SortDirection = "asc" | "desc";

// Base color palette for instance family charts (cycled by index)
const FAMILY_PALETTE = [
  "#1B5162", "#06B6D4", "#10B981", "#14B8A6", "#F59E0B",
  "#3B82F6", "#EC4899", "#EF4444", "#6B7280",
];

// Known instance family -> color overrides for consistency
const INSTANCE_COLORS: Record<string, string> = {
  // AWS EC2 instance families (using canonical Databricks palette)
  i3: "#1B5162", i3en: "#2D7A96", i4i: "#4A99B8",
  m4: "#10B981", m5: "#10B981", m5d: "#34D399", m5n: "#6EE7B7",
  m6i: "#6EE7B7", m6id: "#A7F3D0", m7g: "#059669", m7gd: "#047857", m7i: "#34D399",
  r5: "#F59E0B", r5d: "#FBBF24", r6id: "#FDE68A", r6gd: "#FCD34D", r8gd: "#D97706",
  c5: "#3B82F6", c5d: "#60A5FA", c6gd: "#1D4ED8",
  g4dn: "#EC4899", g5: "#F472B6",
  p3: "#EF4444",
  // Fleet types
  "rd-fleet": "#06B6D4", "rgd-fleet": "#0891B2",
  // Azure VM series
  Standard_D: "#1B5162", Standard_DS: "#2D7A96",
  Standard_E: "#10B981", Standard_ES: "#34D399",
  Standard_F: "#3B82F6", Standard_FS: "#60A5FA",
  Standard_L: "#F59E0B", Standard_LS: "#FBBF24",
  Standard_M: "#EF4444",
  Standard_NC: "#EC4899", Standard_ND: "#F472B6", Standard_NV: "#14B8A6",
  unknown: "#6B7280",
};

function getInstanceColor(name: string, index: number): string {
  return INSTANCE_COLORS[name] || FAMILY_PALETTE[index % FAMILY_PALETTE.length];
}

function formatDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "MMM d");
  } catch {
    return dateStr;
  }
}

function getClusterUrl(host: string | null | undefined, clusterId: string | null, workspaceId: string | null): string | null {
  if (!host || !clusterId) return null;
  const workspaceParam = workspaceId ? `?o=${workspaceId}` : '';
  return workspaceUrl(host, `/compute/interactive${workspaceParam}`);
}

function getInstancePricingUrl(instanceType: string | null, isAzure: boolean = false): string {
  if (isAzure) {
    // Azure VM pricing page
    if (!instanceType) {
      return "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/";
    }

    // Extract Azure VM series (e.g., "Standard_D" from "Standard_D4s_v3")
    const seriesMatch = instanceType.match(/^Standard_([A-Z]+)/i);
    const series = seriesMatch ? seriesMatch[1].toUpperCase() : null;

    // Map Azure VM series to their specific pricing pages
    const azureFamilyUrls: Record<string, string> = {
      'D': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#d-series',
      'E': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#e-series',
      'F': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#f-series',
      'L': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#l-series',
      'M': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#m-series',
      'NC': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#nc-series',
      'ND': 'https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/#nd-series',
    };

    return series && azureFamilyUrls[series]
      ? azureFamilyUrls[series]
      : "https://azure.microsoft.com/en-us/pricing/details/virtual-machines/linux/";
  }

  // AWS EC2 pricing
  if (!instanceType) {
    return "https://aws.amazon.com/ec2/pricing/on-demand/";
  }

  // Extract instance family (e.g., "i3" from "i3.2xlarge")
  const family = instanceType.split('.')[0];

  // Map instance families to their specific pricing pages
  const familyUrls: Record<string, string> = {
    'i3': 'https://aws.amazon.com/ec2/instance-types/i3/',
    'i3en': 'https://aws.amazon.com/ec2/instance-types/i3en/',
    'm5': 'https://aws.amazon.com/ec2/instance-types/m5/',
    'm5d': 'https://aws.amazon.com/ec2/instance-types/m5/',
    'm6i': 'https://aws.amazon.com/ec2/instance-types/m6i/',
    'r5': 'https://aws.amazon.com/ec2/instance-types/r5/',
    'r5d': 'https://aws.amazon.com/ec2/instance-types/r5/',
    'c5': 'https://aws.amazon.com/ec2/instance-types/c5/',
    'c5d': 'https://aws.amazon.com/ec2/instance-types/c5/',
    'g4dn': 'https://aws.amazon.com/ec2/instance-types/g4/',
    'g5': 'https://aws.amazon.com/ec2/instance-types/g5/',
    'p3': 'https://aws.amazon.com/ec2/instance-types/p3/',
  };

  return familyUrls[family] || "https://aws.amazon.com/ec2/pricing/on-demand/";
}

const CHARGE_TYPE_COLORS: Record<string, string> = {
  Compute: "#1B5162",
  Storage: "#06B6D4",
  Networking: "#10B981",
  Other: "#6B7280",
};

export function CloudCostsView({
  data,
  isLoading,
  timeseriesData,
  timeseriesLoading,
  host: _host,
  actualData,
  actualLoading,
  azureActualData,
  azureActualLoading,
  gcpActualData,
  gcpActualLoading,
  infraData,
  infraLoading,
  infraTimeseriesData,
  infraTimeseriesLoading,
  startDate,
  endDate,
  detectedCloud,
  workspaceNameMap,
}: CloudCostsViewProps) {
  const [sortField, setSortField] = useState<SortField>("estimated_aws_cost");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [showHistoricalClusters, setShowHistoricalClusters] = useState(false);
  const [selectedKPI, setSelectedKPI] = useState<{kpi: string; label: string} | null>(null);
  const [selectedFamilies, setSelectedFamilies] = useState<Set<string>>(new Set());
  const [tableFamily, setTableFamily] = useState<string>("");
  const [tableWorkspace, setTableWorkspace] = useState<string>("");
  const [familyFilterOpen, setFamilyFilterOpen] = useState(false);
  const [workspaceFilterOpen, setWorkspaceFilterOpen] = useState(false);
  const familyFilterRef = useRef<HTMLDivElement>(null);
  const workspaceFilterRef = useRef<HTMLDivElement>(null);

  const WIZARD_STEPS_KEY = "cost-obs-wizard-checked-steps";
  const [checkedSteps, setCheckedSteps] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(WIZARD_STEPS_KEY) || "{}"); } catch { return {}; }
  });
  const toggleStep = (key: string) => {
    setCheckedSteps(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem(WIZARD_STEPS_KEY, JSON.stringify(next));
      return next;
    });
  };
  const itemsPerPage = 10;

  // Active cloud for actual cost view — defaults to workspace cloud, switchable via tabs
  const [activeActualCloud, setActiveActualCloud] = useState<"AWS" | "AZURE" | "GCP">(() => {
    const c = (detectedCloud || "AWS").toUpperCase();
    if (c === "AZURE") return "AZURE";
    if (c === "GCP") return "GCP";
    return "AWS";
  });

  // Modular cloud integrations
  type CloudIntegration = { id: string; cloud: "azure" | "aws" | "gcp"; label: string };
  const INTEGRATIONS_KEY = "cost-obs-cloud-integrations";
  const [cloudIntegrations, setCloudIntegrations] = useState<CloudIntegration[]>(() => {
    try { return JSON.parse(localStorage.getItem(INTEGRATIONS_KEY) || "[]"); } catch { return []; }
  });
  const [showIntegrationWizard, setShowIntegrationWizard] = useState(false);
  const [wizardCloud, setWizardCloud] = useState<"azure" | "aws" | "gcp" | null>(null);
  const [wizardExpandedStep, setWizardExpandedStep] = useState<number | null>(null);
  const [viewingIntegration, setViewingIntegration] = useState<CloudIntegration | null>(null);

  const addIntegration = (cloud: "azure" | "aws" | "gcp") => {
    if (cloudIntegrations.length >= 3) return;
    const newInt: CloudIntegration = { id: Date.now().toString(), cloud, label: cloud === "azure" ? "Azure" : cloud === "gcp" ? "GCP" : "AWS" };
    const updated = [...cloudIntegrations, newInt];
    setCloudIntegrations(updated);
    localStorage.setItem(INTEGRATIONS_KEY, JSON.stringify(updated));
  };

  const removeIntegration = (id: string) => {
    const updated = cloudIntegrations.filter(i => i.id !== id);
    setCloudIntegrations(updated);
    localStorage.setItem(INTEGRATIONS_KEY, JSON.stringify(updated));
  };

  const openWizardForExisting = (integration: CloudIntegration) => {
    setWizardCloud(integration.cloud);
    setWizardExpandedStep(null);
    setShowIntegrationWizard(true);
    setViewingIntegration(integration);
  };

  // Close table filter dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (familyFilterRef.current && !familyFilterRef.current.contains(e.target as Node)) {
        setFamilyFilterOpen(false);
      }
      if (workspaceFilterRef.current && !workspaceFilterRef.current.contains(e.target as Node)) {
        setWorkspaceFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Pre-warm trend queries so modals open instantly
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!startDate || !endDate) return;
    for (const kpi of ["infra_cost", "infra_clusters", "infra_dbu_hours", "avg_cost_per_cluster"]) {
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

  // Info box minimize state with localStorage persistence
  const MINIMIZE_KEY = "cost-obs-minimize-infra-info";
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

  // Cloud provider detection — use detectedCloud (from host URL) as reliable fallback
  const cloud = infraData?.cloud || detectedCloud || "AWS";
  const cloudDisplayName = cloud.toUpperCase() === "AZURE" ? "Azure" : cloud.toUpperCase() === "GCP" ? "GCP" : "AWS";
  const isAzure = cloud.toUpperCase() === "AZURE";
  const isGCP = cloud.toUpperCase() === "GCP";

  // Per-cloud actual data availability
  const awsActualAvailable = actualData?.available === true;
  const azureActualAvailable = azureActualData?.available === true;
  const gcpActualAvailable = gcpActualData?.available === true;
  const multipleActualAvailable = [awsActualAvailable, azureActualAvailable, gcpActualAvailable].filter(Boolean).length > 1;

  // Determine if actual data is available (any cloud)
  const actualAvailable = awsActualAvailable || azureActualAvailable || gcpActualAvailable;

  // Cloud tab switcher UI — shown when >1 cloud has real data
  const cloudTabs: Array<{ key: "AWS" | "AZURE" | "GCP"; label: string; logo: string; activeClass: string; available: boolean }> = [
    { key: "AWS",   label: "AWS",   logo: awsLogo,   activeClass: "text-orange-600", available: awsActualAvailable },
    { key: "AZURE", label: "Azure", logo: azureLogo, activeClass: "text-blue-600",   available: azureActualAvailable },
    { key: "GCP",   label: "GCP",   logo: gcpLogo,   activeClass: "text-blue-500",   available: gcpActualAvailable },
  ];
  const CloudTabSwitcher = multipleActualAvailable ? (
    <div className="flex items-center gap-1 rounded-lg bg-gray-100 p-1">
      {cloudTabs.filter(t => t.available).map(t => (
        <button
          key={t.key}
          onClick={() => setActiveActualCloud(t.key)}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            activeActualCloud === t.key ? `bg-white shadow ${t.activeClass}` : "text-gray-600 hover:text-gray-900"
          }`}
        >
          <img src={t.logo} className="h-3.5 w-3.5 object-contain" alt={t.label} />
          {t.label}
        </button>
      ))}
    </div>
  ) : null;
  const [costMode, setCostMode] = useState<CostMode>("estimated");

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <span className="ml-1 text-gray-300">↕</span>;
    }
    return <span className="ml-1">{sortDirection === "asc" ? "↑" : "↓"}</span>;
  };

  const showLoading = isLoading || infraLoading || (costMode === "actual" && (
    activeActualCloud === "AZURE" ? azureActualLoading :
    activeActualCloud === "GCP"   ? gcpActualLoading :
    actualLoading
  ));

  if (showLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
        <p className="text-sm text-gray-500">Loading cloud costs...</p>
      </div>
    );
  }

  // Render Azure actual costs view
  if (costMode === "actual" && activeActualCloud === "AZURE" && azureActualData?.available) {
    const summary = azureActualData.summary;
    const byChargeType = azureActualData.by_charge_type;
    const byCluster = azureActualData.by_cluster;
    const timeseries = azureActualData.timeseries;

    const chargeTypePieData = byChargeType?.charge_types?.map((ct) => ({
      name: ct.charge_type,
      value: ct.total_cost,
      fill: CHARGE_TYPE_COLORS[ct.charge_type] || CHARGE_TYPE_COLORS.Other,
    })) || [];

    return (
      <div className="space-y-6">
        {/* Mode Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-3 py-1 text-sm font-medium text-blue-800">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Azure Cost Data Available
            </span>
            {CloudTabSwitcher}
          </div>
          <div className="flex rounded-lg bg-gray-100 p-1">
            <button
              onClick={() => setCostMode("actual")}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                costMode === "actual"
                  ? "bg-white text-blue-600 shadow"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              Actual Costs
            </button>
            <button
              onClick={() => setCostMode("estimated")}
              className="rounded-md px-4 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
            >
              Estimated
            </button>
          </div>
        </div>

        {/* Azure Actual Summary */}
        <div className="rounded-lg p-6 text-white shadow" style={{ background: 'linear-gradient(to right, #0078D4, #50B4F9)' }}>
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.85)' }}>Actual Azure Infrastructure Cost</p>
                <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}>From Cost Management Export</span>
              </div>
              <p className="mt-1 text-3xl font-bold">{formatCurrency(summary?.total_cost || 0)}</p>
              <p className="mt-1 text-sm" style={{ color: 'rgba(255,255,255,0.85)' }}>
                Across {summary?.cluster_count || 0} clusters and {summary?.warehouse_count || 0} warehouses
              </p>
            </div>
            <div className="rounded-lg p-4" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}>
              <img src={azureLogo} alt="Azure" className="h-12 w-12 object-contain" />
            </div>
          </div>
          {summary?.total_cost_usd && summary.total_cost_usd !== summary.total_cost && (
            <div className="mt-4 border-t pt-4" style={{ borderColor: 'rgba(255,255,255,0.2)' }}>
              <p className="text-xs" style={{ color: 'rgba(255,255,255,0.75)' }}>USD Equivalent</p>
              <p className="text-lg font-semibold">{formatCurrency(summary.total_cost_usd)}</p>
            </div>
          )}
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Charge Type Breakdown */}
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Cost by Charge Type</h3>
            {chargeTypePieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={chargeTypePieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, percent }) => `${name}: ${((percent || 0) * 100).toFixed(1)}%`}
                    labelLine={false}
                  >
                    {chargeTypePieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatCurrency(value as number)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-64 items-center justify-center text-gray-500">No charge type data</div>
            )}
          </div>

          {/* Cost Over Time */}
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Actual Azure Cost Over Time</h3>
            {timeseries?.timeseries && timeseries.timeseries.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={timeseries.timeseries}>
                  <XAxis
                    dataKey="date"
                    tickFormatter={(d) => format(parseISO(d), "MMM d")}
                  />
                  <YAxis tickFormatter={(v) => formatCurrency(v)} />
                  <Tooltip
                    formatter={(value) => formatCurrency(value as number)}
                    labelFormatter={(label) => format(parseISO(label as string), "MMM d, yyyy")}
                  />
                  <Legend />
                  {timeseries.charge_types.map((ct) => (
                    <Bar
                      key={ct}
                      dataKey={ct}
                      stackId="1"
                      fill={CHARGE_TYPE_COLORS[ct] || CHARGE_TYPE_COLORS.Other}
                      radius={[0, 0, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-64 items-center justify-center text-gray-500">No timeseries data</div>
            )}
          </div>
        </div>

        {/* Clusters Table */}
        {byCluster?.clusters && byCluster.clusters.length > 0 && (
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Actual Azure Costs by Cluster</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Cluster</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Compute</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Storage</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Network</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Total Cost</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {byCluster.clusters.slice(0, 20).map((cluster, idx) => (
                    <tr key={`${cluster.cluster_id}-${idx}`} className="hover:bg-gray-50">
                      <td className="px-3 py-3 text-sm font-medium text-gray-900">{cluster.cluster_id || "Unknown"}</td>
                      <td className="px-3 py-3 text-right text-sm text-gray-600">{formatCurrency(cluster.compute_cost)}</td>
                      <td className="px-3 py-3 text-right text-sm text-gray-600">{formatCurrency(cluster.storage_cost)}</td>
                      <td className="px-3 py-3 text-right text-sm text-gray-600">{formatCurrency(cluster.network_cost)}</td>
                      <td className="px-3 py-3 text-right text-sm font-medium text-gray-900">{formatCurrency(cluster.total_cost)}</td>
                      <td className="px-3 py-3 text-right text-sm text-gray-500">{cluster.percentage.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Render GCP actual costs view
  if (costMode === "actual" && activeActualCloud === "GCP" && gcpActualData?.available) {
    const summary = gcpActualData.summary;
    const byService = gcpActualData.by_service;
    const byProject = gcpActualData.by_project;
    const timeseries = gcpActualData.timeseries;

    const GCP_COLORS = ["#4285F4", "#34A853", "#FBBC05", "#EA4335", "#8AB4F8", "#81C995", "#FDD663", "#F28B82", "#A8C7FA", "#CCFF90"];

    const servicePieData = byService?.services?.map((s, i) => ({
      name: s.service,
      value: s.total_cost,
      fill: GCP_COLORS[i % GCP_COLORS.length],
    })) || [];

    return (
      <div className="space-y-6">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-3 py-1 text-sm font-medium text-blue-800">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              GCP Billing Data Available
            </span>
            {CloudTabSwitcher}
          </div>
          <div className="flex rounded-lg bg-gray-100 p-1">
            <button onClick={() => setCostMode("actual")} className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${costMode === "actual" ? "bg-white text-blue-500 shadow" : "text-gray-600 hover:text-gray-900"}`}>Actual Costs</button>
            <button onClick={() => setCostMode("estimated")} className="rounded-md px-4 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors">Estimated</button>
          </div>
        </div>

        {/* Summary card */}
        <div className="rounded-lg p-6 text-white shadow" style={{ background: 'linear-gradient(to right, #4285F4, #8AB4F8)' }}>
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium" style={{ color: 'rgba(255,255,255,0.85)' }}>Actual GCP Infrastructure Cost</p>
                <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}>From BigQuery Billing Export</span>
              </div>
              <p className="mt-1 text-3xl font-bold">{formatCurrency(summary?.total_cost || 0)} <span className="text-base font-normal opacity-75">{summary?.currency || "USD"}</span></p>
              <p className="mt-1 text-sm" style={{ color: 'rgba(255,255,255,0.85)' }}>
                Across {summary?.project_count || 0} projects · {summary?.service_count || 0} services · {summary?.days_in_range || 0} days
              </p>
            </div>
            <div className="rounded-lg p-4" style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}>
              <img src={gcpLogo} alt="GCP" className="h-12 w-12 object-contain" />
            </div>
          </div>
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Cost by Service pie */}
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Cost by GCP Service</h3>
            {servicePieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={servicePieData} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={2} dataKey="value"
                    label={({ name, percent }) => `${name}: ${((percent || 0) * 100).toFixed(1)}%`} labelLine={false}>
                    {servicePieData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                  </Pie>
                  <Tooltip formatter={(v) => formatCurrency(v as number)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : <div className="flex h-64 items-center justify-center text-gray-500">No service data</div>}
          </div>

          {/* Daily timeseries */}
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">GCP Cost Over Time</h3>
            {timeseries?.timeseries && timeseries.timeseries.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={timeseries.timeseries}>
                  <XAxis dataKey="date" tickFormatter={(d) => format(parseISO(d), "MMM d")} />
                  <YAxis tickFormatter={(v) => formatCurrency(v)} />
                  <Tooltip formatter={(v) => formatCurrency(v as number)} labelFormatter={(l) => format(parseISO(l as string), "MMM d, yyyy")} />
                  <Legend />
                  {(timeseries.services || []).slice(0, 8).map((svc, i) => (
                    <Bar key={svc} dataKey={svc} stackId="1" fill={GCP_COLORS[i % GCP_COLORS.length]} radius={[0, 0, 0, 0]} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            ) : <div className="flex h-64 items-center justify-center text-gray-500">No timeseries data</div>}
          </div>
        </div>

        {/* By Project table */}
        {byProject?.projects && byProject.projects.length > 0 && (
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Cost by GCP Project</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Project</th>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Project ID</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Services</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Total Cost</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {byProject.projects.slice(0, 20).map((p, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-3 py-3 text-sm font-medium text-gray-900">{p.project_name}</td>
                      <td className="px-3 py-3 text-sm text-gray-500 font-mono">{p.project_id}</td>
                      <td className="px-3 py-3 text-right text-sm text-gray-600">{p.service_count}</td>
                      <td className="px-3 py-3 text-right text-sm font-medium text-gray-900">{formatCurrency(p.total_cost)}</td>
                      <td className="px-3 py-3 text-right text-sm text-gray-500">{p.percentage.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* By Service table */}
        {byService?.services && byService.services.length > 0 && (
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Cost by GCP Service</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Service</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Days Active</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Total Cost</th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {byService.services.slice(0, 20).map((s, idx) => (
                    <tr key={idx} className="hover:bg-gray-50">
                      <td className="px-3 py-3 text-sm font-medium text-gray-900">{s.service}</td>
                      <td className="px-3 py-3 text-right text-sm text-gray-600">{s.days_active}</td>
                      <td className="px-3 py-3 text-right text-sm font-medium text-gray-900">{formatCurrency(s.total_cost)}</td>
                      <td className="px-3 py-3 text-right text-sm text-gray-500">{s.percentage.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Render actual costs view (AWS)
  if (costMode === "actual" && activeActualCloud === "AWS" && actualData?.available) {
    const summary = actualData.summary;
    const byChargeType = actualData.by_charge_type;
    const byCluster = actualData.by_cluster;
    const timeseries = actualData.timeseries;

    const chargeTypePieData = byChargeType?.charge_types?.map((ct) => ({
      name: ct.charge_type,
      value: ct.net_unblended_cost,
      fill: CHARGE_TYPE_COLORS[ct.charge_type] || CHARGE_TYPE_COLORS.Other,
    })) || [];

    return (
      <div className="space-y-6">
        {/* Mode Toggle */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-3 py-1 text-sm font-medium text-orange-800">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              AWS CUR Data Available
            </span>
            {CloudTabSwitcher}
          </div>
          <div className="flex rounded-lg bg-gray-100 p-1">
            <button
              onClick={() => setCostMode("actual")}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                costMode === "actual"
                  ? "bg-white text-orange-600 shadow"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              Actual Costs
            </button>
            <button
              onClick={() => setCostMode("estimated")}
              className="rounded-md px-4 py-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
            >
              Estimated
            </button>
          </div>
        </div>

        {/* Actual Costs Summary */}
        <div className="rounded-lg bg-gradient-to-r from-green-600 to-emerald-500 p-6 text-white shadow">
          <div className="flex items-center justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-green-100">Actual AWS Infrastructure Cost</p>
                <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs">From CUR 2.0</span>
              </div>
              <p className="mt-1 text-3xl font-bold">{formatCurrency(summary?.total_net_unblended || 0)}</p>
              <p className="mt-1 text-sm text-green-100">
                Across {summary?.cluster_count || 0} clusters and {summary?.warehouse_count || 0} warehouses
              </p>
            </div>
            <div className="rounded-lg bg-white/20 p-4">
              <svg className="h-12 w-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-4 gap-4 border-t border-white/20 pt-4">
            <div>
              <p className="text-xs text-green-200">Unblended</p>
              <p className="text-lg font-semibold">{formatCurrency(summary?.total_unblended || 0)}</p>
            </div>
            <div>
              <p className="text-xs text-green-200">Net Unblended</p>
              <p className="text-lg font-semibold">{formatCurrency(summary?.total_net_unblended || 0)}</p>
            </div>
            <div>
              <p className="text-xs text-green-200">Amortized</p>
              <p className="text-lg font-semibold">{formatCurrency(summary?.total_amortized || 0)}</p>
            </div>
            <div>
              <p className="text-xs text-green-200">Net Amortized</p>
              <p className="text-lg font-semibold">{formatCurrency(summary?.total_net_amortized || 0)}</p>
            </div>
          </div>
        </div>

        {/* Charts Row */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Charge Type Breakdown */}
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Cost by Charge Type</h3>
            {chargeTypePieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={chargeTypePieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, percent }) => `${name}: ${((percent || 0) * 100).toFixed(1)}%`}
                    labelLine={false}
                  >
                    {chargeTypePieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value) => formatCurrency(value as number)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-64 items-center justify-center text-gray-500">No charge type data</div>
            )}
          </div>

          {/* Cost Over Time */}
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Actual AWS Cost Over Time</h3>
            {timeseries?.timeseries && timeseries.timeseries.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={timeseries.timeseries}>
                  <XAxis
                    dataKey="date"
                    tickFormatter={(d) => format(parseISO(d), "MMM d")}
                  />
                  <YAxis tickFormatter={(v) => formatCurrency(v)} />
                  <Tooltip
                    formatter={(value) => formatCurrency(value as number)}
                    labelFormatter={(label) => format(parseISO(label as string), "MMM d, yyyy")}
                  />
                  <Legend />
                  {timeseries.charge_types.map((ct) => (
                    <Bar
                      key={ct}
                      dataKey={ct}
                      stackId="1"
                      fill={CHARGE_TYPE_COLORS[ct] || CHARGE_TYPE_COLORS.Other}
                      radius={[0, 0, 0, 0]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-64 items-center justify-center text-gray-500">No timeseries data</div>
            )}
          </div>
        </div>

        {/* Clusters Table */}
        {byCluster?.clusters && byCluster.clusters.length > 0 && (
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">Actual AWS Costs by Cluster</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                      Cluster
                    </th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Compute
                    </th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Storage
                    </th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Network
                    </th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      Total Cost
                    </th>
                    <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                      %
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {byCluster.clusters.slice(0, 20).map((cluster, idx) => (
                    <tr key={`${cluster.cluster_id}-${idx}`} className="hover:bg-gray-50">
                      <td className="px-3 py-3 text-sm font-medium text-gray-900">
                        {cluster.cluster_id || "Unknown"}
                      </td>
                      <td className="px-3 py-3 text-right text-sm text-gray-600">
                        {formatCurrency(cluster.compute_cost)}
                      </td>
                      <td className="px-3 py-3 text-right text-sm text-gray-600">
                        {formatCurrency(cluster.storage_cost)}
                      </td>
                      <td className="px-3 py-3 text-right text-sm text-gray-600">
                        {formatCurrency(cluster.network_cost)}
                      </td>
                      <td className="px-3 py-3 text-right text-sm font-medium text-gray-900">
                        {formatCurrency(cluster.total_cost)}
                      </td>
                      <td className="px-3 py-3 text-right text-sm text-gray-500">
                        {cluster.percentage.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  // Always show the mode toggle - indicates CUR integration status
  // Only show when actual data IS available (we'll show the "not configured" in the dropdown instead)
  const ModeToggle = actualAvailable ? (
    <div className="mb-6 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 px-3 py-1 text-sm font-medium text-orange-800">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {multipleActualAvailable ? "Multi-Cloud Cost Data Available" : azureActualAvailable ? "Azure Cost Data Available" : gcpActualAvailable ? "GCP Cost Data Available" : "AWS CUR Data Available"}
        </span>
        {CloudTabSwitcher}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex rounded-lg bg-gray-100 p-1">
          <button
            onClick={() => setCostMode("actual")}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              costMode === "actual"
                ? "bg-white text-orange-600 shadow"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Actual Costs
          </button>
          <button
            onClick={() => setCostMode("estimated")}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              costMode === "estimated"
                ? "bg-white text-orange-600 shadow"
                : "text-gray-600 hover:text-gray-900"
            }`}
          >
            Estimated
          </button>
        </div>
        {cloudIntegrations.length < 3 && (
          <button
            onClick={() => { setWizardCloud(null); setWizardExpandedStep(null); setViewingIntegration(null); setShowIntegrationWizard(true); }}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Integrate cloud costs
          </button>
        )}
      </div>
    </div>
  ) : null;

  // Estimation methodology info box (shown at the top like other tabs)
  const EstimationInfoBox = data && (
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
            <h3 className="text-sm font-medium text-orange-800">Estimated {cloudDisplayName} Infrastructure Cost — Methodology</h3>
            <svg className={`h-4 w-4 text-orange-500 transition-transform ${infoMinimized ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {!infoMinimized && (
            <>
              <div className="mt-2 text-sm text-orange-700">
                {isAzure ? (
                  <ul className="list-inside list-disc space-y-1">
                    <li>Estimates <strong>Azure VM Pay-As-You-Go</strong> costs (East US, Linux) per node based on cluster instance types</li>
                    <li>Node uptime is derived from DBU hours — clusters are billed for every node-hour while running</li>
                    <li>Pricing sourced from Azure public pricing (2025); East US rates used as baseline</li>
                    <li><strong>Not included:</strong> Managed Disk storage (P10 ~$19.71/mo, P20 ~$38.40/mo per disk), outbound bandwidth ($0.087/GB)</li>
                    <li>Actual costs may vary by region, SKU availability, and subscription discounts</li>
                  </ul>
                ) : isGCP ? (
                  <ul className="list-inside list-disc space-y-1">
                    <li>Estimates <strong>Compute Engine On-Demand</strong> costs (us-central1, Linux) per node based on cluster machine types</li>
                    <li>Node uptime is derived from DBU hours — clusters are billed for every node-hour while running</li>
                    <li>Pricing sourced from GCP public pricing (2025); us-central1 rates used as baseline</li>
                    <li><strong>Not included:</strong> Persistent Disk storage (~$0.04/GB-month SSD), egress charges, Google Cloud Storage</li>
                    <li>Actual costs may vary by region, Committed Use Discounts, and Spot VM usage</li>
                  </ul>
                ) : (
                  <ul className="list-inside list-disc space-y-1">
                    <li>Estimates <strong>EC2 On-Demand</strong> costs (us-east-1, Linux) per node based on cluster instance types</li>
                    <li>Node uptime is derived from DBU hours — clusters are billed for every node-hour while running</li>
                    <li>Pricing sourced from AWS public pricing (2025); us-east-1 rates used as baseline</li>
                    <li><strong>Not included:</strong> EBS gp3 storage (~$0.08–$0.10/GB-month), data transfer, Route 53</li>
                    <li>Actual costs may vary by region, purchasing model, and AWS organization discounts</li>
                  </ul>
                )}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={infoMinimized}
                    onChange={(e) => handleMinimizeToggle(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-orange-300 text-orange-600 focus:ring-orange-500"
                  />
                  <span className="text-xs text-orange-600">Minimize from now on</span>
                </label>
                <span className="text-xs text-orange-500 italic">For exact costs, integrate {isAzure ? "Azure Cost Management" : isGCP ? "GCP Billing Export" : "AWS CUR 2.0"} below ↓</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  // CUR setup info banner (shown when CUR is not configured)
  const CurSetupBanner = !actualAvailable ? (
    <div className="mb-6">
      {/* Toggle row: Actual (disabled) | Estimated — with inline info tooltip and integrate button */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg bg-gray-100 p-1">
            <button
              disabled
              className="cursor-not-allowed rounded-md px-4 py-1.5 text-sm font-medium text-gray-500"
              title={`Configure ${isAzure ? "Azure Cost Management Export" : "AWS CUR"} to enable actual costs`}
            >
              Actual Costs
            </button>
            <button className="rounded-md bg-white px-4 py-1.5 text-sm font-medium text-orange-600 shadow">
              Estimated
            </button>
          </div>
          <span className="flex items-center gap-1.5 text-sm text-gray-500">
            <svg className="h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Add cloud billing integrations to see actual costs from {isAzure ? "Azure Cost Management" : "AWS CUR"} alongside your estimates.
          </span>
        </div>
        {cloudIntegrations.length < 3 && (
          <button
            onClick={() => { setWizardCloud(null); setWizardExpandedStep(null); setViewingIntegration(null); setShowIntegrationWizard(true); }}
            className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Integrate cloud costs
          </button>
        )}
      </div>



      {/* Additional cloud integrations section */}
      {cloudIntegrations.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-xs font-medium uppercase tracking-wider text-gray-500">Additional Cloud Integrations</div>
          {cloudIntegrations.map((integration) => (
            <div key={integration.id} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 text-xs font-medium"
                  style={integration.cloud === "azure"
                    ? { backgroundColor: '#0078D420', color: '#0078D4' }
                    : { backgroundColor: '#FF990020', color: '#CC7700' }
                  }
                >
                  {integration.label}
                </span>
                <span className="text-sm text-gray-700">{integration.cloud === "azure" ? "Azure Cost Management Export" : integration.cloud === "gcp" ? "GCP Billing Export (BigQuery)" : "AWS CUR 2.0"}</span>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Setup in progress</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => openWizardForExisting(integration)}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  View setup guide
                </button>
                <button
                  onClick={() => removeIntegration(integration.id)}
                  className="rounded p-1 text-gray-500 hover:bg-red-50 hover:text-red-500"
                  title="Remove integration"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  ) : null;

  if (data?.error) {
    return (
      <div className="space-y-6">
        {ModeToggle}
        {CurSetupBanner}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">{cloudDisplayName} Infrastructure Costs</h3>
          <p className="text-sm text-amber-600">{data.error}</p>
        </div>
      </div>
    );
  }

  if (!data || data.clusters.length === 0) {
    return (
      <div className="space-y-6">
        {ModeToggle}
        {CurSetupBanner}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">{cloudDisplayName} Infrastructure Costs</h3>
          <div className="flex h-32 flex-col items-center justify-center gap-2 text-gray-500">
            <p className="text-base font-medium">No cluster data available</p>
            <p className="text-sm">Infrastructure cost estimates require active compute clusters in the selected date range</p>
          </div>
        </div>
      </div>
    );
  }

  // Extract instance family from an instance type string (matches backend regex logic)
  function getInstanceFamily(instanceType: string | null | undefined): string {
    if (!instanceType) return 'unknown';
    // Azure: Standard_<Family><Size>... → "Standard_D", "Standard_DS", etc.
    if (instanceType.startsWith('Standard_')) {
      const m = instanceType.match(/^(Standard_[A-Z]+)/);
      return m ? m[1] : 'unknown';
    }
    // AWS: <family>.<size> → "m5", "g4dn" etc.
    // Also handles fleet types with no dot: "rd-fleet" → "rd-fleet"
    const dotIdx = instanceType.indexOf('.');
    return dotIdx > 0 ? instanceType.slice(0, dotIdx) : instanceType;
  }

  // Cloud costs summary stats
  const cloudSummary = useMemo(() => {
    const bs = (data as any)?.billing_summary;
    const totalDBUHours = data.clusters.reduce((sum, c) => sum + (c.total_dbu_hours || 0), 0);
    const clustersWithTypes = data.clusters.filter(c => c.driver_instance_type || c.worker_instance_type);
    const estimatedTotal = clustersWithTypes.reduce((sum, c) => sum + (c.estimated_aws_cost || 0), 0);

    // avgCostPerCluster: use billing_summary.avg_cost_per_cluster (Databricks billing: DBU × price/DBU)
    // divided by compute/jobs/dlt clusters per day — consistent with the kpi-trend drill-down.
    const avgCostPerCluster = bs?.avg_cost_per_cluster || (() => {
      const tsPoints = infraTimeseriesData?.timeseries || [];
      const activeTsPoints = tsPoints.filter(p => (p["Infrastructure Cost"] || 0) > 0);
      if (activeTsPoints.length > 0) {
        const tsTotal = activeTsPoints.reduce((s, p) => s + (p["Infrastructure Cost"] || 0), 0);
        return tsTotal / activeTsPoints.length;
      }
      return 0;
    })();

    if (bs && bs.total_cost > 0) {
      return {
        totalCost: bs.total_cost,
        totalDBUHours,
        avgActiveClustersPerDay: bs.avg_clusters_per_day,
        avgCostPerCluster,
      };
    }

    const totalCost = estimatedTotal;
    return { totalCost, totalDBUHours, avgActiveClustersPerDay: clustersWithTypes.length, avgCostPerCluster };
  }, [data, infraTimeseriesData]);

  // Filter historical clusters if toggle is off
  const filteredClusters = showHistoricalClusters
    ? data.clusters
    : data.clusters.filter(c => c.driver_instance_type || c.worker_instance_type);

  // Apply instance family filter (shared with the chart family chips above)
  const familyFilteredClusters = selectedFamilies.size === 0
    ? filteredClusters
    : filteredClusters.filter(c => {
        const df = getInstanceFamily(c.driver_instance_type);
        const wf = getInstanceFamily(c.worker_instance_type);
        return selectedFamilies.has(df) || selectedFamilies.has(wf);
      });

  // Derive available families from data.instance_families (full dataset, not limited to top-100 cluster rows)
  const availableTableFamilies = (() => {
    const families = new Set<string>();
    (data.instance_families || []).forEach(f => {
      if (f.instance_family && f.instance_family !== 'unknown') families.add(f.instance_family);
    });
    return [...families].sort();
  })();

  const availableTableWorkspaces = (() => {
    const ws = new Set<string>();
    familyFilteredClusters.forEach(c => { if (c.workspace_id) ws.add(c.workspace_id); });
    return [...ws].sort();
  })();

  // Apply table-specific dropdown filters
  const tableFilteredClusters = familyFilteredClusters.filter(c => {
    if (tableFamily) {
      const df = getInstanceFamily(c.driver_instance_type);
      const wf = getInstanceFamily(c.worker_instance_type);
      if (df !== tableFamily && wf !== tableFamily) return false;
    }
    if (tableWorkspace && c.workspace_id !== tableWorkspace) return false;
    return true;
  });

  const sortedClusters = [...tableFilteredClusters].sort((a, b) => {
    const modifier = sortDirection === "asc" ? 1 : -1;
    if (sortField === "cluster_name") {
      return ((a.cluster_name || "").localeCompare(b.cluster_name || "")) * modifier;
    }
    const aVal = a[sortField] as number;
    const bVal = b[sortField] as number;
    return (aVal - bVal) * modifier;
  });

  const totalPages = Math.ceil(sortedClusters.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedClusters = sortedClusters.slice(startIndex, endIndex);

  // Prepare instance family chart data
  const familyChartData = data.instance_families
    .filter((f) => f.instance_family && f.instance_family !== "unknown")
    .slice(0, 10)
    .map((f) => ({
      name: f.instance_family,
      value: f.total_dbu_hours,
    }));

  // Instance families available in timeseries for filter bubbles
  const timeseriesFamilies: string[] = (timeseriesData as any)?.instance_families || [];

  // Compute filtered timeseries when family filters are active
  const filteredTimeseriesData = useMemo(() => {
    if (!timeseriesData?.timeseries) return null;
    if (selectedFamilies.size === 0) return timeseriesData.timeseries;
    return timeseriesData.timeseries.map((point) => {
      let filteredCost = 0;
      for (const family of selectedFamilies) {
        filteredCost += (point[family] as number) || 0;
      }
      return { ...point, "AWS Cost": filteredCost };
    });
  }, [timeseriesData, selectedFamilies]);

  return (
    <div className="animate-fade-in space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cloud Costs</h1>
          <p className="text-sm text-gray-500">Estimated cloud infrastructure costs and cluster analytics</p>
        </div>
      </div>

      {/* Estimation Info Box */}
      {EstimationInfoBox}

      {ModeToggle}
      {CurSetupBanner}

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* 1. Total Cloud Cost */}
        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({ kpi: "infra_cost", label: "Infrastructure Spend" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500 flex items-center gap-1">
                Est. Total Cloud Cost
                <span className="inline-flex items-center group relative">
                  <svg className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="pointer-events-none absolute bottom-5 left-0 z-[9999] w-72 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                    Estimated {cloudDisplayName} VM cost for cluster compute nodes, derived from DBU hours × cloud instance pricing ({cloudDisplayName === "GCP" ? "us-central1" : cloudDisplayName === "Azure" ? "East US" : "us-east-1"} on-demand rates). Separate from Databricks DBU spend shown in the page header.
                  </span>
                </span>
              </p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(cloudSummary.totalCost)}</p>
              {startDate && endDate && <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>}
            </div>
          </div>
        </div>
        {/* 2. Total DBU Hours */}
        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({ kpi: "infra_dbu_hours", label: "Total DBU Hours" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total DBU Hours</p>
              <p className="text-2xl font-semibold text-gray-900">{formatNumber(cloudSummary.totalDBUHours)}</p>
              {startDate && endDate && <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>}
            </div>
          </div>
        </div>
        {/* 3. Avg Active Clusters Per Day */}
        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({ kpi: "infra_clusters", label: "Avg Active Clusters / Day" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Avg Active Clusters / Day</p>
              <p className="text-2xl font-semibold text-gray-900">{formatNumber(cloudSummary.avgActiveClustersPerDay)}</p>
              {startDate && endDate && <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>}
            </div>
          </div>
        </div>
        {/* 4. Avg Cluster Cost */}
        <div
          className={`rounded-lg bg-white p-6 border shadow-sm transition-all ${startDate && endDate ? "cursor-pointer hover:shadow-md hover:scale-[1.01]" : ""}`}
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => startDate && endDate && setSelectedKPI({ kpi: "avg_cost_per_cluster", label: "Est. Avg Cluster Cost" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Est. Avg Cluster Cost</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(cloudSummary.avgCostPerCluster)}</p>
              {startDate && endDate && (
                <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
              )}
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

      {/* Cost Over Time + Usage by Instance Family - Side by Side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Infrastructure Cost Over Time Chart */}
        {(infraTimeseriesLoading || timeseriesLoading) ? (
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">{cloudDisplayName} Cost Over Time</h3>
            <div className="h-80 animate-pulse rounded bg-gray-200" />
          </div>
        ) : (infraTimeseriesData?.timeseries && infraTimeseriesData.timeseries.length > 0) ? (
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="mb-4 text-lg font-semibold text-gray-900">{cloudDisplayName} Cost Over Time</h3>
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart
                data={infraTimeseriesData.timeseries}
                margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="infraCostGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  stroke="#9ca3af"
                  fontSize={12}
                  tickMargin={8}
                />
                <YAxis
                  tickFormatter={(v) => formatCurrency(v)}
                  stroke="#9ca3af"
                  fontSize={12}
                  width={80}
                />
                <Tooltip
                  formatter={(value: number | undefined) => formatCurrency(value ?? 0)}
                  labelFormatter={(label) => format(parseISO(label as string), "MMM d, yyyy")}
                  contentStyle={{
                    backgroundColor: "white",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="Infrastructure Cost"
                  stroke="#f97316"
                  strokeWidth={2}
                  fill="url(#infraCostGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : (filteredTimeseriesData && filteredTimeseriesData.length > 0) ? (
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">{cloudDisplayName} Cost Over Time</h3>
              {timeseriesFamilies.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setSelectedFamilies(new Set())}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      selectedFamilies.size === 0
                        ? "text-white"
                        : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                    }`}
                    style={selectedFamilies.size === 0 ? { backgroundColor: '#1B5162' } : undefined}
                  >
                    All
                  </button>
                  {timeseriesFamilies.filter(f => f !== "unknown").slice(0, 8).map((family, idx) => (
                    <button
                      key={family}
                      onClick={() => {
                        setSelectedFamilies((prev) => {
                          const next = new Set(prev);
                          if (next.has(family)) {
                            next.delete(family);
                          } else {
                            next.add(family);
                          }
                          return next;
                        });
                      }}
                      className={`rounded-full px-3 py-1 text-xs font-medium ${
                        selectedFamilies.has(family)
                          ? "text-white"
                          : "bg-blue-50 text-blue-700 hover:bg-blue-100"
                      }`}
                      style={selectedFamilies.has(family) ? { backgroundColor: getInstanceColor(family, idx) } : undefined}
                    >
                      {family}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart
                data={filteredTimeseriesData}
                margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="awsCostGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f97316" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDate}
                  stroke="#9ca3af"
                  fontSize={12}
                  tickMargin={8}
                />
                <YAxis
                  tickFormatter={(v) => formatCurrency(v)}
                  stroke="#9ca3af"
                  fontSize={12}
                  width={80}
                />
                <Tooltip
                  formatter={(value: number | undefined) => formatCurrency(value ?? 0)}
                  labelFormatter={(label) => format(parseISO(label as string), "MMM d, yyyy")}
                  contentStyle={{
                    backgroundColor: "white",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="AWS Cost"
                  stroke="#f97316"
                  strokeWidth={2}
                  fill="url(#awsCostGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ) : null}

        {/* Usage by Instance Family */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Usage by Instance Family</h3>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={familyChartData} layout="vertical" margin={{ left: 10, right: 20 }}>
              <XAxis type="number" tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} stroke="#9ca3af" fontSize={12} tickMargin={8} />
              <YAxis type="category" dataKey="name" width={100} fontSize={12} stroke="#9ca3af" interval={0} />
              <Tooltip
                formatter={(value: number | undefined) => [formatNumber(value ?? 0) + " DBU hours", "Usage"]}
                contentStyle={{
                  backgroundColor: "white",
                  border: "1px solid #e5e7eb",
                  borderRadius: "8px",
                }}
              />
              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                {familyChartData.map((entry, index) => (
                  <Cell
                    key={entry.name}
                    fill={getInstanceColor(entry.name, index)}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Clusters Table */}
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Estimated {cloudDisplayName} Costs by Cluster</h3>
            <p className="text-sm text-gray-500">
              {sortedClusters.length} cluster{sortedClusters.length !== 1 ? "s" : ""}{selectedFamilies.size > 0 ? ` · ${[...selectedFamilies].join(", ")} only` : ""}{" "}
              <span className="inline-flex items-center gap-1 group relative">
                <svg className="h-3.5 w-3.5 text-gray-400 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="pointer-events-none absolute bottom-5 left-0 z-[9999] w-72 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                  Estimated {cloudDisplayName} VM cost for cluster compute nodes, derived from DBU hours × cloud instance pricing ({cloudDisplayName === "GCP" ? "us-central1" : cloudDisplayName === "Azure" ? "East US" : "us-east-1"} on-demand rates). This is separate from Databricks DBU spend shown in the page header, which reflects actual Databricks billing.
                </span>
              </span>
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Instance Family filter */}
            {availableTableFamilies.length > 0 && (
              <div className="relative" ref={familyFilterRef}>
                <button
                  onClick={() => { setFamilyFilterOpen(o => !o); setWorkspaceFilterOpen(false); }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${tableFamily ? "border-transparent text-white" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`}
                  style={tableFamily ? { backgroundColor: '#FF3621' } : {}}
                >
                  Instance Family{tableFamily ? `: ${tableFamily}` : ""}
                  {tableFamily ? (
                    <span
                      className="opacity-75 hover:opacity-100 ml-0.5 cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); setTableFamily(""); setCurrentPage(1); }}
                    >×</span>
                  ) : (
                    <svg className={`h-3 w-3 text-gray-500 transition-transform ${familyFilterOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  )}
                </button>
                {familyFilterOpen && (
                  <div className="absolute left-0 top-full z-10 mt-1 w-52 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg" style={{ maxHeight: 260 }}>
                    {availableTableFamilies.map(f => (
                      <button
                        key={f}
                        onClick={() => { setTableFamily(tableFamily === f ? "" : f); setCurrentPage(1); setFamilyFilterOpen(false); }}
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-xs hover:bg-gray-50 ${tableFamily === f ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700"}`}
                      >
                        <span className="flex items-center gap-2">
                          {tableFamily === f && <span className="h-1.5 w-1.5 rounded-full bg-orange-500 inline-block" />}
                          {f}
                        </span>
                        {tableFamily === f && <svg className="h-3.5 w-3.5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Workspace filter */}
            {availableTableWorkspaces.length > 1 && (
              <div className="relative" ref={workspaceFilterRef}>
                <button
                  onClick={() => { setWorkspaceFilterOpen(o => !o); setFamilyFilterOpen(false); }}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${tableWorkspace ? "border-transparent text-white" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`}
                  style={tableWorkspace ? { backgroundColor: '#FF3621' } : {}}
                >
                  Workspace{tableWorkspace ? `: ${workspaceNameMap?.[tableWorkspace] || tableWorkspace}` : ""}
                  {tableWorkspace ? (
                    <span
                      className="opacity-75 hover:opacity-100 ml-0.5 cursor-pointer"
                      onClick={(e) => { e.stopPropagation(); setTableWorkspace(""); setCurrentPage(1); }}
                    >×</span>
                  ) : (
                    <svg className={`h-3 w-3 text-gray-500 transition-transform ${workspaceFilterOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  )}
                </button>
                {workspaceFilterOpen && (
                  <div className="absolute left-0 top-full z-10 mt-1 w-56 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg" style={{ maxHeight: 260 }}>
                    {availableTableWorkspaces.map(w => {
                      const label = workspaceNameMap?.[w] || w;
                      return (
                        <button
                          key={w}
                          onClick={() => { setTableWorkspace(tableWorkspace === w ? "" : w); setCurrentPage(1); setWorkspaceFilterOpen(false); }}
                          className={`flex w-full items-center justify-between px-3 py-1.5 text-xs hover:bg-gray-50 ${tableWorkspace === w ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700"}`}
                        >
                          <span className="flex items-center gap-2">
                            {tableWorkspace === w && <span className="h-1.5 w-1.5 rounded-full bg-orange-500 inline-block" />}
                            {label}
                          </span>
                          {tableWorkspace === w && <svg className="h-3.5 w-3.5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={showHistoricalClusters}
                onChange={(e) => {
                  setShowHistoricalClusters(e.target.checked);
                  setCurrentPage(1); // Reset to first page when filtering
                }}
                className="h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
              />
              <span>Show historical clusters</span>
            </label>
            <div className="group relative">
              <svg className="h-4 w-4 cursor-help text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="invisible absolute right-0 top-6 z-10 w-72 rounded-lg bg-gray-900 p-3 text-xs text-white opacity-0 shadow-xl transition-all group-hover:visible group-hover:opacity-100">
                <p className="font-semibold mb-1.5">Historical Clusters</p>
                <p className="text-gray-200">
                  Historical clusters have no instance type information available. These are typically old or deleted clusters that no longer have detailed configuration data.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  className="cursor-pointer px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                  onClick={() => handleSort("cluster_name")}
                >
                  Cluster <SortIcon field="cluster_name" />
                </th>
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  Instance Types
                </th>
                <th
                  className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span
                      className="cursor-pointer hover:text-gray-700"
                      onClick={() => handleSort("estimated_aws_cost")}
                    >
                      Est. Cost <SortIcon field="estimated_aws_cost" />
                    </span>
                    <div className="group relative">
                      <svg className="h-3.5 w-3.5 cursor-help text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <div className="invisible absolute right-0 top-6 z-10 w-72 rounded-lg bg-gray-900 p-3 text-xs text-white opacity-0 shadow-xl transition-all group-hover:visible group-hover:opacity-100">
                        <p className="font-semibold mb-1.5">Cost Estimate Details</p>
                        <ul className="space-y-1 text-gray-200">
                          <li>• {isAzure ? "Azure VM" : "EC2 instance"} costs only</li>
                          <li>• Based on on-demand pricing</li>
                          <li>• Assumes avg 2-4 workers per cluster</li>
                          <li>• Excludes storage, network, and platform fees</li>
                        </ul>
                      </div>
                    </div>
                  </div>
                </th>
                <th
                  className="cursor-pointer px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                  onClick={() => handleSort("total_dbu_hours")}
                >
                  DBU Hours <SortIcon field="total_dbu_hours" />
                </th>
                <th
                  className="cursor-pointer px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                  onClick={() => handleSort("days_active")}
                >
                  Days <SortIcon field="days_active" />
                </th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                  %
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {paginatedClusters.map((cluster, idx) => {
                const url = getClusterUrl(_host, cluster.cluster_id, cluster.workspace_id);

                return (
                  <tr key={`${cluster.cluster_id}-${idx}`} className="hover:bg-gray-50">
                    <td className="px-3 py-3">
                      {url ? (
                        <div className="flex flex-col gap-1">
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group flex max-w-xs items-center gap-1 truncate text-sm font-medium text-blue-600 hover:text-blue-800"
                          >
                            <span className="truncate">{cluster.cluster_name || cluster.cluster_id}</span>
                            <svg className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                          </a>
                          <div className="flex items-center gap-2">
                            {cluster.state && <StatusIndicator status={cluster.state} type="cluster" />}
                            {cluster.cluster_source && (
                              <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                                {cluster.cluster_source}
                              </span>
                            )}
                            {cluster.cluster_name && cluster.cluster_name !== cluster.cluster_id && (
                              <span className="text-xs text-gray-500">{cluster.cluster_id}</span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-1">
                          <div className="max-w-xs truncate text-sm font-medium text-gray-900">
                            {cluster.cluster_name || cluster.cluster_id}
                          </div>
                          <div className="flex items-center gap-2">
                            {cluster.state && <StatusIndicator status={cluster.state} type="cluster" />}
                            {cluster.cluster_source && (
                              <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                                {cluster.cluster_source}
                              </span>
                            )}
                            {cluster.cluster_name && cluster.cluster_name !== cluster.cluster_id && (
                              <span className="text-xs text-gray-500">{cluster.cluster_id}</span>
                            )}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex flex-col gap-1">
                        {cluster.driver_instance_type && (
                          <div className="group relative inline-flex items-center gap-1">
                            <span className="inline-flex rounded bg-blue-50 px-2 py-0.5 text-xs font-mono text-blue-700">
                              D: {cluster.driver_instance_type}
                            </span>
                            <a
                              href={getInstancePricingUrl(cluster.driver_instance_type, isAzure)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-500 hover:text-blue-700"
                              title={`View ${isAzure ? "Azure" : "AWS"} pricing for this instance type`}
                            >
                              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </a>
                          </div>
                        )}
                        {cluster.worker_instance_type && (
                          <div className="group relative inline-flex items-center gap-1">
                            <span className="inline-flex rounded bg-green-50 px-2 py-0.5 text-xs font-mono text-green-700">
                              W: {cluster.worker_instance_type}
                            </span>
                            <a
                              href={getInstancePricingUrl(cluster.worker_instance_type, isAzure)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-green-500 hover:text-green-700"
                              title={`View ${isAzure ? "Azure" : "AWS"} pricing for this instance type`}
                            >
                              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </a>
                          </div>
                        )}
                        {!cluster.driver_instance_type && !cluster.worker_instance_type && (
                          <div className="group relative inline-flex items-center gap-1">
                            <span className="inline-flex rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
                              Historical cluster
                            </span>
                            <div className="relative">
                              <svg className="h-3 w-3 cursor-help text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <div className="invisible absolute left-0 top-6 z-10 w-64 rounded-lg bg-gray-900 p-3 text-xs text-white opacity-0 shadow-xl transition-all group-hover:visible group-hover:opacity-100">
                                <p className="font-semibold mb-1.5">Instance type unavailable</p>
                                <p className="text-gray-200">
                                  This cluster no longer exists in the workspace. Instance type information is only available for currently configured clusters.
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-medium text-gray-900">
                      {formatCurrency(cluster.estimated_aws_cost)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-600">
                      {formatNumber(cluster.total_dbu_hours)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-600">
                      {cluster.days_active}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-500">
                      {cluster.percentage.toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50">
              <tr>
                <td colSpan={2} className="px-3 py-3 text-sm font-medium text-gray-700">
                  Total ({sortedClusters.length} clusters)
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-bold text-gray-900">
                  <span className="inline-flex items-center justify-end gap-1 group relative">
                    {formatCurrency(data.total_estimated_cost)}
                    <svg className="h-3.5 w-3.5 text-gray-400 cursor-help flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="pointer-events-none absolute bottom-6 right-0 z-[9999] w-72 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-normal text-gray-600 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                      Estimated {cloudDisplayName} VM cost based on DBU hours × cloud instance pricing ({cloudDisplayName === "GCP" ? "us-central1" : cloudDisplayName === "Azure" ? "East US" : "us-east-1"} on-demand rates). This differs from the Databricks DBU spend shown in the page header, which reflects actual billed usage from system.billing.usage.
                    </span>
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-medium text-gray-700">
                  {formatNumber(data.total_dbu_hours)}
                </td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
              <p className="text-sm text-gray-700">
                Showing <span className="font-medium">{startIndex + 1}</span> to{" "}
                <span className="font-medium">{Math.min(endIndex, sortedClusters.length)}</span> of{" "}
                <span className="font-medium">{sortedClusters.length}</span> clusters
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage === 1}
                  className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Previous
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((page) => {
                    // Show first, last, current, and pages around current
                    return (
                      page === 1 ||
                      page === totalPages ||
                      (page >= currentPage - 1 && page <= currentPage + 1)
                    );
                  })
                  .map((page, idx, arr) => {
                    // Add ellipsis if there's a gap
                    const prevPage = arr[idx - 1];
                    const showEllipsis = prevPage && page - prevPage > 1;
                    return (
                      <>
                        {showEllipsis && (
                          <span key={`ellipsis-${page}`} className="px-2 py-1 text-gray-500">
                            ...
                          </span>
                        )}
                        <button
                          key={page}
                          onClick={() => setCurrentPage(page)}
                          className={`rounded px-3 py-1 text-sm font-medium ${
                            currentPage === page
                              ? "bg-orange-600 text-white"
                              : "border border-gray-300 text-gray-700 hover:bg-gray-50"
                          }`}
                        >
                          {page}
                        </button>
                      </>
                    );
                  })}
                <button
                  onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage === totalPages}
                  className="rounded border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Preload logos so they're instant when the modal opens */}
      <div className="fixed" style={{ top: -9999, left: -9999, opacity: 0.01, pointerEvents: "none" }} aria-hidden="true">
        <img src={awsLogo} alt="" style={{ width: 1, height: 1 }} />
        <img src={azureLogo} alt="" style={{ width: 1, height: 1 }} />
        <img src={gcpLogo} alt="" style={{ width: 1, height: 1 }} />
      </div>

      {/* Cloud Integration Wizard Modal — rendered via portal to escape any parent overflow/transform */}
      {showIntegrationWizard && createPortal(
        <div className="fixed inset-0 z-[9999] overflow-y-auto bg-black/50">
          <div className="flex min-h-full items-start justify-center p-8 pt-16">
          <div className="relative w-full max-w-4xl rounded-xl bg-white shadow-2xl">
            {/* Modal header */}
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900">
                  {wizardCloud === null
                    ? "Integrate Cloud Environment Costs"
                    : `${wizardCloud === "azure" ? "Azure" : wizardCloud === "gcp" ? "Google Cloud" : "AWS"} Cost Integration — Setup Guide`}
                </h2>
                <p className="mt-0.5 text-sm text-gray-500">
                  {wizardCloud === null
                    ? "Choose the cloud environment you'd like to integrate billing data from."
                    : "Follow the steps below to enable actual cloud cost data in this app."}
                </p>
              </div>
              <button
                onClick={() => setShowIntegrationWizard(false)}
                className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-5">
              {wizardCloud === null ? (
                /* Cloud selection screen */
                <div className="space-y-4">
                  <p className="text-sm text-gray-600">
                    You can integrate billing data from any cloud environment regardless of where your Databricks workspace is hosted. Up to 3 cloud cost integrations are supported.
                  </p>
                  <div className="grid grid-cols-3 gap-4">
                    {/* Azure card */}
                    <button
                      onClick={() => { setWizardCloud("azure"); setWizardExpandedStep(null); }}
                      disabled={cloudIntegrations.some(i => i.cloud === "azure") || cloudIntegrations.length >= 3}
                      className="group flex flex-col items-center gap-3 rounded-xl border-2 border-gray-200 p-6 text-center hover:border-blue-400 hover:bg-blue-600/10 disabled:cursor-not-allowed disabled:opacity-50 transition-all"
                    >
                      <img src={azureLogo} alt="Azure" className="h-12 w-auto object-contain" />
                      <div>
                        <div className="flex items-center justify-center gap-2">
                          <span className="font-semibold text-gray-900">Microsoft Azure</span>
                          {isAzure && <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">Default</span>}
                        </div>
                        <div className="mt-0.5 text-xs text-gray-500">Azure Cost Management Export via SDP</div>
                      </div>
                      {cloudIntegrations.some(i => i.cloud === "azure") && (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Already added</span>
                      )}
                    </button>
                    {/* AWS card */}
                    <button
                      onClick={() => { setWizardCloud("aws"); setWizardExpandedStep(null); }}
                      disabled={cloudIntegrations.some(i => i.cloud === "aws") || cloudIntegrations.length >= 3}
                      className="group flex flex-col items-center gap-3 rounded-xl border-2 border-gray-200 p-6 text-center hover:border-orange-400 hover:bg-orange-600/10 disabled:cursor-not-allowed disabled:opacity-50 transition-all"
                    >
                      <img src={awsLogo} alt="AWS" className="h-12 w-auto object-contain" />
                      <div>
                        <div className="flex items-center justify-center gap-2">
                          <span className="font-semibold text-gray-900">Amazon Web Services</span>
                          {!isAzure && !isGCP && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">Default</span>}
                        </div>
                        <div className="mt-0.5 text-xs text-gray-500">AWS CUR 2.0 Standard Data Export</div>
                      </div>
                      {cloudIntegrations.some(i => i.cloud === "aws") && (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Already added</span>
                      )}
                    </button>
                    {/* GCP card */}
                    <button
                      onClick={() => { setWizardCloud("gcp"); setWizardExpandedStep(null); }}
                      disabled={cloudIntegrations.some(i => i.cloud === "gcp") || cloudIntegrations.length >= 3}
                      className="group flex flex-col items-center gap-3 rounded-xl border-2 border-gray-200 p-6 text-center hover:border-blue-400 hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-50 transition-all"
                    >
                      <img src={gcpLogo} alt="GCP" className="h-12 w-auto object-contain" />
                      <div>
                        <div className="flex items-center justify-center gap-2">
                          <span className="font-semibold text-gray-900">Google Cloud</span>
                          {isGCP && <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">Default</span>}
                        </div>
                        <div className="mt-0.5 text-xs text-gray-500">GCP Billing Export via BigQuery</div>
                      </div>
                      {cloudIntegrations.some(i => i.cloud === "gcp") && (
                        <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Already added</span>
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                /* Setup guide for chosen cloud */
                <div className="space-y-3">
                  <p className="text-sm text-gray-600">
                    {wizardCloud === "azure"
                      ? "Deploy the cloud-infra-costs Azure project to ingest actual Azure billing data (Actuals, Amortized, or FOCUS format) via Streaming Declarative Pipelines into a medallion architecture:"
                      : wizardCloud === "gcp"
                      ? "Deploy the cloud-infra-costs GCP project to ingest GCP billing data from BigQuery into a medallion architecture via Databricks Asset Bundles:"
                      : "Deploy the cloud-infra-costs AWS project to ingest CUR 2.0 Standard Data Exports from S3 into a medallion architecture via Databricks Asset Bundles:"}
                  </p>

                  {(wizardCloud === "azure" ? [
                    "Deploy Terraform (Storage Account, External Location, Catalog)",
                    "Configure Cost Exports in Azure Portal",
                    "Configure Databricks Asset Bundle (DAB)",
                    "Authenticate & Deploy the Bundle",
                    "Validate Dashboards & Import Genie Space (Final Step)",
                  ] : wizardCloud === "gcp" ? [
                    "Enable GCP Billing Export to BigQuery",
                    "Create a GCP Service Account with BigQuery read access",
                    "Create a Databricks Google Cloud Storage External Location",
                    "Configure & Deploy the Databricks Asset Bundle (DAB)",
                    "Validate Workflows & Dashboards (Final Step)",
                  ] : [
                    "Create S3 Bucket for Cost Export",
                    "Configure Standard Data Export (CUR 2.0)",
                    "Create Storage Credential & External Location",
                    "Configure & Deploy the DAB",
                    "Validate Workflows & Dashboards (Final Step)",
                  ]).map((title, i) => {
                    const step = i + 1;
                    const isLast = step === 5;
                    const stepKey = `${wizardCloud}-${viewingIntegration?.id || 'new'}-step-${step}`;
                    const isChecked = !!checkedSteps[stepKey];
                    return (
                      <div
                        key={step}
                        className={`rounded-lg border ${isLast ? "border-orange-200 bg-orange-50" : "border-gray-200"}`}
                      >
                        <button
                          type="button"
                          onClick={() => setWizardExpandedStep(wizardExpandedStep === step ? null : step)}
                          className={`flex w-full items-center gap-3 px-4 py-3 text-left ${isLast ? "hover:bg-orange-100" : "hover:bg-gray-50"} rounded-t-lg`}
                        >
                          {/* Step number badge */}
                          <span
                            className={`flex-shrink-0 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${isChecked ? "bg-green-100 text-green-700" : isLast ? "text-white" : "bg-orange-100 text-orange-700"}`}
                            style={!isChecked && isLast ? { backgroundColor: '#FF3621' } : {}}
                          >
                            {isChecked ? (
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                              </svg>
                            ) : step}
                          </span>
                          <span className={`flex-1 font-medium ${isChecked ? "text-gray-500 line-through" : isLast ? "text-orange-900" : "text-gray-900"}`}>{title}</span>
                          {/* Explicit checkbox */}
                          <span
                            role="checkbox"
                            aria-checked={isChecked}
                            title={isChecked ? "Mark incomplete" : "Mark complete"}
                            onClick={(e) => { e.stopPropagation(); toggleStep(stepKey); }}
                            className={`flex-shrink-0 flex h-5 w-5 items-center justify-center rounded border-2 transition-colors cursor-pointer ${isChecked ? "border-green-500 bg-green-500" : "border-gray-300 bg-white hover:border-green-400"}`}
                          >
                            {isChecked && (
                              <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </span>
                          <svg className={`flex-shrink-0 h-5 w-5 text-gray-500 transition-transform ${wizardExpandedStep === step ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                        {wizardExpandedStep === step && (
                          <div className={`border-t px-4 py-3 text-sm text-gray-600 ${isLast ? "border-orange-200 bg-white" : "border-gray-200 bg-gray-50"}`}>
                            {wizardCloud === "azure" ? (
                              step === 1 ? (
                                <>
                                  <p className="mb-3">Terraform sets up all dependent infrastructure: storage account, container, external location, catalog, schema, and volume.</p>
                                  <ol className="space-y-2">
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Clone the <a href="https://github.com/databricks-solutions/cloud-infra-costs/tree/main/azure" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">cloud-infra-costs/azure</a> project</span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Configure <code className="rounded bg-gray-200 px-1">terraform/terraform.tfvars</code>:</span></li>
                                    <li className="ml-6 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                                      <pre>{`subscription_id      = "<Azure Subscription Id>"\ndatabricks_host      = "<Workspace Url>"\nresource_group_name  = "<Resource Group Name>"\nlocation             = "<Azure Region>"\nstorage_account_name = "<Globally Unique Name>"\ncontainer_name       = "billing"\ncatalog_name         = "billing"\nschema_name          = "azure"`}</pre>
                                    </li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Run Terraform:</span></li>
                                    <li className="ml-6 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                                      <pre>{`az login\nterraform init\nterraform plan -var-file="terraform.tfvars"\nterraform apply -var-file="terraform.tfvars"`}</pre>
                                    </li>
                                  </ol>
                                  <div className="mt-3 rounded-md bg-blue-50 p-3 text-sm text-blue-800">
                                    <strong>✅ Result:</strong> Terraform deploys a Storage Account, Container, External Location, Catalog, Schema, and Volume in one step.
                                  </div>
                                </>
                              ) : step === 2 ? (
                                <>
                                  <p className="mb-3">Create exports in the <a href="https://portal.azure.com/#view/Microsoft_Azure_CostManagement/Menu/~/exports" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Azure Portal → Cost Exports</a>. Actuals is required; Amortized and FOCUS are optional.</p>
                                  <div className="overflow-x-auto rounded-md bg-white text-xs mb-3">
                                    <table className="w-full border-collapse">
                                      <thead><tr className="bg-gray-100"><th className="border border-gray-200 px-2 py-1 text-left">Export Type</th><th className="border border-gray-200 px-2 py-1 text-left">Description</th><th className="border border-gray-200 px-2 py-1 text-left">Export Directory</th></tr></thead>
                                      <tbody>
                                        <tr><td className="border border-gray-200 px-2 py-1"><strong>Actuals</strong> ✅ required</td><td className="border border-gray-200 px-2 py-1">Actual billed costs as invoiced</td><td className="border border-gray-200 px-2 py-1 font-mono">azure-actual-cost</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1">Amortized (optional)</td><td className="border border-gray-200 px-2 py-1">Reservations spread across usage period</td><td className="border border-gray-200 px-2 py-1 font-mono">azure-amortized-cost</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1">FOCUS (optional)</td><td className="border border-gray-200 px-2 py-1">FinOps standard format</td><td className="border border-gray-200 px-2 py-1 font-mono">azure-focus-cost</td></tr>
                                      </tbody>
                                    </table>
                                  </div>
                                  <p className="mb-1 font-medium text-gray-700">Settings for each export:</p>
                                  <div className="rounded-md bg-white p-2 font-mono text-xs mb-3">
                                    <div>Frequency: <strong>Daily</strong></div>
                                    <div>Schedule status: <strong>Active</strong></div>
                                    <div>File partitioning: <strong>On</strong></div>
                                    <div>Overwrite data: <strong>Off</strong></div>
                                    <div>Format: <strong>Parquet</strong></div>
                                    <div>Compression type: <strong>Snappy</strong></div>
                                  </div>
                                  <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-800">
                                    <strong>📁 Expected structure:</strong> <code>{"<container>/<export-dir>/<billing-period>/<ingestion-date>/<run-id>/*.parquet"}</code>
                                  </div>
                                </>
                              ) : step === 3 ? (
                                <>
                                  <p className="mb-3">Configure <code className="rounded bg-gray-200 px-1">databricks.yml</code> with your workspace URL and warehouse ID, then set pipeline variables.</p>
                                  <p className="mb-2 font-medium text-gray-700">Key variables for the Actuals pipeline:</p>
                                  <div className="overflow-x-auto rounded-md bg-white text-xs mb-3">
                                    <table className="w-full border-collapse">
                                      <thead><tr className="bg-gray-100"><th className="border border-gray-200 px-2 py-1 text-left">Variable</th><th className="border border-gray-200 px-2 py-1 text-left">Default</th></tr></thead>
                                      <tbody>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">catalog</td><td className="border border-gray-200 px-2 py-1 font-mono">billing</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">schema</td><td className="border border-gray-200 px-2 py-1 font-mono">azure</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">volume_name</td><td className="border border-gray-200 px-2 py-1 font-mono">cost_export</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">warehouse_id</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                      </tbody>
                                    </table>
                                  </div>
                                  <div className="rounded-md bg-blue-50 p-3 text-sm text-blue-800">
                                    <strong>ℹ️</strong> Amortized and FOCUS pipelines use the same schema — just different source paths. Both are paused by default.
                                  </div>
                                </>
                              ) : step === 4 ? (
                                <ol className="space-y-2">
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Authenticate to your workspace:</span></li>
                                  <li className="ml-6 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                                    <pre>{"databricks auth login --host <workspace-url> --profile cloud-infra-cost"}</pre>
                                  </li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Deploy the bundle:</span></li>
                                  <li className="ml-6 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                                    <pre>{"databricks bundle deploy --target dev --profile cloud-infra-cost"}</pre>
                                  </li>
                                  <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Validate in the Databricks UI — check <strong>Workflows</strong> for the file arrival jobs (<code className="rounded bg-gray-200 px-1">azure_cost_job</code> active, amortized/FOCUS paused by default)</span></li>
                                </ol>
                              ) : (
                                <>
                                  <p className="mb-3">Once the bundle is deployed, validate your dashboards and optionally import the Genie space for natural language cost queries.</p>
                                  <p className="font-medium text-gray-700 mb-1">File arrival jobs to check in Workflows:</p>
                                  <ul className="space-y-1 mb-4">
                                    <li>• <code className="rounded bg-gray-200 px-1">azure_cost_job</code> — active by default (Actuals)</li>
                                    <li>• <code className="rounded bg-gray-200 px-1">azure_amortized_job</code> — paused by default</li>
                                    <li>• <code className="rounded bg-gray-200 px-1">azure_focus_job</code> — paused by default</li>
                                  </ul>
                                  <div className="border-t border-gray-200 pt-3">
                                    <p className="font-medium text-gray-700 mb-2">(Optional) Import Genie Space:</p>
                                    <div className="overflow-x-auto rounded-md bg-gray-900 p-3 text-xs text-gray-100">
                                      <pre>{"databricks api post /api/2.0/genie/spaces --profile cloud-infra-cost \\\n  --json @Azure_cost_reporting_genie_space_azure_billing.json"}</pre>
                                    </div>
                                  </div>
                                </>
                              )
                            ) : wizardCloud === "gcp" ? (
                              step === 1 ? (
                                <>
                                  <p className="mb-3">Enable GCP Billing Export in the <a href="https://console.cloud.google.com/billing" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Google Cloud Billing Console</a> to stream billing data to BigQuery.</p>
                                  <ol className="space-y-2">
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>In the Billing console, select your billing account → <strong>Billing export</strong></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Under <strong>BigQuery export</strong>, click <strong>Edit settings</strong> for <em>Standard usage cost</em></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Choose or create a BigQuery project and dataset, then click <strong>Save</strong></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">d.</span><span>Note the project ID and dataset name — you'll need them in Step 4</span></li>
                                  </ol>
                                  <div className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                                    <strong>⏱ Note:</strong> Initial export takes up to 48 hours. After that, data is exported daily. Enable <em>Detailed usage cost</em> as well if you want resource-level breakdown.
                                  </div>
                                </>
                              ) : step === 2 ? (
                                <>
                                  <p className="mb-3">Create a GCP Service Account with read access to the BigQuery billing dataset.</p>
                                  <ol className="space-y-2">
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>In the <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">IAM console</a>, create a new service account in the BigQuery project</span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Grant the service account <strong>BigQuery Data Viewer</strong> and <strong>BigQuery Job User</strong> roles</span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Create and download a <strong>JSON key</strong> for the service account</span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">d.</span><span>Store the JSON key securely — it will be referenced in the Databricks asset bundle config</span></li>
                                  </ol>
                                </>
                              ) : step === 3 ? (
                                <>
                                  <p className="mb-3">Create a <a href="https://docs.databricks.com/gcp/en/connect/unity-catalog/cloud-storage/gcs.html" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">GCS External Location</a> in Unity Catalog so the bundle can write staging data.</p>
                                  <ol className="space-y-2">
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Create a GCS bucket in your GCP project for staging</span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>In Databricks, go to <strong>Catalog → External Data → Storage Credentials → Create credential</strong> and choose <strong>GCP Service Account</strong></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Go to <strong>External Locations → Create external location</strong>, set URL to <code className="rounded bg-gray-200 px-1">gs://your-bucket/</code></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">d.</span><span>Click <strong>Test connection</strong> to verify access</span></li>
                                  </ol>
                                </>
                              ) : step === 4 ? (
                                <>
                                  <p className="mb-3">Clone the <a href="https://github.com/databricks-solutions/cloud-infra-costs/tree/main/gcp" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">cloud-infra-costs/gcp</a> project, configure <code className="rounded bg-gray-200 px-1">databricks.yml</code>, then deploy.</p>
                                  <p className="mb-2 font-medium text-gray-700">Required DAB variables:</p>
                                  <div className="overflow-x-auto rounded-md bg-white text-xs mb-3">
                                    <table className="w-full border-collapse">
                                      <thead><tr className="bg-gray-100"><th className="border border-gray-200 px-2 py-1 text-left">Variable</th><th className="border border-gray-200 px-2 py-1 text-left">Default</th></tr></thead>
                                      <tbody>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">catalog</td><td className="border border-gray-200 px-2 py-1 font-mono">billing</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">schema</td><td className="border border-gray-200 px-2 py-1 font-mono">gcp</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">bq_project_id</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">bq_dataset</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">warehouse_id</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                      </tbody>
                                    </table>
                                  </div>
                                  <ol className="space-y-2">
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Authenticate: <code className="rounded bg-gray-200 px-1">databricks configure</code></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Deploy: <code className="rounded bg-gray-200 px-1">databricks bundle deploy --target dev</code></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Run: <code className="rounded bg-gray-200 px-1">databricks bundle run</code></span></li>
                                  </ol>
                                </>
                              ) : (
                                <>
                                  <p className="mb-3">Once deployed, verify the job ran successfully and billing data is flowing into the gold table.</p>
                                  <ul className="space-y-1 mb-4">
                                    <li>• Check <strong>Workflows</strong> for <code className="rounded bg-gray-200 px-1">gcp_cost_job</code> — runs daily</li>
                                    <li>• Verify <strong>bronze → silver → gold</strong> tables exist in <code className="rounded bg-gray-200 px-1">billing.gcp</code></li>
                                    <li>• Open the deployed <strong>dashboard</strong> to confirm cost data is visible</li>
                                  </ul>
                                  <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                                    <strong>ℹ️ Note:</strong> GCP billing export includes Compute Engine, Cloud Storage, networking, and all other GCP services. BigQuery export data typically reflects costs with a 1-day lag.
                                  </div>
                                </>
                              )
                            ) : (
                              step === 1 ? (
                                <>
                                  <p className="mb-3">Create an S3 bucket to receive CUR exports. The account that creates the export must also own the S3 bucket.</p>
                                  <ol className="space-y-2">
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Create a new S3 bucket in your <strong>AWS payer account</strong> (recommended — includes costs for all member accounts)</span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Configure the bucket per the <a href="https://docs.aws.amazon.com/cur/latest/userguide/dataexports-s3-bucket.html" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">AWS S3 bucket requirements</a> for data exports</span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Note your bucket name — you'll need it in Step 2</span></li>
                                  </ol>
                                  <div className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                                    <strong>💡 Tip:</strong> Use your payer account so that all AWS account costs are included. AWS refreshes data multiple times a day; for historical backfills raise an AWS support ticket.
                                  </div>
                                </>
                              ) : step === 2 ? (
                                <>
                                  <p className="mb-3">Configure a <a href="https://docs.aws.amazon.com/cur/latest/userguide/dataexports-create-standard.html" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Standard Data Export</a> in the AWS console. If you have an existing CUR 1.0, <a href="https://docs.aws.amazon.com/cur/latest/userguide/dataexports-migrate.html" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">migrate to CUR 2.0</a> first.</p>
                                  <ol className="space-y-2">
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>In the AWS console, navigate to <strong>Billing → Data Exports → Create</strong></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Configure with these exact settings:</span></li>
                                    <li className="ml-6 rounded-md bg-white p-2 font-mono text-xs">
                                      <div>Type of export: <strong>Standard Data Export</strong></div>
                                      <div>✅ Include resource IDs</div>
                                      <div>Time granularity: <strong>Hourly</strong></div>
                                      <div>Column selection: <strong>Select all columns</strong></div>
                                      <div>Compression type and file format: <strong>Parquet</strong></div>
                                      <div>File versioning: <strong>Overwrite existing data export file</strong></div>
                                    </li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Set delivery destination to the S3 bucket from Step 1</span></li>
                                  </ol>
                                  <div className="mt-3 rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                                    <strong>⏱ Note:</strong> CUR data typically takes 24 hours to start appearing. AWS rewrites current-month files multiple times daily.
                                  </div>
                                </>
                              ) : step === 3 ? (
                                <>
                                  <p className="mb-3">Create a <a href="https://docs.databricks.com/aws/en/connect/unity-catalog/cloud-storage/#storage-credentials" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">Storage Credential</a> and <a href="https://docs.databricks.com/aws/en/connect/unity-catalog/cloud-storage/#overview-of-external-locations" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">External Location</a> pointing to your S3 bucket.</p>
                                  <ol className="space-y-2">
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>In Databricks, go to <strong>Catalog → External Data → Storage Credentials → Create credential</strong></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Choose <strong>AWS IAM role</strong>, create a role with <code className="rounded bg-gray-200 px-1">s3:GetObject</code> and <code className="rounded bg-gray-200 px-1">s3:ListBucket</code> on your CUR bucket, and configure the trust relationship</span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Go to <strong>External Locations → Create external location</strong></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">d.</span><span>Set the URL to your S3 path (e.g. <code className="rounded bg-gray-200 px-1">s3://your-bucket/cur-prefix/</code>) and select the credential from step b</span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">e.</span><span>Click <strong>Test connection</strong> to verify access</span></li>
                                  </ol>
                                </>
                              ) : step === 4 ? (
                                <>
                                  <p className="mb-3">Clone the <a href="https://github.com/databricks-solutions/cloud-infra-costs/tree/main/aws" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">cloud-infra-costs/aws</a> project, configure <code className="rounded bg-gray-200 px-1">databricks.yml</code>, then deploy.</p>
                                  <p className="mb-2 font-medium text-gray-700">Required DAB variables:</p>
                                  <div className="overflow-x-auto rounded-md bg-white text-xs mb-3">
                                    <table className="w-full border-collapse">
                                      <thead><tr className="bg-gray-100"><th className="border border-gray-200 px-2 py-1 text-left">Variable</th><th className="border border-gray-200 px-2 py-1 text-left">Default</th></tr></thead>
                                      <tbody>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">catalog</td><td className="border border-gray-200 px-2 py-1 font-mono">billing</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">schema</td><td className="border border-gray-200 px-2 py-1 font-mono">aws</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">storage_location</td><td className="border border-gray-200 px-2 py-1 text-red-600">required (S3 folder)</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">job_alerts_email</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                        <tr><td className="border border-gray-200 px-2 py-1 font-mono">warehouse_id</td><td className="border border-gray-200 px-2 py-1 text-red-600">required</td></tr>
                                      </tbody>
                                    </table>
                                  </div>
                                  <ol className="space-y-2">
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">a.</span><span>Authenticate: <code className="rounded bg-gray-200 px-1">databricks configure</code></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">b.</span><span>Deploy dev: <code className="rounded bg-gray-200 px-1">databricks bundle deploy --target dev</code></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">c.</span><span>Deploy prod: <code className="rounded bg-gray-200 px-1">databricks bundle deploy --target prod</code></span></li>
                                    <li className="flex gap-2"><span className="font-medium text-gray-700">d.</span><span>Run the job: <code className="rounded bg-gray-200 px-1">databricks bundle run</code></span></li>
                                  </ol>
                                </>
                              ) : (
                                <>
                                  <p className="mb-3">Once deployed, verify the job ran successfully and data is flowing into the gold table.</p>
                                  <ul className="space-y-1 mb-4">
                                    <li>• Check <strong>Workflows</strong> for <code className="rounded bg-gray-200 px-1">aws_cost_job</code> — runs daily in prod</li>
                                    <li>• Verify <strong>bronze → silver → gold</strong> tables exist in <code className="rounded bg-gray-200 px-1">billing.aws</code></li>
                                    <li>• Open the deployed <strong>dashboard</strong> to confirm cost data is visible</li>
                                  </ul>
                                  <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
                                    <strong>⚠️ Limitations:</strong> S3 storage charges and data egress are not included. AWS CUR only includes the latest tag key-value pair per resource.
                                  </div>
                                </>
                              )
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Reference links */}
                  <div className="flex flex-wrap items-center gap-3 border-t border-gray-200 pt-3">
                    <a
                      href={wizardCloud === "azure"
                        ? "https://github.com/databricks-solutions/cloud-infra-costs/tree/main/azure"
                        : wizardCloud === "gcp"
                        ? "https://github.com/databricks-solutions/cloud-infra-costs/tree/main/gcp"
                        : "https://github.com/databricks-solutions/cloud-infra-costs/tree/main/aws"}
                      target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      {wizardCloud === "azure" ? "cloud-infra-costs/azure README" : wizardCloud === "gcp" ? "cloud-infra-costs/gcp README" : "cloud-infra-costs/aws README"}
                    </a>
                    <a
                      href="https://docs.databricks.com/en/dev-tools/bundles/index.html"
                      target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      Databricks Asset Bundles Docs
                    </a>
                  </div>
                </div>
              )}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-between border-t border-gray-200 px-6 py-4">
              <div>
                {wizardCloud !== null && !viewingIntegration && (
                  <button
                    onClick={() => { setWizardCloud(null); setWizardExpandedStep(null); }}
                    className="text-sm text-gray-500 hover:text-gray-700"
                  >
                    ← Choose a different cloud
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowIntegrationWizard(false)}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Close
                </button>
                {wizardCloud !== null && !viewingIntegration && !cloudIntegrations.some(i => i.cloud === wizardCloud) && cloudIntegrations.length < 3 && (
                  <button
                    onClick={() => {
                      if (wizardCloud) addIntegration(wizardCloud);
                      setShowIntegrationWizard(false);
                    }}
                    className="rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
                    style={{ backgroundColor: '#FF3621' }}
                  >
                    Mark as configured
                  </button>
                )}
              </div>
            </div>
          </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
