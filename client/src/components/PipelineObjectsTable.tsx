import { useState, memo } from "react";
import type { PipelineObjectsResponse } from "@/types/billing";
import { formatCurrency, workspaceUrl } from "@/utils/formatters";
import { StatusIndicator } from "./StatusIndicator";
import { formatIdentity } from "@/utils/identity";

interface PipelineObjectsTableProps {
  data: PipelineObjectsResponse | undefined;
  isLoading: boolean;
  host: string | null | undefined;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function getObjectUrl(host: string | null | undefined, objectType: string, objectId: string, _workspaceId: string | null): string | null {
  if (!host || !objectId) return null;
  if (objectType === "Job") {
    return workspaceUrl(host, `/jobs/${objectId}`);
  } else if (objectType === "SDP Pipeline") {
    return workspaceUrl(host, `/pipelines/${objectId}`);
  }
  return null;
}

type SortField = "object_name" | "object_type" | "total_spend" | "total_dbus" | "total_runs";
type SortDirection = "asc" | "desc";

export const PipelineObjectsTable = memo(function PipelineObjectsTable({ data, isLoading, host }: PipelineObjectsTableProps) {
  const [sortField, setSortField] = useState<SortField>("total_spend");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [filter, setFilter] = useState<"all" | "Job" | "SDP Pipeline">("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [search, setSearch] = useState("");
  const [showHistorical, setShowHistorical] = useState(false);
  const itemsPerPage = 10;

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

  if (isLoading) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="flex h-48 flex-col items-center justify-center gap-3">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
          <p className="text-sm text-gray-500">Loading pipelines...</p>
        </div>
      </div>
    );
  }

  if (data?.error) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">ETL Breakdown</h3>
        <p className="text-sm text-amber-600">{data.error}</p>
      </div>
    );
  }

  if (!data || data.objects.length === 0) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">ETL Breakdown</h3>
        <div className="flex h-32 flex-col items-center justify-center gap-2 text-gray-500">
          <p className="text-base font-medium">No pipeline objects found</p>
          <p className="text-sm">Jobs and SDP pipelines will appear here when billing activity is detected</p>
        </div>
      </div>
    );
  }

  const searchLower = search.toLowerCase();
  const isHistorical = (obj: typeof data.objects[0]) => !obj.object_name || obj.object_name === obj.object_id;
  const filteredObjects = data.objects.filter(
    (obj) => (filter === "all" || obj.object_type === filter) &&
      (showHistorical || !isHistorical(obj)) &&
      (!search || (obj.object_name || "").toLowerCase().includes(searchLower) ||
        obj.object_id.toLowerCase().includes(searchLower) ||
        (obj.owner || "").toLowerCase().includes(searchLower))
  );

  const sortedObjects = [...filteredObjects].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    const modifier = sortDirection === "asc" ? 1 : -1;
    if (typeof aVal === "string" && typeof bVal === "string") {
      return aVal.localeCompare(bVal) * modifier;
    }
    return ((aVal as number) - (bVal as number)) * modifier;
  });

  const totalPages = Math.ceil(sortedObjects.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedData = sortedObjects.slice(startIndex, endIndex);

  const activeObjects = showHistorical ? data.objects : data.objects.filter((o) => !isHistorical(o));
  const jobCount = activeObjects.filter((o) => o.object_type === "Job").length;
  const pipelineCount = activeObjects.filter((o) => o.object_type === "SDP Pipeline").length;
  const historicalCount = data.objects.filter((o) => isHistorical(o)).length;

  return (
    <div className="animate-fade-in rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
      <div className="mb-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-1.5">
              ETL Breakdown
              <span className="relative group">
                <svg className="h-4 w-4 text-gray-500 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-80 rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg z-20">
                  All streaming and batch workloads across Spark Declarative Pipelines (SDP) and Jobs. Unlike Interactive Compute, these are automated scheduled or triggered workloads that run without user interaction.
                </span>
              </span>
            </h3>
            <p className="text-sm text-gray-500">
              {activeObjects.length} objects by spend
            </p>
          </div>
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
                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block w-56 rounded-lg bg-gray-900 px-2 py-1.5 text-[10px] text-white shadow-lg z-20">Objects whose names could not be resolved — likely deleted or from inaccessible workspaces</span>
                </span>
              </label>
            )}
            <input
              type="text"
              placeholder="Search jobs & pipelines..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setCurrentPage(1); }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 w-56"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFilter("all")}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === "all"
                ? "text-white"
                : "bg-orange-50 text-orange-700 hover:bg-orange-100"
            }`}
            style={filter === "all" ? { backgroundColor: '#FF3621' } : undefined}
          >
            All ({activeObjects.length})
          </button>
          <button
            onClick={() => setFilter("Job")}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === "Job"
                ? "text-white"
                : "bg-orange-50 text-orange-700 hover:bg-orange-100"
            }`}
            style={filter === "Job" ? { backgroundColor: '#FF3621' } : undefined}
          >
            Jobs ({jobCount})
          </button>
          <button
            onClick={() => setFilter("SDP Pipeline")}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === "SDP Pipeline"
                ? "text-white"
                : "bg-orange-50 text-orange-700 hover:bg-orange-100"
            }`}
            style={filter === "SDP Pipeline" ? { backgroundColor: '#FF3621' } : undefined}
          >
            SDP ({pipelineCount})
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th
                className="cursor-pointer px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                onClick={() => handleSort("object_type")}
              >
                Type <SortIcon field="object_type" />
              </th>
              <th
                className="cursor-pointer px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                onClick={() => handleSort("object_name")}
              >
                Name <SortIcon field="object_name" />
              </th>
              <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Owner
              </th>
              <th
                className="cursor-pointer px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                onClick={() => handleSort("total_spend")}
              >
                Spend <SortIcon field="total_spend" />
              </th>
              <th
                className="cursor-pointer px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                onClick={() => handleSort("total_dbus")}
              >
                DBUs <SortIcon field="total_dbus" />
              </th>
              <th
                className="cursor-pointer px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-700"
                onClick={() => handleSort("total_runs")}
              >
                Runs <SortIcon field="total_runs" />
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                %
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {paginatedData.map((obj, idx) => {
              const url = getObjectUrl(host, obj.object_type, obj.object_id, obj.workspace_id);

              return (
                <tr key={`${obj.object_type}-${obj.object_id}-${idx}`} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-3 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        obj.object_type === "Job"
                          ? "bg-orange-100 text-orange-800"
                          : "bg-orange-100 text-orange-800"
                      }`}
                    >
                      {obj.object_type === "SDP Pipeline" ? "SDP" : obj.object_type}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    {url ? (
                      <div className="flex flex-col gap-1">
                        <a
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group flex max-w-xs items-center gap-1 truncate text-sm font-medium text-[#FF3621] hover:text-[#E02F1C]"
                        >
                          <span className="truncate">{obj.object_name || obj.object_id}</span>
                          <svg className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                        <div className="flex items-center gap-2">
                          {isHistorical(obj) && (
                            <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Historical</span>
                          )}
                          {obj.object_state && (
                            <StatusIndicator
                              status={obj.object_state}
                              type={obj.object_type === "Job" ? "job" : "pipeline"}
                            />
                          )}
                          {obj.object_name && obj.object_name !== obj.object_id && (
                            <div className="max-w-xs truncate text-xs text-gray-500">
                              {obj.object_id}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="max-w-xs truncate text-sm font-medium text-gray-900">
                          {obj.object_name || obj.object_id}
                        </div>
                        <div className="flex items-center gap-2">
                          {isHistorical(obj) && (
                            <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Historical</span>
                          )}
                          {obj.object_state && (
                            <StatusIndicator
                              status={obj.object_state}
                              type={obj.object_type === "Job" ? "job" : "pipeline"}
                            />
                          )}
                          {obj.object_name && obj.object_name !== obj.object_id && (
                            <div className="max-w-xs truncate text-xs text-gray-500">
                              {obj.object_id}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    {obj.owner ? (
                      <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 max-w-40 truncate" title={obj.owner}>
                        {formatIdentity(obj.owner)}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-500">-</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-medium text-gray-900">
                    {formatCurrency(obj.total_spend)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-600">
                    {formatNumber(obj.total_dbus)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-600">
                    {formatNumber(obj.total_runs)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-500">
                    {obj.percentage.toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-gray-50">
            <tr>
              <td colSpan={3} className="px-3 py-3 text-sm font-medium text-gray-700">
                Total ({filteredObjects.length} objects)
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-bold text-gray-900">
                {formatCurrency(filteredObjects.reduce((sum, o) => sum + o.total_spend, 0))}
              </td>
              <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-medium text-gray-700">
                {formatNumber(filteredObjects.reduce((sum, o) => sum + o.total_dbus, 0))}
              </td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
            <p className="text-sm text-gray-700">
              Showing <span className="font-medium">{startIndex + 1}</span> to{" "}
              <span className="font-medium">{Math.min(endIndex, sortedObjects.length)}</span> of{" "}
              <span className="font-medium">{sortedObjects.length}</span> objects
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
