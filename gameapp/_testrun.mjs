// 验收打包产物 v4
//  A) 结构
//  B) 包内 hgyx.js 读随包关卡（顺便数出应落盘的瓦片数）
//  C) 复制到「含空格与中文」的路径 → 证明"任何路径都能读取到源文件"
//  D) 用 --user-data-dir 给一个干净存档目录 + HUAGE_SEED_FORCE=1
//     → 端到端验证"首启自动导入"（完全隔离，不碰用户真实存档）
//  E) 渲染端真的初始化了（Chromium 的 Local Storage/Cache 目录出现）+ 多进程
//  F) 二次启动不重复导入；用户真实存档字节未变；清理
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, 'HuageyouxiGame');
const EXE = path.join(APP, 'HuageyouxiGame.exe');
const SRCAPP = path.join(APP, 'resources', 'app');
const out = [];
const L = (s) => { out.push(String(s)); console.log(s); };
const flush = () => { try { fs.writeFileSync(path.join(HERE, '_testrun.log'), out.join('\n'), 'utf-8'); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PASS = 0, FAIL = 0;
const ok = (c, label, extra) => {
  if (c) { PASS++; L('  PASS ' + label + (extra ? '  (' + extra + ')' : '')); }
  else { FAIL++; L('  **FAIL** ' + label + (extra ? '  (' + extra + ')' : '')); }
};

const PORT = path.join(HERE, '便携 测试');
const TMPAPP = path.join(PORT, 'HuageyouxiGame');
const EXE2 = path.join(TMPAPP, 'HuageyouxiGame.exe');
const UD = path.join(PORT, 'userdata-干净');
const CWD = path.join(PORT, 'cwd-与程序无关');

let filesCopied = 0;
function copyTree(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), path.join(dest, n));
  } else { fs.copyFileSync(src, dest); filesCopied++; }
}
function countTree(d) { let k = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) k += e.isDirectory() ? countTree(path.join(d, e.name)) : 1; return k; }
function pngCount(d) { if (!fs.existsSync(d)) return 0; let k = 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) k += pngCount(path.join(d, e.name)); else if (/\.png$/i.test(e.name)) k++; } return k; }
function kill(pid) { if (pid) spawnSync('C:/Windows/System32/taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
function start(exe, args, env, cwd) {
  return new Promise((resolve) => {
    const c = spawn(exe, args, { cwd, env, stdio: 'ignore' });
    let s = false;
    c.on('error', (e) => { if (!s) { s = true; L('   !! spawn error: ' + e.code + ' ' + e.message); resolve(null); } });
    c.on('spawn', () => { if (!s) { s = true; resolve(c); } });
    setTimeout(() => { if (!s) { s = true; resolve(c); } }, 5000);
  });
}
function procs() {
  const r = spawnSync('C:/Windows/System32/tasklist.exe', ['/FI', 'IMAGENAME eq HuageyouxiGame.exe', '/FO', 'CSV'], { encoding: 'utf-8' });
  return (r.stdout || '').split('\n').filter((l) => /HuageyouxiGame\.exe/i.test(l)).length;
}

(async () => {
  // ── A) 结构 ──────────────────────────────────────────────────────────────
  L('== A) 产物结构 ==');
  L('   exe = ' + EXE);
  L('   顶层: ' + fs.readdirSync(APP).join(', '));
  ok(fs.existsSync(EXE), 'exe 存在');
  ok(!fs.existsSync(path.join(APP, 'resources', 'default_app.asar')), 'default_app.asar 已清掉');
  ok(!fs.existsSync(path.join(APP, 'debug.log')), '无 debug.log');
  ok(fs.existsSync(path.join(APP, 'locales', 'zh-CN.pak')), '中文语言包在（界面中文）');

  // ── B) 随包关卡 ──────────────────────────────────────────────────────────
  L('');
  L('== B) 随包关卡 ==');
  let wantName = null, wantTiles = 0, wantLevels = 0;
  try {
    const req = createRequire(pathToFileURL(path.join(SRCAPP, 'hgyx.js')).href);
    const hgyx = req(path.join(SRCAPP, 'hgyx.js'));
    const pack = hgyx.read(fs.readFileSync(path.join(SRCAPP, '默认关.hgyx')));
    const sj = JSON.parse(pack['save.json'].toString('utf-8'));
    wantName = sj.name; wantLevels = (sj.levels || []).length;
    wantTiles = Object.keys(pack).filter((k) => /^layers\/L\d+_ly\d+\/t/.test(k)).length;
    L('   关卡名 = 「' + wantName + '」  关卡数 = ' + wantLevels + '  瓦片 = ' + wantTiles);
    ok(!!wantName && wantTiles > 0, '包内 hgyx.js 能解析 默认关.hgyx');
  } catch (e) { L('   !! ' + e.message); ok(false, '包内 hgyx.js 能解析 默认关.hgyx'); }

  // ── C) 换路径 ────────────────────────────────────────────────────────────
  L('');
  L('== C) 换到含空格 + 中文的路径 ==');
  L('   目标 = ' + TMPAPP);
  try { fs.rmSync(PORT, { recursive: true, force: true }); } catch (e) {}
  const t0 = Date.now();
  try { copyTree(APP, TMPAPP); } catch (e) { L('   !! 拷贝抛错：' + e.code + ' :: ' + e.message); }
  const srcN = countTree(APP);
  L('   拷贝 ' + filesCopied + ' 个文件，用时 ' + (Date.now() - t0) + ' ms');
  ok(fs.existsSync(EXE2) && fs.statSync(EXE2).size > 0, '新路径下 exe 存在', 'size=' + (fs.existsSync(EXE2) ? fs.statSync(EXE2).size : -1));
  ok(filesCopied === srcN, '文件数与源一致', filesCopied + '/' + srcN);
  ok(fs.existsSync(path.join(TMPAPP, 'resources', 'app', 'index.html')), '新路径下 resources/app/index.html 存在');

  // ── D) 干净 userData 下启动 → 首启播种 ───────────────────────────────────
  L('');
  L('== D) 首启自动导入（--user-data-dir 隔离）==');
  const idx = path.join(UD, 'saves', 'index.json');
  const marker = path.join(UD, '.seeded-default');
  fs.mkdirSync(UD, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  L('   user-data-dir = ' + UD);
  L('   cwd            = ' + CWD);

  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  for (const k of Object.keys(env)) if (/^CODEBUDDY_SAFE_DELETE_/i.test(k)) delete env[k];
  env.HUAGE_SEED_FORCE = '1';

  const realIdx = path.join(process.env.APPDATA || '', 'drawagame', 'saves', 'index.json');
  const realBefore = fs.existsSync(realIdx) ? fs.readFileSync(realIdx, 'utf-8') : null;

  const args = ['--user-data-dir=' + UD];
  const c1 = await start(EXE2, args, env, CWD);
  ok(!!c1, '在新路径 + 无关 cwd 下成功启动', c1 ? 'pid=' + c1.pid : 'spawn 失败');

  for (let i = 0; i < 90; i++) { await sleep(500); if (fs.existsSync(idx) && fs.existsSync(marker)) break; }
  L('   index.json=' + fs.existsSync(idx) + '  marker=' + fs.existsSync(marker));

  let entry = null, count = 0, metaOk = false, tiles = 0;
  try {
    const d = JSON.parse(fs.readFileSync(idx, 'utf-8'));
    count = (d.saves || []).length;
    entry = (d.saves || [])[0] || null;
    if (entry) {
      const lv = path.join(UD, 'saves', String(entry.id));
      metaOk = fs.existsSync(path.join(lv, 'meta.json'));
      tiles = pngCount(path.join(lv, 'layers'));
    }
  } catch (e) { L('   !! 读 index.json 失败：' + e.message); }
  if (entry) L('   index.json → ' + JSON.stringify(entry));
  L('   meta.json=' + metaOk + '  瓦片 png=' + tiles);

  ok(count === 1, '首启后列表正好 1 个存档', 'count=' + count);
  ok(!!entry && entry.name === wantName, '存档名 = 随包关卡名「' + wantName + '」', entry ? entry.name : 'null');
  ok(metaOk, '关卡 meta.json 已落盘');
  ok(tiles === wantTiles, '关卡瓦片全落盘', tiles + '/' + wantTiles);
  ok(fs.existsSync(marker), '已写 .seeded-default 标记');

  // ── E) 渲染端真的起来了 ──────────────────────────────────────────────────
  L('');
  L('== E) 渲染端是否真的起来 ==');
  const marks = ['Local Storage', 'Cache', 'Code Cache', 'DawnGraphiteCache', 'GPUCache', 'Session Storage'];
  const seen = marks.filter((n) => fs.existsSync(path.join(UD, n)));
  L('   渲染端产物: ' + (seen.join(', ') || '（无）'));
  ok(seen.length > 0, 'Chromium 渲染端已初始化（不是只有主进程）', seen.join(','));
  const np = procs();
  L('   同名进程数 = ' + np);
  ok(np >= 2, 'Electron 多进程都在', 'procs=' + np);

  kill(c1 && c1.pid);
  await sleep(3000);

  // ── F) 二次启动 + 真实存档 + 清理 ────────────────────────────────────────
  L('');
  L('== F) 二次启动 / 真实存档 / 清理 ==');
  const c2 = await start(EXE2, args, env, CWD);
  await sleep(8000);
  let count2 = -1;
  try { count2 = (JSON.parse(fs.readFileSync(idx, 'utf-8')).saves || []).length; } catch (e) {}
  L('   第二次启动后 count=' + count2);
  ok(count2 === 1, '第二次启动不重复导入（仍 1 个）', 'count=' + count2);
  kill(c2 && c2.pid);
  await sleep(3000);

  const realAfter = fs.existsSync(realIdx) ? fs.readFileSync(realIdx, 'utf-8') : null;
  ok(realBefore === realAfter, '用户真实 index.json 字节未变', realBefore === null ? '（本来就没有）' : '一致');
  L('   残留进程 = ' + procs() + ' 条');
  try { fs.rmSync(PORT, { recursive: true, force: true }); L('   已清理 ' + PORT); } catch (e) { L('   清理失败：' + e.message); }

  L('');
  L('SUMMARY passed=' + PASS + ' failed=' + FAIL);
  flush();
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { L('!! 未捕获：' + (e && (e.stack || e.message))); flush(); process.exit(9); });
