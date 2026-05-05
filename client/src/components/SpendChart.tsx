import { memo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { format, parseISO } from "date-fns";
import type { TimeseriesResponse } from "@/types/billing";
import { formatCurrencyCompact as formatCurrency } from "@/utils/formatters";

interface SpendChartProps {
  data: TimeseriesResponse | undefined;
  isLoading: boolean;
}

const CATEGORY_COLORS: Record<string, string> = {
  "SQL - DBSQL": "#1B5162", // Databricks Navy 600
  "SQL - Genie": "#06B6D4", // Cyan
  SQL: "#1B5162",
  "ETL - Batch": "#10B981", // Emerald
  "ETL - Streaming": "#14B8A6", // Teal
  Interactive: "#F59E0B", // Amber
  Serverless: "#06B6D4", // Violet
  "Model Serving": "#EC4899", // Pink
  Other: "#6B7280", // Gray
};

function formatDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "MMM d");
  } catch {
    return dateStr;
  }
}

export const SpendChart = memo(function SpendChart({ data, isLoading }: SpendChartProps) {
  if (isLoading) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">
          Spend Over Time
        </h3>
        <div className="h-80 animate-pulse rounded" style={{ backgroundColor: '#E5E5E5' }} />
      </div>
    );
  }

  if (!data || data.timeseries.length === 0) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">
          Spend Over Time
        </h3>
        <div className="flex h-80 flex-col items-center justify-center gap-2" style={{ color: '#6B7280' }}>
          <p className="text-base font-medium">No spend data available</p>
          <p className="text-sm">Try adjusting the date range or check that billing data is being collected</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
      <h3 className="mb-4 text-lg font-semibold text-gray-900">Spend Over Time</h3>
      <ResponsiveContainer width="100%" height={320}>
        <AreaChart
          data={data.timeseries}
          margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
        >
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            stroke="#9ca3af"
            fontSize={12}
            tickMargin={8}
          />
          <YAxis
            tickFormatter={formatCurrency}
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
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {data.categories.map((category) => (
            <Area
              key={category}
              type="monotone"
              dataKey={category}
              stackId="1"
              stroke={CATEGORY_COLORS[category] || "#6b7280"}
              fill={CATEGORY_COLORS[category] || "#6b7280"}
              fillOpacity={0.6}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
});
