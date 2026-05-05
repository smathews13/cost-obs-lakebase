export function Footer() {
  return (
    <footer className="mt-8 border-t border-gray-200 bg-white py-6">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 gap-8">
          {/* System Tables */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-700">
              Databricks System Tables
            </h3>
            <ul className="space-y-1 text-xs text-gray-500">
              <li>
                <a href="https://docs.databricks.com/en/administration-guide/system-tables/billing.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  system.billing.usage
                </a>
              </li>
              <li>
                <a href="https://docs.databricks.com/en/administration-guide/system-tables/billing.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  system.billing.list_prices
                </a>
              </li>
              <li>
                <a href="https://docs.databricks.com/en/administration-guide/system-tables/query-history.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  system.query.history
                </a>
              </li>
              <li>
                <a href="https://docs.databricks.com/en/administration-guide/system-tables/compute.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  system.compute.clusters
                </a>
              </li>
              <li>
                <a href="https://docs.databricks.com/en/administration-guide/system-tables/lakeflow.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  system.lakeflow.jobs
                </a>
              </li>
              <li>
                <a href="https://docs.databricks.com/en/administration-guide/system-tables/lakeflow.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  system.lakeflow.job_runs
                </a>
              </li>
              <li>
                <a href="https://docs.databricks.com/en/administration-guide/system-tables/access.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  system.access.table_lineage
                </a>
              </li>
            </ul>
          </div>

          {/* Resources & Links */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-700">
              Resources &amp; Documentation
            </h3>
            <ul className="space-y-1 text-xs text-gray-500">
              <li>
                <a href="https://docs.databricks.com/en/administration-guide/system-tables/index.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  System Tables Documentation
                </a>
              </li>
              <li>
                <a href="https://docs.databricks.com/en/administration-guide/account-settings/usage.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  Usage &amp; Billing Guide
                </a>
              </li>
              <li>
                <a href="https://www.databricks.com/product/pricing" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  Databricks Pricing
                </a>
              </li>
              <li>
                <a href="https://docs.databricks.com/en/sql/user/alerts.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  SQL Alerts Documentation
                </a>
              </li>
              <li>
                <a href="https://www.databricks.com/product/databricks-apps" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  Databricks Apps
                </a>
              </li>
              <li>
                <a href="https://github.com/databricks/databricks-sdk-py" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  Databricks SDK (Python)
                </a>
              </li>
              <li className="pt-1">
                <span className="font-semibold text-gray-700">Private Preview Repos:</span>
              </li>
              <li className="pl-2">
                <a href="https://github.com/databrickslabs/sandbox/tree/main/dbsql/cost_per_query/PrPr" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  DBSQL Cost Granularity
                </a>
              </li>
              <li className="pl-2">
                <a href="https://github.com/databricks-solutions/cloud-infra-costs/tree/main/aws" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  Cloud Infrastructure Costs
                </a>
              </li>
              <li className="pl-2">
                <a href="https://github.com/numanali-db/Cost-Reporting-Genie" target="_blank" rel="noopener noreferrer" className="hover:text-gray-700 hover:underline">
                  Cost Analysis Genie
                </a>
              </li>
            </ul>
          </div>
        </div>

        {/* Copyright */}
        <div className="mt-6 border-t border-gray-200 pt-4">
          <p className="text-center text-xs text-gray-500">
            Built with Databricks Apps • Powered by System Tables • Data refreshed every 24 hours
          </p>
        </div>
      </div>
    </footer>
  );
}
