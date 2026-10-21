import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const versionFiles = [
  'package.json',
  'design/package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'Cargo.lock',
];

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const cargoVersion = /(^\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
const lockVersion = /(^\[\[package\]\]\nname = "ollaic"\nversion = ")([^"]+)(")/m;

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

export function readVersions(root) {
  return versionFiles.map((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    const version = file.endsWith('.json')
      ? JSON.parse(text).version
      : text.match(file === 'Cargo.lock' ? lockVersion : cargoVersion)?.[2];
    if (!stableVersion.test(version ?? '')) throw new Error(`Invalid version in ${file}: ${version}`);
    return version;
  });
}

export function bumpVersion(root, tags) {
  const versions = readVersions(root);
  const released = tags.filter((tag) => tag.startsWith('v') && stableVersion.test(tag.slice(1)));
  const latest = [...versions, ...released.map((tag) => tag.slice(1))].sort(compareVersions).at(-1);
  const [major, minor, patch] = latest.split('.').map(Number);
  const version = `${major}.${minor}.${patch + 1}`;
  for (const file of versionFiles) {
    const path = join(root, file);
    const text = readFileSync(path, 'utf8');
    // Keep formatting and all unrelated dependency versions unchanged.
    const updated = file.endsWith('.json')
      ? text.replace(/("version"\s*:\s*")[^"]+("\s*[,}])/, (_, start, end) => `${start}${version}${end}`)
      : text.replace(file === 'Cargo.lock' ? lockVersion : cargoVersion, (_, start, old, end) => `${start}${version}${end}`);
    writeFileSync(path, updated);
  }
  return `v${version}`;
}

export function prepareRelease(root, { branch, pr, mergeSha, attempts = 5 }) {
  if (!/^\d+$/.test(String(pr)) || !/^[a-f0-9]{40}$/.test(mergeSha)) {
    throw new Error('A merged PR number and merge commit SHA are required');
  }
  git(root, 'check-ref-format', '--branch', branch);
  if (git(root, 'status', '--porcelain')) throw new Error('Release checkout must be clean');
  const identity = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
  const marker = `Release PR #${pr}`;
  let lastError;

  // Atomic, fast-forward-only pushes allocate versions without a workflow-wide
  // concurrency group (GitHub can discard queued PRs in such a group).
  for (let attempt = 0; attempt < attempts; attempt++) {
    git(root, 'fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`, '--tags');
    const existing = git(root, 'for-each-ref', '--format=%(refname:strip=2)\t%(contents:subject)', 'refs/tags')
      .split('\n').find((line) => line.split('\t')[1] === marker)?.split('\t')[0];
    if (existing) return existing; // Re-running a failed build must reuse its version.

    git(root, 'checkout', '--detach', `refs/remotes/origin/${branch}`);
    git(root, 'merge-base', '--is-ancestor', mergeSha, 'HEAD');
    const tag = bumpVersion(root, git(root, 'tag', '--list').split('\n'));
    git(root, 'add', '--', ...versionFiles);
    git(root, ...identity, 'commit', '-m', `chore(release): ${tag}`, '-m', marker);
    git(root, ...identity, 'tag', '-a', tag, '-m', marker);
    try {
      git(root, 'push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`);
      return tag;
    } catch (error) {
      lastError = error;
      // Another merge/release may have advanced the branch. Fetch and recompute.
      git(root, 'tag', '-d', tag);
    }
  }
  throw new Error(`Could not push release after ${attempts} attempts. Check Actions write access and branch/tag protection.\n${lastError?.stderr}`);
}

function main() {
  const root = process.cwd();
  let tag = '';
  let ref = process.env.GITHUB_SHA;
  if (process.env.GITHUB_EVENT_NAME === 'pull_request_target') {
    tag = prepareRelease(root, {
      branch: process.env.RELEASE_BRANCH,
      pr: process.env.RELEASE_PR,
      mergeSha: process.env.RELEASE_MERGE_SHA,
    });
    ref = `refs/tags/${tag}`;
  } else if (process.env.GITHUB_REF_TYPE === 'tag') {
    tag = process.env.GITHUB_REF_NAME;
    if (!tag.startsWith('v') || !stableVersion.test(tag.slice(1))) throw new Error(`Invalid release tag: ${tag}`);
    if (readVersions(root).some((version) => version !== tag.slice(1))) {
      throw new Error(`Version files must all match ${tag}`);
    }
    ref = `refs/tags/${tag}`;
  }
  if (!ref || !process.env.GITHUB_OUTPUT) throw new Error('Run this script from the release workflow');
  appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\nref=${ref}\n`);
  console.log(tag ? `Release: ${tag}` : `Build artifacts only: ${ref}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
