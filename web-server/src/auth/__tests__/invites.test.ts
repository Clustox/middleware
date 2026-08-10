const mockDb = jest.fn();
jest.mock('@/utils/db', () => ({
  db: (...args: any[]) => mockDb(...args)
}));

const mockCreateUser = jest.fn();
jest.mock('@/auth/queries', () => ({
  createUser: (...args: any[]) => mockCreateUser(...args)
}));

import {
  acceptInvite,
  createInvite,
  findUsableInvite,
  listPendingInvites,
  revokeInvite
} from '@/auth/invites';

const chain = (result: any) => {
  const c: any = {};
  c.insert = jest.fn(() => c);
  c.returning = jest.fn(() => Promise.resolve(result));
  c.select = jest.fn(() => c);
  c.join = jest.fn(() => c);
  c.leftJoin = jest.fn(() => c);
  c.where = jest.fn(() => c);
  c.andWhere = jest.fn(() => c);
  c.whereNull = jest.fn(() => c);
  c.orderBy = jest.fn(() => c);
  c.update = jest.fn(() => Promise.resolve(result));
  c.first = jest.fn(() => Promise.resolve(result));
  c.then = (fn: any) => Promise.resolve(result).then(fn);
  return c;
};

describe('createInvite', () => {
  beforeEach(() => mockDb.mockReset());

  it('stores a hash of the token, not the token itself, and returns the raw token separately', async () => {
    const c = chain([{ id: 'inv-1' }]);
    mockDb.mockReturnValue(c);

    const result = await createInvite({
      name: 'Riya',
      email: 'riya@clustox.com',
      role: 'ADMIN',
      orgId: 'org-1',
      createdBy: 'creator-1'
    });

    expect(result.id).toBe('inv-1');
    expect(result.token).toHaveLength(64); // 32 random bytes as hex
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const insertedRow = c.insert.mock.calls[0][0];
    expect(insertedRow.token_hash).not.toBe(result.token);
    expect(insertedRow.token_hash).toHaveLength(64); // sha256 hex digest
  });

  it('keeps orgId for an ADMIN invite', async () => {
    const c = chain([{ id: 'inv-2' }]);
    mockDb.mockReturnValue(c);

    await createInvite({
      name: 'Riya',
      email: 'riya@clustox.com',
      role: 'ADMIN',
      orgId: 'org-1',
      createdBy: 'creator-1'
    });

    expect(c.insert.mock.calls[0][0].org_id).toBe('org-1');
  });

  it('nulls orgId for a SUPERADMIN invite even if one was passed in', async () => {
    // A SuperAdmin owns no workspace -- see docs/MULTITENANCY_PROPOSAL.md
    // §4. Accepting a non-null orgId here would silently give a
    // SuperAdmin an owned workspace, contradicting that model.
    const c = chain([{ id: 'inv-3' }]);
    mockDb.mockReturnValue(c);

    await createInvite({
      name: 'Boss',
      email: 'boss@clustox.com',
      role: 'SUPERADMIN',
      orgId: 'org-1',
      createdBy: 'creator-1'
    });

    expect(c.insert.mock.calls[0][0].org_id).toBeNull();
  });

  it('handles a driver that returns a bare id string rather than a row object', async () => {
    const c = chain(['inv-4']);
    mockDb.mockReturnValue(c);

    const result = await createInvite({
      name: 'Riya',
      email: 'riya@clustox.com',
      role: 'ADMIN',
      orgId: null,
      createdBy: 'creator-1'
    });

    expect(result.id).toBe('inv-4');
  });
});

describe('listPendingInvites', () => {
  beforeEach(() => mockDb.mockReset());

  it('flags an invite past its expiry as expired', async () => {
    mockDb.mockReturnValue(
      chain([
        {
          id: 'inv-1',
          email: 'a@clustox.com',
          name: 'A',
          role: 'ADMIN',
          org_id: 'org-1',
          created_at: '2020-01-01T00:00:00Z',
          expires_at: '2020-01-08T00:00:00Z', // long past
          emailed_at: null,
          org_name: 'Acme'
        }
      ])
    );

    const [invite] = await listPendingInvites();
    expect(invite.expired).toBe(true);
    expect(invite.emailed).toBe(false);
    expect(invite.orgName).toBe('Acme');
  });

  it('does not flag a still-usable invite as expired', async () => {
    const future = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString();
    mockDb.mockReturnValue(
      chain([
        {
          id: 'inv-2',
          email: 'b@clustox.com',
          name: 'B',
          role: 'SUPERADMIN',
          org_id: null,
          created_at: new Date().toISOString(),
          expires_at: future,
          emailed_at: new Date().toISOString(),
          org_name: null
        }
      ])
    );

    const [invite] = await listPendingInvites();
    expect(invite.expired).toBe(false);
    expect(invite.emailed).toBe(true);
    expect(invite.orgId).toBeNull();
  });

  it('returns an empty array when there are no pending invites', async () => {
    mockDb.mockReturnValue(chain([]));
    await expect(listPendingInvites()).resolves.toEqual([]);
  });
});

describe('revokeInvite', () => {
  beforeEach(() => mockDb.mockReset());

  it('only revokes an invite that has not already been accepted', async () => {
    const c = chain(undefined);
    mockDb.mockReturnValue(c);

    await revokeInvite('inv-1');

    expect(c.whereNull).toHaveBeenCalledWith('accepted_at');
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ revoked_at: expect.any(Date) })
    );
  });
});

describe('findUsableInvite', () => {
  beforeEach(() => mockDb.mockReset());

  it('returns null when no row matches the token hash', async () => {
    mockDb.mockReturnValue(chain(undefined));
    await expect(findUsableInvite('some-token')).resolves.toBeNull();
  });

  it('returns null when the matched row is already expired', async () => {
    mockDb.mockReturnValue(
      chain({
        id: 'inv-1',
        expires_at: '2020-01-01T00:00:00Z'
      })
    );
    await expect(findUsableInvite('some-token')).resolves.toBeNull();
  });

  it('returns the row when it exists and has not expired', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    mockDb.mockReturnValue(chain({ id: 'inv-1', expires_at: future }));
    await expect(findUsableInvite('some-token')).resolves.toMatchObject({
      id: 'inv-1'
    });
  });
});

describe('acceptInvite', () => {
  beforeEach(() => {
    mockDb.mockReset();
    mockCreateUser.mockReset();
  });

  it('rejects an unknown, spent, revoked, or expired token identically as INVALID', async () => {
    mockDb.mockReturnValue(chain(undefined)); // findUsableInvite's own query

    const result = await acceptInvite('bad-token', 'a-strong-password');

    expect(result).toEqual({ ok: false, reason: 'INVALID' });
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('rejects if a user with the invited email already exists, without creating a duplicate', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    mockDb
      .mockReturnValueOnce(
        chain({
          id: 'inv-1',
          email: 'taken@clustox.com',
          name: 'Taken',
          role: 'ADMIN',
          org_id: null,
          expires_at: future
        })
      ) // findUsableInvite
      .mockReturnValueOnce(chain({ id: 'existing-user' })); // existing-user check

    const result = await acceptInvite('good-token', 'a-strong-password');

    expect(result).toEqual({ ok: false, reason: 'ALREADY_EXISTS' });
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('creates the account and marks the invite spent in the same step, on success', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const updateChain = chain(undefined);
    mockDb
      .mockReturnValueOnce(
        chain({
          id: 'inv-1',
          email: 'newperson@clustox.com',
          name: 'Newperson',
          role: 'ADMIN',
          org_id: 'org-1',
          expires_at: future
        })
      ) // findUsableInvite
      .mockReturnValueOnce(chain(undefined)) // no existing user
      .mockReturnValueOnce(updateChain); // mark accepted

    mockCreateUser.mockResolvedValue({ userId: 'new-user-1' });

    const result = await acceptInvite('good-token', 'a-strong-password');

    expect(result).toEqual({ ok: true, email: 'newperson@clustox.com' });
    expect(mockCreateUser).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'newperson@clustox.com',
        password: 'a-strong-password',
        role: 'ADMIN',
        orgId: 'org-1'
      })
    );
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ accepted_by: 'new-user-1' })
    );
  });
});
