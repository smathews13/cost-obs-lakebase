/**
 * Shared formatting utilities for consistent number and currency display
 * across all components. This prevents duplicate implementations and ensures
 * a unified formatting style throughout the application.
 */

/**
 * Format a number as USD currency
 * @param value - The numeric value to format
 * @param decimals - Number of decimal places (default: 0)
 * @returns Formatted currency string (e.g., "$1,234,567")
 */
export function formatCurrency(value: number, decimals: number = 0): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Format currency in compact form (e.g., "$1.2M", "$5K") for chart axes/labels.
 */
export function formatCurrencyCompact(value: number): string {
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toFixed(0)}`;
}

/**
 * Format a number with K/M/B suffixes for large numbers
 * @param value - The numeric value to format
 * @returns Formatted string with appropriate suffix (e.g., "1.2M", "5.3K")
 */
export function formatNumber(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  return value.toFixed(0);
}

/**
 * Format a percentage value
 * @param value - The percentage value (e.g., 25.5 for 25.5%)
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted percentage string (e.g., "25.5%")
 */
export function formatPercent(value: number, decimals: number = 1): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Format bytes as human-readable size
 * @param bytes - The byte count to format
 * @returns Formatted string with appropriate unit (e.g., "1.5 GB")
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000_000) {
    return `${(bytes / 1_000_000_000_000).toFixed(1)} TB`;
  }
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Format a duration in milliseconds as human-readable string
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string (e.g., "2h 30m", "45s")
 */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/**
 * Format a duration given in seconds as a human-readable string.
 * Used for platform KPIs like total_compute_seconds.
 */
export function formatDurationSeconds(seconds: number): string {
  const hours = seconds / 3600;
  if (hours >= 24) return `${(hours / 24).toFixed(1)} days`;
  if (hours >= 1) return `${hours.toFixed(1)} hours`;
  const minutes = seconds / 60;
  if (minutes >= 1) return `${minutes.toFixed(1)} min`;
  return `${seconds.toFixed(0)} sec`;
}

/**
 * Format compute seconds in compact form for chart axes.
 */
export function formatComputeSecondsCompact(value: number): string {
  const hours = value / 3600;
  if (hours >= 24) return `${(hours / 24).toFixed(1)}d`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  const minutes = value / 60;
  if (minutes >= 1) return `${minutes.toFixed(1)}m`;
  return `${value.toFixed(0)}s`;
}

/**
 * Build an absolute URL to a Databricks workspace resource.
 * Ensures the host always has the https:// protocol so browsers don't
 * resolve it as a relative path (which breaks inside Databricks Apps
 * where the page origin is *.databricksapps.com).
 *
 * @param host - Workspace hostname (with or without protocol)
 * @param path - Resource path (e.g., "/browse", "/compute/clusters/abc")
 * @returns Absolute URL or null if host is missing
 */
export function workspaceUrl(host: string | null | undefined, path: string): string | null {
  if (!host) return null;
  const normalized = host.startsWith("http://") || host.startsWith("https://")
    ? host.replace(/\/+$/, "")
    : `https://${host.replace(/\/+$/, "")}`;
  return `${normalized}${path.startsWith("/") ? "" : "/"}${path}`;
}
