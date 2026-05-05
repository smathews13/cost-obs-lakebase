export interface BillingSummary {
  total_dbus: number;
  total_spend: number;
  workspace_count: number;
  days_in_range: number;
  avg_daily_spend: number;
  start_date: string;
  end_date: string;
  first_date: string | null;
  last_date: string | null;
}

export interface ProductBreakdown {
  category: string;
  total_dbus: number;
  total_spend: number;
  workspace_count: number;
  percentage: number;
}

export interface ProductBreakdownResponse {
  products: ProductBreakdown[];
  total_spend: number;
  start_date: string;
  end_date: string;
}

export interface WorkspaceBreakdown {
  workspace_id: string;
  workspace_name: string | null;
  total_dbus: number;
  total_spend: number;
  percentage: number;
  top_products: string[];
  top_users: string[];
}

export interface WorkspaceBreakdownResponse {
  workspaces: WorkspaceBreakdown[];
  total_spend: number;
  start_date: string;
  end_date: string;
}

export interface TimeseriesDataPoint {
  date: string;
  [category: string]: string | number;
}

export interface TimeseriesResponse {
  timeseries: TimeseriesDataPoint[];
  categories: string[];
  start_date: string;
  end_date: string;
}

export interface GranularProduct {
  product: string;
  total_dbus: number;
  total_spend: number;
  percentage: number;
}

export interface GranularBreakdownResponse {
  products: GranularProduct[];
  total_spend: number;
  start_date: string;
  end_date: string;
  error?: string;
}

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface AccountInfo {
  account_id: string | null;
  account_name: string | null;
  cloud: string | null;
  host: string | null;
  error?: string;
}

export interface PipelineObject {
  object_type: string;
  object_id: string;
  object_name: string;
  owner: string | null;
  workspace_id: string;
  object_state: string | null;
  total_dbus: number;
  total_spend: number;
  total_runs: number;
  percentage: number;
}

export interface PipelineObjectsResponse {
  objects: PipelineObject[];
  total_spend: number;
  start_date: string;
  end_date: string;
  error?: string;
}

export interface InteractiveItem {
  cluster_id: string | null;
  cluster_name: string | null;
  notebook_path: string | null;
  user: string | null;
  workspace_id: string;
  cluster_state: string | null;
  total_dbus: number;
  total_spend: number;
  days_active: number;
  notebook_count: number;
  percentage: number;
}

export interface InteractiveBreakdownResponse {
  items: InteractiveItem[];
  total_spend: number;
  start_date: string;
  end_date: string;
  error?: string;
}

export interface AWSClusterCost {
  cluster_id: string | null;
  cluster_name: string | null;
  driver_instance_type: string | null;
  worker_instance_type: string | null;
  cluster_source: string | null;
  workspace_id: string;
  state: string | null;
  total_dbu_hours: number;
  estimated_aws_cost: number;
  days_active: number;
  percentage: number;
}

export interface AWSInstanceFamily {
  instance_family: string;
  total_dbu_hours: number;
  days_active: number;
}

export interface AWSCostsResponse {
  clusters: AWSClusterCost[];
  instance_families: AWSInstanceFamily[];
  total_estimated_cost: number;
  total_dbu_hours: number;
  start_date: string;
  end_date: string;
  disclaimer?: string;
  error?: string;
}

// Multi-cloud infrastructure cost types
export interface InfraClusterCost {
  cluster_id: string;
  cluster_name: string | null;
  driver_instance_type: string | null;
  worker_instance_type: string | null;
  cluster_source: string | null;
  total_dbu_hours: number;
  estimated_cost: number;
  days_active: number;
  percentage: number;
}

export interface InfraInstanceFamily {
  instance_family: string;
  instance_type: string | null;
  total_dbu_hours: number;
  days_active: number;
}

export interface InfraCostsResponse {
  cloud: string;
  cloud_display_name: string;
  clusters: InfraClusterCost[];
  instance_families: InfraInstanceFamily[];
  total_estimated_cost: number;
  total_dbu_hours: number;
  start_date: string;
  end_date: string;
  disclaimer?: string;
  error?: string;
}

export interface InfraCostsTimeseriesPoint {
  date: string;
  "Infrastructure Cost": number;
  total_dbu_hours: number;
}

export interface InfraCostsTimeseriesResponse {
  cloud: string;
  cloud_display_name: string;
  timeseries: InfraCostsTimeseriesPoint[];
  start_date: string;
  end_date: string;
  error?: string;
}

export interface SKUItem {
  product: string;
  workspaces_using: number;
  total_dbus: number;
  total_spend: number;
  percentage: number;
}

export interface SKUBreakdownResponse {
  skus: SKUItem[];
  total_spend: number;
  start_date: string;
  end_date: string;
  error?: string;
}

export interface SpendAnomaly {
  usage_date: string;
  daily_spend: number;
  prev_day_spend: number;
  change_amount: number;
  change_percent: number;
}

export interface SpendAnomaliesResponse {
  anomalies: SpendAnomaly[];
  start_date: string;
  end_date: string;
  error?: string;
}

export interface PlatformKPIsResponse {
  total_queries: number;
  unique_query_users: number;
  total_rows_read: number;
  total_bytes_read: number;
  total_compute_seconds: number;
  total_jobs: number;
  total_job_runs: number;
  successful_runs: number;
  unique_job_owners: number;
  active_workspaces: number;
  active_notebooks: number;
  models_served: number;
  total_serving_dbus: number;
  start_date: string;
  end_date: string;
  error?: string;
}

// Bundled responses for faster tab loading
export interface InfraBundleResponse {
  infra_costs: InfraCostsResponse;
  infra_timeseries: InfraCostsTimeseriesResponse;
}

export interface KPIsBundleResponse {
  kpis: PlatformKPIsResponse;
  anomalies: SpendAnomaliesResponse;
}

// Fast Dashboard Bundle (optimized for quick initial load)
export interface DashboardBundleFast {
  summary: BillingSummary;
  products: ProductBreakdownResponse;
  workspaces: WorkspaceBreakdownResponse;
  timeseries: TimeseriesResponse;
  etl_breakdown: GranularBreakdownResponse;
  is_fast_mode: boolean;
}

// Genie Chat Types
export interface GenieConfig {
  configured: boolean;
  space_id: string | null;
  host: string | null;
}

export interface GenieMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  sql?: string;
  data?: Record<string, unknown>[];
  timestamp: Date;
  status?: "pending" | "completed" | "error";
  error?: string;
}

export interface GenieResponse {
  conversation_id: string;
  message_id: string;
  status: string;
  response: string | null;
  sql: string | null;
  data: Record<string, unknown>[] | null;
  error: string | null;
}

// AI/ML 360 Types
export interface AIMLSummary {
  total_dbus: number;
  total_spend: number;
  workspace_count: number;
  endpoint_count: number;
  days_in_range: number;
  avg_daily_spend: number;
  start_date: string;
  end_date: string;
  first_date: string | null;
  last_date: string | null;
}

export interface AIMLProvider {
  provider: string;
  sku_name: string;
  total_dbus: number;
  total_spend: number;
  workspace_count: number;
  percentage: number;
}

export interface AIMLProvidersResponse {
  providers: AIMLProvider[];
  total_spend: number;
  start_date: string;
  end_date: string;
}

export interface AIMLEndpoint {
  endpoint_name: string;
  sku_name: string;
  cost_type: string;
  total_dbus: number;
  total_spend: number;
  workspace_count: number;
  days_active: number;
  percentage: number;
}

export interface AIMLEndpointsResponse {
  endpoints: AIMLEndpoint[];
  total_spend: number;
  start_date: string;
  end_date: string;
}

export interface AIMLCategory {
  category: string;
  total_dbus: number;
  total_spend: number;
  workspace_count: number;
  percentage: number;
}

export interface AIMLCategoriesResponse {
  categories: AIMLCategory[];
  total_spend: number;
  start_date: string;
  end_date: string;
}

export interface AIMLModel {
  model_name: string;
  model_type: string;
  total_dbus: number;
  total_spend: number;
  days_active: number;
  workspace_count: number;
}

export interface AIMLModelsResponse {
  models: AIMLModel[];
}

export interface AIMLCluster {
  cluster_name: string;
  cluster_id: string;
  runtime_version: string;
  owner: string;
  total_dbus: number;
  total_spend: number;
  days_active: number;
}

export interface AIMLClustersResponse {
  clusters: AIMLCluster[];
}

export interface AIMLAgentBrick {
  agent_name: string;
  agent_type: string;
  endpoint_id: string | null;
  workspace_id: string | null;
  total_dbus: number;
  total_spend: number;
  days_active: number;
  workspace_count: number;
  first_seen: string | null;
  last_seen: string | null;
  avg_daily_spend: number;
}

export interface AIMLAgentBricksResponse {
  agents: AIMLAgentBrick[];
}

export interface AIMLDashboardBundle {
  summary: AIMLSummary;
  providers: AIMLProvidersResponse;
  endpoints: AIMLEndpointsResponse;
  categories: AIMLCategoriesResponse;
  timeseries: TimeseriesResponse;
  models?: AIMLModelsResponse;
  ml_clusters?: AIMLClustersResponse;
  agent_bricks?: AIMLAgentBricksResponse;
  start_date: string;
  end_date: string;
}

// Apps Tab Types
export interface AppsSummary {
  total_dbus: number;
  total_spend: number;
  app_count: number;
  workspace_count: number;
  days_in_range: number;
  avg_daily_spend: number;
}

export interface AppsSkuBreakdown {
  sku_name: string;
  total_dbus: number;
  total_spend: number;
  percentage: number;
}

export interface AppsApp {
  app_id: string;
  app_name: string;
  app_url: string;
  total_dbus: number;
  total_spend: number;
  workspace_count: number;
  workspace_id?: string | null;
  workspace_names?: string[];
  days_active: number;
  last_usage_date: string | null;
  percentage: number;
  is_registered: boolean;
  sku_breakdown?: AppsSkuBreakdown[];
}

export interface AppsInactiveSummary {
  count: number;
  total_spend: number;
  total_dbus: number;
  percentage: number;
}

export interface AppsAppsResponse {
  apps: AppsApp[];
  total_spend: number;
  total_app_count: number;
  active_count: number;
  inactive_count: number;
  inactive_summary: AppsInactiveSummary;
  unregistered_summary: AppsInactiveSummary;
}

export interface AppsConnectedArtifact {
  app_id: string;
  app_name: string;
  artifact_name: string;
  artifact_type: string;
  artifact_description: string;
  workspace_id?: string | null;
}

export interface AppsDashboardBundle {
  summary: AppsSummary;
  apps: AppsAppsResponse;
  timeseries: TimeseriesResponse;
  connected_artifacts: AppsConnectedArtifact[];
  workspaces?: { id: string; name: string }[];
  active_only: boolean;
  start_date: string;
  end_date: string;
}

// Tagging Hub Types
export interface TaggingSummary {
  tagged_spend: number;
  untagged_spend: number;
  total_spend: number;
  tagged_percentage: number;
  untagged_percentage: number;
  tagged_workspaces: number;
  untagged_workspaces: number;
  start_date: string;
  end_date: string;
}

export interface UntaggedCluster {
  cluster_id: string;
  cluster_name: string | null;
  cluster_source: string | null;
  owner: string | null;
  workspace_id: string;
  total_dbus: number;
  total_spend: number;
  days_active: number;
}

export interface UntaggedClustersResponse {
  clusters: UntaggedCluster[];
  total_spend: number;
  count: number;
  start_date: string;
  end_date: string;
}

export interface UntaggedJob {
  job_id: string;
  job_name: string | null;
  workspace_id: string;
  total_dbus: number;
  total_spend: number;
  days_active: number;
}

export interface UntaggedJobsResponse {
  jobs: UntaggedJob[];
  total_spend: number;
  count: number;
  start_date: string;
  end_date: string;
}

export interface UntaggedPipeline {
  pipeline_id: string;
  pipeline_name: string | null;
  workspace_id: string;
  total_dbus: number;
  total_spend: number;
  days_active: number;
}

export interface UntaggedPipelinesResponse {
  pipelines: UntaggedPipeline[];
  total_spend: number;
  count: number;
  start_date: string;
  end_date: string;
}

export interface UntaggedWarehouse {
  warehouse_id: string;
  warehouse_name: string | null;
  workspace_id: string;
  total_dbus: number;
  total_spend: number;
  days_active: number;
}

export interface UntaggedWarehousesResponse {
  warehouses: UntaggedWarehouse[];
  total_spend: number;
  count: number;
  start_date: string;
  end_date: string;
}

export interface UntaggedEndpoint {
  endpoint_name: string;
  workspace_id: string;
  total_dbus: number;
  total_spend: number;
  days_active: number;
}

export interface UntaggedEndpointsResponse {
  endpoints: UntaggedEndpoint[];
  total_spend: number;
  count: number;
  start_date: string;
  end_date: string;
}

export interface TagCost {
  tag_key: string;
  tag_value: string;
  total_dbus: number;
  total_spend: number;
  workspace_count: number;
  days_active: number;
  percentage: number;
}

export interface TagCostResponse {
  tags: TagCost[];
  total_spend: number;
  start_date: string;
  end_date: string;
}

export interface TaggingDashboardBundle {
  summary: TaggingSummary;
  untagged: {
    clusters: { items: UntaggedCluster[]; total_spend: number; count: number };
    jobs: { items: UntaggedJob[]; total_spend: number; count: number };
    pipelines: { items: UntaggedPipeline[]; total_spend: number; count: number };
    warehouses: { items: UntaggedWarehouse[]; total_spend: number; count: number };
    endpoints: { items: UntaggedEndpoint[]; total_spend: number; count: number };
  };
  cost_by_tag: TagCostResponse;
  timeseries: TimeseriesResponse;
  start_date: string;
  end_date: string;
}

// AWS Actual Costs Types (from CUR 2.0)
export interface AWSActualCostsSummary {
  available: boolean;
  message?: string;
  total_unblended?: number;
  total_net_unblended?: number;
  total_amortized?: number;
  total_net_amortized?: number;
  cluster_count?: number;
  warehouse_count?: number;
  days_in_range?: number;
  start_date: string;
  end_date: string;
}

export interface AWSActualClusterCost {
  cluster_id: string;
  compute_cost: number;
  storage_cost: number;
  network_cost: number;
  total_cost: number;
  days_active: number;
  percentage: number;
}

export interface AWSActualByClusterResponse {
  available: boolean;
  clusters: AWSActualClusterCost[];
  total_cost: number;
  start_date: string;
  end_date: string;
}

export interface AWSActualChargeType {
  charge_type: string;
  unblended_cost: number;
  net_unblended_cost: number;
  amortized_cost: number;
  net_amortized_cost: number;
  percentage: number;
}

export interface AWSActualByChargeTypeResponse {
  available: boolean;
  charge_types: AWSActualChargeType[];
  total_cost: number;
  start_date: string;
  end_date: string;
}

export interface AWSActualTimeseriesResponse {
  available: boolean;
  timeseries: TimeseriesDataPoint[];
  charge_types: string[];
  start_date: string;
  end_date: string;
}

export interface AWSActualDashboardBundle {
  available: boolean;
  message?: string;
  summary?: AWSActualCostsSummary;
  by_cluster?: AWSActualByClusterResponse;
  by_charge_type?: AWSActualByChargeTypeResponse;
  timeseries?: AWSActualTimeseriesResponse;
  start_date: string;
  end_date: string;
}

// Azure Actual Costs Types (from Azure Cost Management Export)
export interface AzureActualCostsSummary {
  available: boolean;
  message?: string;
  total_cost?: number;
  total_cost_usd?: number;
  cluster_count?: number;
  warehouse_count?: number;
  days_in_range?: number;
  start_date: string;
  end_date: string;
}

export interface AzureActualClusterCost {
  cluster_id: string;
  compute_cost: number;
  storage_cost: number;
  network_cost: number;
  total_cost: number;
  days_active: number;
  percentage: number;
}

export interface AzureActualByClusterResponse {
  available: boolean;
  clusters: AzureActualClusterCost[];
  total_cost: number;
  start_date: string;
  end_date: string;
}

export interface AzureActualChargeType {
  charge_type: string;
  total_cost: number;
  total_cost_usd: number;
  percentage: number;
}

export interface AzureActualByChargeTypeResponse {
  available: boolean;
  charge_types: AzureActualChargeType[];
  total_cost: number;
  start_date: string;
  end_date: string;
}

export interface AzureActualTimeseriesResponse {
  available: boolean;
  timeseries: TimeseriesDataPoint[];
  charge_types: string[];
  start_date: string;
  end_date: string;
}

export interface AzureActualDashboardBundle {
  available: boolean;
  message?: string;
  summary?: AzureActualCostsSummary;
  by_cluster?: AzureActualByClusterResponse;
  by_charge_type?: AzureActualByChargeTypeResponse;
  timeseries?: AzureActualTimeseriesResponse;
  start_date: string;
  end_date: string;
}

// GCP Actual Cost Types
export interface GCPActualCostsSummary {
  available: boolean;
  total_cost?: number;
  currency?: string;
  project_count?: number;
  service_count?: number;
  days_in_range?: number;
  start_date: string;
  end_date: string;
}

export interface GCPActualService {
  service: string;
  total_cost: number;
  days_active: number;
  percentage: number;
}

export interface GCPActualByServiceResponse {
  available: boolean;
  services: GCPActualService[];
  total_cost: number;
  start_date: string;
  end_date: string;
}

export interface GCPActualProject {
  project_id: string;
  project_name: string;
  total_cost: number;
  service_count: number;
  percentage: number;
}

export interface GCPActualByProjectResponse {
  available: boolean;
  projects: GCPActualProject[];
  total_cost: number;
  start_date: string;
  end_date: string;
}

export interface GCPActualSku {
  service: string;
  sku: string;
  total_cost: number;
  percentage: number;
}

export interface GCPActualBySkuResponse {
  available: boolean;
  skus: GCPActualSku[];
  total_cost: number;
  start_date: string;
  end_date: string;
}

export interface GCPActualTimeseriesResponse {
  available: boolean;
  timeseries: Array<{ date: string; [service: string]: number | string }>;
  services: string[];
  start_date: string;
  end_date: string;
}

export interface GCPActualDashboardBundle {
  available: boolean;
  message?: string;
  summary?: GCPActualCostsSummary;
  by_service?: GCPActualByServiceResponse;
  by_project?: GCPActualByProjectResponse;
  by_sku?: GCPActualBySkuResponse;
  timeseries?: GCPActualTimeseriesResponse;
  start_date: string;
  end_date: string;
}

// Contract Burn-Down Types
export interface ContractTerms {
  start_date: string;
  end_date: string;
  total_commit_usd: number;
  notes: string;
}

export interface ContractKPIs {
  total_commit_usd: number;
  spent_to_date: number;
  remaining: number;
  days_elapsed: number;
  days_remaining: number;
  projected_end_date: string;
  pace_status: "under" | "on_pace" | "over";
}

export interface ContractDailyPoint {
  date: string;
  actual_cumulative: number | null;
  ideal_cumulative: number;
}

export interface ContractBurndownResponse {
  configured: boolean;
  error?: string;
  contract?: ContractTerms;
  kpis?: ContractKPIs;
  daily_series?: ContractDailyPoint[];
}

// DBSQL Query Cost Attribution Types
export interface DBSQLDataRange {
  earliest_date: string | null;
  latest_date: string | null;
  total_rows: number;
}

export interface DBSQLQueryCostSummary {
  available: boolean;
  message?: string;
  total_queries?: number;
  unique_users?: number;
  unique_warehouses?: number;
  total_spend?: number;
  total_dbus?: number;
  avg_cost_per_query?: number;
  avg_duration_seconds?: number;
  start_date: string;
  end_date: string;
  data_range?: DBSQLDataRange;
}

export interface QueryCostBySource {
  query_source_type: string;
  query_count: number;
  total_spend: number;
  total_dbus: number;
  avg_cost_per_query: number;
  percentage: number;
}

export interface QueryCostBySourceResponse {
  available: boolean;
  sources: QueryCostBySource[];
  total_spend: number;
  start_date: string;
  end_date: string;
}

export interface QueryCostByUser {
  executed_by: string;
  query_source_type: string;
  query_count: number;
  total_spend: number;
  total_dbus: number;
}

export interface QueryCostByUserResponse {
  available: boolean;
  users: QueryCostByUser[];
  start_date: string;
  end_date: string;
}

export interface QueryCostByWarehouse {
  warehouse_id: string;
  warehouse_name?: string;
  warehouse_type?: string;
  query_count: number;
  unique_users: number;
  total_spend: number;
  total_dbus: number;
  percentage: number;
}

export interface QueryCostByWarehouseResponse {
  available: boolean;
  warehouses: QueryCostByWarehouse[];
  total_spend: number;
  start_date: string;
  end_date: string;
}

export interface ExpensiveQuery {
  statement_id: string;
  query_source_type: string;
  query_source_id: string | null;
  executed_by: string;
  warehouse_id: string | null;
  workspace_id: string | null;
  statement_preview: string;
  duration_seconds: number;
  cost: number;
  dbus: number;
  query_profile_url: string | null;
  source_url: string | null;
  start_time: string | null;
  end_time: string | null;
}

export interface TopQueriesResponse {
  available: boolean;
  queries: ExpensiveQuery[];
  start_date: string;
  end_date: string;
}

export interface QueryCostTimeseriesResponse {
  available: boolean;
  timeseries: TimeseriesDataPoint[];
  source_types: string[];
  start_date: string;
  end_date: string;
}

export interface DBSQLDashboardBundle {
  available: boolean;
  message?: string;
  summary?: DBSQLQueryCostSummary;
  by_source?: QueryCostBySourceResponse;
  by_user?: QueryCostByUserResponse;
  by_warehouse?: QueryCostByWarehouseResponse;
  top_queries?: TopQueriesResponse;
  timeseries?: QueryCostTimeseriesResponse;
  start_date: string;
  end_date: string;
}
