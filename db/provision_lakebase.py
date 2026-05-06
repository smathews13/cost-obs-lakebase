"""Auto-provision Lakebase (project → branch → endpoint) on app startup.

Called from server/app.py startup_tasks() when PGHOST is not set. Idempotent:
get_* calls return existing resources instantly on subsequent restarts; create_*
LROs only block on first deploy when resources don't exist yet.

On success, sets os.environ["PGHOST"] so the connection pool and bootstrap
can open. On any failure, logs a warning and leaves the app in OLAP mode.
"""
import datetime
import json
import logging
import os
import traceback

logger = logging.getLogger(__name__)

_PROJECT_ID = os.environ.get("LB_PROJECT_ID", "cost-obs-lakebase")
_BRANCH_ID = os.environ.get("LB_BRANCH_ID", "production")
_ENDPOINT_ID = os.environ.get("LB_ENDPOINT_ID", "prod-rw")

_STATUS_PATH = os.path.join(os.path.dirname(__file__), "..", ".settings", "lakebase_provision_log.json")


def _write_status(stage: str, status: str, error: str | None = None, host: str | None = None) -> None:
    try:
        os.makedirs(os.path.dirname(_STATUS_PATH), exist_ok=True)
        payload = {
            "stage": stage,
            "status": status,
            "updated_utc": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "project_id": _PROJECT_ID,
            "branch_id": _BRANCH_ID,
            "endpoint_id": _ENDPOINT_ID,
            "host": host,
            "error": error,
        }
        tmp = _STATUS_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(payload, f)
        os.replace(tmp, _STATUS_PATH)
    except Exception as e:
        logger.debug("Could not write lakebase status file: %s", e)


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
        _write_status("done", "active", host=os.environ["PGHOST"])
        return True

    try:
        from databricks.sdk import WorkspaceClient
        from databricks.sdk.service.postgres import (
            Branch, BranchSpec, Endpoint, EndpointSpec, EndpointType,
            Project, ProjectSpec,
        )
        from databricks.sdk.common import lro as _lro
    except ImportError as e:
        msg = f"databricks-sdk import failed: {e}"
        logger.warning(msg)
        _write_status("import", "failed", error=msg)
        return False

    _LRO_OPTS = _lro.LroOptions(timeout=datetime.timedelta(minutes=10))

    try:
        _write_status("connecting", "running")
        client = WorkspaceClient()
        pg = client.postgres
        logger.info("Lakebase: WorkspaceClient connected, postgres API available")

        # ── Project ──────────────────────────────────────────────────────────
        _write_status("project", "running")
        try:
            project = pg.get_project(_project_name())
            logger.info("Lakebase project %s already exists", _PROJECT_ID)
        except Exception as e:
            logger.info("Creating Lakebase project %s … (get failed: %s)", _PROJECT_ID, e)
            _write_status("project", "creating")
            project = pg.create_project(
                project=Project(spec=ProjectSpec(
                    display_name="Cost Observability Lakebase",
                    pg_version=17,
                )),
                project_id=_PROJECT_ID,
            ).wait(opts=_LRO_OPTS)
            logger.info("Lakebase project created: %s", project.name)

        # ── Branch ───────────────────────────────────────────────────────────
        _write_status("branch", "running")
        try:
            branch = pg.get_branch(_branch_name())
            logger.info("Lakebase branch %s already exists", _BRANCH_ID)
        except Exception as e:
            logger.info("Creating Lakebase branch %s … (get failed: %s)", _BRANCH_ID, e)
            _write_status("branch", "creating")
            branch = pg.create_branch(
                parent=_project_name(),
                branch=Branch(spec=BranchSpec(no_expiry=True)),
                branch_id=_BRANCH_ID,
            ).wait(opts=_LRO_OPTS)
            logger.info("Lakebase branch created: %s", branch.name)

        # ── Endpoint ─────────────────────────────────────────────────────────
        _write_status("endpoint", "running")
        endpoint = None
        try:
            endpoint = pg.get_endpoint(_endpoint_name())
            logger.info("Lakebase endpoint %s already exists", _ENDPOINT_ID)
        except Exception as e:
            logger.info("get_endpoint failed (%s) — checking list before creating", e)
            # An endpoint with a different ID may already exist (only one RW allowed per branch)
            try:
                existing = list(pg.list_endpoints(_branch_name()))
                if existing:
                    endpoint = existing[0]
                    logger.info("Found existing endpoint via list: %s", endpoint.name)
            except Exception as le:
                logger.info("list_endpoints also failed: %s", le)

        if endpoint is None:
            logger.info("No existing endpoint found — creating %s", _ENDPOINT_ID)
            _write_status("endpoint", "creating")
            endpoint = pg.create_endpoint(
                parent=_branch_name(),
                endpoint=Endpoint(spec=EndpointSpec(
                    endpoint_type=EndpointType.ENDPOINT_TYPE_READ_WRITE,
                    autoscaling_limit_min_cu=1,
                    autoscaling_limit_max_cu=4,
                )),
                endpoint_id=_ENDPOINT_ID,
            ).wait(opts=_LRO_OPTS)
            logger.info("Lakebase endpoint created: %s", endpoint.name)

        # ── Extract host ──────────────────────────────────────────────────────
        host = (
            endpoint.status.hosts.host
            if endpoint.status and endpoint.status.hosts
            else None
        )
        if not host:
            msg = f"Endpoint provisioned but host not available yet. endpoint={endpoint}"
            logger.warning("Lakebase: %s", msg)
            _write_status("endpoint", "no_host", error=msg)
            return False

        os.environ["PGHOST"] = host
        os.environ.setdefault("PGDATABASE", "postgres")
        logger.info("Lakebase ready — PGHOST=%s", host)
        _write_status("done", "active", host=host)
        return True

    except Exception as exc:
        tb = traceback.format_exc()
        logger.warning("Lakebase auto-provision failed (non-fatal, running in OLAP mode):\n%s", tb)
        _write_status("failed", "failed", error=f"{exc}\n\n{tb}"[:2000])
        return False
