import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateReleaseUrl } from '../server/update-release.js';
import { createDesktopUpdateController, replaceAppImage } from './updates.js';

const currentVersion = '0.9.0';
const version = '0.10.0';
const sha512 = createHash('sha512').update('replacement').digest('base64');

test('desktop only installs a verified download on explicit restart', async () => {
  const progress: number[] = [];
  let finishDownload!: () => void;
  const pending = new Promise<void>(resolve => { finishDownload = resolve; });
  let checks = 0;
  let downloads = 0;
  let installs = 0;
  const updates = createDesktopUpdateController({
    currentVersion,
    native: {
      target: 'nsis',
      check: async () => {
        checks++;
        return { available: true, version, tag: `v${version}`, files: [{ url: `jira-dag-${version}-x64-setup.exe`, sha512 }] };
      },
      download: async (expected, report) => {
        downloads++;
        assert.equal(expected, sha512);
        report({ percent: 37 });
        await pending;
      },
      install: async () => { installs++; },
    },
    openExternal: async () => { assert.fail('Unexpected release page'); },
    reportProgress: ({ percent }) => { progress.push(percent); },
  });

  assert.deepEqual(await updates.installUpdate(), { status: 'not-available' });
  assert.deepEqual(await updates.downloadUpdate(), { status: 'not-available' });
  const [available] = await Promise.all([updates.checkForUpdate(), updates.checkForUpdate()]);
  assert.deepEqual(available, {
    status: 'available', currentVersion, version, mode: 'install', releaseUrl: updateReleaseUrl(version),
  });
  assert.equal(checks, 1);
  assert.equal(downloads, 0);
  const downloadsInProgress = Promise.all([updates.downloadUpdate(), updates.downloadUpdate()]);
  assert.deepEqual(await updates.installUpdate(), { status: 'not-available' });
  assert.equal(checks, 1);
  assert.equal(downloads, 1);
  assert.deepEqual(progress, [37]);
  finishDownload();
  assert.deepEqual(await downloadsInProgress, [{ status: 'ready' }, { status: 'ready' }]);
  assert.deepEqual(await updates.checkForUpdate(), { ...available, downloaded: true });
  assert.equal(installs, 0);
  assert.deepEqual(await updates.installUpdate(), { status: 'installing' });
  assert.deepEqual(await updates.installUpdate(), { status: 'not-available' });
  assert.equal(installs, 1);
});

test('desktop falls back to the official release when native metadata cannot select the expected artifact', async () => {
  const opened: string[] = [];
  const updates = createDesktopUpdateController({
    currentVersion,
    native: {
      target: 'appimage',
      check: async () => ({
        available: true, version, tag: `v${version}`,
        files: [
          { url: 'another.AppImage?download=1', sha512 },
          { url: `jira-dag-${version}-x86_64.AppImage`, sha512 },
        ],
      }),
      download: async () => { assert.fail('Unexpected download'); },
      install: async () => { assert.fail('Unexpected installer launch'); },
    },
    lookupRelease: async () => ({
      status: 'available', currentVersion, version, mode: 'release', releaseUrl: 'https://example.com/',
    }),
    openExternal: async url => { opened.push(url); },
    reportProgress: () => {},
  });

  assert.equal((await updates.checkForUpdate()).status, 'available');
  assert.deepEqual(await updates.downloadUpdate(), { status: 'opened' });
  assert.deepEqual(await updates.installUpdate(), { status: 'not-available' });
  assert.deepEqual(opened, [updateReleaseUrl(version)]);
});

test('a bad staged AppImage leaves the original in place', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jira-dag-update-test-'));
  const image = join(directory, 'jira-dag.AppImage');
  const downloaded = join(directory, 'downloaded.AppImage');
  t.after(async () => {
    await unlink(image);
    await unlink(downloaded);
    await rmdir(directory);
  });
  await writeFile(image, 'original', { mode: 0o755 });
  await writeFile(downloaded, 'replacement');

  await assert.rejects(replaceAppImage(image, downloaded, 'wrong'), /checksum changed/);
  assert.equal(await readFile(image, 'utf8'), 'original');
  await replaceAppImage(image, downloaded, sha512);
  assert.equal(await readFile(image, 'utf8'), 'replacement');
  assert.deepEqual((await readdir(directory)).sort(), ['downloaded.AppImage', 'jira-dag.AppImage']);
});
