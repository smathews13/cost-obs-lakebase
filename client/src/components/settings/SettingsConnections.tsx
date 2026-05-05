type CloudProvider = "azure" | "aws" | "gcp";

interface CloudConnection {
  id: string;
  name: string;
  provider: CloudProvider;
  tenant_id?: string;
  subscription_id?: string;
  client_id?: string;
  client_secret?: string;
  aws_account_id?: string;
  access_key_id?: string;
  secret_access_key?: string;
  region?: string;
  project_id?: string;
  service_account_key?: string;
  created_at?: string;
}

const PROVIDER_META: Record<CloudProvider, { label: string; color: string; bgClass: string; textClass: string }> = {
  azure: { label: "Azure", color: "#0078D4", bgClass: "bg-blue-100", textClass: "text-blue-600" },
  aws: { label: "AWS", color: "#FF9900", bgClass: "bg-orange-100", textClass: "text-orange-600" },
  gcp: { label: "GCP", color: "#4285F4", bgClass: "bg-sky-100", textClass: "text-sky-600" },
};

interface SettingsConnectionsProps {
  cloudProvider: { provider: CloudProvider; host: string } | undefined;
  connections: CloudConnection[];
  connectionsLoading: boolean;
  addMutation: any;
  deleteMutation: any;
  saveStatus: string | null;
}

export function SettingsConnections({
  cloudProvider,
}: SettingsConnectionsProps) {
  return (
    <div>
      <p className="mb-4 text-sm text-gray-500">
        View your default Databricks workspace connection. External connections to other apps are coming soon.
      </p>

      {/* Default cloud environment connection */}
      <div className="mb-6">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 mb-2">Default Environment</div>
        {cloudProvider ? (
          <div
            className="flex items-center justify-between rounded-lg border-2 border-dashed p-3"
            style={{ borderColor: PROVIDER_META[cloudProvider.provider].color + '60' }}
          >
            <div className="flex items-center gap-3">
              <div className={`flex h-8 w-8 items-center justify-center rounded-md ${PROVIDER_META[cloudProvider.provider].bgClass}`}>
                <svg className={`h-4 w-4 ${PROVIDER_META[cloudProvider.provider].textClass}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
                </svg>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-900">Databricks Workspace</span>
                  <span
                    className="rounded px-1.5 py-0.5 text-xs font-medium"
                    style={{ backgroundColor: PROVIDER_META[cloudProvider.provider].color + '20', color: PROVIDER_META[cloudProvider.provider].color }}
                  >
                    {PROVIDER_META[cloudProvider.provider].label}
                  </span>
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-500">Default</span>
                </div>
                <div className="text-xs text-gray-500 font-mono truncate max-w-md">{cloudProvider.host}</div>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-500">
            No workspace connection detected
          </div>
        )}
      </div>

      {/* External connections - coming soon */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
            </svg>
            <div className="text-xs font-medium uppercase tracking-wider text-gray-500">External Connections</div>
          </div>
          <div className="relative group">
            <button
              disabled
              className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-100 px-3 py-1.5 text-sm font-medium text-gray-500"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Connection
            </button>
            <div className="pointer-events-none absolute right-0 top-full z-50 mt-1 w-52 rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
              External app connections are coming soon.
            </div>
          </div>
        </div>

        <div className="rounded-lg border-2 border-dashed border-gray-200 py-8 text-center">
          <svg className="mx-auto h-8 w-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <p className="mt-2 text-sm font-medium text-gray-500">External connections coming soon</p>
          <p className="text-xs text-gray-300">Connect to other apps and services from here</p>
        </div>
      </div>
    </div>
  );
}
