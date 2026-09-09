import { Integration } from '@/constants/integrations';

// CLUSTOX: lives here rather than in git_org_repos.ts so its test can import
// it without dragging Endpoint -> next-auth's ESM build into jest -- the same
// wall benchmarks.ts and contributorFilters.ts were written import-light to
// dodge. The route imports from here; one direction, no cycle.
export type AdaptedBitbucketRepo = {
  id: string;
  name: string;
  desc: string | null;
  slug: string;
  web_url: string | undefined;
  branch: string | null;
  parent: string;
  provider: Integration;
};

// The shape must match what the GitHub and GitLab branches return
// key-for-key: the repo-selection UI reads all three providers through one
// code path, so a missing or renamed key surfaces as a blank column in the
// picker, not an error.
export const adaptBitbucketRepo = (
  repo: Record<string, any>,
  org: string
): AdaptedBitbucketRepo => ({
  id: repo.uuid,
  name: repo.name,
  desc: repo.description ?? null,
  slug: repo.slug,
  web_url: repo.links?.html?.href,
  branch: repo.mainbranch?.name || null,
  // The canonical slug from the payload, not the user-typed workspace --
  // typed casing would otherwise propagate into org_name and every API path.
  parent: repo.workspace?.slug ?? org,
  provider: Integration.BITBUCKET
});

// CLUSTOX: the Bitbucket page cursor is an opaque URL the CLIENT sends back.
// Fetched unvalidated, it is an SSRF that carries the org's email:token Basic
// header to any host a workspace member names -- credential exfiltration in
// one request. Prefix-anchored, not includes(): a path like
// evil.example/https://api.bitbucket.org/2.0/ must fail.
export const isBitbucketApiUrl = (url: string): boolean =>
  url.startsWith('https://api.bitbucket.org/2.0/');

// CLUSTOX: repo search for the add-repo picker. Scoped Atlassian tokens
// cannot enumerate workspaces (/2.0/workspaces is 410-dead and the
// permissions listing 404s -- both found live in phase 1), so this uses the
// one listing that needs no workspace input: /2.0/repositories?role=member,
// "repos the token's user can access", filtered by name server-side.
//
// Credentials arrive packed as "email:token" because git_provider_org's
// fetchMap hands each provider a single token slot. Split on the FIRST
// colon only -- emails cannot contain colons, Atlassian tokens may.
//
// Failures return [] rather than throwing: the endpoint runs every provider
// through one Promise.all with no catch, so a throwing Bitbucket search
// would take GitHub and GitLab results down with it.
const BITBUCKET_API = 'https://api.bitbucket.org/2.0';

const bitbucketAuthHeader = (packedCredentials: string) => ({
  Authorization: `Basic ${Buffer.from(packedCredentials).toString('base64')}`
});

// A pasted repo URL (https://bitbucket.org/ws/slug/src/main/) or a bare
// "ws/slug" resolves to the repo directly -- the way the GitHub search
// handles pasted URLs.
const parseRepoPath = (searchText: string): string | null => {
  const path = searchText
    .trim()
    .replace(/^https?:\/\/bitbucket\.org\//, '')
    .split('/')
    .filter(Boolean);
  if (
    searchText.includes('bitbucket.org/') ||
    searchText.match(/^[^/\s]+\/[^/\s]+$/)
  ) {
    if (path.length >= 2) return `${path[0]}/${path[1]}`;
  }
  return null;
};

export const searchBitbucketRepos = async (
  packedCredentials: string,
  searchText: string
): Promise<AdaptedBitbucketRepo[]> => {
  const headers = bitbucketAuthHeader(packedCredentials);
  try {
    const repoPath = parseRepoPath(searchText || '');
    if (repoPath) {
      const response = await fetch(
        `${BITBUCKET_API}/repositories/${repoPath}`,
        {
          headers
        }
      );
      if (!response.ok) return [];
      return [adaptBitbucketRepo(await response.json(), '')];
    }

    // The search text lands inside a BBQL string literal (name~"...");
    // quotes and backslashes stripped so it cannot break out of it.
    const term = (searchText || '').replace(/["\\]/g, '').trim();
    const params = new URLSearchParams({ role: 'member', pagelen: '50' });
    if (term) params.set('q', `name~"${term}"`);
    const response = await fetch(
      `${BITBUCKET_API}/repositories?${params.toString()}`,
      { headers }
    );
    if (!response.ok) return [];
    const body = await response.json();
    return (body.values || []).map((repo: Record<string, any>) =>
      adaptBitbucketRepo(repo, '')
    );
  } catch (e) {
    return [];
  }
};
