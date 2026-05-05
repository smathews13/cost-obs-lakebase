interface StatusIndicatorProps {
  status: string | null | undefined;
  type?: "cluster" | "job" | "pipeline";
}

export function StatusIndicator({ status }: StatusIndicatorProps) {
  if (!status) return null;

  // Different colors for different states
  const getStatusColor = () => {
    if (status === "RUNNING") return "bg-green-500";
    if (status === "PENDING" || status === "RESTARTING" || status === "RESIZING")
      return "bg-yellow-500";
    if (status === "TERMINATED" || status === "TERMINATING") return "bg-gray-400";
    if (status === "ERROR" || status === "FAILED") return "bg-red-500";
    return "bg-gray-300";
  };

  return (
    <div className="inline-flex items-center gap-1.5">
      <div className={`h-2 w-2 rounded-full ${getStatusColor()}`} title={status} />
      <span className="text-xs text-gray-600">{status}</span>
    </div>
  );
}
