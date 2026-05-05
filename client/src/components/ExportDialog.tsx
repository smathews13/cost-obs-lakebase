import { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import type { TabVisibility } from "@/components/SettingsDialog";

export interface ExportSections {
  summary: boolean;
  products: boolean;
  workspaces: boolean;
  skus: boolean;
  anomalies: boolean;
  pipelines: boolean;
  interactive: boolean;
  awsCosts: boolean;
  aiml: boolean;
  apps: boolean;
  tagging: boolean;
  platformKPIs: boolean;
  query360: boolean;
  users: boolean;
  useCases: boolean;
  alerts: boolean;
}

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onExport: (sections: ExportSections) => void;
  tabVisibility: TabVisibility;
}

// Map export sections to the tab that owns them
const sectionToTab: Record<keyof ExportSections, keyof TabVisibility | null> = {
  summary: "dbu",
  products: "dbu",
  workspaces: "dbu",
  skus: "dbu",
  anomalies: "dbu",
  pipelines: "dbu",
  interactive: "dbu",
  awsCosts: "infra",
  platformKPIs: "kpis",
  aiml: "aiml",
  query360: "sql",
  apps: "apps",
  tagging: "tagging",
  users: "users-groups",
  useCases: "use-cases",
  alerts: "alerts",
};

// Ordered to match tab layout: DBU Spend, Infrastructure, Platform KPIs, AI/ML, Query 360, Tagging
const sectionLabels: Record<keyof ExportSections, { label: string; description: string }> = {
  summary: { label: "Executive Summary", description: "Total DBUs, spend, and key metrics" },
  products: { label: "Product Breakdown", description: "Spend by product category" },
  workspaces: { label: "Workspace Breakdown", description: "Top workspaces by spend" },
  skus: { label: "SKU Breakdown", description: "Spend by SKU/billing type" },
  pipelines: { label: "Jobs & Pipelines", description: "Top jobs and SDP pipelines" },
  interactive: { label: "Interactive Compute", description: "Notebook and cluster usage" },
  awsCosts: { label: "Cloud Costs", description: "Estimated cloud infrastructure costs" },
  platformKPIs: { label: "Platform KPIs & Trends", description: "Platform-wide metrics and trends" },
  anomalies: { label: "Spend Anomalies", description: "Day-over-day spend changes" },
  aiml: { label: "AI/ML", description: "FMAPI providers and inference endpoints" },
  apps: { label: "Apps", description: "Databricks Apps compute costs and per-app breakdown" },
  query360: { label: "Query", description: "SQL warehouse efficiency and query costs" },
  tagging: { label: "Tagging", description: "Tag coverage and untagged resources" },
  users: { label: "Users", description: "Top users by spend and product breakdown" },
  useCases: { label: "Use Cases", description: "Use case spend attribution and go-live tracking" },
  alerts: { label: "Alerts", description: "Cost anomaly alerts and thresholds" },
};

export function ExportDialog({ isOpen, onClose, onExport, tabVisibility }: ExportDialogProps) {
  // Only show/enable sections whose parent tab is visible
  const visibleSections = useMemo(() => {
    const result: ExportSections = {} as ExportSections;
    for (const key of Object.keys(sectionToTab) as Array<keyof ExportSections>) {
      const tab = sectionToTab[key];
      result[key] = tab === null || tabVisibility[tab];
    }
    return result;
  }, [tabVisibility]);

  const [sections, setSections] = useState<ExportSections>(visibleSections);

  // Escape key handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  // Reset sections when dialog opens to reflect current tab visibility
  useEffect(() => {
    if (isOpen) {
      setSections(visibleSections);
    }
  }, [isOpen, visibleSections]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const toggleSection = (key: keyof ExportSections) => {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const selectAll = () => {
    setSections({ ...visibleSections });
  };

  const selectNone = () => {
    const none: ExportSections = {} as ExportSections;
    for (const key of Object.keys(sectionToTab) as Array<keyof ExportSections>) none[key] = false;
    setSections(none);
  };

  const visibleKeys = (Object.keys(sectionToTab) as Array<keyof ExportSections>).filter((k) => visibleSections[k]);
  const selectedCount = visibleKeys.filter((k) => sections[k]).length;

  const handleExport = () => {
    onExport(sections);
    onClose();
  };

  return createPortal(
    <div className="animate-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/30" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex min-h-full items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="animate-dialog relative w-full max-w-4xl rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="border-b border-gray-200 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-orange-100">
                  <svg className="h-5 w-5 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Export PDF Report</h3>
                  <p className="text-sm text-gray-500">Select sections to include</p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-500"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Content */}
          <div className="max-h-96 overflow-y-auto px-6 py-4">
            {/* Quick actions */}
            <div className="mb-4 flex items-center justify-between">
              <span className="text-sm text-gray-500">{selectedCount} of {visibleKeys.length} sections selected</span>
              <div className="flex gap-2">
                <button
                  onClick={selectAll}
                  className="text-sm font-medium hover:text-[#E02F1C]"
                  style={{ color: '#FF3621' }}
                >
                  Select All
                </button>
                <span className="text-gray-300">|</span>
                <button
                  onClick={selectNone}
                  className="text-sm font-medium hover:text-[#E02F1C]"
                  style={{ color: '#FF3621' }}
                >
                  Select None
                </button>
              </div>
            </div>

            {/* Sections */}
            <div className="space-y-2">
              {visibleKeys.map((key) => {
                const { label, description } = sectionLabels[key];
                const checked = sections[key];

                return (
                  <label
                    key={key}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border-2 p-3 transition-colors ${checked ? "border-orange-500 bg-orange-50" : "border-gray-300 bg-white"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSection(key)}
                      className="mt-0.5 h-4 w-4 rounded border-gray-300 text-orange-600 focus:ring-orange-500"
                    />
                    <div className="flex-1">
                      <div className="font-medium text-gray-900">{label}</div>
                      <div className="text-sm text-gray-500">{description}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 border-t border-gray-200 px-6 py-4">
            <button
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleExport}
              disabled={selectedCount === 0}
              className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                backgroundColor: selectedCount === 0 ? '#FFA390' : '#FF3621'
              }}
              onMouseEnter={(e) => {
                if (selectedCount > 0) {
                  e.currentTarget.style.backgroundColor = '#E02F1C';
                }
              }}
              onMouseLeave={(e) => {
                if (selectedCount > 0) {
                  e.currentTarget.style.backgroundColor = '#FF3621';
                }
              }}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Export {selectedCount} Section{selectedCount !== 1 ? "s" : ""}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
