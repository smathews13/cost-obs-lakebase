import { useState, Fragment, type ReactElement } from "react";
import { format, parseISO } from "date-fns";
import DOMPurify from "dompurify";
import type { SpendAnomaliesResponse } from "@/types/billing";
import { formatCurrency } from "@/utils/formatters";

interface SpendAnomaliesProps {
  data: SpendAnomaliesResponse | undefined;
  isLoading: boolean;
  enableAIFeatures?: boolean;
}

function parseMarkdown(text: string): ReactElement {
  // Split into lines for processing
  const lines = text.split('\n');
  const elements: ReactElement[] = [];
  let bulletPoints: string[] = [];

  const flushBulletPoints = () => {
    if (bulletPoints.length > 0) {
      elements.push(
        <ul key={`ul-${elements.length}`} className="list-disc list-inside space-y-1 my-2">
          {bulletPoints.map((point, idx) => (
            <li key={idx} dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(point) }} />
          ))}
        </ul>
      );
      bulletPoints = [];
    }
  };

  const formatInlineMarkdown = (line: string): string => {
    // Convert **bold** to <strong>, then sanitize to prevent XSS
    const html = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    return DOMPurify.sanitize(html);
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    // Handle bullet points (lines starting with - or *)
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      bulletPoints.push(trimmed.substring(2));
    } else {
      // Flush any pending bullet points
      flushBulletPoints();

      // Handle regular paragraphs
      if (trimmed) {
        elements.push(
          <p key={`p-${idx}`} className="mb-2" dangerouslySetInnerHTML={{ __html: formatInlineMarkdown(trimmed) }} />
        );
      }
    }
  });

  // Flush any remaining bullet points
  flushBulletPoints();

  return <div className="space-y-1">{elements}</div>;
}

export function SpendAnomalies({ data, isLoading, enableAIFeatures = true }: SpendAnomaliesProps) {
  const [, setAnalyzingDate] = useState<string | null>(null);
  const [analysisResults, setAnalysisResults] = useState<Record<string, { loading: boolean; response: string | null; error: string | null }>>({});
  const [collapsedAnalyses, setCollapsedAnalyses] = useState<Record<string, boolean>>({});
  const [dateSearch, setDateSearch] = useState("");

  const analyzeAnomaly = async (anomaly: SpendAnomaliesResponse['anomalies'][0]) => {
    setAnalyzingDate(anomaly.usage_date);
    setAnalysisResults((prev) => ({
      ...prev,
      [anomaly.usage_date]: { loading: true, response: null, error: null },
    }));

    try {
      const response = await fetch("/api/genie/analyze-anomaly", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usage_date: anomaly.usage_date,
          daily_spend: anomaly.daily_spend,
          prev_day_spend: anomaly.prev_day_spend,
          change_amount: anomaly.change_amount,
          change_percent: anomaly.change_percent,
        }),
      });

      const result = await response.json();

      if (result.status === "completed") {
        const responseText = result.response
          || (result.sql ? "Analysis completed. Genie ran a query but did not return a text summary." : null);
        if (responseText) {
          setAnalysisResults((prev) => ({
            ...prev,
            [anomaly.usage_date]: { loading: false, response: responseText, error: null },
          }));
        } else {
          setAnalysisResults((prev) => ({
            ...prev,
            [anomaly.usage_date]: { loading: false, response: null, error: "Analysis completed but no results were returned" },
          }));
        }
      } else if (result.error) {
        setAnalysisResults((prev) => ({
          ...prev,
          [anomaly.usage_date]: { loading: false, response: null, error: result.error },
        }));
      } else {
        setAnalysisResults((prev) => ({
          ...prev,
          [anomaly.usage_date]: { loading: false, response: null, error: `Analysis returned status: ${result.status || "unknown"}` },
        }));
      }
    } catch (error) {
      setAnalysisResults((prev) => ({
        ...prev,
        [anomaly.usage_date]: { loading: false, response: null, error: "Failed to analyze anomaly" },
      }));
    } finally {
      setAnalyzingDate(null);
    }
  };

  if (isLoading) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <div className="flex h-48 flex-col items-center justify-center gap-3">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
          <p className="text-sm text-gray-500">Loading spend anomalies...</p>
        </div>
      </div>
    );
  }

  if (!data || data.anomalies.length === 0) {
    return (
      <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
        <h3 className="mb-4 text-lg font-semibold text-gray-900">
          Largest Spend Changes
        </h3>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-gray-500">
          <p className="text-base font-medium">No significant spend changes detected</p>
          <p className="text-sm">This is good news -- spending has been stable over the selected period</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Largest Spend Changes</h3>
          <p className="text-sm text-gray-500">
            Top {data.anomalies.length} days with biggest day-over-day spend changes
          </p>
        </div>
        <input
          type="text"
          placeholder="Search date..."
          value={dateSearch}
          onChange={(e) => setDateSearch(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 placeholder-gray-400 focus:border-orange-500 focus:ring-1 focus:ring-orange-500 w-44"
        />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead className="bg-gray-50">
            <tr className="border-b border-gray-200">
              <th className="px-3 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                Date
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Daily Spend
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Previous Day
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Change $
              </th>
              <th className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">
                Change %
              </th>
              {enableAIFeatures && (
                <th className="px-3 py-3 text-center text-xs font-medium uppercase tracking-wider text-gray-500">
                  AI Analysis
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {data.anomalies.filter((a) => {
              if (!dateSearch) return true;
              const searchLower = dateSearch.toLowerCase();
              const formatted = format(parseISO(a.usage_date), "MMM d, yyyy").toLowerCase();
              return formatted.includes(searchLower) || a.usage_date.includes(searchLower);
            }).map((anomaly, idx) => {
              // Color scheme: Red = cost increase (higher cost = bad), Green = cost decrease (lower cost = good)
              const isCostIncrease = anomaly.change_amount > 0;
              const absChangePercent = Math.abs(anomaly.change_percent);
              const analysis = analysisResults[anomaly.usage_date];

              return (
                <Fragment key={`${anomaly.usage_date}-${idx}`}>
                <tr className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-3 py-3 text-sm font-medium text-gray-900">
                    {format(parseISO(anomaly.usage_date), "MMM d, yyyy")}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-900">
                    {formatCurrency(anomaly.daily_spend)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm text-gray-600">
                    {formatCurrency(anomaly.prev_day_spend)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm font-medium">
                    <span className={isCostIncrease ? "text-red-600" : "text-green-600"}>
                      {isCostIncrease ? "+" : ""}
                      {formatCurrency(anomaly.change_amount)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-right text-sm">
                    <div className="flex items-center justify-end gap-2">
                      <div className="flex items-center gap-1">
                        {isCostIncrease ? (
                          <svg className="h-4 w-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                          </svg>
                        ) : (
                          <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                          </svg>
                        )}
                        <span className={`font-medium ${isCostIncrease ? "text-red-600" : "text-green-600"}`}>
                          {absChangePercent.toFixed(1)}%
                        </span>
                      </div>
                    </div>
                  </td>
                  {enableAIFeatures && <td className="whitespace-nowrap px-3 py-3 text-center">
                    {analysis?.loading ? (
                      <div className="inline-flex flex-col items-center gap-1">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-600">
                          <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Analyzing spend change...
                        </span>
                        <span className="text-[10px] text-gray-500">This can take a few minutes</span>
                      </div>
                    ) : analysis && (analysis.response || analysis.error) ? (
                      <button
                        onClick={() => setCollapsedAnalyses((prev) => ({ ...prev, [anomaly.usage_date]: !prev[anomaly.usage_date] }))}
                        className="inline-flex items-center gap-1 text-xs text-green-600 hover:text-green-800 transition-colors"
                      >
                        <span>✓ Analyzed</span>
                        <svg className={`h-3 w-3 transition-transform ${collapsedAnalyses[anomaly.usage_date] ? '' : 'rotate-180'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        onClick={() => analyzeAnomaly(anomaly)}
                        className="btn-brand inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-white transition-colors"
                      >
                        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                        </svg>
                        Analyze
                      </button>
                    )}
                  </td>}
                </tr>
                {enableAIFeatures && analysis && !analysis.loading && (analysis.response || analysis.error) && !collapsedAnalyses[anomaly.usage_date] && (
                  <tr className="bg-orange-50/30">
                    <td colSpan={6} className="px-3 py-4">
                      <div className="rounded-lg bg-white p-4 shadow-sm">
                        <div className="flex items-start gap-2">
                          <svg className="h-5 w-5 flex-shrink-0 text-orange-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                          </svg>
                          <div className="flex-1">
                            <h4 className="text-sm font-semibold text-gray-900 mb-2">AI Analysis</h4>
                            {analysis.error ? (
                              <p className="text-sm text-red-600">{analysis.error}</p>
                            ) : (
                              <div className="text-sm text-gray-700">{parseMarkdown(analysis.response || '')}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
