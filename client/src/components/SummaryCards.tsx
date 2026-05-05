import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BillingSummary } from "@/types/billing";
import { formatCurrency, formatNumber } from "@/utils/formatters";
import { KPITrendModal } from "./KPITrendModal";

interface SummaryCardsProps {
  data: BillingSummary | undefined;
  isLoading: boolean;
  startDate?: string;
  endDate?: string;
}

interface CardProps {
  title: string;
  value: string;
  subtitle?: string;
  icon: React.ReactNode;
  isLoading: boolean;
  onClick?: () => void;
}

function Card({ title, value, subtitle, icon, isLoading, onClick }: CardProps) {
  return (
    <div
      className={`rounded-lg bg-white p-6 border shadow-sm transition-all ${
        onClick ? "cursor-pointer hover:shadow-md hover:scale-[1.01]" : ""
      }`}
      style={{ borderColor: '#E5E5E5' }}
      onClick={onClick}
    >
      <div className="flex items-center">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100">
          {icon}
        </div>
        <div className="ml-4 flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-500">{title}</p>
          {isLoading ? (
            <div className="mt-1 h-7 w-20 animate-pulse rounded bg-gray-200" />
          ) : (
            <p className="mt-1 text-2xl font-semibold text-gray-900">{value}</p>
          )}
          {subtitle && <p className="mt-0.5 text-sm text-gray-500">{subtitle}</p>}
          {onClick && (
            <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
          )}
        </div>
      </div>
    </div>
  );
}

type KPIType = "total_spend" | "total_dbus" | "avg_daily_spend" | "workspace_count";

const KPI_TREND_KEYS: KPIType[] = ["total_spend", "total_dbus", "avg_daily_spend", "workspace_count"];

export function SummaryCards({ data, isLoading, startDate, endDate }: SummaryCardsProps) {
  const queryClient = useQueryClient();
  const [selectedKPI, setSelectedKPI] = useState<{
    kpi: KPIType;
    label: string;
  } | null>(null);

  // Pre-warm trend data in the background once dates are available
  useEffect(() => {
    if (!startDate || !endDate) return;
    for (const kpi of KPI_TREND_KEYS) {
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

  const handleCardClick = (kpi: KPIType, label: string) => {
    if (startDate && endDate) {
      setSelectedKPI({ kpi, label });
    }
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          title="Total Spend"
          value={formatCurrency(data?.total_spend ?? 0)}
          subtitle={data?.days_in_range != null ? `${data.days_in_range} days` : undefined}
          isLoading={isLoading}
          onClick={() => handleCardClick("total_spend", "Total Spend")}
          icon={
            <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <Card
          title="Total DBUs"
          value={formatNumber(data?.total_dbus ?? 0)}
          subtitle="Databricks Units consumed"
          isLoading={isLoading}
          onClick={() => handleCardClick("total_dbus", "Total DBUs")}
          icon={
            <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          }
        />
        <Card
          title="Avg Daily Spend"
          value={formatCurrency(data?.avg_daily_spend ?? 0)}
          subtitle="Per day average"
          isLoading={isLoading}
          onClick={() => handleCardClick("avg_daily_spend", "Average Daily Spend")}
          icon={
            <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          }
        />
        <Card
          title="Workspaces"
          value={String(data?.workspace_count ?? 0)}
          subtitle="Active workspaces"
          isLoading={isLoading}
          onClick={() => handleCardClick("workspace_count", "Active Workspaces")}
          icon={
            <svg className="h-6 w-6 text-[#FF3621]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          }
        />
      </div>

      {selectedKPI && startDate && endDate && (
        <KPITrendModal
          kpi={selectedKPI.kpi}
          kpiLabel={selectedKPI.label}
          isOpen={!!selectedKPI}
          onClose={() => setSelectedKPI(null)}
          startDate={startDate}
          endDate={endDate}
        />
      )}
    </>
  );
}
