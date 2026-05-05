import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  Cell, LabelList,
} from "recharts";
import { useUsersGroupsBundle } from "@/hooks/useBillingData";
import { KPITrendModal } from "@/components/KPITrendModal";

function InfoTooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex items-center ml-1">
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        className="text-gray-500 hover:text-gray-600"
        aria-label="More info"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
      {show && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-50 w-56 rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg">
          {text}
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
        </div>
      )}
    </span>
  );
}
import type { UserSpend } from "@/hooks/useBillingData";
import type { DateRange } from "@/types/billing";
import { formatIdentity, isServicePrincipal } from "@/utils/identity";

const COLORS = ["#1B5162", "#06B6D4", "#10B981", "#14B8A6", "#F59E0B", "#06B6D4", "#EC4899", "#EF4444", "#6B7280", "#3B82F6"];

const PRODUCT_COLORS: Record<string, string> = {
  "ETL - Batch": "#1B5162",
  "ETL - Streaming": "#06B6D4",
  "Interactive": "#10B981",
  "SQL": "#14B8A6",
  "Serverless": "#F59E0B",
  "Model Serving": "#06B6D4",
  "Fine-Tuning": "#EC4899",
  "Vector Search": "#EF4444",
  "AI Functions": "#FF3621",
  "Other": "#6B7280",
};

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}


// ── User Detail Modal ─────────────────────────────────────────────────────────

function UserDetailModal({ user, onClose }: { user: UserSpend; onClose: () => void }) {
  const [detail, setDetail] = useState<{ permission_grants: { type: string; value: string }[] } | null>(null);

  useEffect(() => {
    fetch(`/api/users-groups/user-detail/${encodeURIComponent(user.user_email)}`)
      .then(r => r.json())
      .then(d => setDetail(d))
      .catch(() => {});
  }, [user.user_email]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-gray-900 text-sm truncate max-w-75">{formatIdentity(user.user_email)}</h3>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">{user.active_days} active days · {user.workspace_count} workspace{user.workspace_count !== 1 ? "s" : ""}</p>
          </div>
          <button onClick={onClose} className="ml-4 shrink-0 rounded-lg p-1.5 hover:bg-gray-100 text-gray-500">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Total spend</p>
              <p className="text-lg font-bold text-gray-900">{fmt(user.total_spend)}</p>
            </div>
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Share of total</p>
              <p className="text-lg font-bold text-gray-900">{user.percentage.toFixed(1)}%</p>
            </div>
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Total DBUs</p>
              <p className="text-lg font-bold text-gray-900">{user.total_dbus.toFixed(0)}</p>
              <p className="text-xs text-gray-500 mt-0.5">{fmt(user.total_spend)} spend</p>
            </div>
            <div className="rounded-lg border border-gray-100 bg-gray-50 p-3">
              <p className="text-xs text-gray-500">Primary product</p>
              <p className="text-sm font-semibold text-gray-900 mt-1">{user.primary_product}</p>
            </div>
          </div>

          {user.products.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Spend by product</h4>
              <div className="space-y-2">
                {user.products.sort((a, b) => b.spend - a.spend).map(p => {
                  const pct = user.total_spend > 0 ? (p.spend / user.total_spend) * 100 : 0;
                  return (
                    <div key={p.product}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-gray-600">{p.product}</span>
                        <span className="font-medium text-gray-800">{fmt(p.spend)}</span>
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-gray-100">
                        <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, backgroundColor: PRODUCT_COLORS[p.product] || '#999' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Permission grants */}
          {detail?.permission_grants && detail.permission_grants.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Permission grants</h4>
              <div className="flex flex-wrap gap-1.5">
                {detail.permission_grants.map((pg, i) => (
                  <span key={i} className="inline-flex rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">{pg.value}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}


// ── Product Drill-down ────────────────────────────────────────────────────────

function ProductDrilldown({ topUsers }: { topUsers: UserSpend[] }) {
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  const productTotals: Record<string, number> = {};
  topUsers.forEach(u => u.products.forEach(p => {
    productTotals[p.product] = (productTotals[p.product] || 0) + p.spend;
  }));
  const sorted = Object.entries(productTotals).sort((a, b) => b[1] - a[1]);
  const total = sorted.reduce((s, [, v]) => s + v, 0);

  // Top 5 users for the selected product
  const top5 = selectedProduct
    ? topUsers
        .map(u => ({ email: u.user_email, spend: u.products.find(p => p.product === selectedProduct)?.spend ?? 0 }))
        .filter(u => u.spend > 0)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 5)
    : [];

  return (
    <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
      <h3 className="text-lg font-medium text-gray-900 mb-4">User Spend by Product</h3>
      <div className="space-y-2.5 mt-2">
        {sorted.map(([product, spend]) => {
          const pct = total > 0 ? (spend / total) * 100 : 0;
          const isSelected = selectedProduct === product;
          return (
            <div key={product}>
              <button
                className="w-full text-left group"
                onClick={() => setSelectedProduct(isSelected ? null : product)}
              >
                <div className="flex justify-between text-xs mb-1">
                  <span className={`font-medium ${isSelected ? 'text-[#FF3621]' : 'text-gray-600 group-hover:text-gray-900'}`}>
                    {product}
                    <span className="ml-1 text-gray-500 text-[10px]">{isSelected ? '▲' : '▼'}</span>
                  </span>
                  <span className="font-medium text-gray-800">{fmt(spend)} <span className="text-gray-500">({pct.toFixed(1)}%)</span></span>
                </div>
                <div className="h-2 w-full rounded-full bg-gray-100">
                  <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: isSelected ? '#FF3621' : (PRODUCT_COLORS[product] || '#999') }} />
                </div>
              </button>
              {isSelected && top5.length > 0 && (
                <div className="mt-2 mb-1 ml-2 rounded-lg border border-gray-100 bg-gray-50 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 mb-2">Top users — {product}</p>
                  <div className="space-y-1.5">
                    {top5.map((u, i) => (
                      <div key={u.email} className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-gray-500 w-3 shrink-0">{i + 1}.</span>
                          <span className="text-gray-700 truncate">{formatIdentity(u.email)}</span>
                        </div>
                        <span className="ml-3 font-medium text-gray-800 shrink-0">{fmt(u.spend)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ── Main page ─────────────────────────────────────────────────────────────────

interface Props {
  startDate: string;
  endDate: string;
  dateRange: DateRange;
  anonymizeUsers?: boolean;
}

const PAGE_SIZE = 10;

export default function UsersGroups({ startDate, endDate, dateRange, anonymizeUsers = false }: Props) {
  const [selectedUser, setSelectedUser] = useState<UserSpend | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<"spend" | "dbus" | "days">("spend");
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLDivElement>(null);
  const [typeFilter, setTypeFilter] = useState<"all" | "users" | "sps">("all");
  const [typeFilterOpen, setTypeFilterOpen] = useState(false);
  const typeFilterRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const [productFilter, setProductFilter] = useState<string>("all");
  const [productFilterOpen, setProductFilterOpen] = useState(false);
  const productFilterRef = useRef<HTMLDivElement>(null);
  const [selectedKPI, setSelectedKPI] = useState<{kpi: string; label: string; variant?: "billing" | "platform"} | null>(null);
  const [infoMinimized, setInfoMinimized] = useState(() => {
    if (typeof window !== "undefined") return localStorage.getItem("cost-obs-minimize-users-info") === "true";
    return false;
  });
  const handleMinimizeToggle = (v: boolean) => {
    setInfoMinimized(v);
    v ? localStorage.setItem("cost-obs-minimize-users-info", "true") : localStorage.removeItem("cost-obs-minimize-users-info");
  };

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (typeFilterRef.current && !typeFilterRef.current.contains(e.target as Node)) {
        setTypeFilterOpen(false);
      }
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
      if (productFilterRef.current && !productFilterRef.current.contains(e.target as Node)) {
        setProductFilterOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const { data, isLoading } = useUsersGroupsBundle(dateRange);

  const summary = data?.summary;
  const topUsers = data?.top_users ?? [];
  const uniqueProducts = Array.from(new Set(topUsers.map(u => u.primary_product).filter(Boolean))).sort();

  // Stable anon index map: human users sorted by spend get User 1, User 2, …
  const anonMap = new Map<string, string>();
  if (anonymizeUsers) {
    let idx = 0;
    [...topUsers].sort((a, b) => b.total_spend - a.total_spend).forEach(u => {
      if (!isServicePrincipal(u.user_email)) {
        anonMap.set(u.user_email, `User ${idx + 1}`);
        idx++;
      }
    });
  }
  const displayUser = (email: string) =>
    anonymizeUsers && anonMap.has(email) ? anonMap.get(email)! : formatIdentity(email);

  const filtered = topUsers
    .filter(u => {
      if (searchQuery && !u.user_email.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      if (typeFilter === "users" && isServicePrincipal(u.user_email)) return false;
      if (typeFilter === "sps" && !isServicePrincipal(u.user_email)) return false;
      if (productFilter !== "all" && u.primary_product !== productFilter) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortBy === "dbus") return b.total_dbus - a.total_dbus;
      if (sortBy === "days") return b.active_days - a.active_days;
      return b.total_spend - a.total_spend;
    });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Bar chart — top 15 users (always from unfiltered top users)
  // Use raw email as the Recharts category key to avoid duplicate-key issues for SPs
  // Pre-format labels so Recharts category axis shows abbreviated SP names directly
  const seenLabels = new Set<string>();
  const barData = topUsers.slice(0, 15).map(u => {
    let label = displayUser(u.user_email);
    if (seenLabels.has(label)) {
      let n = 2;
      while (seenLabels.has(`${label} (${n})`)) n++;
      label = `${label} (${n})`;
    }
    seenLabels.add(label);
    return { user: label, rawEmail: u.user_email, spend: u.total_spend };
  });

  if (isLoading) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-gray-300" style={{ borderTopColor: '#FF3621' }} />
        <p className="text-sm text-gray-500">Loading user spend data…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg p-2" style={{ backgroundColor: '#FF3621' }}>
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Users</h1>
        </div>
      </div>

      {/* Best Practices Banner */}
      <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
        <div className="flex">
          <div className="flex-shrink-0">
            <svg className="h-5 w-5 text-orange-400" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <div className="ml-3 flex-1">
            <button className="flex w-full items-center justify-between" onClick={() => handleMinimizeToggle(!infoMinimized)}>
              <h3 className="text-sm font-medium text-orange-800">User Spend — Best Practices & Methodology</h3>
              <svg className={`h-4 w-4 text-orange-500 transition-transform ${infoMinimized ? "" : "rotate-180"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {!infoMinimized && (
              <>
                <div className="mt-2 text-sm text-orange-700">
                  <ul className="list-inside list-disc space-y-1">
                    <li><strong>Attribution model</strong>: Spend is attributed via <code>identity_metadata.run_as</code> in <code>system.billing.usage</code> — the user or service principal that triggered the workload.</li>
                    <li><strong>Service principals</strong>: Jobs and automated pipelines run as SPs. High SP spend is normal and expected; focus on human user spend for personal cost governance.</li>
                    <li><strong>Active users</strong>: Distinct identities with any DBU spend in the period — not just SQL query users.</li>
                    <li><strong>Cost governance</strong>: Set per-user spend alerts in the Alerts tab to notify individuals or managers when spend exceeds a threshold.</li>
                    <li><strong>Reducing costs</strong>: Review the top spenders for long-running interactive clusters, idle warehouses, or redundant notebook sessions.</li>
                  </ul>
                </div>
                <div className="mt-3 flex justify-start">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={infoMinimized} onChange={(e) => handleMinimizeToggle(e.target.checked)} className="h-3.5 w-3.5 rounded border-orange-300 text-orange-600 focus:ring-orange-500" />
                    <span className="text-xs text-orange-700">Don't show again</span>
                  </label>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {<>
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {/* Active users */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all" onClick={() => startDate && endDate && setSelectedKPI({kpi: "total_users", label: "Active Users", variant: "platform"})}>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-[#FF3621]">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
            </div>
            <div className="min-w-0">
              <p className="text-sm text-gray-500 flex items-center">
                Active users
                <InfoTooltip text="Distinct users (humans and service principals) with any DBU spend in the selected date range, across all products." />
              </p>
              <p className="text-2xl font-semibold text-gray-900">{summary?.user_count?.toLocaleString() ?? "—"}</p>
              <p className="text-xs text-gray-500">Across all products</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>
        {/* Avg spend / user */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all" onClick={() => startDate && endDate && setSelectedKPI({kpi: "total_spend", label: "Avg Spend / User", variant: "billing"})}>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-[#FF3621]">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
            </div>
            <div className="min-w-0">
              <p className="text-sm text-gray-500 flex items-center">
                Avg spend / user
                <InfoTooltip text="Total list-price spend in the date range divided by the number of distinct active users. Includes all products." />
              </p>
              <p className="text-2xl font-semibold text-gray-900">{summary ? fmt(summary.avg_spend_per_user) : "—"}</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>
        {/* Top spender */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all" onClick={() => startDate && endDate && setSelectedKPI({kpi: "total_users", label: "Active Users Trend", variant: "platform"})}>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-[#FF3621]">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
            </div>
            <div className="min-w-0">
              <p className="text-sm text-gray-500">Top spender</p>
              <p className="text-2xl font-semibold text-gray-900">{topUsers[0] ? fmt(topUsers[0].total_spend) : "—"}</p>
              {topUsers[0] && <p className="text-xs text-gray-500 truncate">{displayUser(topUsers[0].user_email)}</p>}
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>
        {/* Spend growth */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm cursor-pointer hover:shadow-md hover:scale-[1.01] transition-all" onClick={() => startDate && endDate && setSelectedKPI({kpi: "total_spend", label: "Total Spend Trend", variant: "billing"})}>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-orange-100 text-[#FF3621]">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" /></svg>
            </div>
            <div className="min-w-0">
              <p className="text-sm text-gray-500 flex items-center">
                Spend growth
                <InfoTooltip text="Compares total user spend in the first half of the selected date range to the second half. Positive = spend increased over the period." />
              </p>
              {summary?.spend_growth_pct != null ? (
                <p className={`text-2xl font-semibold ${summary.spend_growth_pct >= 0 ? "text-red-600" : "text-green-600"}`}>
                  {summary.spend_growth_pct >= 0 ? "+" : ""}{summary.spend_growth_pct}%
                </p>
              ) : (
                <p className="text-2xl font-semibold text-gray-500">—</p>
              )}
              <p className="text-xs text-gray-500">First vs second half</p>
              <p className="mt-1 text-xs font-medium" style={{ color: '#FF3621' }}>Click to see trend →</p>
            </div>
          </div>
        </div>
      </div>

      {selectedKPI && startDate && endDate && (
        <KPITrendModal
          variant={selectedKPI.variant ?? "billing"}
          kpi={selectedKPI.kpi}
          kpiLabel={selectedKPI.label}
          isOpen={!!selectedKPI}
          onClose={() => setSelectedKPI(null)}
          startDate={startDate}
          endDate={endDate}
        />
      )}

      {/* Charts row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Top users bar chart */}
        <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
          <h3 className="text-lg font-medium text-gray-900 mb-4">Top Users by Spend</h3>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={barData} layout="vertical" margin={{ left: 8, right: 24, top: 0, bottom: 0 }}>
              <XAxis type="number" tickFormatter={v => fmt(v)} stroke="#9ca3af" fontSize={12} tickMargin={8} />
              <YAxis type="category" dataKey="user" width={140} stroke="#9ca3af" fontSize={12} tickMargin={8} interval={0} />
              <Tooltip formatter={(v: number | undefined) => fmt(v ?? 0)} />
              <Bar dataKey="spend" radius={[0, 4, 4, 0]} onClick={(d: unknown) => {
                const rawEmail = (d as { rawEmail?: string }).rawEmail;
                const u = topUsers.find(u => u.user_email === rawEmail);
                if (u) setSelectedUser(u);
              }} style={{ cursor: "pointer" }}>
                {barData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Spend by product */}
        <ProductDrilldown topUsers={topUsers} />
      </div>

      {/* User growth charts — always last 6 months */}
      {data?.user_growth && data.user_growth.length > 1 && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="text-lg font-medium text-gray-900 mb-1 flex items-center">
              Monthly Active Users
              <InfoTooltip text="Distinct users (humans + service principals) with any DBU spend in that calendar month. Always shows the last 6 months regardless of the date filter above." />
            </h3>
            <p className="text-xs text-gray-500 mb-4">Last 6 months</p>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data!.user_growth} margin={{ left: 0, right: 16, top: 20, bottom: 0 }}>
                <XAxis dataKey="month" stroke="#9ca3af" fontSize={12} tickMargin={8} tickFormatter={m => { const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; const parts = m.split("-"); return months[parseInt(parts[1], 10) - 1] || m; }} />
                <YAxis stroke="#9ca3af" fontSize={12} tickMargin={4} allowDecimals={false} />
                <Tooltip labelFormatter={l => String(l)} />
                <Bar dataKey="active_users" name="Active users" fill="#FF3621" radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="active_users" position="top" style={{ fontSize: 10, fill: '#6b7280' }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="rounded-lg bg-white p-6 border " style={{ borderColor: '#E5E5E5' }}>
            <h3 className="text-lg font-medium text-gray-900 mb-1">Monthly User Growth</h3>
            <p className="text-xs text-gray-500 mb-4">New users appearing for the first time each month — last 6 months</p>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data!.user_growth} margin={{ left: 0, right: 16, top: 20, bottom: 0 }}>
                <XAxis dataKey="month" stroke="#9ca3af" fontSize={12} tickMargin={8} tickFormatter={m => { const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; const parts = m.split("-"); return months[parseInt(parts[1], 10) - 1] || m; }} />
                <YAxis stroke="#9ca3af" fontSize={12} tickMargin={4} allowDecimals={false} />
                <Tooltip labelFormatter={l => String(l)} />
                <Bar dataKey="new_users" name="New users" fill="#1B5162" radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="new_users" position="top" style={{ fontSize: 10, fill: '#6b7280' }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* User table */}
      <div className="rounded-xl border border-gray-200 bg-white ">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">All Users by Spend</h2>
          <div className="flex flex-wrap items-center gap-2">
            {/* Type filter */}
            <div className="relative" ref={typeFilterRef}>
              <button
                onClick={() => setTypeFilterOpen(o => !o)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${typeFilter !== "all" ? "border-transparent text-white" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`}
                style={typeFilter !== "all" ? { backgroundColor: '#FF3621' } : {}}
              >
                {typeFilter === "all" ? "Type" : typeFilter === "users" ? "Users" : "Service Principals"}
                {typeFilter !== "all" ? (
                  <span className="opacity-75 hover:opacity-100 ml-0.5 cursor-pointer" onClick={(e) => { e.stopPropagation(); setTypeFilter("all"); setPage(0); }}>×</span>
                ) : (
                  <svg className={`h-3 w-3 text-gray-500 transition-transform ${typeFilterOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                )}
              </button>
              {typeFilterOpen && (
                <div className="absolute left-0 top-full z-10 mt-1 w-44 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                  {(["all", "users", "sps"] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => { setTypeFilter(t); setPage(0); setTypeFilterOpen(false); }}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-xs hover:bg-gray-50 ${typeFilter === t ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700"}`}
                    >
                      <span className="flex items-center gap-2">
                        {typeFilter === t && <span className="h-1.5 w-1.5 rounded-full bg-orange-500 inline-block" />}
                        {t === "all" ? "All" : t === "users" ? "Users" : "Service Principals"}
                      </span>
                      {typeFilter === t && <svg className="h-3.5 w-3.5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Product filter */}
            <div className="relative" ref={productFilterRef}>
              <button
                onClick={() => setProductFilterOpen(o => !o)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${productFilter !== "all" ? "border-transparent text-white" : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"}`}
                style={productFilter !== "all" ? { backgroundColor: '#FF3621' } : {}}
              >
                {productFilter !== "all" ? productFilter : "Product"}
                {productFilter !== "all" ? (
                  <span className="opacity-75 hover:opacity-100 ml-0.5 cursor-pointer" onClick={(e) => { e.stopPropagation(); setProductFilter("all"); setPage(0); }}>×</span>
                ) : (
                  <svg className={`h-3 w-3 text-gray-500 transition-transform ${productFilterOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                )}
              </button>
              {productFilterOpen && (
                <div className="absolute left-0 top-full z-10 mt-1 w-52 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg" style={{ maxHeight: 260 }}>
                  {uniqueProducts.map(p => (
                    <button
                      key={p}
                      onClick={() => { setProductFilter(productFilter === p ? "all" : p); setPage(0); setProductFilterOpen(false); }}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-xs hover:bg-gray-50 ${productFilter === p ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700"}`}
                    >
                      <span className="flex items-center gap-2">
                        {productFilter === p && <span className="h-1.5 w-1.5 rounded-full bg-orange-500 inline-block" />}
                        {p}
                      </span>
                      {productFilter === p && <svg className="h-3.5 w-3.5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Sort */}
            <div className="relative" ref={sortRef}>
              <button
                onClick={() => setSortOpen(o => !o)}
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                {sortBy === "spend" ? "Spend" : sortBy === "dbus" ? "DBUs" : "Active Days"}
                <svg className={`h-3 w-3 text-gray-500 transition-transform ${sortOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
              </button>
              {sortOpen && (
                <div className="absolute left-0 top-full z-10 mt-1 w-36 rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                  {(["spend", "dbus", "days"] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => { setSortBy(s); setPage(0); setSortOpen(false); }}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-xs hover:bg-gray-50 ${sortBy === s ? "bg-orange-50 text-orange-700 font-medium" : "text-gray-700"}`}
                    >
                      <span className="flex items-center gap-2">
                        {sortBy === s && <span className="h-1.5 w-1.5 rounded-full bg-orange-500 inline-block" />}
                        {s === "spend" ? "Spend" : s === "dbus" ? "DBUs" : "Active Days"}
                      </span>
                      {sortBy === s && <svg className="h-3.5 w-3.5 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <input
              type="text"
              placeholder="Search…"
              value={searchQuery}
              onChange={e => { setSearchQuery(e.target.value); setPage(0); }}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-[#FF3621] focus:outline-none w-44"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500">
                <th className="px-5 py-3 text-left font-medium">User</th>
                <th className="px-4 py-3 text-right font-medium">Share</th>
                <th className="px-4 py-3 text-right font-medium">Spend</th>
                <th className="px-4 py-3 text-right font-medium">Active days</th>
                <th className="px-4 py-3 text-left font-medium">Primary product</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {paginated.map((u, i) => {
                const globalIdx = page * PAGE_SIZE + i;
                const sp = isServicePrincipal(u.user_email);
                return (
                  <tr key={u.user_email} className="border-b border-gray-50 hover:bg-gray-50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white text-xs font-semibold" style={{ backgroundColor: COLORS[globalIdx % COLORS.length] }}>
                          {sp ? "SP" : (anonymizeUsers ? (globalIdx + 1).toString() : u.user_email.charAt(0).toUpperCase())}
                        </div>
                        <div className="min-w-0">
                          <span className="text-gray-800 font-medium truncate max-w-55 block">{displayUser(u.user_email)}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="w-16 h-1.5 rounded-full bg-gray-100">
                          <div className="h-1.5 rounded-full" style={{ width: `${Math.min(u.percentage, 100)}%`, backgroundColor: COLORS[globalIdx % COLORS.length] }} />
                        </div>
                        <span className="text-gray-500 text-xs w-10 text-right">{u.percentage.toFixed(1)}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">{fmt(u.total_spend)}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{u.active_days}</td>
                    <td className="px-4 py-3">
                      <span className="rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600">{u.primary_product}</span>
                    </td>
                    <td className="px-4 py-3">
                      <button onClick={() => setSelectedUser(u)} className="text-xs text-gray-500 hover:text-gray-700 underline">
                        Details
                      </button>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-5 py-8 text-center text-sm text-gray-500">
                    {searchQuery || typeFilter !== "all" || productFilter !== "all" ? "No users match your filters." : "No user spend data found for this date range."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-gray-100">
            <span className="text-xs text-gray-500">
              {filtered.length} result{filtered.length !== 1 ? "s" : ""}
            </span>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  ‹ Prev
                </button>
                <span className="px-2 text-xs text-gray-500">{page + 1} / {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next ›
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {selectedUser && (
        <UserDetailModal user={selectedUser} onClose={() => setSelectedUser(null)} />
      )}
      </>}
    </div>
  );
}
