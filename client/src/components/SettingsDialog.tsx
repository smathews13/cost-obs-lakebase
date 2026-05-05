import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingsConfig, SettingsGeneral, SettingsTabs, SettingsExperimental, SettingsAccuracyChecks, SettingsPermissions } from "./settings";

export interface TabVisibility {
  dbu: boolean;
  infra: boolean;
  kpis: boolean;
  aiml: boolean;
  sql: boolean;
  apps: boolean;
  tagging: boolean;
  "use-cases": boolean;
  alerts: boolean;
  "users-groups": boolean;
  forecasting: boolean;
}

const DEFAULT_VISIBILITY: TabVisibility = {
  dbu: true,
  infra: true,
  kpis: true,
  aiml: true,
  sql: true,
  apps: true,
  tagging: true,
  "use-cases": false,
  alerts: false,
  "users-groups": true,
  forecasting: false,
};

const STORAGE_KEY = "coc-tab-visibility";

export function loadTabVisibility(): TabVisibility {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_VISIBILITY, ...JSON.parse(stored) };
    }
  } catch {
    // ignore parse errors
  }
  return DEFAULT_VISIBILITY;
}

function saveTabVisibility(visibility: TabVisibility) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility));
}

// ── App Settings (General tab) ──────────────────────────────────────────
export interface AppSettings {
  defaultDateRangeDays: 7 | 14 | 30 | 60 | 90;
  refreshIntervalMinutes: 0 | 5 | 15 | 30;
  compactMode: boolean;
  companyName: string;
  appDisplayName: string;
  monthlyBudget: number;
  costAllocationTags: string;
  alertSpikePercent: number;
  alertDailyBudget: number;
  alertWorkspaceBudget: number;
  slackWebhookUrl: string;
  enableAppHostingComparison: boolean;
  enableUseCaseTracking: boolean;
  enableAccuracyChecks: boolean;
  enableAIFeatures: boolean;
  enableGenie: boolean;
  genieSpaceId: string;
  enableAlerts: boolean;
  enableForecasting: boolean;
  enableContractTracking: boolean;
  darkMode: boolean;
  anonymizeUsers: boolean;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultDateRangeDays: 30,
  refreshIntervalMinutes: 0,
  compactMode: false,
  companyName: "",
  appDisplayName: "",
  monthlyBudget: 0,
  costAllocationTags: "",
  alertSpikePercent: 20,
  alertDailyBudget: 50000,
  alertWorkspaceBudget: 10000,
  slackWebhookUrl: "",
  enableAppHostingComparison: false,
  enableUseCaseTracking: false,
  enableAccuracyChecks: false,
  enableAIFeatures: true,
  enableGenie: false,
  genieSpaceId: "",
  enableAlerts: false,
  enableForecasting: false,
  enableContractTracking: false,
  darkMode: false,
  anonymizeUsers: false,
};

const APP_SETTINGS_KEY = "coc-app-settings";

export function loadAppSettings(): AppSettings {
  try {
    const stored = localStorage.getItem(APP_SETTINGS_KEY);
    if (stored) {
      return { ...DEFAULT_APP_SETTINGS, ...JSON.parse(stored) };
    }
  } catch {
    // ignore parse errors
  }
  return { ...DEFAULT_APP_SETTINGS };
}

function saveAppSettings(settings: AppSettings) {
  localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
}

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onTabVisibilityChange: (visibility: TabVisibility) => void;
  onSettingsChange: (settings: AppSettings) => void;
  tabVisibility: TabVisibility;
  appSettings: AppSettings;
  onRerunWizard?: () => void;
}

export function SettingsDialog({ isOpen, onClose, onTabVisibilityChange, onSettingsChange, tabVisibility, appSettings, onRerunWizard }: SettingsDialogProps) {
  const [activeSection, setActiveSection] = useState<"tabs" | "general" | "config" | "experimental" | "accuracy-checks" | "permissions">("general");
  const [localVisibility, setLocalVisibility] = useState<TabVisibility>(tabVisibility);
  const [localSettings, setLocalSettings] = useState<AppSettings>(appSettings);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [generalDirty, setGeneralDirty] = useState(false);
  const [pendingWarehouseSwitch, setPendingWarehouseSwitch] = useState<{ id: string; name: string; state: string } | null>(null);
  const queryClient = useQueryClient();

  // ── Queries ──────────────────────────────────────────────────────────
  const { data: appConfig, isLoading: configLoading } = useQuery<{
    warehouse: { id: string; name: string | null; size: string | null; state: string } | null;
    identity: { display_name: string | null; user_name: string | null } | null;
    storage_location: { catalog: string; schema: string } | null;
  }>({
    queryKey: ["app-config"],
    queryFn: async () => {
      const res = await fetch("/api/settings/config");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: isOpen,
  });

  const { data: warehouses = [], isLoading: warehousesLoading } = useQuery<{
    id: string; name: string; size: string | null; state: string; is_current: boolean;
  }[]>({
    queryKey: ["warehouses"],
    queryFn: async () => {
      const res = await fetch("/api/settings/warehouses");
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: isOpen,
  });

  // ── Mutations ────────────────────────────────────────────────────────
  const switchWarehouseMutation = useMutation({
    mutationFn: async (warehouseId: string) => {
      const res = await fetch("/api/settings/warehouse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warehouse_id: warehouseId }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error("Failed to switch warehouse");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["warehouses"], (old: { id: string; name: string; size: string | null; state: string; is_current: boolean }[] | undefined) => {
        if (!Array.isArray(old)) return old;
        return old.map((wh) => ({ ...wh, is_current: wh.id === data.warehouse?.id }));
      });
      queryClient.invalidateQueries({ queryKey: ["app-config"] });
      setPendingWarehouseSwitch(null);
      setSaveStatus(`Switched to warehouse: ${data.warehouse?.name || data.warehouse?.id}${data.warehouse?.state === "STARTING" ? " (starting...)" : ""}`);
      setTimeout(() => setSaveStatus(null), 5000);
    },
    onError: () => {
      setPendingWarehouseSwitch(null);
      setSaveStatus("Failed to switch warehouse");
      setTimeout(() => setSaveStatus(null), 3000);
    },
  });

  // ── Effects ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (isOpen) {
      setLocalVisibility(tabVisibility);
      setLocalSettings(appSettings);
      setGeneralDirty(false);
    }
  }, [isOpen, tabVisibility, appSettings]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  // ── Handlers ─────────────────────────────────────────────────────────
  const toggleTab = (key: keyof TabVisibility) => {
    const updated = { ...localVisibility, [key]: !localVisibility[key] };
    if (Object.values(updated).some(Boolean)) setLocalVisibility(updated);
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
    setGeneralDirty(true);
  };

  const handleSave = () => {
    saveTabVisibility(localVisibility);
    onTabVisibilityChange(localVisibility);
    onClose();
  };

  const handleSaveGeneral = () => {
    saveAppSettings(localSettings);
    onSettingsChange(localSettings);
    setGeneralDirty(false);
    fetch(
      `/api/alerts/setup-databricks-alerts?spike_threshold_percent=${localSettings.alertSpikePercent}&daily_threshold_amount=${localSettings.alertDailyBudget}&workspace_threshold_amount=${localSettings.alertWorkspaceBudget}`,
      { method: "POST", signal: AbortSignal.timeout(10000) }
    ).catch(() => {});
    if (localSettings.slackWebhookUrl !== appSettings.slackWebhookUrl) {
      fetch("/api/settings/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slack_webhook_url: localSettings.slackWebhookUrl }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }
    onClose();
  };

  const visibleCount = Object.values(localVisibility).filter(Boolean).length;

  // ── Render ───────────────────────────────────────────────────────────
  return createPortal(
    <div className="animate-backdrop fixed inset-0 z-50 overflow-y-auto bg-black/30" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex min-h-full items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="animate-dialog relative flex h-[40rem] w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="shrink-0 border-b border-gray-200 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ backgroundColor: '#FF3621' }}>
                  <svg className="h-5 w-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-gray-900">App Settings</h3>
              </div>
              <button onClick={onClose} className="rounded-full p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-500">
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4 flex items-center justify-between">
              <div className="flex flex-wrap gap-1">
                {(["general", "permissions", "config", "experimental", "tabs"] as const).map((section) => (
                  <button
                    key={section}
                    onClick={() => setActiveSection(section)}
                    className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                      activeSection === section ? "text-white" : "text-gray-600 hover:bg-gray-100"
                    }`}
                    style={activeSection === section ? { backgroundColor: '#1B3139' } : {}}
                  >
                    {section === "general" ? "General" : section === "tabs" ? "Visibility" : section === "experimental" ? "Experimental" : section === "permissions" ? "Permissions" : "Configuration"}
                  </button>
                ))}
                {localSettings.enableAccuracyChecks && (
                  <button
                    onClick={() => setActiveSection("accuracy-checks")}
                    className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                      activeSection === "accuracy-checks" ? "text-white" : "text-gray-600 hover:bg-gray-100"
                    }`}
                    style={activeSection === "accuracy-checks" ? { backgroundColor: '#1B3139' } : {}}
                  >
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Accuracy Checks
                  </button>
                )}
              </div>
              <div className="relative group">
                <button
                  onClick={() => {
                    setLocalSettings({ ...DEFAULT_APP_SETTINGS });
                    setLocalVisibility({ ...DEFAULT_VISIBILITY });
                    saveAppSettings({ ...DEFAULT_APP_SETTINGS });
                    saveTabVisibility({ ...DEFAULT_VISIBILITY });
                    onSettingsChange({ ...DEFAULT_APP_SETTINGS });
                    onTabVisibilityChange({ ...DEFAULT_VISIBILITY });
                    localStorage.removeItem("coc-permissions-dont-show-again");
                    setGeneralDirty(false);
                    setSaveStatus("All settings reset to defaults");
                    setTimeout(() => setSaveStatus(null), 3000);
                  }}
                  className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
                >
                  Reset to Default
                </button>
                <div className="pointer-events-none absolute right-0 top-full z-50 mt-2 w-56 rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-200 opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
                  Resets all General settings (date range, refresh, budget, alerts), re-enables all tabs, clears company name, and restores the permissions dialog.
                </div>
              </div>
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {activeSection === "config" && (
              <SettingsConfig
                configLoading={configLoading}
                appConfig={appConfig}
                warehouses={warehouses}
                warehousesLoading={warehousesLoading}
                pendingWarehouseSwitch={pendingWarehouseSwitch}
                setPendingWarehouseSwitch={setPendingWarehouseSwitch}
                switchWarehouseMutation={switchWarehouseMutation}
                saveStatus={saveStatus}
                localSettings={localSettings}
                updateSetting={updateSetting}
              />
            )}
            {activeSection === "general" && (
              <SettingsGeneral
                localSettings={localSettings}
                updateSetting={updateSetting}
                saveStatus={saveStatus}
                setSaveStatus={setSaveStatus}
                onRerunWizard={onRerunWizard}
              />
            )}
            {activeSection === "tabs" && (
              <SettingsTabs
                localVisibility={localVisibility}
                toggleTab={toggleTab}
                visibleCount={visibleCount}
                enableUseCaseTracking={localSettings.enableUseCaseTracking}
                enableAlerts={localSettings.enableAlerts}
                enableForecasting={localSettings.enableForecasting}
              />
            )}
            {activeSection === "experimental" && (
              <SettingsExperimental
                localSettings={localSettings}
                updateSetting={updateSetting}
                saveStatus={saveStatus}
              />
            )}
            {activeSection === "accuracy-checks" && (
              <SettingsAccuracyChecks />
            )}
            {activeSection === "permissions" && (
              <SettingsPermissions />
            )}
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-end gap-3 border-t border-gray-200 px-6 py-4">
            {(activeSection === "general" || activeSection === "tabs" || activeSection === "experimental" || activeSection === "config") && (
              <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                Cancel
              </button>
            )}
            {activeSection === "tabs" && (
              <button
                onClick={handleSave}
                className="btn-brand inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                Save Settings
              </button>
            )}
            {(activeSection === "general" || activeSection === "experimental" || activeSection === "config") && (
              <button
                onClick={handleSaveGeneral}
                disabled={!generalDirty}
                className="btn-brand inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save Settings
              </button>
            )}
            {(activeSection === "accuracy-checks" || activeSection === "permissions") && (
              <button
                onClick={onClose}
                className="btn-brand inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                Done
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
