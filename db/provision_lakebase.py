"""
Lakebase provisioning is handled by the Databricks Asset Bundle (databricks.yml),
not at runtime. The bundle creates the postgres project, branch, and endpoint via
DAB resource blocks, and the Apps database resource binding injects PGHOST,
PGDATABASE, PGPORT, PGSSLMODE, and PGUSER automatically.

To provision:
    databricks bundle deploy -t prod --var="warehouse_id=<id>"

To start the app after deploy:
    databricks bundle run cost_obs_app -t prod

Runtime code (server/lakebase.py) handles only idempotent schema/table bootstrap
against an already-bound database.
"""
