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
const lockVersion = /(^\[\[package\]\]\r?\nname = "ollaic"\r?\nversion = ")([^"]+)(")/m;

function parseVersion(text) {
  const version = text.trim();
  if (!stableVersion.test(version)) throw new Error(`Invalid VERSION: ${version}. Expected major.minor.patch.`);
  return version;
}

function compareVersions(left, right) {
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function checkRelease(root, before, after = 'HEAD') {
  if (!/^[a-f0-9]{40}$/.test(before ?? '')) throw new Error('A valid push before SHA is required');
  const commit = git(root, 'rev-parse', `${after}^{commit}`);
  const version = parseVersion(git(root, 'show', `${commit}:VERSION`));
  const tag = `v${version}`;
  let previous;
  let recoveringRelease = false;
  if (!/^0+$/.test(before)) {
    let baseline = before;
    try {
      baseline = git(root, 'rev-parse', '--verify', `${before}^{commit}`);
    } catch {
      // A force push can leave the event's before SHA unavailable in the checkout.
      try {
        baseline = git(root, 'rev-parse', '--verify', `${commit}^`);
      } catch {
        baseline = '';
      }
    }
    const hasVersion = baseline ? git(root, 'ls-tree', '--name-only', baseline, '--', 'VERSION') : '';
    // Introducing VERSION at the existing app version should not release it.
    if (baseline) {
      previous = parseVersion(hasVersion
        ? git(root, 'show', `${baseline}:VERSION`)
        : JSON.parse(git(root, 'show', `${baseline}:package.json`)).version);
    }
  }
  if (previous === version) {
    // Recover a release skipped by a failed workflow when a later push still
    // carries the version increase.
    const ancestors = git(root, 'rev-list', '--first-parent', `${commit}^`).split('\n').filter(Boolean);
    for (const ancestor of ancestors) {
      const hasAncestorVersion = git(root, 'ls-tree', '--name-only', ancestor, '--', 'VERSION');
      const ancestorVersion = parseVersion(hasAncestorVersion
        ? git(root, 'show', `${ancestor}:VERSION`)
        : JSON.parse(git(root, 'show', `${ancestor}:package.json`)).version);
      if (ancestorVersion !== version) {
        previous = ancestorVersion;
        recoveringRelease = true;
        break;
      }
    }
    if (previous === version || (!recoveringRelease && git(root, 'tag', '--list', tag))) {
      return { release: false, version, tag };
    }
  }
  if (previous && compareVersions(version, previous) < 0) {
    throw new Error(`VERSION must increase: ${previous} -> ${version}`);
  }
  for (const existing of git(root, 'tag', '--list', 'v*').split('\n')) {
    if (existing === tag) {
      if (!recoveringRelease && git(root, 'rev-parse', `${tag}^{commit}`) !== commit) {
        throw new Error(`${tag} already belongs to another commit; increase VERSION`);
      }
    } else if (stableVersion.test(existing.slice(1)) && compareVersions(version, existing.slice(1)) <= 0) {
      throw new Error(`VERSION ${version} must be higher than existing tag ${existing}`);
    }
  }
  return { release: true, version, tag };
}

export function syncVersion(root) {
  const version = parseVersion(readFileSync(join(root, 'VERSION'), 'utf8'));
  // Validate every file before writing any of them. Keep dependency versions intact.
  const updates = versionFiles.map((file) => {
    const text = readFileSync(join(root, file), 'utf8');
    const pattern = file.endsWith('.json')
      ? /("version"\s*:\s*")([^"]+)("\s*[,}])/
      : file === 'Cargo.lock' ? lockVersion : cargoVersion;
    if (!pattern.test(text) || (file.endsWith('.json') && typeof JSON.parse(text).version !== 'string')) {
      throw new Error(`Cannot find app version in ${file}`);
    }
    return [file, text.replace(pattern, (_, start, old, end) => `${start}${version}${end}`)];
  });
  for (const [file, text] of updates) writeFileSync(join(root, file), text);
  return version;
}

function main() {
  if (process.argv[2] === 'sync') {
    console.log(`Synchronized app version: ${syncVersion(process.cwd())}`);
  } else if (process.argv[2] === 'check') {
    const result = checkRelease(process.cwd(), process.env.RELEASE_BEFORE, process.env.GITHUB_SHA ?? 'HEAD');
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(result.release ? `Release ${result.tag}` : `VERSION unchanged: ${result.version}`);
  } else {
    throw new Error('Usage: node scripts/version.mjs <check|sync>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
