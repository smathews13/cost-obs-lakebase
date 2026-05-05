"""
DBSQL Query Cost Attribution Router - Per-Query Cost Granularity

This router queries the dbsql_cost_per_query materialized view to provide
granular query-level cost attribution for all DBSQL queries.

Source: https://github.com/databrickslabs/sandbox/tree/main/dbsql/cost_per_query/PrPr
"""

from server.routers.dbsql_base import create_dbsql_router

router = create_dbsql_router("dbsql_cost_per_query")
