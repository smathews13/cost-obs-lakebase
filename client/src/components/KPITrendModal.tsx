import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { format, parseISO } from "date-fns";
import { X, TrendingUp, TrendingDown, Minus } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useKPITrend, usePlatformKPITrend, useAppsKPITrend } from "@/hooks/useKPITrend";
import { formatCurrency, formatNumber, formatBytes, formatComputeSecondsCompact } from "@/utils/formatters";

interface KPITrendModalProps {
  kpi: string;
  kpiLabel: string;
  isOpen: boolean;
  onClose: () => void;
  startDate: string;
  endDate: string;
  formatValue?: (value: number, kpi: string) => string;
  variant?: "billing" | "platform" | "apps";
}

const SPEND_KPIS = new Set(["total_spend", "avg_daily_spend", "aiml_spend", "apps_spend", "tagged_spend", "untagged_spend", "infra_cost", "avg_cost_per_cluster"]);

function defaultBillingFormat(value: number, kpi: string): string {
  if (SPEND_KPIS.has(kpi)) {
    return formatCurrency(value);
  }
  return formatNumber(value);
}

function defaultPlatformFormat(value: number, kpi: string): string {
  if (kpi === "total_bytes_read") return formatBytes(value);
  if (kpi === "total_compute_seconds") return formatComputeSecondsCompact(value);
  return formatNumber(value);
}

export function KPITrendModal({
  kpi,
  kpiLabel,
  isOpen,
  onClose,
  startDate,
  endDate,
  formatValue,
  variant = "billing",
}: KPITrendModalProps) {
  const [granularity, setGranularity] = useState<"daily" | "monthly">("daily");

  const billingTrend = useKPITrend(kpi, startDate, endDate, granularity);
  const platformTrend = usePlatformKPITrend(kpi, startDate, endDate, granularity);
  const appsTrend = useAppsKPITrend(kpi, startDate, endDate, granularity);
  const { data, isLoading } = variant === "platform" ? platformTrend : variant === "apps" ? appsTrend : billingTrend;

  const fmt = formatValue ?? (variant === "platform" ? defaultPlatformFormat : defaultBillingFormat);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

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

  const trendColor = "#FF3621";
  const gradientId = `kpiTrendGradient-${variant}`;

  const formattedStart = format(parseISO(startDate), "MMM d, yyyy");
  const formattedEnd = format(parseISO(endDate), "MMM d, yyyy");

  return createPortal(
    <div
      className="animate-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex min-h-full items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="animate-dialog relative w-full max-w-4xl rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">{kpiLabel}</h2>
            <p className="text-sm text-gray-500">Trend Analysis</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Granularity Tabs */}
          <div className="mb-6 inline-flex rounded-lg bg-gray-100 p-1">
            {(["daily", "monthly"] as const).map((g) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                className={`rounded-md px-4 py-2 text-sm font-medium transition-all ${
                  granularity === g
                    ? "bg-white text-gray-900 shadow-sm"
                    : "text-gray-600 hover:text-gray-900"
                }`}
              >
                {g.charAt(0).toUpperCase() + g.slice(1)}
              </button>
            ))}
          </div>

          {isLoading ? (
            <div className="flex h-80 items-center justify-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-gray-200" style={{ borderTopColor: '#FF3621' }} />
            </div>
          ) : data?.data_points && data.data_points.length > 0 ? (
            <>
              {/* Stats Row */}
              <div className="mb-6 grid grid-cols-4 gap-4">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase text-gray-500">Start</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">
                    {fmt(data.summary.period_start_value, kpi)}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase text-gray-500">End</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">
                    {fmt(data.summary.period_end_value, kpi)}
                  </p>
                </div>
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <p className="text-xs font-medium uppercase text-gray-500">Average</p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">
                    {fmt(data.summary.avg_value, kpi)}
                  </p>
                </div>
                <div
                  className="rounded-lg border p-4"
                  style={{
                    backgroundColor: `${trendColor}10`,
                    borderColor: `${trendColor}30`
                  }}
                >
                  <p className="text-xs font-medium uppercase text-gray-500">Change</p>
                  <p className="mt-1 text-lg font-semibold" style={{ color: trendColor }}>
                    {data.summary.change_percent > 0 ? "+" : ""}
                    {data.summary.change_percent.toFixed(1)}%
                  </p>
                </div>
              </div>

              {/* Chart */}
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.data_points} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#FF3621" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#FF3621" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="date"
                      tickFormatter={(value) => format(parseISO(value), "MMM d")}
                      tick={{ fontSize: 11, fill: "#6b7280" }}
                      axisLine={{ stroke: "#e5e7eb" }}
                    />
                    <YAxis
                      tickFormatter={(value) => fmt(value, kpi)}
                      tick={{ fontSize: 11, fill: "#6b7280" }}
                      axisLine={{ stroke: "#e5e7eb" }}
                      width={60}
                    />
                    <Tooltip
                      formatter={(value: number | undefined) => [fmt(value ?? 0, kpi), kpiLabel]}
                      labelFormatter={(label) => format(parseISO(label), "MMM d, yyyy")}
                      contentStyle={{
                        borderRadius: "8px",
                        border: "1px solid #e5e7eb",
                        boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)"
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke="#FF3621"
                      strokeWidth={2}
                      fill={`url(#${gradientId})`}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Trend Indicator */}
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-gray-50 px-4 py-3">
                {data.summary.trend === "increasing" && (
                  <>
                    <TrendingUp className="h-5 w-5" style={{ color: '#FF3621' }} />
                    <span className="text-sm font-medium text-gray-700">
                      Trending upward by {data.summary.change_percent.toFixed(1)}% from {formattedStart} to {formattedEnd}
                    </span>
                  </>
                )}
                {data.summary.trend === "decreasing" && (
                  <>
                    <TrendingDown className="h-5 w-5" style={{ color: '#FF3621' }} />
                    <span className="text-sm font-medium text-gray-700">
                      Trending downward by {Math.abs(data.summary.change_percent).toFixed(1)}% from {formattedStart} to {formattedEnd}
                    </span>
                  </>
                )}
                {data.summary.trend === "flat" && (
                  <>
                    <Minus className="h-5 w-5" style={{ color: '#FF3621' }} />
                    <span className="text-sm font-medium text-gray-700">
                      Relatively stable (±{Math.abs(data.summary.change_percent).toFixed(1)}%) from {formattedStart} to {formattedEnd}
                    </span>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-64 flex-col items-center justify-center text-gray-500">
              <p className="text-lg font-medium">No data available</p>
              <p className="text-sm">Try selecting a different date range</p>
            </div>
          )}
        </div>
      </div>
      </div>
    </div>,
    document.body
  );
}
