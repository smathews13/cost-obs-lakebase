import { formatCurrency } from "@/utils/formatters";

interface ForecastingViewProps {
  startDate: string;
  endDate: string;
}

// Placeholder data for wireframe
const MOCK_FORECAST = {
  currentMonthSpend: 142850,
  projectedMonthEnd: 178560,
  nextMonthForecast: 185200,
  confidenceInterval: { low: 165800, high: 204600 },
  trend: "increasing" as const,
  trendPercent: 3.7,
  topGrowthDrivers: [
    { category: "Jobs Compute", currentSpend: 52400, projectedSpend: 58100, growth: 10.9 },
    { category: "SQL Warehouses", currentSpend: 38200, projectedSpend: 41500, growth: 8.6 },
    { category: "Model Serving", currentSpend: 18600, projectedSpend: 22300, growth: 19.9 },
    { category: "All-Purpose Compute", currentSpend: 24100, projectedSpend: 24800, growth: 2.9 },
    { category: "SDP Pipelines", currentSpend: 9550, projectedSpend: 9860, growth: 3.2 },
  ],
  monthlyHistory: [
    { month: "Oct 2025", actual: 148200, forecast: null },
    { month: "Nov 2025", actual: 155600, forecast: null },
    { month: "Dec 2025", actual: 151300, forecast: null },
    { month: "Jan 2026", actual: 162400, forecast: null },
    { month: "Feb 2026", actual: 171900, forecast: null },
    { month: "Mar 2026", actual: 142850, forecast: 178560 },
    { month: "Apr 2026", actual: null, forecast: 185200 },
    { month: "May 2026", actual: null, forecast: 191400 },
  ],
};

export function ForecastingView(_props: ForecastingViewProps) {
  const data = MOCK_FORECAST;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg p-2 bg-indigo-600">
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cost Forecasting</h1>
          <p className="text-sm text-gray-500">Projected consumption based on historical usage patterns</p>
        </div>
      </div>

      {/* Preview Banner */}
      <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3">
        <div className="flex items-center gap-2">
          <svg className="h-5 w-5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
          </svg>
          <div>
            <span className="text-sm font-medium text-indigo-800">Experimental Preview</span>
            <span className="ml-2 text-sm text-indigo-600">
              Forecasting models are being calibrated. Displayed values use sample data for demonstration.
            </span>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border bg-white p-5 " style={{ borderColor: '#E5E5E5' }}>
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Current Month (MTD)</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{formatCurrency(data.currentMonthSpend)}</p>
          <p className="mt-1 text-xs text-gray-500">through today</p>
        </div>
        <div className="rounded-lg border bg-white p-5 " style={{ borderColor: '#E5E5E5' }}>
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Projected Month-End</p>
          <p className="mt-2 text-2xl font-bold text-indigo-600">{formatCurrency(data.projectedMonthEnd)}</p>
          <p className="mt-1 text-xs text-gray-500">estimated total for this month</p>
        </div>
        <div className="rounded-lg border bg-white p-5 " style={{ borderColor: '#E5E5E5' }}>
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Next Month Forecast</p>
          <p className="mt-2 text-2xl font-bold text-gray-900">{formatCurrency(data.nextMonthForecast)}</p>
          <p className="mt-1 text-xs text-gray-500">
            {formatCurrency(data.confidenceInterval.low)} – {formatCurrency(data.confidenceInterval.high)}
          </p>
        </div>
        <div className="rounded-lg border bg-white p-5 " style={{ borderColor: '#E5E5E5' }}>
          <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Trend</p>
          <div className="mt-2 flex items-baseline gap-2">
            <p className="text-2xl font-bold text-amber-600">+{data.trendPercent}%</p>
            <svg className="h-5 w-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <p className="mt-1 text-xs text-gray-500">month-over-month growth</p>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Forecast Chart Placeholder */}
        <div className="rounded-lg border bg-white p-6 " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Monthly Spend Forecast</h3>
          <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-gray-200 bg-gray-50">
            <svg className="h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
            </svg>
            <p className="text-sm font-medium text-gray-500">Time-series forecast chart</p>
            <p className="text-xs text-gray-500">Actual spend vs. projected with confidence bands</p>
            {/* Mini mockup of chart data */}
            <div className="mt-2 flex items-end gap-1">
              {data.monthlyHistory.map((m) => (
                <div key={m.month} className="flex flex-col items-center gap-0.5">
                  <div
                    className={`w-6 rounded-t ${m.actual !== null ? 'bg-indigo-400' : 'bg-indigo-200 border border-dashed border-indigo-300'}`}
                    style={{ height: `${((m.actual || m.forecast || 0) / 200000) * 80 + 20}px` }}
                  />
                  <span className="text-[9px] text-gray-500">{m.month.split(' ')[0].slice(0, 3)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Spend by Category Forecast */}
        <div className="rounded-lg border bg-white p-6 " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="mb-4 text-lg font-semibold text-gray-900">Category Growth Forecast</h3>
          <div className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-gray-200 bg-gray-50">
            <svg className="h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
            </svg>
            <p className="text-sm font-medium text-gray-500">Category breakdown with projections</p>
            <p className="text-xs text-gray-500">Side-by-side current vs. forecasted allocation</p>
          </div>
        </div>
      </div>

      {/* Growth Drivers Table */}
      <div className="rounded-lg border bg-white p-6 " style={{ borderColor: '#E5E5E5' }}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">Top Growth Drivers</h3>
        <p className="mb-4 text-sm text-gray-500">Categories contributing most to projected cost increases</p>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-gray-50">
              <tr className="border-b border-gray-200">
                <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Category</th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Current Spend</th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Projected Spend</th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Growth</th>
                <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {data.topGrowthDrivers.map((driver) => (
                <tr key={driver.category} className="hover:bg-gray-50">
                  <td className="px-3 py-3 text-sm font-medium text-gray-900">{driver.category}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-600">
                    {formatCurrency(driver.currentSpend)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-medium text-indigo-600">
                    {formatCurrency(driver.projectedSpend)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm">
                    <span className={`font-medium ${driver.growth > 10 ? 'text-red-600' : driver.growth > 5 ? 'text-amber-600' : 'text-green-600'}`}>
                      +{driver.growth}%
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-2 w-20 overflow-hidden rounded-full bg-gray-200">
                        <div
                          className={`h-full rounded-full ${driver.growth > 10 ? 'bg-red-400' : driver.growth > 5 ? 'bg-amber-400' : 'bg-green-400'}`}
                          style={{ width: `${Math.min(driver.growth * 5, 100)}%` }}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Query Origin Attribution */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="mb-3 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700">
            Experimental
          </span>
          <h3 className="text-base font-semibold text-gray-900">Query Origin Attribution</h3>
        </div>
        <p className="mb-4 text-sm text-gray-500">
          Break down SQL warehouse queries by origin — Human, Genie, MCP/AI tool, and Service Principal — with daily spend timeseries and per-warehouse attribution.
        </p>
        <div className="rounded-lg border-2 border-dashed border-gray-200 bg-gray-50 p-6 text-center">
          <svg className="mx-auto mb-3 h-10 w-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p className="text-sm font-medium text-gray-500">Under development</p>
          <p className="mt-1 text-xs text-gray-500">
            Requires <code className="rounded bg-gray-100 px-1">system.query.history</code> access and the <code className="rounded bg-gray-100 px-1">dbsql_cost_per_query</code> materialized view.
          </p>
        </div>
      </div>

      {/* Budget Scenarios */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-white p-5 " style={{ borderColor: '#E5E5E5' }}>
          <div className="flex items-center gap-2 mb-3">
            <div className="h-3 w-3 rounded-full bg-green-400" />
            <h4 className="text-sm font-semibold text-gray-900">Optimistic</h4>
          </div>
          <p className="text-2xl font-bold text-green-600">{formatCurrency(data.confidenceInterval.low)}</p>
          <p className="mt-1 text-xs text-gray-500">Assumes reduced weekend/off-hours usage and better autoscaling</p>
        </div>
        <div className="rounded-lg border-2 border-indigo-200 bg-indigo-50 p-5 ">
          <div className="flex items-center gap-2 mb-3">
            <div className="h-3 w-3 rounded-full bg-indigo-400" />
            <h4 className="text-sm font-semibold text-gray-900">Most Likely</h4>
          </div>
          <p className="text-2xl font-bold text-indigo-600">{formatCurrency(data.nextMonthForecast)}</p>
          <p className="mt-1 text-xs text-gray-500">Based on trailing 90-day weighted moving average</p>
        </div>
        <div className="rounded-lg border bg-white p-5 " style={{ borderColor: '#E5E5E5' }}>
          <div className="flex items-center gap-2 mb-3">
            <div className="h-3 w-3 rounded-full bg-red-400" />
            <h4 className="text-sm font-semibold text-gray-900">Pessimistic</h4>
          </div>
          <p className="text-2xl font-bold text-red-600">{formatCurrency(data.confidenceInterval.high)}</p>
          <p className="mt-1 text-xs text-gray-500">Accounts for spike events and unoptimized new workloads</p>
        </div>
      </div>
    </div>
  );
}
