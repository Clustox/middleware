import { WarningAmberRounded } from '@mui/icons-material';
import { Chip, CircularProgress } from '@mui/material';
import { LoadingButton } from '@mui/lab';
import { FC } from 'react';

import { FlexBox } from '@/components/FlexBox';
import { Line } from '@/components/Text';
import { useAuth } from '@/hooks/useAuth';

import { SelectedJiraProject } from './useTeamJiraProjectsConfig';
import { useTeamRepoProjectMapping } from './useTeamRepoProjectMapping';

// CLUSTOX: which single Jira project (if any) each of this team's repos
// belongs to -- see docs/JIRA_INTEGRATION_PROPOSAL.md, "Repo <-> Project
// Mapping". Only rendered for an existing team (same reasoning as
// TeamJiraProjects: the relationship needs a team_id that must already
// exist) in an org that has Jira linked. Deliberately optional -- a
// repo left unmapped keeps the pre-existing org-wide ticket-matching
// behavior, it isn't blocked from saving.
export const TeamRepoProjectMapping: FC<{ teamId: ID }> = ({ teamId }) => {
  const { integrations } = useAuth();
  const isJiraLinked = Boolean(integrations?.jira?.integrated);

  if (!teamId || !isJiraLinked) return null;

  return <TeamRepoProjectMappingBody teamId={teamId} />;
};

const TeamRepoProjectMappingBody: FC<{ teamId: ID }> = ({ teamId }) => {
  const {
    rows,
    projectOptions,
    hasProjectOptions,
    unmappedCount,
    setMapping,
    isLoading,
    isSaving,
    onSave
  } = useTeamRepoProjectMapping(teamId);

  if (isLoading) {
    return (
      <FlexBox alignCenter gap2>
        <CircularProgress size="20px" />
        <Line>Loading repo → project mapping...</Line>
      </FlexBox>
    );
  }

  if (!rows.length) return null;

  return (
    <FlexBox col gap={2}>
      <FlexBox col>
        <FlexBox alignCenter justifyBetween gap2 flexWrap="wrap">
          <Line big semibold>
            Repo &#8596; Project Mapping
          </Line>
          {rows.length > 0 && (
            <Line tiny secondary>
              {rows.length - unmappedCount} of {rows.length} repo
              {rows.length === 1 ? '' : 's'} connected to a project
            </Line>
          )}
        </FlexBox>
        <Line>
          For each repo, pick at most one Jira project its tickets come
          from. Ticket matching only looks at the project mapped here —
          not the whole org. Optional: an unmapped repo keeps matching
          against every synced ticket, same as before.
        </Line>
      </FlexBox>

      {!hasProjectOptions ? (
        <Line secondary>
          Select at least one Jira project above before mapping repos to
          it.
        </Line>
      ) : (
        <FlexBox col gap={1.5}>
          {rows.map((row) => (
            <RepoMappingRowView
              key={row.org_repo_id}
              repoName={row.repo_name}
              selectedProjectId={row.org_project_id}
              projectOptions={projectOptions}
              onSelect={(projectId) => setMapping(row.org_repo_id, projectId)}
            />
          ))}
        </FlexBox>
      )}

      {unmappedCount > 0 && (
        <FlexBox alignCenter gap1 sx={{ color: 'warning.main' }}>
          <WarningAmberRounded fontSize="small" />
          <Line tiny>
            {unmappedCount} repo{unmappedCount === 1 ? '' : 's'} not mapped
            to a project yet
          </Line>
        </FlexBox>
      )}

      <FlexBox>
        <LoadingButton
          loading={isSaving}
          disabled={isSaving}
          variant="contained"
          onClick={onSave}
        >
          Save mapping
        </LoadingButton>
      </FlexBox>
    </FlexBox>
  );
};

const RepoMappingRowView: FC<{
  repoName: string;
  selectedProjectId: string | null;
  projectOptions: SelectedJiraProject[];
  onSelect: (projectId: string | null) => void;
}> = ({ repoName, selectedProjectId, projectOptions, onSelect }) => {
  const selectedProject = projectOptions.find((p) => p.id === selectedProjectId);

  return (
    <FlexBox
      col
      gap={1}
      p={1.5}
      sx={{
        border: '1px solid',
        borderColor: selectedProject ? 'primary.main' : 'divider',
        borderRadius: 1
      }}
    >
      {/* CLUSTOX: the mapping state as text, not just chip styling -- the
          row's own header says outright which project this repo is
          connected to (or that it isn't), so the answer to "which
          project is connected with which repo" is readable at a glance
          without having to spot which chip below happens to be filled. */}
      <FlexBox justifyBetween alignCenter gap2 flexWrap="wrap">
        <Line semibold>{repoName}</Line>
        {selectedProject ? (
          <Line tiny sx={{ color: 'primary.main' }}>
            &#8594; {selectedProject.key} — {selectedProject.name}
          </Line>
        ) : (
          <Line tiny secondary>
            &#8594; No project connected
          </Line>
        )}
      </FlexBox>
      <FlexBox gap1 flexWrap="wrap">
        <Chip
          size="small"
          label="No project"
          variant={selectedProjectId ? 'outlined' : 'filled'}
          color={selectedProjectId ? 'default' : 'primary'}
          onClick={() => onSelect(null)}
        />
        {projectOptions.map((project) => {
          const selected = selectedProjectId === project.id;
          return (
            <Chip
              key={project.idempotency_key}
              size="small"
              label={`${project.key} — ${project.name}`}
              variant={selected ? 'filled' : 'outlined'}
              color={selected ? 'primary' : 'default'}
              onClick={() => onSelect(project.id)}
            />
          );
        })}
      </FlexBox>
    </FlexBox>
  );
};
