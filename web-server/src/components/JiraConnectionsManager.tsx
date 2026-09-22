import { DeleteOutline, StarRounded, StarOutlineRounded } from '@mui/icons-material';
import { LoadingButton } from '@mui/lab';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  useTheme
} from '@mui/material';
import { useCallback, useState } from 'react';

import { FlexBox } from '@/components/FlexBox';
import { Line } from '@/components/Text';
// CLUSTOX: server-resolved workspace, consistent with every other
// integration modal (ConfigureJiraModalBody, ClustoxJenkinsSetup, ...).
import { useClustoxUser } from '@/hooks/useClustoxUser';
import { JiraConnection, useJiraConnections } from '@/hooks/useJiraConnections';
import { readApiError } from '@/utils/api-error';
import { normalizeJiraSiteUrl } from '@/utils/auth';

// CLUSTOX: the server's own words whenever it sent any -- a 409 here means
// "already connected" (create) or "still has projects synced from it"
// (delete), and both are things only the admin looking at this screen can
// fix. Mirrors ClustoxJenkinsMapping's mutationError.
const mutationError = (err: unknown, fallback: string) => {
  const { status, message } = readApiError(err);
  return status && status < 500 && message ? message : fallback;
};

const emptyForm = { site_url: '', email: '', access_token: '' };

/**
 * CLUSTOX: Jira multi-account support -- see
 * docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 6. Lists an org's JiraConnection
 * rows and lets an admin add, remove, or change the default one.
 * Deliberately separate from ConfigureJiraModalBody/JiraIntegrationCard,
 * which keep managing the legacy, single-account Integration row
 * unchanged -- the two flows are independent by design (see the plan's
 * Global Constraints).
 */
export const JiraConnectionsManager = () => {
  const theme = useTheme();
  const { orgId } = useClustoxUser();
  const { connections, loading, failed, create, remove, setDefault } =
    useJiraConnections(orgId);

  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState('');
  const [creating, setCreating] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<JiraConnection | null>(
    null
  );

  const submitCreate = useCallback(async () => {
    if (!form.site_url || !form.email || !form.access_token) {
      setFormError('Please fill in all three fields');
      return;
    }
    setFormError('');
    setCreating(true);
    try {
      // CLUSTOX: matches ConfigureJiraModalBody's legacy-flow behavior --
      // a URL pasted straight from the browser's address bar
      // ("https://acme.atlassian.net/") must become the bare host, or
      // the backend builds an unreachable, doubly-prefixed URL from it
      // at search/sync time. The backend also normalizes this now (the
      // authoritative fix, since a form is never the only caller), but
      // showing the actual value that gets saved here avoids a
      // could-look-wrong round trip.
      await create({ ...form, site_url: normalizeJiraSiteUrl(form.site_url) });
      setForm(emptyForm);
    } catch (e) {
      setFormError(
        mutationError(e, 'Could not add this connection. Try again.')
      );
    } finally {
      setCreating(false);
    }
  }, [create, form]);

  const submitSetDefault = useCallback(
    async (connection: JiraConnection) => {
      setRowError('');
      setRowBusyId(connection.id);
      try {
        await setDefault(connection.id);
      } catch (e) {
        setRowError(
          mutationError(e, 'Could not set this connection as default.')
        );
      } finally {
        setRowBusyId(null);
      }
    },
    [setDefault]
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setRowError('');
    setRowBusyId(pendingDelete.id);
    try {
      await remove(pendingDelete.id);
      setPendingDelete(null);
    } catch (e) {
      setRowError(
        mutationError(
          e,
          'Could not remove this connection. Try again.'
        )
      );
      setPendingDelete(null);
    } finally {
      setRowBusyId(null);
    }
  }, [pendingDelete, remove]);

  return (
    <FlexBox col gap={2} minWidth="560px">
      {failed && (
        <Alert severity="error">
          Could not load Jira connections. Try again in a moment.
        </Alert>
      )}

      <FlexBox col gap={1}>
        <Line medium>Add a connection</Line>
        <FlexBox gap={1} flexWrap="wrap" alignItems="flex-start">
          <TextField
            size="small"
            label="Jira Site URL"
            placeholder="yourcompany.atlassian.net"
            value={form.site_url}
            onChange={(e) => setForm({ ...form, site_url: e.target.value })}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            InputLabelProps={{ shrink: true }}
          />
          <TextField
            size="small"
            label="API Token"
            type="password"
            value={form.access_token}
            onChange={(e) =>
              setForm({ ...form, access_token: e.target.value })
            }
            InputLabelProps={{ shrink: true }}
          />
          <LoadingButton
            variant="contained"
            loading={creating}
            onClick={submitCreate}
          >
            Add
          </LoadingButton>
        </FlexBox>
        {formError && (
          <Line error tiny>
            {formError}
          </Line>
        )}
      </FlexBox>

      {loading ? (
        <FlexBox p={4} justifyCenter>
          <CircularProgress />
        </FlexBox>
      ) : (
        <TableContainer
          sx={{
            border: `1px solid ${theme.colors.alpha.trueWhite[10]}`,
            borderRadius: 1.5,
            overflow: 'hidden'
          }}
        >
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Site</TableCell>
                <TableCell>Email</TableCell>
                <TableCell align="center">Default</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {connections.map((connection) => (
                <TableRow key={connection.id} hover>
                  <TableCell>{connection.site_url}</TableCell>
                  <TableCell>{connection.email}</TableCell>
                  <TableCell align="center">
                    <Tooltip
                      title={
                        connection.is_default
                          ? 'This is the default connection'
                          : 'Set as default'
                      }
                    >
                      <span>
                        <IconButton
                          size="small"
                          disabled={
                            connection.is_default ||
                            rowBusyId === connection.id
                          }
                          aria-label={`Set ${connection.site_url} as the default connection`}
                          onClick={() => submitSetDefault(connection)}
                        >
                          {connection.is_default ? (
                            <StarRounded fontSize="small" color="warning" />
                          ) : (
                            <StarOutlineRounded fontSize="small" />
                          )}
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right">
                    {rowBusyId === connection.id ? (
                      <CircularProgress size={16} />
                    ) : (
                      <Tooltip title="Remove this connection">
                        <IconButton
                          size="small"
                          aria-label={`Remove the ${connection.site_url} connection`}
                          onClick={() => setPendingDelete(connection)}
                        >
                          <DeleteOutline fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!connections.length && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Line secondary>No Jira connections yet.</Line>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {rowError && (
        <Line error tiny>
          {rowError}
        </Line>
      )}

      <Dialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
      >
        <DialogTitle>
          Remove {pendingDelete?.site_url}?
        </DialogTitle>
        <DialogContent>
          <FlexBox col gap={1}>
            <Line>
              This connection&apos;s projects and their synced data are kept,
              but nothing more will sync from it once removed.
            </Line>
            <Line secondary small>
              If any team&apos;s projects still come from this connection,
              removal is blocked until they&apos;re moved elsewhere.
            </Line>
          </FlexBox>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            variant="outlined"
            color="secondary"
            onClick={() => setPendingDelete(null)}
          >
            Cancel
          </Button>
          <LoadingButton
            variant="contained"
            color="error"
            loading={rowBusyId === pendingDelete?.id}
            onClick={confirmDelete}
          >
            Remove connection
          </LoadingButton>
        </DialogActions>
      </Dialog>
    </FlexBox>
  );
};
