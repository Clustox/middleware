import {
  Autocomplete,
  Chip,
  CircularProgress,
  TextField
} from '@mui/material';
import { LoadingButton } from '@mui/lab';
import { useSnackbar } from 'notistack';
import { FC, useCallback } from 'react';

import { FlexBox } from '@/components/FlexBox';
import { Line } from '@/components/Text';

import {
  ProjectOption,
  useTeamRepoProjectMappings
} from './useTeamRepoProjectMappings';

// CLUSTOX: explicit, informational repo<->Jira-project pairing -- see
// docs/JIRA_MULTI_ACCOUNT_PLAN.md's follow-up on Jira<->repo
// relationships. Rendered only once the team already has at least one
// repo and one project selected (TeamRepos/TeamJiraProjects); pairing
// nothing to nothing isn't a screen worth showing. Never affects PR<->
// ticket matching or any DORA metric -- purely organizational, see
// useTeamRepoProjectMappings's own comment.
export const TeamRepoProjectMappings: FC<{ teamId: ID }> = ({ teamId }) => {
  const {
    repos,
    projects,
    mappingsByRepo,
    setProjectsForRepo,
    save,
    isLoading,
    isSaving
  } = useTeamRepoProjectMappings(teamId);
  const { enqueueSnackbar } = useSnackbar();

  const onSave = useCallback(async () => {
    const ok = await save();
    enqueueSnackbar(
      ok ? 'Repo/project pairings updated' : 'Failed to update pairings',
      { variant: ok ? 'success' : 'error', autoHideDuration: 2000 }
    );
  }, [save, enqueueSnackbar]);

  if (isLoading) {
    return (
      <FlexBox alignCenter gap2>
        <CircularProgress size="20px" />
        <Line>Loading repo/project pairings...</Line>
      </FlexBox>
    );
  }

  if (!repos.length || !projects.length) return null;

  const projectById = new Map(projects.map((p) => [p.org_project_id, p]));

  return (
    <FlexBox col gap={2}>
      <FlexBox col>
        <Line big semibold>
          Repo ↔ Project pairing
        </Line>
        <Line>
          Optional -- record which Jira project each repo&apos;s tickets
          come from. This is for organization only and never changes how a
          PR gets linked to a ticket (that&apos;s always by the Jira key in
          the PR title).
        </Line>
      </FlexBox>

      {repos.map((repo) => (
        <FlexBox key={repo.id} alignCenter gap={2}>
          <Line medium sx={{ width: '220px', flexShrink: 0 }}>
            {repo.name}
          </Line>
          <Autocomplete
            multiple
            size="small"
            sx={{ width: '420px' }}
            options={projects}
            value={(mappingsByRepo[repo.id] || [])
              .map((id) => projectById.get(id))
              .filter(Boolean) as ProjectOption[]}
            onChange={(_, value) =>
              setProjectsForRepo(
                repo.id,
                value.map((p) => p.org_project_id)
              )
            }
            getOptionLabel={(option) => `${option.key} — ${option.name}`}
            isOptionEqualToValue={(option, value) =>
              option.org_project_id === value.org_project_id
            }
            renderTags={(value, getTagProps) =>
              value.map((option, index) => (
                <Chip
                  size="small"
                  label={option.key}
                  {...getTagProps({ index })}
                  key={option.org_project_id}
                />
              ))
            }
            renderInput={(params) => (
              <TextField
                {...params}
                placeholder={
                  mappingsByRepo[repo.id]?.length ? '' : 'No project linked'
                }
              />
            )}
          />
        </FlexBox>
      ))}

      <FlexBox justifyEnd>
        <LoadingButton
          loading={isSaving}
          disabled={isSaving}
          variant="contained"
          onClick={onSave}
        >
          Save pairings
        </LoadingButton>
      </FlexBox>
    </FlexBox>
  );
};
