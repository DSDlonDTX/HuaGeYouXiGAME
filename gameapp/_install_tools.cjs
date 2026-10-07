// 确定性地把 @electron/packager 装进 gameapp/_tools/node_modules
// 关键：直接跑 npm 的 JS 入口，不经过 shell —— 本机 Bash 的 PATH 和 cwd 都不可信。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOLS = path.join(__dirname, '_tools');
const NODE_EXE = process.execPath;
const NPM_CLI = path.join(path.dirname(NODE_EXE), 'node_modules', 'npm', 'bin', 'npm-cli.js');

const out = [];
const L = (s) => { out.push(String(s)); console.log(s); };
L('node      = ' + NODE_EXE);
L('npm-cli   = ' + NPM_CLI + '  (exists=' + fs.existsSync(NPM_CLI) + ')');
L('cwd       = ' + TOOLS);

fs.mkdirSync(TOOLS, { recursive: true });
fs.writeFileSync(path.join(TOOLS, 'package.json'),
  JSON.stringify({ name: 'wb-packager', private: true, version: '1.0.0' }, null, 2) + '\n', 'utf-8');

const env = Object.assign({}, process.env);
delete env.NODE_OPTIONS;              // 别把宿主的 shim 带进 npm 子进程
delete env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(env)) if (/^CODEBUDDY_SAFE_DELETE_/i.test(k)) delete env[k];

const r = spawnSync(NODE_EXE, [NPM_CLI, 'install', '@electron/packager', '--no-audit', '--no-fund', '--loglevel=error'], {
  cwd: TOOLS, env, encoding: 'utf-8'
});
L('exit      = ' + r.status);
if (r.stdout) L('--- npm stdout ---\n' + r.stdout.trim());
if (r.stderr) L('--- npm stderr ---\n' + r.stderr.trim());

const pkg = path.join(TOOLS, 'node_modules', '@electron', 'packager', 'package.json');
L('装好了吗  = ' + fs.existsSync(pkg));
if (fs.existsSync(pkg)) L('   版本 = ' + JSON.parse(fs.readFileSync(pkg, 'utf-8')).version);
const rc = ['rcedit', '@electron/rcedit'].map((n) => {
  const p = path.join(TOOLS, 'node_modules', n);
  return n + '=' + fs.existsSync(p);
});
L('   ' + rc.join('  '));
const bin = path.join(TOOLS, 'node_modules', '.bin');
if (fs.existsSync(bin)) L('   .bin = ' + fs.readdirSync(bin).join(', '));

fs.writeFileSync(path.join(TOOLS, '_install.log'), out.join('\n'), 'utf-8');
process.exit(fs.existsSync(pkg) ? 0 : 1);
