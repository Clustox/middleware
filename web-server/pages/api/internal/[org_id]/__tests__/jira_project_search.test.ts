jest.mock('@/auth/session', () => ({ getAuthSession: jest.fn() }));
jest.mock('axios');
jest.mock('@/utils/db', () => ({ db: jest.fn() }));
jest.mock('@/utils/auth-supplementary', () => ({ dec: jest.fn() }));

import axios from 'axios';

import { getAuthSession } from '@/auth/session';
import { dec } from '@/utils/auth-supplementary';
import { db } from '@/utils/db';

import searchHandler from '../jira_project_search';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.send = jest.fn(() => res);
  // CLUSTOX: the real res is an untouched http.ServerResponse (EventEmitter),
  // and the handler listens for 'close' to abort the outbound Jira call if
  // the client disconnects mid-search -- see jira_project_search.ts's own
  // comment. This plain mock needs at least a no-op .on to match that shape.
  res.on = jest.fn();
  return res;
};

const mockReq = (query: Record<string, unknown> = {}) =>
  ({ method: 'GET', query: { org_id: ORG_ID, ...query }, body: {}, headers: {} }) as any;

const asAuthed = () =>
  (getAuthSession as jest.Mock).mockResolvedValue({
    userId: 'u1',
    email: 'admin@clustox.com',
    name: 'Admin',
    role: 'SUPERADMIN'
  });

// CLUSTOX: this route reads an Integration row via a real knex chain
// (db('Integration').select(...).where(...).first()), not a one-shot
// call -- stub the whole chain rather than just `db` itself. Mirrors the
// same auth/no-DB test setup already used by
// pages/api/integrations/jira/__tests__/validate.test.ts for the rest.
const mockDbChain = (row: any) => {
  const chain: any = {};
  chain.select = jest.fn(() => chain);
  chain.where = jest.fn(() => chain);
  chain.first = jest.fn().mockResolvedValue(row);
  (db as unknown as jest.Mock).mockReturnValue(chain);
  return chain;
};

describe('GET /api/internal/[org_id]/jira_project_search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asAuthed();
  });

  it('requires an authenticated session', async () => {
    (getAuthSession as jest.Mock).mockResolvedValue(null);
    mockDbChain(undefined);
    const res = mockRes();

    await searchHandler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('reports not-linked, and never calls Jira, when the org has no Jira integration row', async () => {
    mockDbChain(undefined);
    const res = mockRes();

    await searchHandler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('searches Jira and maps results, scoping idempotency_key by org_id', async () => {
    mockDbChain({
      provider_meta: { site_url: 'mycompany.atlassian.net', email: 'a@b.com' },
      access_token_enc_chunks: ['enc1']
    });
    (dec as jest.Mock).mockReturnValue('decrypted-token');
    (axios.get as jest.Mock).mockResolvedValue({
      data: {
        values: [
          { id: '10001', key: 'PAY', name: 'Payments' },
          { id: '10002', key: 'ENG', name: 'Engineering' }
        ]
      }
    });
    const res = mockRes();

    await searchHandler(mockReq({ search_text: 'pay' }), res);

    expect(axios.get).toHaveBeenCalledWith(
      'https://mycompany.atlassian.net/rest/api/3/project/search',
      expect.objectContaining({
        auth: { username: 'a@b.com', password: 'decrypted-token' },
        params: { maxResults: 50, query: 'pay' }
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith([
      {
        id: '10001',
        key: 'PAY',
        name: 'Payments',
        idempotency_key: `jira:${ORG_ID}:10001`,
        provider: 'jira'
      },
      {
        id: '10002',
        key: 'ENG',
        name: 'Engineering',
        idempotency_key: `jira:${ORG_ID}:10002`,
        provider: 'jira'
      }
    ]);
  });

  it('omits the query param when no search_text was given', async () => {
    mockDbChain({
      provider_meta: { site_url: 'mycompany.atlassian.net', email: 'a@b.com' },
      access_token_enc_chunks: ['enc1']
    });
    (dec as jest.Mock).mockReturnValue('decrypted-token');
    (axios.get as jest.Mock).mockResolvedValue({ data: { values: [] } });
    const res = mockRes();

    await searchHandler(mockReq(), res);

    expect(axios.get).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ params: { maxResults: 50 } })
    );
  });

  it.each([401, 403])(
    'reports 401 when Jira rejects the stored credentials (%d)',
    async (status) => {
      mockDbChain({
        provider_meta: { site_url: 'mycompany.atlassian.net', email: 'a@b.com' },
        access_token_enc_chunks: ['enc1']
      });
      (dec as jest.Mock).mockReturnValue('decrypted-token');
      (axios.get as jest.Mock).mockRejectedValue({ response: { status } });
      const res = mockRes();

      await searchHandler(mockReq(), res);

      expect(res.status).toHaveBeenCalledWith(401);
    }
  );

  it('aborts the outbound Jira call when the client disconnects mid-search', async () => {
    // Regression test for the pile-up bug: search-as-you-type fires a new
    // request on every keystroke, and without this, a superseded request's
    // outbound Jira call keeps running to completion (or its own 8s
    // timeout) regardless of the client having already moved on.
    mockDbChain({
      provider_meta: { site_url: 'mycompany.atlassian.net', email: 'a@b.com' },
      access_token_enc_chunks: ['enc1']
    });
    (dec as jest.Mock).mockReturnValue('decrypted-token');
    let resolveAxios: (value: unknown) => void;
    (axios.get as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveAxios = resolve;
      })
    );
    const res = mockRes();

    const handlerPromise = searchHandler(mockReq(), res);
    // Let the handler run up to (and register) res.on('close', ...) before
    // simulating the disconnect -- several awaited steps (schema
    // validation, the DB lookup) sit before that line, so a single
    // microtask tick isn't enough; a macrotask (setTimeout) flushes all
    // of them. jsdom has no setImmediate.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [, onClose] = (res.on as jest.Mock).mock.calls[0];
    const [, axiosConfig] = (axios.get as jest.Mock).mock.calls[0];
    expect(axiosConfig.signal.aborted).toBe(false);

    onClose();

    expect(axiosConfig.signal.aborted).toBe(true);

    resolveAxios!({ data: { values: [] } });
    await handlerPromise;
  });

  it('reports 502 when Jira is unreachable', async () => {
    mockDbChain({
      provider_meta: { site_url: 'mycompany.atlassian.net', email: 'a@b.com' },
      access_token_enc_chunks: ['enc1']
    });
    (dec as jest.Mock).mockReturnValue('decrypted-token');
    (axios.get as jest.Mock).mockRejectedValue(new Error('network down'));
    const res = mockRes();

    await searchHandler(mockReq(), res);

    expect(res.status).toHaveBeenCalledWith(502);
  });
});

// CLUSTOX: Jira multi-account support. See
// docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 6 part 2.
describe('GET /api/internal/[org_id]/jira_project_search with connection_id', () => {
  const CONNECTION_ID = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    jest.clearAllMocks();
    asAuthed();
  });

  it('searches the given connection’s Jira site, not the legacy Integration row', async () => {
    const chain = mockDbChain({
      site_url: 'other.atlassian.net',
      email: 'b@other.com',
      access_token_enc_chunks: ['enc2']
    });
    (dec as jest.Mock).mockReturnValue('other-decrypted-token');
    (axios.get as jest.Mock).mockResolvedValue({
      data: { values: [{ id: '5001', key: 'TEST', name: 'Test Project' }] }
    });
    const res = mockRes();

    await searchHandler(
      mockReq({ connection_id: CONNECTION_ID, search_text: 'test' }),
      res
    );

    expect(db).toHaveBeenCalledWith('JiraConnection');
    expect(chain.where).toHaveBeenCalledWith({
      org_id: ORG_ID,
      id: CONNECTION_ID
    });
    expect(axios.get).toHaveBeenCalledWith(
      'https://other.atlassian.net/rest/api/3/project/search',
      expect.objectContaining({
        auth: { username: 'b@other.com', password: 'other-decrypted-token' }
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith([
      {
        id: '5001',
        key: 'TEST',
        name: 'Test Project',
        // Scoped by connection_id too, not just org_id -- a second
        // connection with a colliding site-local project id must not
        // collide with this one.
        idempotency_key: `jira:${ORG_ID}:${CONNECTION_ID}:5001`,
        provider: 'jira',
        connection_id: CONNECTION_ID
      }
    ]);
  });

  it('reports 404 without ever calling Jira when the connection does not resolve', async () => {
    mockDbChain(undefined);
    const res = mockRes();

    await searchHandler(mockReq({ connection_id: CONNECTION_ID }), res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('never falls back to the legacy Integration row for a connection that fails to resolve', async () => {
    // A missing/foreign connection_id must not silently search whatever
    // the legacy Integration row happens to point at -- that would search
    // (or worse, appear to succeed against) the wrong Jira site entirely.
    mockDbChain(undefined);
    const res = mockRes();

    await searchHandler(mockReq({ connection_id: CONNECTION_ID }), res);

    expect(db).toHaveBeenCalledWith('JiraConnection');
    expect(db).not.toHaveBeenCalledWith('Integration');
  });
});
