"""
DBSQL Query Cost Attribution Router - PrPr Private Preview Implementation

This router queries the dbsql_cost_per_query_prpr materialized view which implements
the enhanced Private Preview methodology with warehouse utilization tracking.

Source: https://github.com/databrickslabs/sandbox/tree/main/dbsql/cost_per_query/PrPr

Key differences from original implementation:
- Applies warehouse utilization proportion (discounts idle time)
- Splits multi-hour queries across time boundaries
- Enhanced work calculation including compilation and result fetch time
- Structured query source classification from query_source fields
"""

import logging
from typing import Any

from fastapi import Query

from server.db import execute_query, get_catalog_schema
from server.routers.dbsql_base import create_dbsql_router

logger = logging.getLogger(__name__)

# Create base router with all shared endpoints
router = create_dbsql_router("dbsql_cost_per_query_prpr")

# Access the check_mv_status closure from the base router
_check_mv_status = router.check_mv_status  # type: ignore[attr-defined]


def _get_efficiency_grade(utilization_pct: float) -> str:
    """Assign letter grade based on warehouse utilization."""
    if utilization_pct >= 80:
        return "A"
    elif utilization_pct >= 60:
        return "B"
    elif utilization_pct >= 40:
        return "C"
    elif utilization_pct >= 20:
        return "D"
    else:
        return "F"


def _generate_efficiency_recommendations(
    utilization_pct: float,
    idle_cost: float,
    idle_pct: float,
) -> list[dict[str, Any]]:
    """Generate actionable recommendations based on warehouse efficiency metrics."""
    recommendations = []

    if idle_pct > 70:
        recommendations.append({
            "priority": "critical",
            "title": "Reduce Auto-Stop Timeout",
            "description": f"With {idle_pct:.1f}% idle time, warehouses are staying on too long between queries.",
            "action": "Set auto-stop timeout to 5-10 minutes in warehouse settings",
            "potential_savings": idle_cost * 0.6,
            "effort": "low",
        })
        recommendations.append({
            "priority": "critical",
            "title": "Enable Serverless SQL Warehouses",
            "description": "Serverless warehouses scale to zero and only charge for query execution time.",
            "action": "Migrate to Serverless SQL warehouses in warehouse settings",
            "potential_savings": idle_cost * 0.95,
            "effort": "medium",
        })
        recommendations.append({
            "priority": "high",
            "title": "Consolidate Underutilized Warehouses",
            "description": "Multiple low-utilization warehouses can often be merged into fewer, better-utilized ones.",
            "action": "Review warehouse usage patterns and consolidate where possible",
            "potential_savings": idle_cost * 0.4,
            "effort": "high",
        })
    elif idle_pct > 40:
        recommendations.append({
            "priority": "high",
            "title": "Optimize Auto-Stop Settings",
            "description": f"Moderate idle time ({idle_pct:.1f}%) suggests room for optimization.",
            "action": "Review and reduce auto-stop timeouts for low-traffic warehouses",
            "potential_savings": idle_cost * 0.3,
            "effort": "low",
        })
        recommendations.append({
            "priority": "medium",
            "title": "Right-Size Warehouse Clusters",
            "description": "Ensure warehouse sizes match workload requirements.",
            "action": "Analyze query patterns and adjust warehouse sizes accordingly",
            "potential_savings": idle_cost * 0.25,
            "effort": "medium",
        })
    else:
        recommendations.append({
            "priority": "low",
            "title": "Maintain Good Efficiency",
            "description": f"Warehouse utilization is healthy at {utilization_pct:.1f}%.",
            "action": "Continue monitoring and optimize slow queries to improve further",
            "potential_savings": idle_cost * 0.1,
            "effort": "low",
        })

    recommendations.append({
        "priority": "medium" if utilization_pct < 40 else "low",
        "title": "Optimize Slow Queries",
        "description": "Faster queries = less warehouse runtime = lower costs.",
        "action": "Review top expensive queries and optimize with caching, indexing, or query rewriting",
        "potential_savings": idle_cost * 0.15 + (idle_cost * utilization_pct / 100 * 0.2),
        "effort": "medium",
    })

    if idle_pct > 50:
        recommendations.append({
            "priority": "medium",
            "title": "Implement Warehouse Usage Policies",
            "description": "Set up alerts and policies to prevent waste.",
            "action": "Configure alerts for idle warehouses and set spending limits",
            "potential_savings": idle_cost * 0.2,
            "effort": "low",
        })

    return recommendations


@router.get("/comparison")
async def get_methodology_comparison(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
) -> dict[str, Any]:
    """Compare original vs PrPr methodology side-by-side with warehouse efficiency metrics."""
    catalog, schema = get_catalog_schema()

    from datetime import date, timedelta

    if not end_date:
        end_date = date.today().isoformat()
    if not start_date:
        start_date = (date.today() - timedelta(days=30)).isoformat()

    original_query = f"""
    SELECT
      COUNT(*) as total_queries,
      SUM(query_attributed_dollars_estimation) as total_spend,
      SUM(query_attributed_dbus_estimation) as total_dbus,
      AVG(query_attributed_dollars_estimation) as avg_cost_per_query
    FROM {catalog}.{schema}.dbsql_cost_per_query
    WHERE start_time >= :start_date
      AND start_time < :end_date
    """

    prpr_query = f"""
    SELECT
      COUNT(*) as total_queries,
      SUM(query_attributed_dollars_estimation) as total_spend,
      SUM(query_attributed_dbus_estimation) as total_dbus,
      AVG(query_attributed_dollars_estimation) as avg_cost_per_query
    FROM {catalog}.{schema}.dbsql_cost_per_query_prpr
    WHERE start_time >= :start_date
      AND start_time < :end_date
    """

    try:
        original_results = execute_query(original_query, {"start_date": start_date, "end_date": end_date})
        prpr_results = execute_query(prpr_query, {"start_date": start_date, "end_date": end_date})

        original_data = original_results[0] if original_results else {}
        prpr_data = prpr_results[0] if prpr_results else {}

        original_spend = float(original_data.get("total_spend") or 0)
        prpr_spend = float(prpr_data.get("total_spend") or 0)
        idle_cost = original_spend - prpr_spend

        utilization_pct = (prpr_spend / original_spend * 100) if original_spend > 0 else 0
        idle_pct = 100 - utilization_pct

        recommendations = _generate_efficiency_recommendations(utilization_pct, idle_cost, idle_pct)

        return {
            "available": True,
            "original": {
                "total_queries": original_data.get("total_queries") or 0,
                "total_spend": original_spend,
                "total_dbus": float(original_data.get("total_dbus") or 0),
                "avg_cost_per_query": float(original_data.get("avg_cost_per_query") or 0),
                "description": "Actual Databricks bill (includes all warehouse uptime: utilized + idle)",
            },
            "prpr": {
                "total_queries": prpr_data.get("total_queries") or 0,
                "total_spend": prpr_spend,
                "total_dbus": float(prpr_data.get("total_dbus") or 0),
                "avg_cost_per_query": float(prpr_data.get("avg_cost_per_query") or 0),
                "description": "Query-attributed cost (only utilized time, fair for chargeback)",
            },
            "idle_warehouse_cost": {
                "total_idle_cost": idle_cost,
                "idle_percentage": idle_pct,
                "description": "Warehouse idle time cost - you're still billed for this!",
                "status": "critical" if idle_pct > 70 else "warning" if idle_pct > 40 else "good",
            },
            "warehouse_efficiency": {
                "utilization_percentage": utilization_pct,
                "idle_percentage": idle_pct,
                "status": "good" if utilization_pct > 60 else "warning" if utilization_pct > 30 else "critical",
                "grade": _get_efficiency_grade(utilization_pct),
            },
            "recommendations": recommendations,
            "start_date": start_date,
            "end_date": end_date,
        }
    except Exception as e:
        logger.error(f"Comparison query failed: {e}")
        return {"available": False, "message": str(e), "start_date": start_date, "end_date": end_date}


@router.get("/warehouse-efficiency")
async def get_warehouse_efficiency(
    start_date: str = Query(default=None),
    end_date: str = Query(default=None),
    min_cost: float = Query(default=10.0, description="Minimum warehouse cost to include"),
) -> dict[str, Any]:
    """Get warehouse-level efficiency metrics with idle cost breakdown."""
    catalog, schema = get_catalog_schema()

    from datetime import date, timedelta

    if not end_date:
        end_date = date.today().isoformat()
    if not start_date:
        start_date = (date.today() - timedelta(days=30)).isoformat()

    warehouse_comparison_query = f"""
    WITH original_costs AS (
      SELECT
        warehouse_id,
        COUNT(*) as total_queries,
        SUM(query_attributed_dollars_estimation) as total_cost,
        SUM(query_attributed_dbus_estimation) as total_dbus
      FROM {catalog}.{schema}.dbsql_cost_per_query
      WHERE start_time >= :start_date
        AND start_time < :end_date
      GROUP BY warehouse_id
    ),
    prpr_costs AS (
      SELECT
        warehouse_id,
        COUNT(*) as query_count,
        SUM(query_attributed_dollars_estimation) as utilized_cost,
        SUM(query_attributed_dbus_estimation) as utilized_dbus
      FROM {catalog}.{schema}.dbsql_cost_per_query_prpr
      WHERE start_time >= :start_date
        AND start_time < :end_date
      GROUP BY warehouse_id
    )
    SELECT
      COALESCE(o.warehouse_id, p.warehouse_id) as warehouse_id,
      COALESCE(o.total_queries, 0) as total_queries,
      COALESCE(p.query_count, 0) as utilized_queries,
      COALESCE(o.total_cost, 0) as total_cost,
      COALESCE(p.utilized_cost, 0) as utilized_cost,
      COALESCE(o.total_cost, 0) - COALESCE(p.utilized_cost, 0) as idle_cost,
      COALESCE(o.total_dbus, 0) as total_dbus,
      COALESCE(p.utilized_dbus, 0) as utilized_dbus
    FROM original_costs o
    FULL OUTER JOIN prpr_costs p ON o.warehouse_id = p.warehouse_id
    WHERE COALESCE(o.total_cost, 0) >= :min_cost
    ORDER BY idle_cost DESC
    """

    try:
        results = execute_query(
            warehouse_comparison_query,
            {"start_date": start_date, "end_date": end_date, "min_cost": min_cost},
        )

        warehouses = []
        total_idle_cost = 0
        total_cost = 0

        for row in results:
            total_cost_val = float(row.get("total_cost") or 0)
            utilized_cost_val = float(row.get("utilized_cost") or 0)
            idle_cost_val = float(row.get("idle_cost") or 0)

            utilization_pct = (utilized_cost_val / total_cost_val * 100) if total_cost_val > 0 else 0
            idle_pct = 100 - utilization_pct

            total_idle_cost += idle_cost_val
            total_cost += total_cost_val

            warehouse_recs = []
            if idle_pct > 80:
                warehouse_recs.append("CRITICAL: Enable auto-stop or migrate to serverless")
            elif idle_pct > 60:
                warehouse_recs.append("Reduce auto-stop timeout to 5 minutes")
            elif idle_pct > 40:
                warehouse_recs.append("Review usage patterns and consider consolidation")
            else:
                warehouse_recs.append("Good utilization - monitor for optimization opportunities")

            warehouses.append({
                "warehouse_id": row.get("warehouse_id"),
                "total_cost": total_cost_val,
                "utilized_cost": utilized_cost_val,
                "idle_cost": idle_cost_val,
                "total_queries": row.get("total_queries") or 0,
                "utilized_queries": row.get("utilized_queries") or 0,
                "utilization_percentage": utilization_pct,
                "idle_percentage": idle_pct,
                "efficiency_grade": _get_efficiency_grade(utilization_pct),
                "status": "good" if utilization_pct > 60 else "warning" if utilization_pct > 30 else "critical",
                "recommendations": warehouse_recs,
                "total_dbus": float(row.get("total_dbus") or 0),
                "utilized_dbus": float(row.get("utilized_dbus") or 0),
            })

        overall_utilization = (total_cost - total_idle_cost) / total_cost * 100 if total_cost > 0 else 0

        return {
            "available": True,
            "warehouses": warehouses,
            "summary": {
                "total_warehouses": len(warehouses),
                "critical_count": len([w for w in warehouses if w["idle_percentage"] > 70]),
                "warning_count": len([w for w in warehouses if 40 < w["idle_percentage"] <= 70]),
                "good_count": len([w for w in warehouses if w["idle_percentage"] <= 40]),
                "total_cost": total_cost,
                "total_idle_cost": total_idle_cost,
                "overall_utilization_percentage": overall_utilization,
                "overall_idle_percentage": 100 - overall_utilization,
            },
            "top_idle_cost_warehouses": warehouses[:10],
            "start_date": start_date,
            "end_date": end_date,
        }

    except Exception as e:
        logger.error(f"Warehouse efficiency query failed: {e}")
        return {"available": False, "message": str(e), "start_date": start_date, "end_date": end_date}
