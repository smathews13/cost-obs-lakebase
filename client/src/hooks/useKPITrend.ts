import { useQuery } from "@tanstack/react-query";

export interface KPITrendDataPoint {
  date: string;
  value: number;
}

export interface KPITrendSummary {
  period_start_value: number;
  period_end_value: number;
  change_amount: number;
  change_percent: number;
  min_value: number;
  max_value: number;
  avg_value: number;
  trend: "increasing" | "decreasing" | "flat";
}

export interface KPITrendResponse {
  kpi: string;
  granularity: string;
  data_points: KPITrendDataPoint[];
  summary: KPITrendSummary;
}

function useTrendQuery(
  queryKeyPrefix: string,
  endpoint: string,
  kpi: string,
  startDate: string,
  endDate: string,
  granularity: string = "daily"
) {
  return useQuery<KPITrendResponse>({
    queryKey: [queryKeyPrefix, kpi, startDate, endDate, granularity],
    queryFn: async () => {
      const params = new URLSearchParams({
        kpi,
        start_date: startDate,
        end_date: endDate,
        granularity,
      });

      const response = await fetch(`/api/billing/${endpoint}?${params}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch KPI trend: ${response.statusText}`);
      }

      return response.json();
    },
    enabled: !!kpi && !!startDate && !!endDate,
    staleTime: 5 * 60 * 1000,
  });
}

export function useKPITrend(
  kpi: string,
  startDate: string,
  endDate: string,
  granularity: string = "daily"
) {
  return useTrendQuery("kpi-trend", "kpi-trend", kpi, startDate, endDate, granularity);
}

export function usePlatformKPITrend(
  kpi: string,
  startDate: string,
  endDate: string,
  granularity: string = "daily"
) {
  return useTrendQuery("platform-kpi-trend", "platform-kpi-trend", kpi, startDate, endDate, granularity);
}

function useAppsTrendQuery(
  kpi: string,
  startDate: string,
  endDate: string,
  granularity: string = "daily"
) {
  return useQuery<KPITrendResponse>({
    queryKey: ["apps-kpi-trend", kpi, startDate, endDate, granularity],
    queryFn: async () => {
      const params = new URLSearchParams({ kpi, start_date: startDate, end_date: endDate, granularity });
      const response = await fetch(`/api/apps/kpi-trend?${params}`);
      if (!response.ok) throw new Error(`Failed to fetch apps KPI trend: ${response.statusText}`);
      return response.json();
    },
    enabled: !!kpi && !!startDate && !!endDate,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAppsKPITrend(
  kpi: string,
  startDate: string,
  endDate: string,
  granularity: string = "daily"
) {
  return useAppsTrendQuery(kpi, startDate, endDate, granularity);
}
