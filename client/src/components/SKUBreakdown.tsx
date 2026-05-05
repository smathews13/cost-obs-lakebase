import { useMemo, useState, useEffect, useRef } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
  ResponsiveContainer,
  LabelList,
} from "recharts";
import type { SKUBreakdownResponse, WorkspaceBreakdown } from "@/types/billing";
import { formatCurrency } from "@/utils/formatters";

interface SKUBreakdownProps {
  data: SKUBreakdownResponse | undefined;
  isLoading: boolean;
  workspaces?: WorkspaceBreakdown[];
  dateRange?: { startDate: string; endDate: string };
}

const SKU_COLORS = [
  "#1B5162", "#FF3621", "#06B6D4", "#10B981", "#F59E0B",
  "#3B82F6", "#EC4899", "#EF4444", "#14B8A6", "#6B7280",
];

export function SKUBreakdown({ data, isLoading, workspaces, dateRange }: SKUBreakdownProps) {
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>("all");
  const [filteredData, setFilteredData] = useState<SKUBreakdownResponse | undefined>(undefined);
  const [filterLoading, setFilterLoading] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedWorkspace === "all") {
      setFilteredData(undefined);
      return;
    }

    setFilterLoading(true);
    const params = new URLSearchParams();
    if (dateRange?.startDate) params.set("start_date", dateRange.startDate);
    if (dateRange?.endDate) params.set("end_date", dateRange.endDate);
    params.set("workspace_id", selectedWorkspace);

    fetch(`/api/billing/sku-breakdown?${params}`)
      .then((res) => res.json())
      .then((json) => {
        setFilteredData(json);
        setFilterLoading(false);
      })
      .catch(() => {
        setFilterLoading(false);
      });
  }, [selectedWorkspace, dateRange?.startDate, dateRange?.endDate]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    if (dropdownOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [dropdownOpen]);

  const displayData = selectedWorkspace === "all" ? data : filteredData;
  const showLoading = isLoading || filterLoading;

  const selectedWorkspaceName = useMemo(() => {
    if (selectedWorkspace === "all" || !workspaces) return null;
    const ws = workspaces.find((w) => String(w.workspace_id) === selectedWorkspace);
    return ws ? (ws.workspace_name || String(ws.workspace_id)) : selectedWorkspace;
  }, [selectedWorkspace, workspaces]);

  const workspaceSelector = workspaces && workspaces.length > 1 ? (
    <div className="relative" ref={dropdownRef}>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <svg className="h-3.5 w-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
          Filter
          <svg className={`h-3 w-3 text-gray-500 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {selectedWorkspaceName && (
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-white cursor-pointer"
            style={{ backgroundColor: '#FF3621' }}
            onClick={() => setSelectedWorkspace("all")}
            title="Click to clear filter"
          >
            {selectedWorkspaceName.length > 15 ? selectedWorkspaceName.substring(0, 15) + "..." : selectedWorkspaceName}
            <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </span>
        )}
      </div>
      {dropdownOpen && (
        <div className="absolute right-0 top-full z-10 mt-1 max-h-64 w-72 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          <button
            onClick={() => { setSelectedWorkspace("all"); setDropdownOpen(false); }}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
              selectedWorkspace === "all" ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700 hover:bg-gray-50"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${selectedWorkspace === "all" ? "bg-orange-500" : "bg-transparent"}`} />
            All Workspaces
          </button>
          {(workspaces || []).map((ws) => {
            const wsId = String(ws.workspace_id);
            const isActive = selectedWorkspace === wsId;
            return (
              <button
                key={wsId}
                onClick={() => { setSelectedWorkspace(wsId); setDropdownOpen(false); }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                  isActive ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${isActive ? "bg-orange-500" : "bg-transparent"}`} />
                <span className="truncate">{ws.workspace_name || ws.workspace_id}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  ) : null;

  const barData = useMemo(() => {
    if (!displayData?.skus?.length) return [];
    return [...displayData.skus]
      .sort((a, b) => b.total_spend - a.total_spend)
      .slice(0, 10)
      .map((sku) => {
        const stripped = sku.product.replace(/^(PREMIUM_|STANDARD_|ENTERPRISE_)/i, "");
        const parts = stripped.split("_");
        const label = parts.length > 4 ? parts.slice(0, 4).join(" ") + "…" : stripped.replace(/_/g, " ");
        return { name: label, total_spend: sku.total_spend };
      });
  }, [displayData]);

  if (showLoading) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Spend by SKU</h3>
          {workspaceSelector}
        </div>
        <div className="flex h-48 flex-col items-center justify-center gap-3">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
          <p className="text-sm text-gray-500">Loading SKU breakdown...</p>
        </div>
      </div>
    );
  }

  if (!displayData || !displayData.skus?.length) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Spend by SKU</h3>
          {workspaceSelector}
        </div>
        <div className="flex h-80 flex-col items-center justify-center gap-2 text-gray-500">
          <p className="text-base font-medium">No SKU data available</p>
          <p className="text-sm">Try expanding the date range</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Spend by SKU</h3>
          {selectedWorkspaceName && (
            <p className="text-sm text-orange-600 font-medium mt-0.5">
              Filtered to: {selectedWorkspaceName}
            </p>
          )}
        </div>
        {workspaceSelector}
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={barData} layout="vertical" margin={{ left: -25, right: 70 }}>
          <XAxis type="number" tickFormatter={(v) => formatCurrency(v)} stroke="#9ca3af" fontSize={12} tickMargin={8} />
          <YAxis
            type="category"
            dataKey="name"
            width={175}
            stroke="#9ca3af"
            fontSize={11}
            tickMargin={2}
            tickFormatter={(v: string) => v.length > 22 ? v.substring(0, 20) + "…" : v}
          />
          <Tooltip
            formatter={(value: number | undefined) => formatCurrency(value ?? 0)}
            labelFormatter={(label) => `SKU: ${label}`}
            contentStyle={{
              backgroundColor: "white",
              border: "1px solid #e5e7eb",
              borderRadius: "8px",
            }}
          />
          <Bar dataKey="total_spend" name="Spend" radius={[0, 4, 4, 0]}>
            {barData.map((_entry, idx) => (
              <Cell key={idx} fill={SKU_COLORS[idx % SKU_COLORS.length]} />
            ))}
            <LabelList dataKey="total_spend" position="right" formatter={(v: unknown) => formatCurrency(v as number)} style={{ fontSize: 11, fill: "#6b7280" }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
