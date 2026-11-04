const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repository = path.resolve(__dirname, '..');
const archive = process.argv[2] || process.env.WEBGAL_TEST_RUNTIME_ZIP;
assert(archive, 'Supply the pinned WebGAL web ZIP as an argument or WEBGAL_TEST_RUNTIME_ZIP');
assert(fs.statSync(archive).isFile(), 'WebGAL web ZIP is unavailable');
const report = JSON.parse(
  execFileSync(
    'cargo',
    [
      'run',
      '--locked',
      '--offline',
      '--quiet',
      '-p',
      'ollaic-core',
      '--example',
      'runtime-contracts',
      '--',
      path.resolve(archive),
    ],
    { cwd: repository, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  ),
);
assert.equal(
  report.version,
  fs.readFileSync(path.join(repository, 'crates/ollaic-runtime/webgal-version.txt'), 'utf8').trim(),
);

function sourceBetween(start, end) {
  const first = report.engine.indexOf(start);
  const last = report.engine.indexOf(end, first + start.length);
  assert(first >= 0 && last > first, `Update the engine fixture adapter for ${start}`);
  return report.engine.slice(first, last);
}

const context = vm.createContext({
  Te: {
    say: 0,
    changeBg: 1,
    changeFigure: 2,
    bgm: 3,
    video: 4,
    miniAvatar: 8,
    changeScene: 9,
    choose: 10,
    callScene: 19,
    unlockCg: 21,
    unlockBgm: 22,
    setAnimation: 100,
  },
  Sr: {
    background: 'background',
    figure: 'figure',
    bgm: 'bgm',
    video: 'video',
    vocal: 'vocal',
    scene: 'scene',
  },
});
const parser =
  sourceBetween('function gD(', 'function Cte(') + sourceBetween('const WR=', 'var Np=');
vm.runInContext(parser, context, { timeout: 1000 });
vm.runInContext(
  "const assetSetter = (name, category) => /^https?:\\/\\//.test(name) ? name : './game/' + category + '/' + name; const commands = new Map(Object.entries(Te).map(([name, scriptType]) => [name, { scriptType }])); commands.set('playEffect', { scriptType: 101 }); Te.playEffect = 101; commands.set('playVideo', { scriptType: Te.video });",
  context,
);
for (const item of report.cases) {
  context.input = item.source;
  const parsed = vm.runInContext('Lte(input, assetSetter, [], commands)', context, {
    timeout: 1000,
  });
  let resource = parsed.content;
  if (item.command === 'say')
    resource = parsed.args.find((argument) => argument.key === 'vocal')?.value;
  if (item.command === 'choose') resource = parsed.content.slice(parsed.content.indexOf(':') + 1);
  assert.equal(
    decodeURIComponent(new URL(resource, 'http://127.0.0.1:1234/').pathname),
    `/game/${item.category}/${item.fileName}`,
    item.source,
  );
}

for (const item of report.externalCases) {
  for (const source of [item.source, item.saved]) {
    context.input = source;
    const parsed = vm.runInContext('Lte(input, assetSetter, [], commands)', context, {
      timeout: 1000,
    });
    const resource =
      item.command === 'say'
        ? parsed.args.find((argument) => argument.key === 'vocal')?.value
        : parsed.content;
    assert.equal(resource, item.url, source);
  }
}

context.input = report.config.split('\n').find((line) => line.startsWith('Title_img:'));
const title = vm.runInContext('Tte(input)', context, { timeout: 1000 });
assert.equal(title.command, 'Title_img');
assert.equal(decodeURIComponent(title.args[0]), report.titleName);
assert(context.input.endsWith('; title comment'));
context.input = report.animation.source;
const animation = vm.runInContext('Lte(input, assetSetter, [], commands)', context, {
  timeout: 1000,
});
assert(report.animation.table.includes(animation.content), 'Animation command is not registered');
assert.equal(decodeURIComponent(animation.content) + '.json', 'new -fade.json');
for (const name of report.builtins)
  assert(report.animation.table.includes(name), `Missing built-in ${name}`);
context.animationNames = report.animation.table;
context.animationFrames = report.animation.frames;
context.animationName = animation.content;
vm.runInContext(
  'const L = { animationManager: { getAnimations: () => animationNames.map(name => ({ name, effects: animationFrames })) } };',
  context,
);
vm.runInContext(sourceBetween('function wn(', 'function hy('), context);
assert.equal(vm.runInContext('wn(animationName)', context, { timeout: 1000 }), 300);
console.log(
  `WebGAL ${report.version}: ${report.cases.length} local and ${report.externalCases.length} external resource cases, title configuration, and animation registry passed`,
);
