import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkRelease, syncVersion, versionFiles } from './version.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('./version.mjs', import.meta.url));

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function fixture(t, { legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ollaic-version-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of versionFiles) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(project, file), join(root, file));
  }
  if (!legacy) writeFileSync(join(root, 'VERSION'), '0.1.0\n');
  git(root, 'init', '--initial-branch=master');
  git(root, 'config', 'user.name', 'Version Test');
  git(root, 'config', 'user.email', 'version-test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'tag.gpgsign', 'false');
  const commit = (message = 'Update') => {
    git(root, 'add', '.');
    git(root, 'commit', '-m', message);
    return git(root, 'rev-parse', 'HEAD');
  };
  const before = commit('Initial app');
  const setVersion = (version) => {
    writeFileSync(join(root, 'VERSION'), version);
    return commit('Set VERSION');
  };
  return { root, before, commit, setVersion };
}

test('ordinary commits and whitespace-only version edits do not release', (t) => {
  const { root, before, commit, setVersion } = fixture(t);
  writeFileSync(join(root, 'feature.txt'), 'A feature');
  commit();
  assert.equal(checkRelease(root, before).release, false);
  setVersion('  0.1.0\r\n');
  assert.equal(checkRelease(root, before).release, false);
});

test('an increased VERSION releases the push commit, even with subsequent commits in the push', (t) => {
  const { root, before, commit, setVersion } = fixture(t);
  setVersion('0.1.1\n');
  writeFileSync(join(root, 'feature.txt'), 'A feature');
  const after = commit();
  assert.deepEqual(checkRelease(root, before, after), { release: true, version: '0.1.1', tag: 'v0.1.1' });
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('an untagged version increase can be released by a later push', (t) => {
  const { root, setVersion, commit } = fixture(t);
  const versionCommit = setVersion('0.1.1\n');
  writeFileSync(join(root, 'feature.txt'), 'A follow-up fix');
  const after = commit();
  assert.deepEqual(checkRelease(root, versionCommit, after), { release: true, version: '0.1.1', tag: 'v0.1.1' });
});

test('adding VERSION at the existing app version does not release; increasing it does', (t) => {
  const { root, before, setVersion } = fixture(t, { legacy: true });
  const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  setVersion(`${current}\n`);
  assert.equal(checkRelease(root, before).release, false);
  setVersion('99.0.0\n');
  assert.equal(checkRelease(root, before).release, true);
});

test('numeric version comparison allows patch, minor and major increases', (t) => {
  const { root, before, setVersion } = fixture(t);
  for (const version of ['0.1.9', '0.1.10', '0.2.0', '1.0.0']) {
    setVersion(`${version}\n`);
    assert.equal(checkRelease(root, before).release, true);
  }
});

test('rejects version downgrades and invalid stable versions', (t) => {
  const { root, before, setVersion } = fixture(t);
  setVersion('0.0.9\n');
  assert.throws(() => checkRelease(root, before), /VERSION must increase/);
  for (const invalid of ['v0.1.1', '0.1', '01.2.3', '0.1.1-beta.1', '0.1.1\ninjected=true', '']) {
    setVersion(invalid);
    assert.throws(() => checkRelease(root, before), /Invalid VERSION/);
  }
  assert.throws(() => checkRelease(root, ''), /valid push before SHA/);
});

test('reruns may reuse their own tag but cannot reuse another commit or downgrade past a tag', (t) => {
  const { root, before, commit, setVersion } = fixture(t);
  git(root, 'tag', 'v0.1.9');
  setVersion('0.1.10\n');
  git(root, 'tag', '-a', 'v0.1.10', '-m', 'Release');
  assert.equal(checkRelease(root, before).release, true);
  writeFileSync(join(root, 'feature.txt'), 'Another commit');
  commit();
  assert.throws(() => checkRelease(root, before), /already belongs to another commit/);
  setVersion('0.1.8\n');
  assert.throws(() => checkRelease(root, before), /must be higher than existing tag/);
});

test('a new branch with an all-zero before SHA can release its initial version', (t) => {
  const { root } = fixture(t);
  assert.equal(checkRelease(root, '0'.repeat(40)).release, true);
});

test('a force push with an unavailable before commit compares against the pushed commit parent', (t) => {
  const { root, before, commit } = fixture(t);
  writeFileSync(join(root, 'feature.txt'), 'A feature');
  const after = commit();
  const missingBefore = 'b341fbdabba5c5dd4c1c9abcdad29cf36d38c796';
  assert.notEqual(missingBefore, before);
  assert.equal(checkRelease(root, missingBefore, after).release, false);
});

test('sync updates all five app versions without changing dependencies, and is idempotent', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'VERSION'), '1.2.3\n');
  const originals = versionFiles.map((file) => readFileSync(join(root, file), 'utf8'));
  assert.equal(syncVersion(root), '1.2.3');
  const updates = versionFiles.map((file) => readFileSync(join(root, file), 'utf8'));
  for (let i = 0; i < versionFiles.length; i++) {
    const oldLines = originals[i].split('\n');
    const newLines = updates[i].split('\n');
    assert.equal(oldLines.length, newLines.length);
    const changed = oldLines.map((line, index) => index).filter((index) => oldLines[index] !== newLines[index]);
    assert.equal(changed.length, 1, versionFiles[i]);
    const index = changed[0];
    assert.match(newLines[index], /1\.2\.3/);
    assert.equal(oldLines[index].replace(/\d+\.\d+\.\d+/, '1.2.3'), newLines[index]);
  }
  syncVersion(root);
  assert.deepEqual(versionFiles.map((file) => readFileSync(join(root, file), 'utf8')), updates);
});

test('sync fails before writing any metadata when a version field is missing', (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'VERSION'), '1.2.3\n');
  writeFileSync(join(root, 'Cargo.lock'), 'version = 4\n');
  const packageBefore = readFileSync(join(root, 'package.json'), 'utf8');
  assert.throws(() => syncVersion(root), /Cannot find app version in Cargo.lock/);
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), packageBefore);
});

test('CLI exports GitHub job outputs and rejects an invalid push context', (t) => {
  const { root, before, setVersion } = fixture(t);
  const after = setVersion('0.1.1\n');
  const output = join(root, 'github-output');
  const env = { ...process.env, RELEASE_BEFORE: before, GITHUB_SHA: after, GITHUB_OUTPUT: output };
  execFileSync(process.execPath, [script, 'check'], { cwd: root, env });
  assert.equal(readFileSync(output, 'utf8'), 'release=true\nversion=0.1.1\ntag=v0.1.1\n');
  assert.throws(() => execFileSync(process.execPath, [script, 'check'], {
    cwd: root, env: { ...env, RELEASE_BEFORE: '' }, stdio: 'pipe',
  }), /valid push before SHA/);
});
