"""AWS CUR 2.0 Setup - Creates medallion architecture tables for actual AWS costs.

This module creates the bronze/silver/gold tables to process AWS Cost and Usage
Reports (CUR 2.0) data. Based on: https://github.com/databricks-solutions/cloud-infra-costs

Prerequisites (customer must complete):
1. Enable CUR 2.0 exports in AWS Billing Console
2. Create S3 bucket for CUR data
3. Create Unity Catalog Storage Credential with S3 access
4. Create Unity Catalog External Location pointing to CUR bucket

This module automates:
- Bronze table creation (raw CUR data)
- Silver table creation (enriched with Databricks linkage)
- Gold table creation (aggregated costs)
"""

import logging
import os
from typing import Any

from server.db import execute_query

logger = logging.getLogger(__name__)


def get_catalog_schema() -> tuple[str, str]:
    """Get the catalog and schema for AWS cost tables from environment.

    Defaults match the cloud-infra-costs private preview DAB repo
    (catalog=billing, schema=aws). Override via env vars if needed.
    """
    catalog = os.getenv("AWS_COST_CATALOG", os.getenv("COST_OBS_CATALOG", "billing"))
    schema = os.getenv("AWS_COST_SCHEMA", "aws")
    return catalog, schema


# Check if external location exists for CUR data
CHECK_EXTERNAL_LOCATION = """
SELECT location_name, url, credential_name
FROM system.information_schema.external_locations
WHERE url LIKE '%{s3_path_pattern}%'
   OR location_name LIKE '%cur%'
   OR location_name LIKE '%cost%'
LIMIT 10
"""

# Check if CUR tables already exist
CHECK_CUR_TABLES = """
SELECT table_name
FROM information_schema.tables
WHERE table_catalog = '{catalog}'
  AND table_schema = '{schema}'
  AND table_name IN ('actual_bronze', 'actuals_silver', 'actuals_gold')
"""

# Create schema for AWS costs
CREATE_AWS_SCHEMA = """
CREATE SCHEMA IF NOT EXISTS {catalog}.{schema}
COMMENT 'AWS Cost and Usage Report data processed via medallion architecture'
"""

# Bronze table - raw CUR 2.0 data from S3
# This uses the COPY INTO pattern to incrementally load CUR data
CREATE_BRONZE_TABLE = """
CREATE TABLE IF NOT EXISTS {catalog}.{schema}.actual_bronze (
  -- Identity columns
  identity_line_item_id STRING,
  identity_time_interval STRING,

  -- Bill columns
  bill_invoice_id STRING,
  bill_invoicing_entity STRING,
  bill_billing_entity STRING,
  bill_bill_type STRING,
  bill_payer_account_id STRING,
  bill_billing_period_start_date TIMESTAMP,
  bill_billing_period_end_date TIMESTAMP,

  -- Line item columns
  line_item_usage_account_id STRING,
  line_item_line_item_type STRING,
  line_item_usage_start_date TIMESTAMP,
  line_item_usage_end_date TIMESTAMP,
  line_item_product_code STRING,
  line_item_usage_type STRING,
  line_item_operation STRING,
  line_item_availability_zone STRING,
  line_item_resource_id STRING,
  line_item_usage_amount DOUBLE,
  line_item_normalization_factor DOUBLE,
  line_item_normalized_usage_amount DOUBLE,
  line_item_currency_code STRING,
  line_item_unblended_rate STRING,
  line_item_unblended_cost DOUBLE,
  line_item_blended_rate STRING,
  line_item_blended_cost DOUBLE,
  line_item_line_item_description STRING,
  line_item_tax_type STRING,
  line_item_legal_entity STRING,
  line_item_net_unblended_cost DOUBLE,
  line_item_net_unblended_rate STRING,

  -- Product columns
  product_product_name STRING,
  product_instance_type STRING,
  product_instance_type_family STRING,
  product_region STRING,
  product_operating_system STRING,
  product_tenancy STRING,
  product_physical_processor STRING,
  product_processor_features STRING,
  product_database_engine STRING,
  product_group STRING,
  product_group_description STRING,
  product_location STRING,
  product_location_type STRING,
  product_product_family STRING,

  -- Pricing columns
  pricing_rate_code STRING,
  pricing_rate_id STRING,
  pricing_currency STRING,
  pricing_public_on_demand_cost DOUBLE,
  pricing_public_on_demand_rate STRING,
  pricing_term STRING,
  pricing_unit STRING,

  -- Reservation columns
  reservation_amortized_upfront_cost_for_usage DOUBLE,
  reservation_amortized_upfront_fee_for_billing_period DOUBLE,
  reservation_effective_cost DOUBLE,
  reservation_end_time STRING,
  reservation_modification_status STRING,
  reservation_normalized_units_per_reservation STRING,
  reservation_number_of_reservations STRING,
  reservation_recurring_fee_for_usage DOUBLE,
  reservation_start_time STRING,
  reservation_subscription_id STRING,
  reservation_total_reserved_normalized_units STRING,
  reservation_total_reserved_units STRING,
  reservation_units_per_reservation STRING,
  reservation_unused_amortized_upfront_fee_for_billing_period DOUBLE,
  reservation_unused_normalized_unit_quantity DOUBLE,
  reservation_unused_quantity DOUBLE,
  reservation_unused_recurring_fee DOUBLE,
  reservation_upfront_value DOUBLE,
  reservation_reservation_a_r_n STRING,
  reservation_net_amortized_upfront_cost_for_usage DOUBLE,
  reservation_net_amortized_upfront_fee_for_billing_period DOUBLE,
  reservation_net_effective_cost DOUBLE,
  reservation_net_recurring_fee_for_usage DOUBLE,
  reservation_net_unused_amortized_upfront_fee_for_billing_period DOUBLE,
  reservation_net_unused_recurring_fee DOUBLE,
  reservation_net_upfront_value DOUBLE,

  -- Savings Plan columns
  savings_plan_total_commitment_to_date DOUBLE,
  savings_plan_savings_plan_a_r_n STRING,
  savings_plan_savings_plan_rate DOUBLE,
  savings_plan_used_commitment DOUBLE,
  savings_plan_savings_plan_effective_cost DOUBLE,
  savings_plan_amortized_upfront_commitment_for_billing_period DOUBLE,
  savings_plan_recurring_commitment_for_billing_period DOUBLE,
  savings_plan_start_time STRING,
  savings_plan_end_time STRING,
  savings_plan_offering_type STRING,
  savings_plan_payment_option STRING,
  savings_plan_purchase_term STRING,
  savings_plan_region STRING,
  savings_plan_instance_type_family STRING,
  savings_plan_net_savings_plan_effective_cost DOUBLE,
  savings_plan_net_amortized_upfront_commitment_for_billing_period DOUBLE,
  savings_plan_net_recurring_commitment_for_billing_period DOUBLE,

  -- Resource tags (common ones)
  resource_tags_user_name STRING,
  resource_tags_user_cluster_id STRING,
  resource_tags_user_cluster_name STRING,
  resource_tags_user_warehouse_id STRING,
  resource_tags_user_job_id STRING,
  resource_tags_user_instance_pool_id STRING,
  resource_tags_user_creator STRING,
  resource_tags_user_cost_center STRING,
  resource_tags_user_environment STRING,
  resource_tags_user_project STRING,
  resource_tags_user_team STRING,

  -- Metadata
  _loaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP()
)
USING DELTA
COMMENT 'Raw AWS CUR 2.0 data - bronze layer'
"""

# Silver table - enriched with Databricks resource linkage
CREATE_SILVER_TABLE = """
CREATE OR REPLACE TABLE {catalog}.{schema}.actuals_silver AS
SELECT
  -- Time dimensions
  DATE(line_item_usage_start_date) AS usage_date,
  DATE_TRUNC('hour', line_item_usage_start_date) AS usage_hour,
  bill_billing_period_start_date AS billing_period_start,
  bill_billing_period_end_date AS billing_period_end,

  -- Account info
  bill_payer_account_id AS payer_account_id,
  line_item_usage_account_id AS usage_account_id,

  -- Resource identification
  line_item_resource_id AS resource_id,
  line_item_product_code AS product_code,
  product_product_name AS product_name,
  line_item_usage_type AS usage_type,
  line_item_operation AS operation,
  line_item_availability_zone AS availability_zone,
  product_region AS region,

  -- Instance details
  product_instance_type AS instance_type,
  product_instance_type_family AS instance_family,
  product_operating_system AS operating_system,
  product_tenancy AS tenancy,

  -- Databricks resource linkage (from tags)
  resource_tags_user_cluster_id AS cluster_id,
  resource_tags_user_cluster_name AS cluster_name,
  resource_tags_user_warehouse_id AS warehouse_id,
  resource_tags_user_job_id AS job_id,
  resource_tags_user_instance_pool_id AS instance_pool_id,
  resource_tags_user_creator AS cluster_creator,

  -- Cost center tags
  resource_tags_user_cost_center AS cost_center,
  resource_tags_user_environment AS environment,
  resource_tags_user_project AS project,
  resource_tags_user_team AS team,

  -- Charge type classification
  CASE
    WHEN line_item_line_item_type = 'Usage' THEN
      CASE
        WHEN product_product_family LIKE '%Compute%' THEN 'Compute'
        WHEN product_product_family LIKE '%Storage%' THEN 'Storage'
        WHEN product_product_family LIKE '%Data Transfer%' THEN 'Networking'
        WHEN product_product_family LIKE '%Network%' THEN 'Networking'
        ELSE 'Other'
      END
    WHEN line_item_line_item_type IN ('SavingsPlanCoveredUsage', 'SavingsPlanRecurringFee', 'SavingsPlanNegation') THEN 'SavingsPlan'
    WHEN line_item_line_item_type IN ('DiscountedUsage', 'RIFee') THEN 'ReservedInstance'
    WHEN line_item_line_item_type = 'Fee' THEN 'Fee'
    WHEN line_item_line_item_type = 'Tax' THEN 'Tax'
    WHEN line_item_line_item_type = 'Credit' THEN 'Credit'
    WHEN line_item_line_item_type = 'Refund' THEN 'Refund'
    ELSE 'Other'
  END AS charge_type,

  -- Pricing term
  COALESCE(pricing_term, 'OnDemand') AS pricing_term,
  line_item_currency_code AS currency_code,

  -- Usage metrics
  line_item_usage_amount AS usage_amount,
  line_item_normalized_usage_amount AS normalized_usage_amount,

  -- Cost metrics (all variants)
  COALESCE(line_item_unblended_cost, 0) AS unblended_cost,
  COALESCE(line_item_net_unblended_cost, line_item_unblended_cost, 0) AS net_unblended_cost,
  COALESCE(line_item_blended_cost, 0) AS blended_cost,

  -- Amortized costs (include RI/SP amortization)
  COALESCE(line_item_unblended_cost, 0) +
    COALESCE(reservation_amortized_upfront_cost_for_usage, 0) +
    COALESCE(savings_plan_amortized_upfront_commitment_for_billing_period, 0) AS amortized_cost,

  COALESCE(line_item_net_unblended_cost, line_item_unblended_cost, 0) +
    COALESCE(reservation_net_amortized_upfront_cost_for_usage, reservation_amortized_upfront_cost_for_usage, 0) +
    COALESCE(savings_plan_net_amortized_upfront_commitment_for_billing_period, savings_plan_amortized_upfront_commitment_for_billing_period, 0) AS net_amortized_cost,

  -- RI/SP specific costs
  reservation_effective_cost AS ri_effective_cost,
  savings_plan_savings_plan_effective_cost AS sp_effective_cost,

  -- Metadata
  _loaded_at

FROM {catalog}.{schema}.actual_bronze
WHERE line_item_usage_start_date IS NOT NULL
  AND line_item_line_item_type NOT IN ('Tax')  -- Exclude tax rows from analysis
"""

# Gold table - aggregated costs ready for dashboard
CREATE_GOLD_TABLE = """
CREATE OR REPLACE TABLE {catalog}.{schema}.actuals_gold AS
SELECT
  usage_date,
  usage_account_id,
  region,
  charge_type,
  pricing_term,
  instance_type,
  instance_family,

  -- Databricks resource linkage (as struct for easy querying)
  STRUCT(
    cluster_id,
    cluster_name,
    warehouse_id,
    job_id,
    instance_pool_id,
    cluster_creator
  ) AS usage_metadata,

  -- Cost center tags
  cost_center,
  environment,
  project,
  team,

  -- Aggregated costs
  SUM(unblended_cost) AS unblended_cost,
  SUM(net_unblended_cost) AS net_unblended_cost,
  SUM(blended_cost) AS blended_cost,
  SUM(amortized_cost) AS amortized_cost,
  SUM(net_amortized_cost) AS net_amortized_cost,

  -- Usage metrics
  SUM(usage_amount) AS total_usage_amount,
  COUNT(*) AS line_item_count,

  currency_code

FROM {catalog}.{schema}.actuals_silver
GROUP BY
  usage_date,
  usage_account_id,
  region,
  charge_type,
  pricing_term,
  instance_type,
  instance_family,
  cluster_id,
  cluster_name,
  warehouse_id,
  job_id,
  instance_pool_id,
  cluster_creator,
  cost_center,
  environment,
  project,
  team,
  currency_code
"""

# COPY INTO command to load CUR data from S3
COPY_INTO_BRONZE = """
COPY INTO {catalog}.{schema}.actual_bronze
FROM '{s3_path}'
FILEFORMAT = PARQUET
COPY_OPTIONS ('mergeSchema' = 'true')
"""


def check_cur_prerequisites(catalog: str, schema: str) -> dict[str, Any]:
    """Check if prerequisites for CUR setup are met."""
    results = {
        "external_locations": [],
        "existing_tables": [],
        "ready": False,
    }

    # Check for CUR-related external locations
    try:
        locations = execute_query(CHECK_EXTERNAL_LOCATION.format(s3_path_pattern="cur"))
        results["external_locations"] = [
            {"name": r.get("location_name"), "url": r.get("url"), "credential": r.get("credential_name")}
            for r in locations
        ]
    except Exception as e:
        logger.warning(f"Could not check external locations: {e}")

    # Check if tables already exist
    try:
        tables = execute_query(CHECK_CUR_TABLES.format(catalog=catalog, schema=schema))
        results["existing_tables"] = [r.get("table_name") for r in tables]
    except Exception:
        pass

    # Ready if we have at least one external location
    results["ready"] = len(results["external_locations"]) > 0

    return results


def create_cur_tables(
    catalog: str | None = None,
    schema: str | None = None,
    s3_path: str | None = None,
    load_data: bool = False,
) -> dict[str, Any]:
    """Create AWS CUR medallion tables.

    Args:
        catalog: Target catalog (default: from env)
        schema: Target schema (default: from env)
        s3_path: S3 path for CUR data (required if load_data=True)
        load_data: Whether to load data from S3 after creating tables

    Returns:
        Dict with status of each table creation
    """
    if catalog is None or schema is None:
        cat, sch = get_catalog_schema()
        catalog = catalog or cat
        schema = schema or sch

    results = {}

    # Create schema
    try:
        logger.info(f"Creating schema {catalog}.{schema}...")
        execute_query(CREATE_AWS_SCHEMA.format(catalog=catalog, schema=schema))
        results["schema"] = "created"
    except Exception as e:
        logger.error(f"Failed to create schema: {e}")
        results["schema"] = f"error: {e}"
        return results

    # Create bronze table
    try:
        logger.info(f"Creating bronze table {catalog}.{schema}.actual_bronze...")
        execute_query(CREATE_BRONZE_TABLE.format(catalog=catalog, schema=schema))
        results["actual_bronze"] = "created"
    except Exception as e:
        logger.error(f"Failed to create bronze table: {e}")
        results["actual_bronze"] = f"error: {e}"

    # Optionally load data into bronze
    if load_data and s3_path:
        try:
            logger.info(f"Loading CUR data from {s3_path}...")
            execute_query(COPY_INTO_BRONZE.format(
                catalog=catalog, schema=schema, s3_path=s3_path
            ))
            results["data_load"] = "completed"
        except Exception as e:
            logger.error(f"Failed to load CUR data: {e}")
            results["data_load"] = f"error: {e}"

    # Create silver table (only if bronze has data or load_data was successful)
    try:
        logger.info(f"Creating silver table {catalog}.{schema}.actuals_silver...")
        execute_query(CREATE_SILVER_TABLE.format(catalog=catalog, schema=schema))
        results["actuals_silver"] = "created"
    except Exception as e:
        logger.error(f"Failed to create silver table: {e}")
        results["actuals_silver"] = f"error: {e}"

    # Create gold table
    try:
        logger.info(f"Creating gold table {catalog}.{schema}.actuals_gold...")
        execute_query(CREATE_GOLD_TABLE.format(catalog=catalog, schema=schema))
        results["actuals_gold"] = "created"
    except Exception as e:
        logger.error(f"Failed to create gold table: {e}")
        results["actuals_gold"] = f"error: {e}"

    return results


def refresh_cur_tables(
    catalog: str | None = None,
    schema: str | None = None,
    s3_path: str | None = None,
) -> dict[str, Any]:
    """Refresh CUR tables with latest data from S3.

    This incrementally loads new CUR data and refreshes silver/gold tables.
    """
    if catalog is None or schema is None:
        cat, sch = get_catalog_schema()
        catalog = catalog or cat
        schema = schema or sch

    results = {}

    # Load new data into bronze
    if s3_path:
        try:
            logger.info(f"Loading new CUR data from {s3_path}...")
            execute_query(COPY_INTO_BRONZE.format(
                catalog=catalog, schema=schema, s3_path=s3_path
            ))
            results["data_load"] = "completed"
        except Exception as e:
            logger.warning(f"Data load warning: {e}")
            results["data_load"] = f"warning: {e}"

    # Refresh silver table
    try:
        logger.info("Refreshing silver table...")
        execute_query(CREATE_SILVER_TABLE.format(catalog=catalog, schema=schema))
        results["actuals_silver"] = "refreshed"
    except Exception as e:
        logger.error(f"Failed to refresh silver table: {e}")
        results["actuals_silver"] = f"error: {e}"

    # Refresh gold table
    try:
        logger.info("Refreshing gold table...")
        execute_query(CREATE_GOLD_TABLE.format(catalog=catalog, schema=schema))
        results["actuals_gold"] = "refreshed"
    except Exception as e:
        logger.error(f"Failed to refresh gold table: {e}")
        results["actuals_gold"] = f"error: {e}"

    return results
