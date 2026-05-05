import { useEffect, useMemo, useState, useCallback } from "react";
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
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import type { TaggingDashboardBundle } from "@/types/billing";
import { KPITrendModal } from "./KPITrendModal";

interface TaggingHubProps {
  data: TaggingDashboardBundle | undefined;
  isLoading: boolean;
  host?: string | null;
  startDate?: string;
  endDate?: string;
}

import { workspaceUrl } from "@/utils/formatters";

// Helper functions to generate resource URLs
function getClusterUrl(host: string | null | undefined, _clusterId: string, workspaceId?: string): string | null {
  if (!host) return null;
  const workspaceParam = workspaceId ? `?o=${workspaceId}` : '';
  return workspaceUrl(host, `/compute/interactive${workspaceParam}`);
}

function getJobUrl(host: string | null | undefined, jobId: string, _workspaceId?: string): string | null {
  if (!host || !jobId) return null;
  return workspaceUrl(host, `/jobs/${jobId}`);
}

function getPipelineUrl(host: string | null | undefined, pipelineId: string, _workspaceId?: string): string | null {
  if (!host || !pipelineId) return null;
  return workspaceUrl(host, `/pipelines/${pipelineId}`);
}

function getWarehouseUrl(host: string | null | undefined, warehouseId: string, workspaceId?: string): string | null {
  if (!host || !warehouseId) return null;
  const workspaceParam = workspaceId ? `?o=${workspaceId}` : '';
  return workspaceUrl(host, `/sql/warehouses/${warehouseId}${workspaceParam}`);
}

function getEndpointUrl(host: string | null | undefined, endpointName: string, workspaceId?: string): string | null {
  if (!host || !endpointName) return null;
  const workspaceParam = workspaceId ? `?o=${workspaceId}` : '';
  return workspaceUrl(host, `/ml/endpoints/${endpointName}${workspaceParam}`);
}

type UntaggedTab = "clusters" | "jobs" | "pipelines" | "warehouses" | "endpoints";

const COLORS = {
  tagged: "#10b981",
  untagged: "#ef4444",
};

const TAG_COLORS = ["#1B5162", "#06B6D4", "#10B981", "#14B8A6", "#F59E0B", "#3B82F6", "#EC4899", "#EF4444", "#6B7280"];

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

export function TaggingHub({ data, isLoading, host, startDate, endDate }: TaggingHubProps) {
  const [activeUntaggedTab, setActiveUntaggedTab] = useState<UntaggedTab>("clusters");
  const [selectedKPI, setSelectedKPI] = useState<{kpi: string; label: string} | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<string>("total_spend");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [showHistoricalUntagged, setShowHistoricalUntagged] = useState(false);

  // Tag key filter state (for Spend by Key chart)
  const [selectedTagFilters, setSelectedTagFilters] = useState<string[]>([]);
  const [tagFilterDropdownOpen, setTagFilterDropdownOpen] = useState(false);
  const [tagFilterSearch, setTagFilterSearch] = useState("");

  // Tag value filter state (for Spend by Tag table)
  const [selectedTagValueFilters, setSelectedTagValueFilters] = useState<string[]>([]);
  const [tagValueFilterDropdownOpen, setTagValueFilterDropdownOpen] = useState(false);
  const [tagValueFilterSearch, setTagValueFilterSearch] = useState("");

  // Tag drilldown state
  const [selectedTag, setSelectedTag] = useState<{tag_key: string; tag_value: string} | null>(null);
  const [tagObjectsCache, setTagObjectsCache] = useState<Record<string, any[]>>({});
  const [tagObjectsLoading, setTagObjectsLoading] = useState(false);
  const tagObjects = selectedTag ? (tagObjectsCache[`${selectedTag.tag_key}::${selectedTag.tag_value}`] || []) : [];

  const handleTagClick = (tagKey: string, tagValue: string) => {
    setSelectedTag({ tag_key: tagKey, tag_value: tagValue });
    const cacheKey = `${tagKey}::${tagValue}`;
    if (!tagObjectsCache[cacheKey]) {
      setTagObjectsLoading(true);
      const params = new URLSearchParams({ tag_key: tagKey, tag_value: tagValue });
      if (startDate) params.set("start_date", startDate);
      if (endDate) params.set("end_date", endDate);
      fetch(`/api/tagging/top-objects-by-tag?${params}`)
        .then((res) => res.json())
        .then((result) => {
          setTagObjectsCache((prev) => ({ ...prev, [cacheKey]: result.objects || [] }));
        })
        .catch(() => {
          setTagObjectsCache((prev) => ({ ...prev, [cacheKey]: [] }));
        })
        .finally(() => setTagObjectsLoading(false));
    }
  };

  // Suggested tags banner minimize state
  const SUGGESTED_TAGS_KEY = "cost-obs-minimize-suggested-tags";
  const [suggestedTagsMinimized, setSuggestedTagsMinimized] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem(SUGGESTED_TAGS_KEY) === "true";
    }
    return false;
  });

  const handleSuggestedTagsMinimize = useCallback((minimized: boolean) => {
    setSuggestedTagsMinimized(minimized);
    if (minimized) {
      localStorage.setItem(SUGGESTED_TAGS_KEY, "true");
    } else {
      localStorage.removeItem(SUGGESTED_TAGS_KEY);
    }
  }, []);

  // Reset page/search when tab changes
  const handleTabChange = useCallback((tab: UntaggedTab) => {
    setActiveUntaggedTab(tab);
    setCurrentPage(1);
    setSearchQuery("");
    setSortField("total_spend");
    setSortDirection("desc");
  }, []);

  const handleSort = useCallback((field: string) => {
    if (sortField === field) {
      setSortDirection(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
    setCurrentPage(1);
  }, [sortField]);

  // Pre-warm trend queries so modals open instantly
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!startDate || !endDate) return;
    for (const kpi of ["tagged_spend", "untagged_spend", "total_spend"]) {
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
  const MINIMIZE_KEY = "cost-obs-minimize-tagging-info";
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

  const coveragePieData = useMemo(() => {
    if (!data?.summary) return [];
    return [
      { name: "Tagged", value: data.summary.tagged_spend, fill: COLORS.tagged },
      { name: "Untagged", value: data.summary.untagged_spend, fill: COLORS.untagged },
    ];
  }, [data?.summary]);

  const tagBreakdownData = useMemo(() => {
    if (!data?.cost_by_tag?.tags) return [];
    // Group by tag key and aggregate
    const byKey: Record<string, number> = {};
    for (const tag of data.cost_by_tag.tags) {
      if (!byKey[tag.tag_key]) {
        byKey[tag.tag_key] = 0;
      }
      byKey[tag.tag_key] += tag.total_spend;
    }
    return Object.entries(byKey)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, spend], idx) => ({
        tag_key: key,
        total_spend: spend,
        fill: TAG_COLORS[idx % TAG_COLORS.length],
      }));
  }, [data?.cost_by_tag]);

  const untaggedCounts = useMemo(() => {
    if (!data?.untagged) return { clusters: 0, jobs: 0, pipelines: 0, warehouses: 0, endpoints: 0 };
    return {
      clusters: data.untagged.clusters?.count || 0,
      jobs: data.untagged.jobs?.count || 0,
      pipelines: data.untagged.pipelines?.count || 0,
      warehouses: data.untagged.warehouses?.count || 0,
      endpoints: data.untagged.endpoints?.count || 0,
    };
  }, [data?.untagged]);

  // Compute suggested tags based on what's already used in the environment
  const suggestedTags = useMemo(() => {
    if (!data?.cost_by_tag?.tags) return [];

    // Get unique tag keys and their usage counts
    const tagKeyUsage: Record<string, { count: number; examples: string[] }> = {};
    for (const tag of data.cost_by_tag.tags) {
      if (!tagKeyUsage[tag.tag_key]) {
        tagKeyUsage[tag.tag_key] = { count: 0, examples: [] };
      }
      tagKeyUsage[tag.tag_key].count += tag.workspace_count || 1;
      if (tagKeyUsage[tag.tag_key].examples.length < 3 && !tagKeyUsage[tag.tag_key].examples.includes(tag.tag_value)) {
        tagKeyUsage[tag.tag_key].examples.push(tag.tag_value);
      }
    }

    // Sort by usage and return top tag keys with example values
    return Object.entries(tagKeyUsage)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([key, info]) => ({
        key,
        usageCount: info.count,
        examples: info.examples,
      }));
  }, [data?.cost_by_tag]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    if (!tagFilterDropdownOpen && !tagValueFilterDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (tagFilterDropdownOpen && !target.closest("[data-tag-filter-dropdown]")) {
        setTagFilterDropdownOpen(false);
      }
      if (tagValueFilterDropdownOpen && !target.closest("[data-tag-value-filter-dropdown]")) {
        setTagValueFilterDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [tagFilterDropdownOpen, tagValueFilterDropdownOpen]);

  // All unique tag keys for the filter dropdown
  const availableTagKeys = useMemo(() => {
    if (!data?.cost_by_tag?.tags) return [];
    const keys = new Set<string>();
    for (const tag of data.cost_by_tag.tags) {
      keys.add(tag.tag_key);
    }
    return Array.from(keys).sort();
  }, [data?.cost_by_tag]);

  // All unique tag key:value pairs for the tag filter dropdown
  const availableTagValues = useMemo(() => {
    if (!data?.cost_by_tag?.tags) return [];
    return data.cost_by_tag.tags
      .map(tag => `${tag.tag_key}:${tag.tag_value}`)
      .sort();
  }, [data?.cost_by_tag]);

  // Filtered tag data based on selected tag value filters
  const filteredTags = useMemo(() => {
    if (!data?.cost_by_tag?.tags) return [];
    if (selectedTagValueFilters.length === 0) return data.cost_by_tag.tags;
    return data.cost_by_tag.tags.filter(tag =>
      selectedTagValueFilters.includes(`${tag.tag_key}:${tag.tag_value}`)
    );
  }, [data?.cost_by_tag, selectedTagValueFilters]);

  // Filtered tag breakdown (Spend by Key chart) based on selected filters
  const filteredTagBreakdownData = useMemo(() => {
    if (selectedTagFilters.length === 0) return tagBreakdownData;
    const byKey: Record<string, number> = {};
    for (const tag of filteredTags) {
      if (!byKey[tag.tag_key]) byKey[tag.tag_key] = 0;
      byKey[tag.tag_key] += tag.total_spend;
    }
    return Object.entries(byKey)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, spend], idx) => ({
        tag_key: key,
        total_spend: spend,
        fill: TAG_COLORS[idx % TAG_COLORS.length],
      }));
  }, [filteredTags, selectedTagFilters, tagBreakdownData]);

  const handleToggleTagFilter = useCallback((key: string) => {
    setSelectedTagFilters(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  }, []);

  const handleClearTagFilters = useCallback(() => {
    setSelectedTagFilters([]);
  }, []);

  const handleToggleTagValueFilter = useCallback((keyValue: string) => {
    setSelectedTagValueFilters(prev =>
      prev.includes(keyValue) ? prev.filter(kv => kv !== keyValue) : [...prev, keyValue]
    );
  }, []);

  const handleClearTagValueFilters = useCallback(() => {
    setSelectedTagValueFilters([]);
  }, []);

  if (isLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
        <p className="text-sm text-gray-500">Loading tagging data...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-6">
        <p className="text-yellow-700">No tagging data available for the selected date range.</p>
      </div>
    );
  }

  const summary = data.summary;

  const renderUntaggedTable = () => {
    const tabs: { key: UntaggedTab; label: string; count: number }[] = [
      { key: "clusters", label: "Clusters", count: untaggedCounts.clusters },
      { key: "jobs", label: "Jobs", count: untaggedCounts.jobs },
      { key: "pipelines", label: "SDP Pipelines", count: untaggedCounts.pipelines },
      { key: "warehouses", label: "SQL Warehouses", count: untaggedCounts.warehouses },
      { key: "endpoints", label: "Endpoints", count: untaggedCounts.endpoints },
    ];

    const getItems = () => {
      switch (activeUntaggedTab) {
        case "clusters":
          return data.untagged.clusters?.items || [];
        case "jobs":
          return data.untagged.jobs?.items || [];
        case "pipelines":
          return data.untagged.pipelines?.items || [];
        case "warehouses":
          return data.untagged.warehouses?.items || [];
        case "endpoints":
          return data.untagged.endpoints?.items || [];
        default:
          return [];
      }
    };

    const allItems = getItems();

    // Resource name/ID config per tab
    const getResourceConfig = () => {
      switch (activeUntaggedTab) {
        case "clusters":
          return { nameKey: "cluster_name", idKey: "cluster_id", label: "Cluster" };
        case "jobs":
          return { nameKey: "job_name", idKey: "job_id", label: "Job" };
        case "pipelines":
          return { nameKey: "pipeline_name", idKey: "pipeline_id", label: "Pipeline" };
        case "warehouses":
          return { nameKey: "warehouse_name", idKey: "warehouse_id", label: "Warehouse" };
        case "endpoints":
          return { nameKey: "endpoint_name", idKey: "endpoint_name", label: "Endpoint" };
        default:
          return { nameKey: "", idKey: "", label: "" };
      }
    };

    const resourceConfig = getResourceConfig();

    // Extra columns per tab (beyond the name/ID column)
    const getExtraColumns = (): { key: string; label: string }[] => {
      switch (activeUntaggedTab) {
        case "clusters":
          return [{ key: "owner", label: "Owner" }];
        default:
          return [];
      }
    };

    const extraColumns = getExtraColumns();

    // Historical detection: name === id means unresolved
    const isHistoricalItem = (item: any) => {
      const name = item[resourceConfig.nameKey];
      const id = item[resourceConfig.idKey];
      return !name || name === id;
    };
    const historicalCount = allItems.filter(isHistoricalItem).length;
    const activeItems = showHistoricalUntagged ? allItems : allItems.filter((item: any) => !isHistoricalItem(item));

    // Search filter
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filteredItems = activeItems.filter((item: any) => {
      if (!searchQuery) return true;
      const query = searchQuery.toLowerCase();
      // Search across all string fields
      return Object.values(item).some(
        (val) => typeof val === "string" && val.toLowerCase().includes(query)
      );
    });

    // Sort
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sortedItems = [...filteredItems].sort((a: any, b: any) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      const modifier = sortDirection === "asc" ? 1 : -1;
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (typeof aVal === "string" && typeof bVal === "string") {
        return aVal.localeCompare(bVal) * modifier;
      }
      return ((aVal as number) - (bVal as number)) * modifier;
    });

    // Pagination
    const totalPages = Math.ceil(sortedItems.length / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const paginatedItems = sortedItems.slice(startIndex, startIndex + itemsPerPage);

    const SortIcon = ({ field }: { field: string }) => {
      if (sortField !== field) return <span className="ml-1 text-gray-300">↕</span>;
      return <span className="ml-1">{sortDirection === "asc" ? "↑" : "↓"}</span>;
    };

    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Untagged Resources</h3>
          <span className="text-sm text-red-600">
            {formatCurrency(data.summary.untagged_spend)} untagged spend
          </span>
        </div>

        {/* Tab Navigation - consistent border, orange text for selected */}
        <div className="mb-4 border-b border-gray-200">
          <nav className="-mb-px flex space-x-4 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => handleTabChange(tab.key)}
                className={`whitespace-nowrap border-b-2 border-gray-200 px-1 py-2 text-sm font-medium ${
                  activeUntaggedTab === tab.key
                    ? "text-[#FF3621]"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${
                    activeUntaggedTab === tab.key
                      ? "bg-orange-100 text-orange-600"
                      : "bg-gray-100 text-gray-600"
                  }`}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* Suggested Tags Banner - orange theme, minimizable */}
        {suggestedTags.length > 0 && allItems.length > 0 && (
          <div className="mb-4 rounded-lg border border-orange-200 bg-orange-50 p-4">
            <div className="flex items-start gap-3">
              <svg className="mt-0.5 h-5 w-5 flex-shrink-0 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              <div className="flex-1">
                <button className="flex w-full items-center justify-between" onClick={() => handleSuggestedTagsMinimize(!suggestedTagsMinimized)}>
                  <p className="text-sm font-medium text-orange-800">Suggested Tags for Your Environment</p>
                  <svg className={`h-4 w-4 text-orange-500 transition-transform ${suggestedTagsMinimized ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {!suggestedTagsMinimized && (
                  <>
                    <p className="mt-1 text-xs text-orange-700">Based on tags already in use across your resources:</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {suggestedTags.map((tag) => (
                        <div key={tag.key} className="group relative">
                          <span className="inline-flex items-center rounded-full bg-orange-100 px-3 py-1 text-sm font-medium text-orange-800 cursor-help">
                            {tag.key}
                          </span>
                          <div className="invisible absolute bottom-full left-0 z-10 mb-2 w-64 rounded-lg bg-gray-900 p-3 text-xs text-white opacity-0 shadow-xl transition-all group-hover:visible group-hover:opacity-100">
                            <p className="font-semibold text-orange-300 mb-1">{tag.key}</p>
                            <p className="text-gray-300 mb-1">Used by {tag.usageCount} resources</p>
                            {tag.examples.length > 0 && (
                              <div>
                                <p className="text-gray-500 text-[10px] uppercase">Example values:</p>
                                <div className="flex flex-wrap gap-1 mt-1">
                                  {tag.examples.map((ex, i) => (
                                    <span key={i} className="rounded bg-gray-700 px-1.5 py-0.5">{ex}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Search + Historical */}
        <div className="mb-4 flex items-center gap-4">
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder={`Search untagged ${activeUntaggedTab}...`}
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-4 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
            />
            {searchQuery && (
              <button
                onClick={() => { setSearchQuery(""); setCurrentPage(1); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-600"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer whitespace-nowrap">
            <input type="checkbox" checked={showHistoricalUntagged}
              onChange={(e) => { setShowHistoricalUntagged(e.target.checked); setCurrentPage(1); }}
              className="rounded border-gray-300 text-orange-600 focus:ring-orange-500" />
            Show historical ({historicalCount})
            <span className="relative group ml-0.5">
              <svg className="inline h-3 w-3 text-gray-500 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              <span className="absolute bottom-full right-0 mb-1 hidden group-hover:block w-56 rounded-lg bg-gray-900 px-2 py-1.5 text-[10px] text-white shadow-lg z-20">Resources whose names could not be resolved — likely deleted or from inaccessible workspaces</span>
            </span>
          </label>
        </div>
        {searchQuery && (
          <p className="mb-2 text-xs text-gray-500">
            {filteredItems.length} result{filteredItems.length !== 1 ? "s" : ""} found
          </p>
        )}

        {/* Table */}
        {sortedItems.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th
                    className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                    onClick={() => handleSort(resourceConfig.idKey)}
                  >
                    {resourceConfig.label} <SortIcon field={resourceConfig.idKey} />
                  </th>
                  {extraColumns.map((col) => (
                    <th
                      key={col.key}
                      className="cursor-pointer px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                      onClick={() => handleSort(col.key)}
                    >
                      {col.label} <SortIcon field={col.key} />
                    </th>
                  ))}
                  <th
                    className="cursor-pointer px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                    onClick={() => handleSort("total_dbus")}
                  >
                    DBUs <SortIcon field="total_dbus" />
                  </th>
                  <th
                    className="cursor-pointer px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                    onClick={() => handleSort("total_spend")}
                  >
                    Spend <SortIcon field="total_spend" />
                  </th>
                  <th
                    className="cursor-pointer px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                    onClick={() => handleSort("days_active")}
                  >
                    Days Active <SortIcon field="days_active" />
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                    Suggested Tags
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {paginatedItems.map((item: any, idx: number) => {
                  // Generate resource URL based on type
                  let resourceUrl: string | null = null;
                  const workspaceId = item.workspace_id;
                  switch (activeUntaggedTab) {
                    case "clusters":
                      resourceUrl = getClusterUrl(host, item.cluster_id, workspaceId);
                      break;
                    case "jobs":
                      resourceUrl = getJobUrl(host, item.job_id, workspaceId);
                      break;
                    case "pipelines":
                      resourceUrl = getPipelineUrl(host, item.pipeline_id, workspaceId);
                      break;
                    case "warehouses":
                      resourceUrl = getWarehouseUrl(host, item.warehouse_id, workspaceId);
                      break;
                    case "endpoints":
                      resourceUrl = getEndpointUrl(host, item.endpoint_name, workspaceId);
                      break;
                  }

                  const rawName = item[resourceConfig.nameKey];
                  const displayId = item[resourceConfig.idKey];
                  const displayName = rawName || displayId || "-";
                  const hasDistinctName = rawName && rawName !== displayId;

                  return (
                    <tr key={idx} className="hover:bg-gray-50">
                      {/* Name + ID column (pipeline objects pattern) */}
                      <td className="px-6 py-4 text-sm">
                        {resourceUrl ? (
                          <div className="flex flex-col gap-0.5">
                            <a
                              href={resourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="group flex max-w-xs items-center gap-1 truncate font-medium text-[#FF3621] hover:text-[#E02F1C]"
                            >
                              <span className="truncate">{displayName}</span>
                              <svg className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                              </svg>
                            </a>
                            {displayId && (hasDistinctName || activeUntaggedTab === "clusters" || activeUntaggedTab === "warehouses") && (
                              <span className="max-w-xs truncate text-xs text-gray-500">{displayId}</span>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            <span className="max-w-xs truncate font-medium text-gray-900">{displayName}</span>
                            {displayId && (hasDistinctName || activeUntaggedTab === "clusters" || activeUntaggedTab === "warehouses") && (
                              <span className="max-w-xs truncate text-xs text-gray-500">{displayId}</span>
                            )}
                          </div>
                        )}
                      </td>
                      {/* Extra columns */}
                      {extraColumns.map((col) => (
                        <td key={col.key} className="px-6 py-4 text-sm text-gray-600">
                          {item[col.key] ? (
                            col.key === "owner" ? (
                              <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 max-w-40 truncate" title={item[col.key]}>
                                {formatIdentity(item[col.key])}
                              </span>
                            ) : (
                              <span className="max-w-40 truncate block" title={item[col.key]}>{item[col.key]}</span>
                            )
                          ) : (
                            <span className="text-xs text-gray-500">-</span>
                          )}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-6 py-4 text-right text-sm text-gray-500">
                        {formatNumber(item.total_dbus)}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-right text-sm text-gray-900">
                        {formatCurrency(item.total_spend)}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-right text-sm text-gray-500">
                        {item.days_active}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        <div className="flex flex-wrap gap-1">
                          {(() => {
                            const tagMap: Record<string, string[]> = {
                              clusters: ["team", "environment", "project"],
                              jobs: ["pipeline", "owner", "schedule"],
                              pipelines: ["data_domain", "tier", "team"],
                              warehouses: ["department", "cost_center", "environment"],
                              endpoints: ["model", "use_case", "team"],
                            };
                            return (tagMap[activeUntaggedTab] || ["team", "environment", "project"]).map((tag) => (
                            <span
                              key={tag}
                              className="inline-flex items-center rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                            >
                              {tag}
                            </span>
                          ));
                          })()}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-center">
                        {resourceUrl && (
                          <a
                            href={resourceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-brand inline-flex items-center gap-1 rounded px-3 py-1.5 text-xs font-medium text-white transition-colors"
                          >
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                            </svg>
                            Add Tag
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
                <p className="text-sm text-gray-700">
                  Showing <span className="font-medium">{startIndex + 1}</span> to{" "}
                  <span className="font-medium">{Math.min(startIndex + itemsPerPage, sortedItems.length)}</span> of{" "}
                  <span className="font-medium">{sortedItems.length}</span> resources
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
                    .filter((page) => page === 1 || page === totalPages || (page >= currentPage - 1 && page <= currentPage + 1))
                    .map((page, idx, arr) => {
                      const prevPage = arr[idx - 1];
                      const showEllipsis = prevPage && page - prevPage > 1;
                      return (
                        <span key={page} className="flex items-center">
                          {showEllipsis && <span className="px-2 py-1 text-gray-500">...</span>}
                          <button
                            onClick={() => setCurrentPage(page)}
                            className={`rounded px-3 py-1 text-sm font-medium ${
                              currentPage === page
                                ? "text-white"
                                : "border border-gray-300 text-gray-700 hover:bg-gray-50"
                            }`}
                            style={currentPage === page ? { backgroundColor: '#FF3621' } : undefined}
                          >
                            {page}
                          </button>
                        </span>
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
        ) : (
          <div className="flex h-32 items-center justify-center text-gray-500">
            {searchQuery
              ? `No results for "${searchQuery}" in ${activeUntaggedTab}`
              : `No untagged ${activeUntaggedTab} found - great job!`}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tagging</h1>
          <p className="text-sm text-gray-500">Cost attribution through resource tagging coverage</p>
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
              <h3 className="text-sm font-medium text-orange-800">Tagging Best Practices</h3>
              <svg className={`h-4 w-4 text-orange-500 transition-transform ${infoMinimized ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {!infoMinimized && (
              <>
                <div className="mt-2 text-sm text-orange-700">
                  <ul className="list-inside list-disc space-y-1">
                    <li>Add <strong>custom_tags</strong> to clusters, jobs, and endpoints for cost attribution</li>
                    <li>Use consistent tag keys like <code>Owner</code>, <code>Team</code>, <code>Project</code>, <code>CostCenter</code></li>
                    <li>Tags propagate to billing usage records for chargeback and reporting</li>
                    <li>Higher tag coverage = better cost visibility and accountability</li>
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
          onClick={() => setSelectedKPI({ kpi: "tagged_spend", label: "Tagged Spend" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Tagged Spend</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(summary.tagged_spend)}</p>
              <p className="text-sm text-gray-500">{(summary.tagged_percentage ?? 0).toFixed(1)}% of total</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => setSelectedKPI({ kpi: "untagged_spend", label: "Untagged Spend" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Untagged Spend</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(summary.untagged_spend)}</p>
              <p className="text-sm text-gray-500">{(summary.untagged_percentage ?? 0).toFixed(1)}% of total</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => setSelectedKPI({ kpi: "tagged_spend", label: "Tag Coverage" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Tag Coverage</p>
              <p className="text-2xl font-semibold text-gray-900">{(summary.tagged_percentage ?? 0).toFixed(1)}%</p>
              <p className="text-sm text-gray-500">of total spend</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>

        <div
          className="rounded-lg bg-white p-6 border shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all"
          style={{ borderColor: '#E5E5E5' }}
          onClick={() => setSelectedKPI({ kpi: "total_spend", label: "Total Spend" })}
        >
          <div className="flex items-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
              <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Total Spend</p>
              <p className="text-2xl font-semibold text-gray-900">{formatCurrency(summary.total_spend)}</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>
      </div>

      {/* KPI Trend Modal */}
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

      {/* Tag Coverage + Tag Coverage Over Time — side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Tag Coverage Pie Chart */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Total Tag Coverage</h3>
          {coveragePieData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={coveragePieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={2}
                  dataKey="value"
                  label={({ name, value }) => `${name}: ${formatCurrency(value)}`}
                  labelLine={false}
                >
                  {coveragePieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatCurrency(value as number)} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-gray-500">No coverage data</div>
          )}
        </div>

        {/* Tag Coverage Over Time */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Tag Coverage Over Time</h3>
          {data.timeseries?.timeseries?.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={data.timeseries.timeseries} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <XAxis
                  dataKey="date"
                  tickFormatter={(date) => new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  stroke="#9ca3af"
                  fontSize={12}
                  tickMargin={8}
                />
                <YAxis tickFormatter={(value) => formatCurrency(value)} width={80} stroke="#9ca3af" fontSize={12} />
                <Tooltip
                  formatter={(value) => formatCurrency(value as number)}
                  labelFormatter={(label) => new Date(label).toLocaleDateString()}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Area
                  type="monotone"
                  dataKey="Tagged"
                  stackId="1"
                  stroke={COLORS.tagged}
                  fill={COLORS.tagged}
                  fillOpacity={0.6}
                />
                <Area
                  type="monotone"
                  dataKey="Untagged"
                  stackId="1"
                  stroke={COLORS.untagged}
                  fill={COLORS.untagged}
                  fillOpacity={0.6}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-64 items-center justify-center text-gray-500">No timeseries data</div>
          )}
        </div>
      </div>

      {/* Spend by Tag + Spend by Key — side by side */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Spend by Tag Table (left) */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">
              Spend by Tag
              {selectedTagValueFilters.length > 0 && (
                <span className="ml-2 text-sm font-normal text-gray-500">({filteredTags.length} results)</span>
              )}
            </h3>
            {availableTagValues.length > 0 && (
              <div className="relative" data-tag-value-filter-dropdown>
                <button
                  onClick={() => { setTagValueFilterDropdownOpen(!tagValueFilterDropdownOpen); setTagValueFilterSearch(""); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                >
                  <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                  </svg>
                  Filter
                  {selectedTagValueFilters.length > 0 && (
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: '#FF3621' }}>
                      {selectedTagValueFilters.length}
                    </span>
                  )}
                </button>
                {tagValueFilterDropdownOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-gray-200 bg-white shadow-lg">
                    <div className="p-2">
                      <input
                        type="text"
                        value={tagValueFilterSearch}
                        onChange={(e) => setTagValueFilterSearch(e.target.value)}
                        placeholder="Search tags..."
                        className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-60 overflow-y-auto py-1">
                      {availableTagValues
                        .filter(kv => !tagValueFilterSearch || kv.toLowerCase().includes(tagValueFilterSearch.toLowerCase()))
                        .map(kv => {
                          const [key, ...rest] = kv.split(":");
                          const value = rest.join(":");
                          return (
                            <button
                              key={kv}
                              onClick={() => handleToggleTagValueFilter(kv)}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                            >
                              <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${selectedTagValueFilters.includes(kv) ? "border-orange-500 bg-orange-500" : "border-gray-300"}`}>
                                {selectedTagValueFilters.includes(kv) && (
                                  <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                  </svg>
                                )}
                              </div>
                              <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-800">{key}</span>
                              <span className="truncate text-xs text-gray-600">{value}</span>
                            </button>
                          );
                        })}
                      {availableTagValues.filter(kv => !tagValueFilterSearch || kv.toLowerCase().includes(tagValueFilterSearch.toLowerCase())).length === 0 && (
                        <div className="px-3 py-2 text-sm text-gray-500">No matching tags</div>
                      )}
                    </div>
                    {selectedTagValueFilters.length > 0 && (
                      <div className="border-t border-gray-200 p-2">
                        <button onClick={handleClearTagValueFilters} className="w-full rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100">
                          Clear all
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Tag value filter pills */}
          {selectedTagValueFilters.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {selectedTagValueFilters.map(kv => {
                const [key, ...rest] = kv.split(":");
                const value = rest.join(":");
                return (
                  <span key={kv} className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: '#FF3621' }}>
                    {key}: {value}
                    <button onClick={() => handleToggleTagValueFilter(kv)} className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-white/20">
                      <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                );
              })}
              <button onClick={handleClearTagValueFilters} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
            </div>
          )}
          {filteredTags.length > 0 ? (
            <div className="max-h-75 overflow-y-auto">
              <table className="w-full divide-y divide-gray-200">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500" style={{ width: '100px' }}>Key</th>
                    <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Value</th>
                    <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Spend</th>
                    <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {filteredTags.slice(0, 20).map((tag, idx) => (
                    <tr key={idx} className="cursor-pointer hover:bg-gray-50" onClick={() => handleTagClick(tag.tag_key, tag.tag_value)}>
                      <td className="whitespace-nowrap px-2 py-2 text-xs font-medium text-gray-900" style={{ width: '100px', maxWidth: '100px' }}>
                        <span className="rounded bg-orange-100 px-1.5 py-0.5 text-orange-800 truncate inline-block max-w-full" title={tag.tag_key}>{tag.tag_key}</span>
                      </td>
                      <td className="px-2 py-2 text-xs text-gray-500 max-w-28 truncate" title={tag.tag_value}>{tag.tag_value}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right text-xs font-medium text-gray-900">{formatCurrency(tag.total_spend)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <div className="h-1.5 w-10 overflow-hidden rounded-full bg-gray-200">
                            <div className="h-full rounded-full bg-orange-500" style={{ width: `${tag.percentage}%` }} />
                          </div>
                          <span className="text-xs text-gray-500">{tag.percentage.toFixed(1)}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="flex h-32 items-center justify-center text-gray-500">
              {selectedTagFilters.length > 0 ? "No tags match the selected filters" : "No tagged resources found"}
            </div>
          )}
        </div>

        {/* Spend by Key Bar Chart (right) */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900">Spend by Key</h3>
            {availableTagKeys.length > 0 && (
              <div className="relative" data-tag-filter-dropdown>
                <button
                  onClick={() => { setTagFilterDropdownOpen(!tagFilterDropdownOpen); setTagFilterSearch(""); }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                >
                  <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                  </svg>
                  Filter
                  {selectedTagFilters.length > 0 && (
                    <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: '#FF3621' }}>
                      {selectedTagFilters.length}
                    </span>
                  )}
                </button>
                {tagFilterDropdownOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-gray-200 bg-white shadow-lg">
                    <div className="p-2">
                      <input
                        type="text"
                        value={tagFilterSearch}
                        onChange={(e) => setTagFilterSearch(e.target.value)}
                        placeholder="Search tag keys..."
                        className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
                        autoFocus
                      />
                    </div>
                    <div className="max-h-60 overflow-y-auto py-1">
                      {availableTagKeys
                        .filter(k => !tagFilterSearch || k.toLowerCase().includes(tagFilterSearch.toLowerCase()))
                        .map(key => (
                          <button
                            key={key}
                            onClick={() => handleToggleTagFilter(key)}
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                          >
                            <div className={`flex h-4 w-4 items-center justify-center rounded border ${selectedTagFilters.includes(key) ? "border-orange-500 bg-orange-500" : "border-gray-300"}`}>
                              {selectedTagFilters.includes(key) && (
                                <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </div>
                            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-xs font-medium text-orange-800">{key}</span>
                          </button>
                        ))}
                      {availableTagKeys.filter(k => !tagFilterSearch || k.toLowerCase().includes(tagFilterSearch.toLowerCase())).length === 0 && (
                        <div className="px-3 py-2 text-sm text-gray-500">No matching tag keys</div>
                      )}
                    </div>
                    {selectedTagFilters.length > 0 && (
                      <div className="border-t border-gray-200 p-2">
                        <button onClick={handleClearTagFilters} className="w-full rounded-md px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100">
                          Clear all
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Tag key filter pills */}
          {selectedTagFilters.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {selectedTagFilters.map(key => (
                <span key={key} className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: '#FF3621' }}>
                  {key}
                  <button onClick={() => handleToggleTagFilter(key)} className="ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-white/20">
                    <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
              <button onClick={handleClearTagFilters} className="text-xs text-gray-500 hover:text-gray-700">Clear</button>
            </div>
          )}
          {filteredTagBreakdownData.length > 0 ? (() => {
            const totalKeySpend = filteredTagBreakdownData.reduce((sum, d) => sum + d.total_spend, 0);
            return (
              <div className="max-h-75 overflow-y-auto">
                <table className="w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Key</th>
                      <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Spend</th>
                      <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wider text-gray-500">%</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 bg-white">
                    {filteredTagBreakdownData.map((entry, idx) => {
                      const pct = totalKeySpend > 0 ? (entry.total_spend / totalKeySpend) * 100 : 0;
                      return (
                        <tr key={idx} className="hover:bg-gray-50">
                          <td className="whitespace-nowrap px-2 py-2 text-xs font-medium text-gray-900">
                            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-orange-800" title={entry.tag_key}>{entry.tag_key}</span>
                          </td>
                          <td className="whitespace-nowrap px-2 py-2 text-right text-xs font-medium text-gray-900">{formatCurrency(entry.total_spend)}</td>
                          <td className="whitespace-nowrap px-2 py-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <div className="h-1.5 w-10 overflow-hidden rounded-full bg-gray-200">
                                <div className="h-full rounded-full bg-orange-500" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-xs text-gray-500">{pct.toFixed(1)}%</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })() : (
            <div className="flex h-32 items-center justify-center text-gray-500">
              {selectedTagFilters.length > 0 ? "No data for selected filters" : "No tag data available"}
            </div>
          )}
        </div>
      </div>

      {/* Untagged Resources Table */}
      {renderUntaggedTable()}

      {/* Tag Drilldown Modal */}
      {selectedTag && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50" onClick={() => setSelectedTag(null)}>
          <div className="mx-4 w-full max-w-2xl rounded-lg bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="rounded bg-orange-100 px-2 py-1 text-sm font-medium text-orange-800">{selectedTag.tag_key}</span>
                <h3 className="text-lg font-semibold text-gray-900">
                  Top 5 Objects — {selectedTag.tag_value}
                </h3>
              </div>
              <button onClick={() => setSelectedTag(null)} className="rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-600">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {tagObjectsLoading ? (
              <div className="flex h-40 items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
              </div>
            ) : tagObjects.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Object</th>
                      <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Type</th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">DBUs</th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Spend</th>
                      <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Days Active</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {tagObjects.map((obj, idx) => (
                      <tr key={obj.object_id || idx} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 max-w-xs truncate">
                          {obj.object_name}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${
                            obj.object_type === 'Cluster' ? 'bg-blue-100 text-blue-700' :
                            obj.object_type === 'Job' ? 'bg-green-100 text-green-700' :
                            obj.object_type === 'SQL Warehouse' ? 'bg-blue-50 text-blue-700' :
                            obj.object_type === 'Pipeline' ? 'bg-cyan-100 text-cyan-700' :
                            obj.object_type === 'Serving Endpoint' ? 'bg-pink-100 text-pink-700' :
                            'bg-gray-100 text-gray-700'
                          }`}>
                            {obj.object_type}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-500">
                          {formatNumber(obj.total_dbus)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-medium text-gray-900">
                          {formatCurrency(obj.total_spend)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right text-sm text-gray-500">
                          {obj.days_active}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="flex h-40 items-center justify-center text-gray-500">
                No objects found for this tag
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
