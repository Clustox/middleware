export const defaultFlags = {
  dummy_function_flag: (_args: { orgId: ID }) => true,
  use_mock_data: false,
  enable_pr_cycle_time_comparison: false,
  use_hotkeys: true,
  show_deployment_settings: false,
  show_incident_settings: false,
  // CLUSTOX: docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 3 -- gates the new
  // jira-connections API routes and (Task 6) their UI. On by default: the
  // feature is ready for real use. The legacy single-Jira-account flow via
  // orgs/[org_id]/integration.ts is unaffected either way. Still a real
  // flag (not deleted) so it can be switched off per-browser via
  // FlagOverride if ever needed.
  show_jira_multi_account: true
};

export type Features = typeof defaultFlags;
