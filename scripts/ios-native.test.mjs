import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const script = path.join(projectRoot, 'scripts/ios-native.sh');

function fixture(t) {
  const scratch = path.join(projectRoot, '_local');
  fs.mkdirSync(scratch, { recursive: true });
  const directory = fs.mkdtempSync(path.join(scratch, 'ios-native-script-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const derived = path.join(directory, 'derived');
  const log = path.join(directory, 'calls.jsonl');
  const developer = path.join(directory, 'Xcode');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(developer, 'Applications/Simulator.app'), {
    recursive: true,
  });
  const stub = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.IOS_SCRIPT_TEST_LOG, JSON.stringify({ tool, args }) + '\\n');
if (tool === 'uname') process.stdout.write('Darwin\\n');
if (tool === 'git') process.stdout.write(process.env.IOS_SCRIPT_TEST_PREFERENCE);
if (tool === 'xcrun' && args[0] === 'simctl' && args[1] === 'list') {
  process.stdout.write(process.env.IOS_SCRIPT_TEST_INVENTORY);
}
if (tool === 'xcrun' && args[0] === 'simctl' && args[1] === 'create') {
  process.stdout.write('created-simulator\\n');
}
if (tool === 'xcode-select') process.stdout.write(process.env.IOS_SCRIPT_TEST_DEVELOPER + '\\n');
if (tool === 'xcodebuild') {
  const derived = args[args.indexOf('-derivedDataPath') + 1];
  fs.mkdirSync(path.join(derived, 'Build/Products/Debug-iphonesimulator/Ollaic.app'), { recursive: true });
}
`;
  for (const tool of ['uname', 'git', 'xcrun', 'xcode-select', 'xcodebuild', 'open']) {
    fs.writeFileSync(path.join(bin, tool), stub, { mode: 0o755 });
  }
  return {
    derived,
    directory,
    run(
      mode,
      archive = '',
      {
        simulatorUDID = 'test-simulator',
        preferredUDID = '',
        inventory = {},
        exitCode = 0,
        stderrPattern,
      } = {},
    ) {
      fs.writeFileSync(log, '');
      const result = spawnSync('bash', [script, mode], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          IOS_SIMULATOR_UDID: simulatorUDID,
          IOS_DERIVED_DATA_PATH: derived,
          IOS_SCRIPT_TEST_LOG: log,
          IOS_SCRIPT_TEST_DEVELOPER: developer,
          IOS_SCRIPT_TEST_PREFERENCE: preferredUDID,
          IOS_SCRIPT_TEST_INVENTORY: JSON.stringify(inventory),
          WEBGAL_TEST_RUNTIME_ZIP: archive,
        },
      });
      assert.equal(result.status, exitCode, result.stderr || result.error?.message);
      if (stderrPattern) assert.match(result.stderr, stderrPattern);
      return fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    },
  };
}

function assertSelection(calls, scheme, selection) {
  const builds = calls.filter(({ tool }) => tool === 'xcodebuild');
  assert.equal(builds.length, 2);
  for (const { args } of builds) {
    assert.equal(args[args.indexOf('-scheme') + 1], scheme);
    assert.ok(args.includes(`-only-testing:${selection}`));
  }
}

const runtimeIdentifier = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0';

function simulator(udid, type, state = 'Booted') {
  return {
    udid,
    name: udid,
    deviceTypeIdentifier: `device-type-${type}`,
    state,
    isAvailable: true,
  };
}

function simulatorInventory(devices) {
  const devicetypes = [
    ['phone', 'iPhone 17', 'iPhone'],
    ['tablet', 'iPad mini (A17 Pro)', 'iPad'],
    ['duo', 'iPhone Duo', 'iPhone'],
    ['tv', 'Apple TV', 'Apple TV'],
  ].map(([id, name, productFamily]) => ({
    identifier: `device-type-${id}`,
    name,
    productFamily,
  }));
  return {
    devicetypes,
    runtimes: [
      {
        identifier: runtimeIdentifier,
        name: 'iOS 27.0',
        version: '27.0',
        isAvailable: true,
        supportedDeviceTypes: devicetypes,
      },
    ],
    devices: { [runtimeIdentifier]: devices },
  };
}

function assertDevelopmentDevice(calls, udid) {
  const simctl = calls.filter(({ tool }) => tool === 'xcrun').map(({ args }) => args);
  assert.ok(simctl.some((args) => args[1] === 'bootstatus' && args[2] === udid));
  assert.ok(simctl.some((args) => args[1] === 'install' && args[2] === udid));
  assert.ok(
    simctl.some(
      (args) =>
        args[1] === 'launch' && args[2] === '--terminate-running-process' && args[3] === udid,
    ),
  );
  const build = calls.find(({ tool }) => tool === 'xcodebuild');
  assert.equal(
    build.args[build.args.indexOf('-destination') + 1],
    `platform=iOS Simulator,id=${udid}`,
  );
  for (const { args } of calls.filter(({ tool }) => tool === 'git')) {
    assert.deepEqual(args, [
      '-C',
      projectRoot,
      'config',
      '--local',
      '--get',
      'ollaic.iosSimulatorUDID',
    ]);
  }
}

test('development discovers a running iPad without a saved default', (t) => {
  const calls = fixture(t).run('dev', '', {
    simulatorUDID: '',
    inventory: simulatorInventory([
      simulator('idle-phone', 'phone', 'Shutdown'),
      simulator('running-tablet', 'tablet'),
    ]),
  });
  assertDevelopmentDevice(calls, 'running-tablet');
});

test('development uses a running iPhone before the saved idle iPad', (t) => {
  const calls = fixture(t).run('dev', '', {
    simulatorUDID: '',
    preferredUDID: 'saved-tablet',
    inventory: simulatorInventory([
      simulator('saved-tablet', 'tablet', 'Shutdown'),
      simulator('running-phone', 'phone'),
    ]),
  });
  assertDevelopmentDevice(calls, 'running-phone');
});

test('development prefers the saved device when several devices are running', (t) => {
  const calls = fixture(t).run('dev', '', {
    simulatorUDID: '',
    preferredUDID: 'saved-tablet',
    inventory: simulatorInventory([
      simulator('running-phone', 'phone'),
      simulator('saved-tablet', 'tablet'),
    ]),
  });
  assertDevelopmentDevice(calls, 'saved-tablet');
});

test('an explicit simulator overrides discovery and the saved default', (t) => {
  const calls = fixture(t).run('dev', '', {
    simulatorUDID: 'explicit-phone',
    preferredUDID: 'saved-tablet',
    inventory: simulatorInventory([simulator('running-tablet', 'tablet')]),
  });
  assertDevelopmentDevice(calls, 'explicit-phone');
  assert.ok(!calls.some(({ tool, args }) => tool === 'xcrun' && args[1] === 'list'));
});

test('development falls back to the saved device when none is running', (t) => {
  const calls = fixture(t).run('dev', '', {
    simulatorUDID: '',
    preferredUDID: 'saved-tablet',
    inventory: simulatorInventory([
      simulator('idle-phone', 'phone', 'Shutdown'),
      simulator('saved-tablet', 'tablet', 'Shutdown'),
    ]),
  });
  assertDevelopmentDevice(calls, 'saved-tablet');
});

test('discovery skips unavailable devices, old runtimes and other product families', (t) => {
  const inventory = simulatorInventory([
    simulator('running-tv', 'tv'),
    { ...simulator('unavailable-phone', 'phone'), isAvailable: false },
    simulator('idle-phone', 'phone', 'Shutdown'),
  ]);
  const oldRuntime = 'com.apple.CoreSimulator.SimRuntime.iOS-16-4';
  const unavailableRuntime = 'com.apple.CoreSimulator.SimRuntime.iOS-28-0';
  inventory.runtimes.push(
    { identifier: oldRuntime, version: '16.4', isAvailable: true },
    { identifier: unavailableRuntime, version: '28.0', isAvailable: false },
  );
  inventory.devices[oldRuntime] = [simulator('old-phone', 'phone')];
  inventory.devices[unavailableRuntime] = [simulator('unavailable-runtime-phone', 'phone')];
  const calls = fixture(t).run('dev', '', { simulatorUDID: '', inventory });
  assertDevelopmentDevice(calls, 'idle-phone');
});

test('development creates a regular iPhone when no saved or available device exists', (t) => {
  const calls = fixture(t).run('dev', '', {
    simulatorUDID: '',
    inventory: simulatorInventory([simulator('idle-duo', 'duo', 'Shutdown')]),
  });
  const creation = calls.find(({ tool, args }) => tool === 'xcrun' && args[1] === 'create');
  assert.deepEqual(creation.args, [
    'simctl',
    'create',
    'Ollaic iPhone 17',
    'device-type-phone',
    runtimeIdentifier,
  ]);
  assertDevelopmentDevice(calls, 'created-simulator');
});

test('development fails before booting or building when no runtime is installed', (t) => {
  const inventory = simulatorInventory([]);
  inventory.runtimes = [];
  const calls = fixture(t).run('dev', '', {
    simulatorUDID: '',
    inventory,
    exitCode: 1,
    stderrPattern: /No iOS 17\+ Simulator runtime is installed/,
  });
  assert.ok(!calls.some(({ tool }) => ['xcodebuild', 'open'].includes(tool)));
  assert.deepEqual(
    calls
      .filter(({ tool, args }) => tool === 'xcrun' && args[0] === 'simctl')
      .map(({ args }) => args),
    [['simctl', 'list', '--json']],
  );
});

test('native test commands retain the saved default before automatic discovery', (t) => {
  const calls = fixture(t).run('test', '', {
    simulatorUDID: '',
    preferredUDID: 'saved-tablet',
    inventory: simulatorInventory([simulator('running-phone', 'phone')]),
  });
  assertSelection(calls, 'Ollaic', 'OllaicTests');
  for (const { args } of calls.filter(({ tool }) => tool === 'xcodebuild')) {
    assert.equal(args[args.indexOf('-destination') + 1], 'platform=iOS Simulator,id=saved-tablet');
  }
  assert.ok(!calls.some(({ tool, args }) => tool === 'xcrun' && args[1] === 'list'));
});

test('default and unit commands run native tests without opening simulator UI', (t) => {
  const environment = fixture(t);
  for (const mode of ['test', 'unit-test']) {
    const calls = environment.run(mode);
    assertSelection(calls, 'Ollaic', 'OllaicTests');
    assert.ok(!calls.some(({ tool }) => tool === 'open'));
  }
});

test('preview command stays non-interactive and removes its engine fixture', (t) => {
  const environment = fixture(t);
  const archive = path.join(environment.directory, 'engine.zip');
  fs.writeFileSync(archive, 'Test fixture for the stubbed build tool');
  const calls = environment.run('preview-test', archive);
  assertSelection(calls, 'Ollaic', 'OllaicTests/NativePreviewTests');
  assert.ok(!calls.some(({ tool }) => tool === 'open'));
  assert.ok(
    !fs.existsSync(
      path.join(
        environment.derived,
        'Build/Products/Debug-iphonesimulator/Ollaic.app/WebGALTestEngine.zip',
      ),
    ),
  );
});

test('optional UI command uses the separate UI scheme', (t) => {
  const calls = fixture(t).run('ui-test');
  assertSelection(calls, 'OllaicUI', 'OllaicUITests');
  assert.ok(calls.some(({ tool }) => tool === 'open'));
});

test('default Xcode scheme excludes UI journeys', () => {
  for (const [scheme, targets] of [
    ['Ollaic', ['OllaicTests']],
    ['OllaicUI', ['OllaicUITests']],
  ]) {
    const schemePath = path.join(
      projectRoot,
      'apps/ios/Ollaic.xcodeproj/xcshareddata/xcschemes',
      `${scheme}.xcscheme`,
    );
    const output = execFileSync(
      '/usr/bin/ruby',
      [
        '-rrexml/document',
        '-rjson',
        '-e',
        'document = REXML::Document.new(File.read(ARGV.fetch(0))); puts JSON.generate(document.get_elements("Scheme/TestAction/Testables/TestableReference/BuildableReference").map { |element| element.attributes["BlueprintName"] })',
        schemePath,
      ],
      { encoding: 'utf8' },
    );
    assert.deepEqual(JSON.parse(output), targets);
  }
});
