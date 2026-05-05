"""Auto-provision Lakebase (project → branch → endpoint) on app startup.

Called from server/app.py startup_tasks() when PGHOST is not set. Idempotent:
get_* calls return existing resources instantly on subsequent restarts; create_*
LROs only block on first deploy when resources don't exist yet.

On success, sets os.environ["PGHOST"] so the connection pool and bootstrap
can open. On any failure, logs a warning and leaves the app in OLAP mode.
"""
import logging
import os

logger = logging.getLogger(__name__)

_PROJECT_ID = os.environ.get("LB_PROJECT_ID", "cost-obs-lakebase")
_BRANCH_ID = os.environ.get("LB_BRANCH_ID", "production")
_ENDPOINT_ID = os.environ.get("LB_ENDPOINT_ID", "prod-rw")


def _project_name() -> str:
    return f"projects/{_PROJECT_ID}"


def _branch_name() -> str:
    return f"projects/{_PROJECT_ID}/branches/{_BRANCH_ID}"


def _endpoint_name() -> str:
    return f"projects/{_PROJECT_ID}/branches/{_BRANCH_ID}/endpoints/{_ENDPOINT_ID}"


def provision() -> bool:
    """Provision Lakebase and set PGHOST. Returns True if PGHOST is now set."""
    if os.environ.get("PGHOST"):
        logger.info("Lakebase already configured via PGHOST — skipping provisioning")
        return True

    try:
        from databricks.sdk import WorkspaceClient
        from databricks.sdk.service.postgres import (
            Branch, BranchSpec, Endpoint, EndpointSpec, EndpointType,
            Project, ProjectSpec,
        )
    except ImportError:
        logger.warning("databricks-sdk not available — cannot auto-provision Lakebase")
        return False

    try:
        client = WorkspaceClient()
        pg = client.postgres

        # ── Project ──────────────────────────────────────────────────────────
        try:
            project = pg.get_project(_project_name())
            logger.info("Lakebase project %s already exists", _PROJECT_ID)
        except Exception:
            logger.info("Creating Lakebase project %s …", _PROJECT_ID)
            project = pg.create_project(
                project=Project(spec=ProjectSpec(
                    display_name="Cost Observability Lakebase",
                    pg_version=17,
                )),
                project_id=_PROJECT_ID,
            ).wait()
            logger.info("Lakebase project created: %s", project.name)

        # ── Branch ───────────────────────────────────────────────────────────
        try:
            branch = pg.get_branch(_branch_name())
            logger.info("Lakebase branch %s already exists", _BRANCH_ID)
        except Exception:
            logger.info("Creating Lakebase branch %s …", _BRANCH_ID)
            branch = pg.create_branch(
                parent=_project_name(),
                branch=Branch(spec=BranchSpec(no_expiry=True)),
                branch_id=_BRANCH_ID,
            ).wait()
            logger.info("Lakebase branch created: %s", branch.name)

        # ── Endpoint ─────────────────────────────────────────────────────────
        try:
            endpoint = pg.get_endpoint(_endpoint_name())
            logger.info("Lakebase endpoint %s already exists", _ENDPOINT_ID)
        except Exception:
            logger.info("Creating Lakebase endpoint %s …", _ENDPOINT_ID)
            endpoint = pg.create_endpoint(
                parent=_branch_name(),
                endpoint=Endpoint(spec=EndpointSpec(
                    endpoint_type=EndpointType.ENDPOINT_TYPE_READ_WRITE,
                    autoscaling_limit_min_cu=1,
                    autoscaling_limit_max_cu=4,
                )),
                endpoint_id=_ENDPOINT_ID,
            ).wait()
            logger.info("Lakebase endpoint created: %s", endpoint.name)

        # ── Extract host ──────────────────────────────────────────────────────
        host = (
            endpoint.status.hosts.host
            if endpoint.status and endpoint.status.hosts
            else None
        )
        if not host:
            logger.warning(
                "Lakebase endpoint provisioned but host not available yet — "
                "will retry on next restart. Endpoint: %s", endpoint
            )
            return False

        os.environ["PGHOST"] = host
        os.environ.setdefault("PGDATABASE", "postgres")
        logger.info("Lakebase ready — PGHOST=%s", host)
        return True

    except Exception as exc:
        logger.warning("Lakebase auto-provision failed (non-fatal, running in OLAP mode): %s", exc)
        return False
