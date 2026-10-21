import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bumpVersion, prepareRelease, readVersions, versionFiles } from './release-version.mjs';

const script = fileURLToPath(new URL('./release-version.mjs', import.meta.url));
const project = fileURLToPath(new URL('../', import.meta.url));

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ollaic-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = join(root, 'seed');
  mkdirSync(seed);
  for (const file of versionFiles) {
    mkdirSync(dirname(join(seed, file)), { recursive: true });
    copyFileSync(join(project, file), join(seed, file));
  }
  git(seed, 'init', '--initial-branch=master');
  git(seed, 'config', 'user.name', 'Release Test');
  git(seed, 'config', 'user.email', 'release-test@example.com');
  git(seed, 'config', 'commit.gpgsign', 'false');
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'Merged application');
  const mergeSha = git(seed, 'rev-parse', 'HEAD');
  const remote = join(root, 'remote.git');
  git(root, 'clone', '--bare', seed, remote);
  const clone = (name) => {
    const path = join(root, name);
    git(root, 'clone', remote, path);
    git(path, 'config', 'commit.gpgsign', 'false');
    git(path, 'config', 'tag.gpgsign', 'false');
    return path;
  };
  return { root, seed, remote, mergeSha, clone };
}

function runRelease(root, pr, mergeSha) {
  return new Promise((resolve, reject) => {
    const output = join(dirname(root), `output-${pr}-${Date.now()}`);
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'pull_request_target',
        GITHUB_OUTPUT: output,
        RELEASE_BRANCH: 'master',
        RELEASE_PR: String(pr),
        RELEASE_MERGE_SHA: mergeSha,
      },
    });
    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr));
      resolve(readFileSync(output, 'utf8').match(/^tag=(.+)$/m)[1]);
    });
  });
}

test('bumps the patch version in actual project files without changing dependencies', (t) => {
  const { seed } = fixture(t);
  const versions = readVersions(seed);
  const base = versions[0].split('.').map(Number);
  assert.ok(versions.every((version) => version === versions[0]));
  const expected = `${base[0]}.${base[1]}.${base[2] + 1}`;
  assert.equal(bumpVersion(seed, []), `v${expected}`);
  assert.deepEqual(readVersions(seed), Array(5).fill(expected));
  versionFiles.forEach((file) => {
    const diff = git(seed, 'diff', '--unified=0', '--', file).split('\n');
    const removed = diff.filter((line) => line.startsWith('-') && !line.startsWith('---'));
    const added = diff.filter((line) => line.startsWith('+') && !line.startsWith('+++'));
    assert.equal(removed.length, 1, file);
    assert.equal(added.length, 1, file);
    assert.equal(added[0].slice(1), removed[0].slice(1).replace(versions[0], expected), file);
  });
});

test('uses numeric tag ordering, ignores prereleases, and carries patch digits', (t) => {
  const { seed } = fixture(t);
  assert.equal(bumpVersion(seed, ['v1.2.9', 'v1.2.10', 'v2.0.0-beta.1', 'unrelated']), 'v1.2.11');
  assert.deepEqual(readVersions(seed), Array(5).fill('1.2.11'));
});

test('pushes version commit and tag together, and reuses the version on reruns', (t) => {
  const { remote, mergeSha, clone } = fixture(t);
  const first = clone('first');
  const tag = prepareRelease(first, { branch: 'master', pr: 42, mergeSha });
  assert.equal(git(remote, 'rev-parse', `${tag}^{commit}`), git(remote, 'rev-parse', 'master'));
  assert.equal(git(remote, 'log', '-1', '--format=%s'), `chore(release): ${tag}`);
  const second = clone('second');
  const next = prepareRelease(second, { branch: 'master', pr: 43, mergeSha });
  assert.notEqual(tag, next);
  assert.equal(prepareRelease(first, { branch: 'master', pr: 42, mergeSha }), tag);
  assert.equal(git(remote, 'tag', '--list').split('\n').length, 2);
});

test('concurrent merged PRs each receive a distinct version without losing commits', async (t) => {
  const { remote, mergeSha, clone } = fixture(t);
  const tags = await Promise.all([
    runRelease(clone('pr-50'), 50, mergeSha),
    runRelease(clone('pr-51'), 51, mergeSha),
    runRelease(clone('pr-52'), 52, mergeSha),
  ]);
  assert.equal(new Set(tags).size, 3);
  assert.deepEqual(git(remote, 'tag', '--list').split('\n').sort(), tags.sort());
  assert.equal(git(remote, 'rev-list', '--count', 'master'), '4');
  for (const tag of tags) git(remote, 'merge-base', '--is-ancestor', `${tag}^{commit}`, 'master');
});

test('a rejected tag push cannot leave an untagged version commit on master', (t) => {
  const { remote, mergeSha, clone } = fixture(t);
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do\n  case "$ref" in refs/tags/*) exit 1 ;; esac\ndone\n');
  chmodSync(hook, 0o755);
  const checkout = clone('rejected');
  assert.throws(() => prepareRelease(checkout, { branch: 'master', pr: 60, mergeSha, attempts: 2 }), /Check Actions write access/);
  assert.equal(git(remote, 'rev-parse', 'master'), mergeSha);
  assert.equal(git(remote, 'tag', '--list'), '');
  assert.equal(git(checkout, 'tag', '--list'), '');
});

test('manual branch runs only export the selected commit; mismatched tags fail', (t) => {
  const { root, seed, mergeSha } = fixture(t);
  const output = join(root, 'manual-output');
  const env = {
    ...process.env,
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF_TYPE: 'branch',
    GITHUB_SHA: mergeSha,
    GITHUB_OUTPUT: output,
  };
  execFileSync(process.execPath, [script], { cwd: seed, env });
  assert.equal(readFileSync(output, 'utf8'), `tag=\nref=${mergeSha}\n`);
  assert.equal(git(seed, 'status', '--porcelain'), '');
  assert.throws(() => execFileSync(process.execPath, [script], {
    cwd: seed,
    env: { ...env, GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' },
    stdio: 'pipe',
  }), /Version files must all match v9.9.9/);
});
