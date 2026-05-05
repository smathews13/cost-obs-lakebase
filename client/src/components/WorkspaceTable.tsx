import { useState, memo } from "react";
import type { WorkspaceBreakdownResponse } from "@/types/billing";
import { formatCurrency, formatNumber, workspaceUrl } from "@/utils/formatters";
import { formatIdentity } from "@/utils/identity";

interface WorkspaceTableProps {
  data: WorkspaceBreakdownResponse | undefined;
  isLoading: boolean;
  host: string | null | undefined;
}

function getWorkspaceUrl(host: string | null | undefined, workspaceId: string): string | null {
  if (!host || !workspaceId) return null;
  return workspaceUrl(host, `/browse/folders/workspace?o=${workspaceId}`);
}

const PRODUCT_LABELS: Record<string, string> = {
  ALL_PURPOSE_COMPUTE: "All-Purpose",
  JOBS_COMPUTE: "Jobs",
  JOBS: "Jobs",
  SQL: "SQL Warehouses",
  DLT: "Spark Declarative Pipelines",
  MODEL_SERVING: "Model Serving",
  INTERACTIVE: "Notebooks",
  VECTOR_SEARCH: "Vector Search",
  AI_RUNTIME: "AI Runtime",
  AI_GATEWAY: "AI Gateway",
  AI_FUNCTIONS: "AI Functions",
  AGENT_EVALUATION: "Agent Eval",
  AGENT_BRICKS: "Agent Bricks",
  FOUNDATION_MODEL_TRAINING: "Fine-Tuning",
  DATABASE: "Catalog/Metastore",
  GENOMICS: "Genomics",
  INFERENCE: "Inference",
};

function formatProductName(raw: string): string {
  return PRODUCT_LABELS[raw] || raw.split("_").map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ");
}

export const WorkspaceTable = memo(function WorkspaceTable({ data, isLoading, host }: WorkspaceTableProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [search, setSearch] = useState("");
  const [showHistorical, setShowHistorical] = useState(false);
  const itemsPerPage = 10;
  if (isLoading) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="flex h-48 flex-col items-center justify-center gap-3">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
          <p className="text-sm text-gray-500">Loading workspaces...</p>
        </div>
      </div>
    );
  }

  if (!data || !data.workspaces?.length) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">
          Spend by Workspace
        </h3>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-gray-500">
          <p className="text-base font-medium">No workspace data available</p>
          <p className="text-sm">Try adjusting the date range or verify workspace billing is enabled</p>
        </div>
      </div>
    );
  }

  const isHistoricalWs = (ws: typeof data.workspaces[0]) => !ws.workspace_name;
  const historicalCount = data.workspaces.filter((ws) => isHistoricalWs(ws)).length;
  const activeWorkspaces = showHistorical ? data.workspaces : data.workspaces.filter((ws) => !isHistoricalWs(ws));
  const searchLower = search.toLowerCase();
  const filteredWorkspaces = search
    ? activeWorkspaces.filter((ws) =>
        (ws.workspace_name || "").toLowerCase().includes(searchLower) ||
        ws.workspace_id.toLowerCase().includes(searchLower) ||
        (ws.top_products || []).some((p) => p.toLowerCase().includes(searchLower)) ||
        (ws.top_users || []).some((u) => u.toLowerCase().includes(searchLower))
      )
    : activeWorkspaces;

  const totalPages = Math.ceil(filteredWorkspaces.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedData = filteredWorkspaces.slice(startIndex, endIndex);

  return (
    <div className="animate-fade-in rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900">
          Spend by Workspace
        </h3>
        <div className="flex items-center gap-3">
          {historicalCount > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
              <input
                type="checkbox"
                checked={showHistorical}
                onChange={(e) => { setShowHistorical(e.target.checked); setCurrentPage(1); }}
                className="rounded border-gray-300 text-orange-600 focus:ring-orange-500"
              />
              Show historical ({historicalCount})
                <span className="relative group ml-0.5">
                  <svg className="inline h-3 w-3 text-gray-500 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block w-56 rounded-lg bg-gray-900 px-2 py-1.5 text-[10px] text-white shadow-lg z-20">Workspaces whose names could not be resolved — likely decommissioned or inaccessible</span>
                </span>
            </label>
          )}
          <input
            type="text"
            placeholder="Search workspaces..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setCurrentPage(1); }}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 w-56"
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50">
            <tr className="border-b border-gray-200">
              <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Workspace
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Top Products
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Top Users
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                DBUs
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Spend
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                %
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {paginatedData.map((ws) => {
              const url = getWorkspaceUrl(host, ws.workspace_id);

              return (
                <tr key={ws.workspace_id} className="hover:bg-gray-50">
                  <td className="px-3 py-3">
                    {url ? (
                      <div className="flex flex-col gap-0.5">
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group flex items-center gap-1 text-sm font-medium text-[#FF3621] hover:text-[#E02F1C]"
                        >
                          <span>{ws.workspace_name || `Workspace ${ws.workspace_id}`}</span>
                          <svg className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">{ws.workspace_id}</span>
                          {isHistoricalWs(ws) && <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Historical</span>}
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-gray-900">{ws.workspace_name || `Workspace ${ws.workspace_id}`}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500">{ws.workspace_id}</span>
                          {isHistoricalWs(ws) && <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Historical</span>}
                        </div>
                      </div>
                    )}
                  </td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(ws.top_products || []).map((p) => (
                      <span key={p} className="inline-flex rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700" title={p}>
                        {formatProductName(p)}
                      </span>
                    ))}
                    {(!ws.top_products || ws.top_products.length === 0) && (
                      <span className="text-xs text-gray-500">-</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1">
                    {(ws.top_users || []).map((u) => (
                      <div key={u} className="flex flex-col gap-0.5">
                        <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 max-w-35 truncate" title={u}>
                          {formatIdentity(u)}
                        </span>
                      </div>
                    ))}
                    {(!ws.top_users || ws.top_users.length === 0) && (
                      <span className="text-xs text-gray-500">-</span>
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-500">
                  {formatNumber(ws.total_dbus)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-900">
                  {formatCurrency(ws.total_spend)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-500">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-2 w-16 overflow-hidden rounded-full bg-gray-200">
                      <div
                        className="h-full rounded-full bg-[#1B5162]"
                        style={{ width: `${Math.min(ws.percentage, 100)}%` }}
                      />
                    </div>
                    <span className="w-12 text-right">
                      {ws.percentage.toFixed(1)}%
                    </span>
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
            <p className="text-sm text-gray-700">
              Showing <span className="font-medium">{startIndex + 1}</span> to{" "}
              <span className="font-medium">{Math.min(endIndex, filteredWorkspaces.length)}</span> of{" "}
              <span className="font-medium">{filteredWorkspaces.length}</span> workspaces
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
                            ? "text-white"
                            : "border border-gray-300 text-gray-700 hover:bg-gray-50"
                        }`}
                        style={currentPage === page ? { backgroundColor: '#FF3621' } : undefined}
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
  );
});
