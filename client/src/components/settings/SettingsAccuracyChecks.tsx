import { useState } from "react";

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "info";
  details: Record<string, unknown>;
}

interface ReconResponse {
  summary: {
    total_checks: number;
    passed: number;
    info: number;
    failed: number;
    status: "healthy" | "issues_detected";
  };
  date_range: { start_date: string; end_date: string };
  checks: CheckResult[];
}

const CHECK_LABELS: Record<string, { label: string; description: string }> = {
  ground_truth: {
    label: "Ground Truth Baseline",
    description: "Confirms billing.usage has data in the date range and calculates the authoritative total spend.",
  },
  product_completeness: {
    label: "Product Category Completeness",
    description: "Sum of spend across all product categories must equal the ground truth total (±0.01%).",
  },
  workspace_completeness: {
    label: "Workspace Completeness",
    description: "Sum of spend across all workspaces must equal the ground truth total (±0.01%).",
  },
  price_coverage: {
    label: "Price Coverage",
    description: "Checks what percentage of DBUs have no matching list price — above 5% is flagged.",
  },
  null_attribution: {
    label: "NULL Attribution Audit",
    description: "Informational: percentage of spend with no cluster, warehouse, job, pipeline, or endpoint attribution.",
  },
  price_uniqueness: {
    label: "Price Uniqueness",
    description: "Each SKU+cloud combination should have exactly one active price in list_prices.",
  },
  sql_attribution: {
    label: "SQL Attribution Accuracy",
    description: "Compares attributed SQL spend against billing totals. A gap is expected — query history doesn't capture idle time, system queries, or metadata operations.",
  },
  query_history_duplicates: {
    label: "Query History Duplicates",
    description: "Checks for duplicate statement_ids in system.query.history — above 1% is flagged.",
  },
  mv_vs_live: {
    label: "Materialized View vs Live",
    description: "Compares daily spend totals between the daily_usage_summary MV and a live query. Today's date may differ due to MV refresh timing. Skipped if MV doesn't exist.",
  },
};

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDollars(n: number): string {
  return "$" + fmt(n);
}

function fmtPct(n: number): string {
  return fmt(n, 4) + "%";
}

function DetailRow({ label, value }: { label: string; value: string | number | boolean }) {
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <span className="text-gray-500">{label}</span>
      <span className="font-mono font-medium text-gray-800">{String(value)}</span>
    </div>
  );
}

function CheckDetails({ name, details }: { name: string; details: Record<string, unknown> }) {
  if (details.error) {
    return <p className="text-xs text-red-600 font-mono">{String(details.error)}</p>;
  }
  if (details.skipped) {
    return <p className="text-xs text-gray-500 italic">{String(details.skipped)}</p>;
  }

  const rows: { label: string; value: string }[] = [];

  if (name === "ground_truth") {
    rows.push(
      { label: "Total Spend", value: fmtDollars(details.total_spend as number) },
      { label: "Total DBUs", value: fmt(details.total_dbus as number) },
      { label: "Total Rows", value: fmt(details.total_rows as number, 0) },
      { label: "Workspaces", value: String(details.workspace_count) },
      { label: "Days in Range", value: String(details.days_in_range) },
    );
  } else if (name === "product_completeness") {
    rows.push(
      { label: "Ground Truth Spend", value: fmtDollars(details.ground_truth_spend as number) },
      { label: "Product Sum Spend", value: fmtDollars(details.product_sum_spend as number) },
      { label: "Difference", value: fmtDollars(details.difference as number) },
      { label: "Difference %", value: fmtPct(details.difference_pct as number) },
    );
    const cats = details.categories as { category: string; spend: number; dbus: number; rows: number }[];
    return (
      <div className="space-y-1">
        {rows.map((r) => <DetailRow key={r.label} label={r.label} value={r.value} />)}
        <div className="mt-2 border-t border-gray-100 pt-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">By Category</p>
          <div className="space-y-0.5">
            {cats.map((c) => (
              <div key={c.category} className="flex items-center justify-between text-xs">
                <span className="text-gray-600">{c.category}</span>
                <span className="font-mono text-gray-700">{fmtDollars(c.spend)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  } else if (name === "workspace_completeness") {
    rows.push(
      { label: "Ground Truth Spend", value: fmtDollars(details.ground_truth_spend as number) },
      { label: "Workspace Sum Spend", value: fmtDollars(details.workspace_sum_spend as number) },
      { label: "Difference", value: fmtDollars(details.difference as number) },
      { label: "Difference %", value: fmtPct(details.difference_pct as number) },
      { label: "Workspace Count", value: String(details.workspace_count) },
    );
  } else if (name === "price_coverage") {
    rows.push(
      { label: "Total Rows", value: fmt(details.total_rows as number, 0) },
      { label: "Priced Rows", value: fmt(details.priced_rows as number, 0) },
      { label: "Unpriced Rows", value: fmt(details.unpriced_rows as number, 0) },
      { label: "Unpriced Row %", value: fmtPct(details.unpriced_row_pct as number) },
      { label: "Total DBUs", value: fmt(details.total_dbus as number) },
      { label: "Unpriced DBUs", value: fmt(details.unpriced_dbus as number) },
      { label: "Unpriced DBU %", value: fmtPct(details.unpriced_dbu_pct as number) },
    );
  } else if (name === "null_attribution") {
    rows.push(
      { label: "Total Rows", value: fmt(details.total_rows as number, 0) },
      { label: "Total Spend", value: fmtDollars(details.total_spend as number) },
      { label: "Unattributed Rows", value: fmt(details.fully_unattributed_rows as number, 0) },
      { label: "Unattributed Spend", value: fmtDollars(details.unattributed_spend as number) },
      { label: "Unattributed %", value: fmtPct(details.unattributed_pct as number) },
    );
  } else if (name === "price_uniqueness") {
    const skus = details.skus as { sku_name: string; cloud: string; active_prices: number; min_price: number; max_price: number }[];
    if (skus.length === 0) {
      return <p className="text-xs text-gray-500">No duplicate SKUs found.</p>;
    }
    return (
      <div className="space-y-1">
        <DetailRow label="Duplicate SKUs" value={String(details.duplicate_price_skus)} />
        <div className="mt-2 border-t border-gray-100 pt-2 space-y-1">
          {skus.map((s) => (
            <div key={s.sku_name + s.cloud} className="text-xs">
              <span className="font-mono text-gray-700">{s.sku_name}</span>
              <span className="ml-1 text-gray-500">({s.cloud})</span>
              <span className="ml-2 text-gray-500">{s.active_prices} prices · ${s.min_price}–${s.max_price}</span>
            </div>
          ))}
        </div>
      </div>
    );
  } else if (name === "sql_attribution") {
    rows.push(
      { label: "Billing Spend", value: fmtDollars(details.billing_spend as number) },
      { label: "Billing DBUs", value: fmt(details.billing_dbus as number) },
      { label: "Attributed Spend", value: fmtDollars(details.attributed_spend as number) },
      { label: "Attributed DBUs", value: fmt(details.attributed_dbus as number) },
      { label: "Difference", value: fmtDollars(details.difference as number) },
      { label: "Difference %", value: fmtPct(details.difference_pct as number) },
    );
  } else if (name === "query_history_duplicates") {
    rows.push(
      { label: "Total Rows", value: fmt(details.total_rows as number, 0) },
      { label: "Unique Statements", value: fmt(details.unique_statements as number, 0) },
      { label: "Duplicate Rows", value: fmt(details.duplicate_rows as number, 0) },
      { label: "Duplicate %", value: fmtPct(details.duplicate_pct as number) },
    );
  } else if (name === "mv_vs_live") {
    rows.push(
      { label: "Dates Compared", value: String(details.total_dates_compared) },
      { label: "Mismatched Dates", value: String(details.mismatched_dates) },
    );
    const mismatches = details.mismatches as { date: string; live_spend: number; mv_spend: number; difference: number }[];
    return (
      <div className="space-y-1">
        {rows.map((r) => <DetailRow key={r.label} label={r.label} value={r.value} />)}
        {mismatches && mismatches.length > 0 && (
          <div className="mt-2 border-t border-gray-100 pt-2 space-y-1">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Mismatches</p>
            {mismatches.map((m) => (
              <div key={m.date} className="flex items-center justify-between text-xs">
                <span className="font-mono text-gray-600">{m.date}</span>
                <span className="text-gray-500">live {fmtDollars(m.live_spend)} · mv {fmtDollars(m.mv_spend)} · diff {fmtDollars(m.difference)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-50">
      {rows.map((r) => <DetailRow key={r.label} label={r.label} value={r.value} />)}
    </div>
  );
}

function CheckCard({ check }: { check: CheckResult }) {
  const [expanded, setExpanded] = useState(false);
  const meta = CHECK_LABELS[check.name] ?? { label: check.name, description: "" };
  const status = check.status;

  const borderColor = status === "pass" ? "border-gray-200" : status === "info" ? "border-amber-200" : "border-red-200";
  const iconBg = status === "pass" ? "bg-green-100" : status === "info" ? "bg-amber-100" : "bg-red-100";
  const badgeCls = status === "pass" ? "bg-green-50 text-green-700" : status === "info" ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700";
  const badgeLabel = status === "pass" ? "Pass" : status === "info" ? "Expected" : "Fail";

  return (
    <div className={`rounded-lg border bg-white ${borderColor}`}>
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Status indicator */}
        <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${iconBg}`}>
          {status === "pass" ? (
            <svg className="h-3.5 w-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          ) : status === "info" ? (
            <svg className="h-3.5 w-3.5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : (
            <svg className="h-3.5 w-3.5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900">{meta.label}</p>
          <p className="mt-0.5 text-xs text-gray-500">{meta.description}</p>
        </div>

        {/* Badge */}
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeCls}`}>
          {badgeLabel}
        </span>

        <svg
          className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3">
          <CheckDetails name={check.name} details={check.details} />
        </div>
      )}
    </div>
  );
}

export function SettingsAccuracyChecks() {
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState<ReconResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runChecks = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/reconciliation/run?start_date=${startDate}&end_date=${endDate}`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      setResult(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Info banner */}
      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3">
        <div className="flex gap-2">
          <svg className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-xs text-blue-700">
            These checks cross-validate cost reporting by comparing spend across different aggregation
            dimensions. Run them after deploying new queries or when numbers look unexpected. The SQL
            attribution and query history checks query <span className="font-mono">system.query.history</span> and may take longer.
          </p>
        </div>
      </div>

      {/* Date range + run */}
      <div className="flex items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-orange-400 focus:outline-none focus:ring-1 focus:ring-orange-400"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">End Date</label>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-orange-400 focus:outline-none focus:ring-1 focus:ring-orange-400"
          />
        </div>
        <button
          onClick={runChecks}
          disabled={running}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-60"
          style={{ backgroundColor: '#1B3139' }}
        >
          {running ? (
            <>
              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Running…
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Run Checks
            </>
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className={`flex items-center justify-between rounded-lg border px-4 py-3 ${result.summary.status === "healthy" ? "border-green-200 bg-green-50" : "border-red-200 bg-red-50"}`}>
            <div className="flex items-center gap-3">
              {result.summary.status === "healthy" ? (
                <svg className="h-5 w-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="h-5 w-5 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              )}
              <div>
                <p className={`text-sm font-semibold ${result.summary.status === "healthy" ? "text-green-800" : "text-red-800"}`}>
                  {result.summary.status === "healthy"
                    ? (result.summary.info > 0
                      ? `All checks passed · ${result.summary.info} expected`
                      : "All checks passed")
                    : `${result.summary.failed} check${result.summary.failed !== 1 ? "s" : ""} failed`}
                </p>
                <p className="text-xs text-gray-500">{result?.date_range?.start_date || "—"} → {result?.date_range?.end_date || "—"}</p>
              </div>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-green-700"><span className="font-bold">{result.summary.passed}</span> passed</span>
              {result.summary.info > 0 && <span className="text-amber-700"><span className="font-bold">{result.summary.info}</span> expected</span>}
              {result.summary.failed > 0 && <span className="text-red-700"><span className="font-bold">{result.summary.failed}</span> failed</span>}
              <span className="text-gray-500">{result.summary.total_checks} total</span>
            </div>
          </div>

          {/* Check cards */}
          <div className="space-y-2">
            {result.checks.map((check) => (
              <CheckCard key={check.name} check={check} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
