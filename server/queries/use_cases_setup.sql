-- Create schema for use case tracking
CREATE SCHEMA IF NOT EXISTS cost_observability;

-- Use cases table
CREATE TABLE IF NOT EXISTS cost_observability.use_cases (
  use_case_id STRING NOT NULL,
  name STRING NOT NULL,
  description STRING,
  owner STRING,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  status STRING,
  tags MAP<STRING, STRING>,
  stage STRING,
  start_date DATE,
  end_date DATE,
  live_date DATE
) USING DELTA;

-- Use case objects mapping table
CREATE TABLE IF NOT EXISTS cost_observability.use_case_objects (
  mapping_id STRING NOT NULL,
  use_case_id STRING NOT NULL,
  object_type STRING NOT NULL,
  object_id STRING NOT NULL,
  object_name STRING,
  workspace_id STRING,
  assigned_at TIMESTAMP NOT NULL,
  assigned_by STRING,
  notes STRING,
  custom_start_date DATE,
  custom_end_date DATE
) USING DELTA;

-- Migration: Add new columns to existing tables (safe to run multiple times)
-- These ALTER statements will fail silently if columns already exist

-- Add stage and date columns to use_cases table
ALTER TABLE cost_observability.use_cases ADD COLUMNS (stage STRING);
ALTER TABLE cost_observability.use_cases ADD COLUMNS (start_date DATE);
ALTER TABLE cost_observability.use_cases ADD COLUMNS (end_date DATE);
ALTER TABLE cost_observability.use_cases ADD COLUMNS (live_date DATE);

-- Add custom date range columns to use_case_objects table
ALTER TABLE cost_observability.use_case_objects ADD COLUMNS (custom_start_date DATE);
ALTER TABLE cost_observability.use_case_objects ADD COLUMNS (custom_end_date DATE);
