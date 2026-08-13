import { WarningAmberRounded } from '@mui/icons-material';
import {
  CircularProgress,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  useTheme
} from '@mui/material';
import { LoadingButton } from '@mui/lab';
import { FC } from 'react';

import { FlexBox } from '@/components/FlexBox';
import { Line } from '@/components/Text';
import { useAuth } from '@/hooks/useAuth';

import { useTeamRepoProjectMapping } from './useTeamRepoProjectMapping';

// CLUSTOX: which single Jira project (if any) each of this team's repos
// belongs to -- see docs/JIRA_INTEGRATION_PROPOSAL.md, "Repo <-> Project
// Mapping". Only rendered for an existing team (same reasoning as
// TeamJiraProjects: the relationship needs a team_id that must already
// exist) in an org that has Jira linked. Deliberately optional -- a
// repo left unmapped keeps the pre-existing org-wide ticket-matching
// behavior, it isn't blocked from saving.
//
// A table with one Select per row, not a chip grid repeating every
// project's full name in every row -- mirrors DisplayRepos'/
// DeploymentSourceSelector's own "one repo, one dropdown" pattern
// elsewhere in this same file's neighbor, which is both more compact
// and a pattern this app's admins already know from the repo table
// right above this section.
const NO_PROJECT = '__none__';

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
  const theme = useTheme();

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
          <Line tiny secondary>
            {rows.length - unmappedCount} of {rows.length} repo
            {rows.length === 1 ? '' : 's'} connected to a project
          </Line>
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
        <TableContainer
          sx={{
            border: `2px solid ${theme.colors.secondary.light}`,
            borderRadius: 1
          }}
        >
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ px: 2 }}>Repo</TableCell>
                <TableCell sx={{ px: 1 }}>Jira Project</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.org_repo_id}>
                  <TableCell sx={{ px: 2 }}>
                    <FlexBox gap1 alignCenter>
                      {!row.org_project_id && (
                        <WarningAmberRounded
                          fontSize="small"
                          sx={{ color: 'warning.main' }}
                          titleAccess="Not mapped to a project"
                        />
                      )}
                      {row.repo_name}
                    </FlexBox>
                  </TableCell>
                  <TableCell sx={{ px: 1, minWidth: 220 }}>
                    <Select
                      size="small"
                      fullWidth
                      value={row.org_project_id ?? NO_PROJECT}
                      onChange={(e) =>
                        setMapping(
                          row.org_repo_id,
                          e.target.value === NO_PROJECT ? null : e.target.value
                        )
                      }
                    >
                      <MenuItem value={NO_PROJECT}>
                        <Line secondary fontSize="14px">
                          No project
                        </Line>
                      </MenuItem>
                      {projectOptions.map((project) => (
                        <MenuItem key={project.idempotency_key} value={project.id}>
                          <Line fontSize="14px">
                            {project.key} — {project.name}
                          </Line>
                        </MenuItem>
                      ))}
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
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
