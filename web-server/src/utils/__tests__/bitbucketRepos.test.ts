import { adaptBitbucketRepo } from '@/utils/bitbucketRepos';
import { Integration } from '@/constants/integrations';

// CLUSTOX: the same realistic v2 payload shape the backend fixtures use --
// asserting a simplified shape here would let the adapter and the test agree
// while both misread the real API.
const BB_REPO = {
  uuid: '{c3d4e5f6-0000-4000-8000-000000000003}',
  name: 'middleware',
  slug: 'middleware',
  full_name: 'clustox/middleware',
  description: 'DORA metrics',
  mainbranch: { name: 'main' },
  workspace: { slug: 'clustox' },
  links: { html: { href: 'https://bitbucket.org/clustox/middleware' } }
};

describe('adaptBitbucketRepo', () => {
  it('returns the exact shape the GitHub and GitLab branches return', () => {
    // Key-for-key: the repo-selection UI reads all three providers through
    // one code path, so a missing or renamed key here surfaces as a blank
    // column in the picker, not an error.
    expect(adaptBitbucketRepo(BB_REPO, 'clustox')).toEqual({
      id: '{c3d4e5f6-0000-4000-8000-000000000003}',
      name: 'middleware',
      desc: 'DORA metrics',
      slug: 'middleware',
      web_url: 'https://bitbucket.org/clustox/middleware',
      branch: 'main',
      parent: 'clustox',
      provider: Integration.BITBUCKET
    });
  });

  it('tolerates a repo with no mainbranch', () => {
    // A freshly created empty repo has mainbranch: null.
    const empty = { ...BB_REPO, mainbranch: null as any };
    expect(adaptBitbucketRepo(empty, 'clustox').branch).toBeNull();
  });
});

describe('isBitbucketApiUrl', () => {
  const { isBitbucketApiUrl } = require('@/utils/bitbucketRepos');

  it('accepts only Bitbucket API URLs, prefix-anchored', () => {
    expect(
      isBitbucketApiUrl('https://api.bitbucket.org/2.0/repositories/x?page=2')
    ).toBe(true);
    // CLUSTOX: the cursor is client-supplied and fetched with the org's
    // Basic auth header -- each of these is a token-exfiltration attempt.
    expect(isBitbucketApiUrl('https://evil.example/steal')).toBe(false);
    expect(
      isBitbucketApiUrl('https://evil.example/https://api.bitbucket.org/2.0/')
    ).toBe(false);
    expect(isBitbucketApiUrl('http://api.bitbucket.org/2.0/x')).toBe(false);
  });
});

describe('searchBitbucketRepos', () => {
  const { searchBitbucketRepos } = require('@/utils/bitbucketRepos');

  const BB_REPO: Record<string, any> = {
    uuid: '{c3d4e5f6-0000-4000-8000-000000000003}',
    name: 'lynky-rails',
    slug: 'lynky-rails',
    description: null,
    mainbranch: { name: 'main' },
    workspace: { slug: 'clustox' },
    links: { html: { href: 'https://bitbucket.org/clustox/lynky-rails' } }
  };

  const mockFetch = (body: any, ok = true, status = 200) => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok,
      status,
      json: () => Promise.resolve(body)
    });
    global.fetch = fetchMock as any;
    return fetchMock;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('searches across all workspaces by name, no workspace input needed', async () => {
    // CLUSTOX: scoped tokens cannot enumerate workspaces (410/404, found
    // live in phase 1), so the search MUST be the workspace-agnostic
    // /2.0/repositories?role=member listing -- not a per-workspace walk.
    const fetchMock = mockFetch({ values: [BB_REPO] });

    const repos = await searchBitbucketRepos('h@x.com:tok-1', 'lynky');

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url.startsWith('https://api.bitbucket.org/2.0/repositories?')).toBe(
      true
    );
    expect(url).toContain('role=member');
    // Assert the decoded query, not a byte encoding -- URLSearchParams
    // percent-encodes '~' where encodeURIComponent would not; both are the
    // same query to the server.
    expect(new URL(url).searchParams.get('q')).toBe('name~"lynky"');
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('lynky-rails');
    expect(repos[0].parent).toBe('clustox');
  });

  it('sends Basic auth from the packed email:token pair', async () => {
    const fetchMock = mockFetch({ values: [] });

    await searchBitbucketRepos('h@x.com:tok:with:colons', 'x');

    const headers = (fetchMock.mock.calls[0][1] as any).headers;
    // Split on the FIRST colon only -- Atlassian tokens may contain colons.
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('h@x.com:tok:with:colons').toString('base64')}`
    );
  });

  it('strips quotes and backslashes from the search text', async () => {
    // CLUSTOX: the search text lands inside a BBQL string literal
    // (name~"..."). Unescaped quotes let a user break out of the literal
    // into arbitrary query clauses.
    const fetchMock = mockFetch({ values: [] });

    await searchBitbucketRepos('h@x.com:t', 'ly"nky\\');

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get('q')).toBe('name~"lynky"');
  });

  it('resolves a pasted repo URL or workspace/slug directly', async () => {
    // The exact thing a user does: paste
    // https://bitbucket.org/clustox/lynky-rails/src/main/ into the search.
    const fetchMock = mockFetch(BB_REPO);

    const repos = await searchBitbucketRepos(
      'h@x.com:t',
      'https://bitbucket.org/clustox/lynky-rails/src/main/'
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/clustox/lynky-rails'
    );
    expect(repos).toHaveLength(1);
    expect(repos[0].slug).toBe('lynky-rails');
  });

  it('returns empty on API failure instead of throwing', async () => {
    // CLUSTOX: git_provider_org runs every provider through one
    // Promise.all with no catch -- a throwing Bitbucket search would 500
    // the whole endpoint and take GitHub/GitLab results down with it.
    mockFetch({ error: { message: 'nope' } }, false, 403);

    await expect(searchBitbucketRepos('h@x.com:t', 'x')).resolves.toEqual([]);
  });
});
