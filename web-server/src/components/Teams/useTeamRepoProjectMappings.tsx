import axios from 'axios';
import { useCallback, useEffect } from 'react';

import { useBoolState, useEasyState } from '@/hooks/useEasyState';
import { depFn } from '@/utils/fn';

// CLUSTOX: explicit, informational repo<->Jira-project pairing within a
// team -- see docs/JIRA_MULTI_ACCOUNT_PLAN.md's follow-up on Jira<->repo
// relationships. Deliberately its own hook/component, not folded into
// TeamRepos or TeamJiraProjects: this only makes sense once both of those
// already have a selection to pair, and (like TeamJiraProjects itself)
// saves independently rather than joining an existing "one big form"
// submit.
export type RepoOption = { id: string; name: string };
export type ProjectOption = { org_project_id: string; key: string; name: string };

// repo_id -> the org_project_ids currently paired with it.
export type MappingsByRepo = Record<string, string[]>;

export const useTeamRepoProjectMappings = (teamId: ID) => {
  const repos = useEasyState<RepoOption[]>([]);
  const projects = useEasyState<ProjectOption[]>([]);
  const mappingsByRepo = useEasyState<MappingsByRepo>({});
  const isLoading = useBoolState(Boolean(teamId));
  const isSaving = useBoolState(false);

  const load = useCallback(async () => {
    if (!teamId) return depFn(isLoading.false);
    depFn(isLoading.true);
    try {
      const [repoRows, projectRows, mappingRows] = await Promise.all([
        axios(`/api/resources/team_repos`, { params: { team_id: teamId } }).then(
          (r) => r.data
        ),
        axios(`/api/resources/team_projects`, { params: { team_id: teamId } }).then(
          (r) => r.data
        ),
        axios(`/api/resources/team_repo_project_mappings`, {
          params: { team_id: teamId }
        }).then((r) => r.data)
      ]);

      depFn(
        repos.set,
        repoRows.map((r: { id: string; name: string }) => ({
          id: r.id,
          name: r.name
        }))
      );
      depFn(
        projects.set,
        // CLUSTOX: /api/resources/team_projects (adapt_org_project on the
        // backend) returns the OrgProject id as "id", not "org_project_id" --
        // reading the latter left every project here with the same
        // (undefined) id, which made MUI's Autocomplete treat every project
        // as equal to every other one (see isOptionEqualToValue below).
        projectRows.map((p: { id: string; key: string; name: string }) => ({
          org_project_id: p.id,
          key: p.key,
          name: p.name
        }))
      );

      const grouped: MappingsByRepo = {};
      (
        mappingRows as { org_repo_id: string; org_project_id: string }[]
      ).forEach((m) => {
        grouped[m.org_repo_id] = [
          ...(grouped[m.org_repo_id] || []),
          m.org_project_id
        ];
      });
      depFn(mappingsByRepo.set, grouped);
    } catch (error) {
      console.error(error);
    } finally {
      depFn(isLoading.false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  const setProjectsForRepo = useCallback(
    (repoId: string, projectIds: string[]) => {
      depFn(mappingsByRepo.set, { ...mappingsByRepo.value, [repoId]: projectIds });
    },
    [mappingsByRepo.set, mappingsByRepo.value]
  );

  const save = useCallback(async () => {
    if (!teamId) return;
    depFn(isSaving.true);
    try {
      const mappings = Object.entries(mappingsByRepo.value).flatMap(
        ([repoId, projectIds]) =>
          projectIds.map((projectId) => ({
            org_repo_id: repoId,
            org_project_id: projectId
          }))
      );
      await axios.put('/api/resources/team_repo_project_mappings', {
        team_id: teamId,
        mappings
      });
      return true;
    } catch (error) {
      console.error(error);
      return false;
    } finally {
      depFn(isSaving.false);
    }
  }, [isSaving.false, isSaving.true, mappingsByRepo.value, teamId]);

  return {
    repos: repos.value,
    projects: projects.value,
    mappingsByRepo: mappingsByRepo.value,
    setProjectsForRepo,
    save,
    isLoading: isLoading.value,
    isSaving: isSaving.value
  };
};
