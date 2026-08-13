import axios from 'axios';
import { useCallback, useEffect, useMemo } from 'react';
import { useSnackbar } from 'notistack';

import { useBoolState, useEasyState } from '@/hooks/useEasyState';
import { depFn } from '@/utils/fn';

import { SelectedJiraProject } from './useTeamJiraProjectsConfig';

// CLUSTOX: which single Jira project (if any) each of a team's repos
// maps to -- see docs/JIRA_INTEGRATION_PROPOSAL.md, "Repo <-> Project
// Mapping". Its own hook, own fetch, own save action -- same
// independence TeamJiraProjects/useTeamJiraProjectsConfig already has
// from the repo-selection flow, applied consistently to this third,
// separate relationship.
export type RepoMappingRow = {
  org_repo_id: string;
  repo_name: string;
  org_project_id: string | null;
};

export const useTeamRepoProjectMapping = (teamId: ID) => {
  const { enqueueSnackbar } = useSnackbar();
  const rows = useEasyState<RepoMappingRow[]>([]);
  const projectOptions = useEasyState<SelectedJiraProject[]>([]);
  const isLoading = useBoolState(Boolean(teamId));
  const isSaving = useBoolState(false);

  useEffect(() => {
    if (!teamId) return depFn(isLoading.false);
    depFn(isLoading.true);

    Promise.all([
      axios('/api/resources/team_repo_project_mapping', {
        params: { team_id: teamId }
      }),
      axios('/api/resources/team_projects', { params: { team_id: teamId } })
    ])
      .then(([mappingRes, projectsRes]) => {
        depFn(rows.set, mappingRes.data);
        depFn(projectOptions.set, projectsRes.data);
      })
      .catch((error) => console.error(error))
      .finally(isLoading.false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  // Repos with no Jira project selected for the team at all have
  // nothing to map to -- surfacing that distinctly from "mapped to
  // nothing yet" avoids a picker with zero real options.
  const hasProjectOptions = projectOptions.value.length > 0;

  const setMapping = useCallback(
    (orgRepoId: string, orgProjectId: string | null) => {
      depFn(
        rows.set,
        rows.value.map((row) =>
          row.org_repo_id === orgRepoId
            ? { ...row, org_project_id: orgProjectId }
            : row
        )
      );
    },
    [rows.set, rows.value]
  );

  const unmappedCount = useMemo(
    () => rows.value.filter((row) => !row.org_project_id).length,
    [rows.value]
  );

  const onSave = useCallback(async () => {
    if (!teamId) return;
    depFn(isSaving.true);
    try {
      const res = await axios.put('/api/resources/team_repo_project_mapping', {
        team_id: teamId,
        mappings: rows.value.map((row) => ({
          org_repo_id: row.org_repo_id,
          org_project_id: row.org_project_id
        }))
      });
      depFn(rows.set, res.data);
      enqueueSnackbar('Repo → project mapping updated', {
        variant: 'success',
        autoHideDuration: 2000
      });
    } catch (error) {
      console.error(error);
      enqueueSnackbar('Failed to update repo → project mapping', {
        variant: 'error',
        autoHideDuration: 2000
      });
    } finally {
      depFn(isSaving.false);
    }
  }, [enqueueSnackbar, isSaving.false, isSaving.true, rows.set, rows.value, teamId]);

  return {
    rows: rows.value,
    projectOptions: projectOptions.value,
    hasProjectOptions,
    unmappedCount,
    setMapping,
    isLoading: isLoading.value,
    isSaving: isSaving.value,
    onSave
  };
};
