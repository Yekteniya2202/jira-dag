import type { UpdateCheckResult } from '../shared/updates.js';

export const updateRepository = { owner: 'Yekteniya2202', repo: 'jira-dag' } as const;
const repositoryUrl = `https://github.com/${updateRepository.owner}/${updateRepository.repo}`;
const releaseApi = `https://api.github.com/repos/${updateRepository.owner}/${updateRepository.repo}/releases/latest`;

function stableParts(value: unknown): number[] | undefined {
  if (typeof value !== 'string' || value !== value.trim() ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return undefined;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : undefined;
}

export function compareStableVersions(left: unknown, right: unknown): number | undefined {
  const a = stableParts(left);
  const b = stableParts(right);
  if (!a || !b) return undefined;
  return Math.sign(a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}

export function updateReleaseUrl(version: string): string {
  return `${repositoryUrl}/releases/tag/v${version}`;
}

export async function checkRelease(currentVersion: string, fetcher: typeof fetch = fetch): Promise<UpdateCheckResult> {
  try {
    const response = await fetcher(releaseApi, {
      headers: { Accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (response.status === 404) return { status: 'unavailable', currentVersion };
    if (!response.ok) return { status: 'error', currentVersion };
    const release: unknown = await response.json();
    if (!release || typeof release !== 'object' || !('tag_name' in release) ||
        typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v') ||
        ('draft' in release && release.draft === true) || ('prerelease' in release && release.prerelease === true)) {
      return { status: 'unavailable', currentVersion };
    }
    const version = release.tag_name.slice(1);
    const comparison = compareStableVersions(version, currentVersion);
    if (comparison === undefined) return { status: 'unavailable', currentVersion };
    if (comparison <= 0) return { status: 'current', currentVersion };
    const archive = `jira-dag-web-${version}.tar.gz`;
    const publishedArchive = 'assets' in release && Array.isArray(release.assets) && release.assets.some((item: unknown) =>
      item && typeof item === 'object' && 'name' in item && item.name === archive &&
      'state' in item && item.state === 'uploaded' && 'size' in item && typeof item.size === 'number' && item.size > 0);
    return {
      status: 'available', currentVersion, version, mode: 'release',
      releaseUrl: updateReleaseUrl(version),
      ...(publishedArchive ? { webArchiveUrl: `${repositoryUrl}/releases/download/v${version}/${archive}` } : {}),
    };
  } catch {
    return { status: 'error', currentVersion };
  }
}
