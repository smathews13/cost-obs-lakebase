import { useState } from "react";

interface TabRefreshButtonProps {
  onRefresh: () => Promise<void>;
}

export function TabRefreshButton({ onRefresh }: TabRefreshButtonProps) {
  const [spinning, setSpinning] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);

  const handleClick = async () => {
    if (spinning) return;
    setSpinning(true);
    try {
      await onRefresh();
    } finally {
      // Keep spinner for at least 600ms so it's visible
      setTimeout(() => setSpinning(false), 600);
    }
  };

  return (
    <div className="relative inline-flex" onMouseEnter={() => setShowTooltip(true)} onMouseLeave={() => setShowTooltip(false)}>
      <button
        onClick={handleClick}
        disabled={spinning}
        aria-label="Refresh tab data"
        className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white p-2 text-gray-500 shadow-sm transition-colors hover:border-gray-300 hover:text-gray-600 disabled:cursor-not-allowed"
      >
        <svg
          className={`h-4 w-4 ${spinning ? "animate-spin" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>

      {showTooltip && !spinning && (
        <div className="pointer-events-none absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-lg">
          <p className="text-xs font-medium text-gray-700">Refresh tab data</p>
          <p className="mt-0.5 text-xs text-gray-500">
            Clears the cache and reloads all visuals and tables on this tab with the latest data from Databricks.
          </p>
          {/* Tooltip arrow */}
          <div className="absolute -top-1.5 right-3 h-3 w-3 rotate-45 border-l border-t border-gray-200 bg-white" />
        </div>
      )}
    </div>
  );
}
