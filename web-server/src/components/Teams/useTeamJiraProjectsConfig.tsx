import { debounce } from '@mui/material';
import axios, { CanceledError } from 'axios';
import { useSnackbar } from 'notistack';
import {
  SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef
} from 'react';

import { useAuth } from '@/hooks/useAuth';
import { useBoolState, useEasyState } from '@/hooks/useEasyState';
import { useJiraConnections } from '@/hooks/useJiraConnections';
import { depFn } from '@/utils/fn';

// CLUSTOX: Jira integration, Phase 2 (project selection). Deliberately its
// own hook, not folded into useTeamsConfig.tsx's repo-selection state --
// Jira projects have none of a repo's deployment-type/workflow concerns,
// and a team's project links save independently of its name/repos (no
// shared "one big form" submit). Mirrors useTeamsConfig.tsx's
// useReposSearch for the live-search half; see
// docs/JIRA_INTEGRATION_PROPOSAL.md.
export type SelectedJiraProject = {
  id: string;
  key: string;
  name: string;
  provider: string;
  idempotency_key: string;
  // CLUSTOX: which JiraConnection this result came from -- absent for a
  // legacy-flow result. Carried on the search result itself (see
  // jira_project_search.ts) rather than stamped on separately, so a
  // project keeps the right connection even if the picker's selection
  // changes after it was already added. See
  // docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 6 part 2.
  connection_id?: string;
};

const DEBOUNCE_TIME = 500;

// CLUSTOX: connectionId '' means "search the legacy single-account
// Integration row" -- omitted from the request entirely in that case,
// exactly as jira_project_search.ts expects.
const useJiraProjectSearch = (connectionId: string) => {
  const { orgId } = useAuth();
  const searchResults = useEasyState<SelectedJiraProject[]>([]);
  const isLoading = useBoolState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(
    async (query: string) => {
      depFn(isLoading.true);
      if (controllerRef.current) {
        controllerRef.current.abort('Operation canceled due to new request.');
      }
      if (!query) return depFn(isLoading.false);

      controllerRef.current = new AbortController();
      try {
        const response = await axios(
          `/api/internal/${orgId}/jira_project_search`,
          {
            params: {
              search_text: query,
              ...(connectionId ? { connection_id: connectionId } : {})
            },
            signal: controllerRef.current.signal,
            // CLUSTOX: this route can take up to ~8s (it's a live call out
            // to Jira, see jira_project_search.ts's own timeout) and a
            // slow/failing search there returns a retryable-looking 502.
            // The app's global axios instance is configured with
            // axiosRetry(axios, { retries: 2 }) (src/api-helpers/axios.ts),
            // which would otherwise retry that 502 twice more, silently
            // stretching one search into a ~24s wait that reads as a stuck
            // loader. Search-as-you-type has its own recovery already (the
            // next keystroke fires a fresh request), so a slow one here
            // should fail fast, not retry.
            'axios-retry': { retries: 0 }
          }
        );
        depFn(searchResults.set, response.data);
        depFn(isLoading.false);
      } catch (error: any) {
        if (!(error instanceof CanceledError)) {
          depFn(isLoading.false);
          console.error(error);
        }
      }
    },
    [orgId, connectionId]
  );

  const debouncedSearch = useMemo(
    () => debounce((query: string) => fetchData(query), DEBOUNCE_TIME),
    [fetchData]
  );

  const onSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      debouncedSearch(e.target.value);
    },
    [debouncedSearch]
  );

  return {
    searchResults: searchResults.value,
    onSearchChange,
    isSearching: isLoading.value
  };
};

export const useTeamJiraProjectsConfig = (teamId: ID) => {
  const { orgId } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const selections = useEasyState<SelectedJiraProject[]>([]);
  const isLoading = useBoolState(Boolean(teamId));
  const isSaving = useBoolState(false);
  // CLUSTOX: '' (legacy) by default -- an admin who has never touched
  // multi-account Jira sees exactly the search behaviour this always had.
  const selectedConnectionId = useEasyState('');
  const { connections } = useJiraConnections(orgId);
  const { searchResults, onSearchChange, isSearching } = useJiraProjectSearch(
    selectedConnectionId.value
  );

  useEffect(() => {
    if (!teamId) return depFn(isLoading.false);
    depFn(isLoading.true);
    axios(`/api/resources/team_projects`, { params: { team_id: teamId } })
      .then((res) => depFn(selections.set, res.data))
      .catch((error) => console.error(error))
      .finally(isLoading.false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  const projectOptions = useMemo(
    () =>
      searchResults.filter(
        (project) =>
          !selections.value.find((s) => s.idempotency_key === project.idempotency_key)
      ),
    [searchResults, selections.value]
  );

  const handleSelectionChange = useCallback(
    (_: SyntheticEvent, value: SelectedJiraProject[]) => {
      depFn(selections.set, value);
    },
    [selections.set]
  );

  const unselectProject = useCallback(
    (idempotencyKey: string) => {
      depFn(
        selections.set,
        selections.value.filter((p) => p.idempotency_key !== idempotencyKey)
      );
    },
    [selections.set, selections.value]
  );

  const onSave = useCallback(async () => {
    if (!teamId) return;
    depFn(isSaving.true);
    try {
      await axios.put('/api/resources/team_projects', {
        team_id: teamId,
        projects: selections.value.map((p) => ({
          key: p.key,
          name: p.name,
          provider: p.provider,
          idempotency_key: p.idempotency_key,
          // Undefined for a project loaded back from a prior save (the
          // GET response doesn't surface it yet) or picked via the legacy
          // flow -- the backend leaves an existing connection association
          // alone rather than erasing it when this is absent, so
          // re-saving an untouched selection is safe.
          ...(p.connection_id ? { connection_id: p.connection_id } : {})
        }))
      });
      enqueueSnackbar('Jira projects updated', {
        variant: 'success',
        autoHideDuration: 2000
      });
    } catch (error) {
      console.error(error);
      enqueueSnackbar('Failed to update Jira projects', {
        variant: 'error',
        autoHideDuration: 2000
      });
    } finally {
      depFn(isSaving.false);
    }
  }, [enqueueSnackbar, isSaving.false, isSaving.true, selections.value, teamId]);

  return {
    selectedProjects: selections.value,
    projectOptions,
    handleSelectionChange,
    unselectProject,
    onSearchChange,
    isSearching,
    isLoading: isLoading.value,
    isSaving: isSaving.value,
    onSave,
    connections,
    selectedConnectionId: selectedConnectionId.value,
    setSelectedConnectionId: selectedConnectionId.set
  };
};
