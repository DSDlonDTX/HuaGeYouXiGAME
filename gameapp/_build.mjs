// 把「画个游戏」打包成独立 Windows 应用 -> gameapp/HuageyouxiGame/
//
// 为什么用 Node 而不是 shell：本机 Bash 的 coreutils 会时不时从 PATH 里消失
// （dirname/mkdir/cp 全 command not found），PowerShell 又删不掉工作区文件。
// Node 的 fs 只依赖自己，稳。@electron/packager 20 是 ESM，所以本文件是 .mjs。
//
// 用法： node gameapp/_build.mjs
// 产物： gameapp/HuageyouxiGame/HuageyouxiGame.exe + resources/app/<源码>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GAMEAPP = HERE;
const STAGE = path.join(GAMEAPP, '_stage');
const NAME = 'HuageyouxiGame';
const ELECTRON_VERSION = '33.4.11';

const log = [];
const L = (s) => { log.push(String(s)); console.log(s); };
const flush = () => { try { fs.writeFileSync(path.join(GAMEAPP, '_build.log'), log.join('\n'), 'utf-8'); } catch (e) {} };

// 运行期真正需要的文件（逐个人工核过：index.html 的 <script src>/<audio src>/<img src>/CSS url()）
// 排除：_shots/、*.log、debug.log、.psd、截图、python 脚本、dev 测试 html、
//       testlevel-debug.js（457KB 调试图，只给 G 键"生成调试场景"用）、_backup/、复制来的关卡存档/ 等
const FILES = [
  'package.json',   // ↔ main.js require('./package.json')、Electron 靠它找 main
  'main.js',        // 主进程
  'preload.js',     // ↔ webPreferences.preload
  'hgyx.js',        // ↔ main.js require('./hgyx')
  'index.html',     // 全部游戏+编辑器（loadFile('index.html')）
  'icon.ico',       // ↔ BrowserWindow icon + 打包器设置 exe 图标
  '默认关.hgyx',     // 首次启动自动导入的随包关卡
  // ---- index.html 直接引用的素材（少一个就是白框/没声音）----
  '终点.svg',                            // <img src="终点.svg">（起点/终点元件）
  'unnamedbgm.mp3',                      // <audio id="bgm"> 主菜单/编辑器 BGM
  'space_cadet_training_montage_0.mp3.ogg', // <audio id="winBgm"> 通关 BGM
  'mainmenubg.png',                      // CSS url() 主菜单背景
  'help.png',                            // CSS url() 帮助弹窗
  'empty.png',                           // CSS url() 空图层/空缩略图底纹
  'win.png',                             // CSS url() 通关弹窗
  'gamemenu.png',                        // CSS url() 游戏内菜单
  'gameover.png',                        // CSS url() 失败覆盖层
  'texticons.png',                       // CSS url() 文字工具栏图标
];

// 打包器装在哪不一定（本机那次 npm 被 shim 改了 cwd）→ 挨个找
const MOD_CANDIDATES = [
  path.join(GAMEAPP, '_tools', 'node_modules'),
  path.join(ROOT, '_shots', '_tools', 'node_modules'),
  path.join(ROOT, 'node_modules'),
  path.join(GAMEAPP, 'node_modules')
];
let MODS = null;
for (const c of MOD_CANDIDATES) {
  if (fs.existsSync(path.join(c, '@electron', 'packager', 'dist', 'index.js'))) { MODS = c; break; }
}

// 官方 Electron zip 缓存（有就用 → 离线、快）
function findElectronZipDir() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d);
      if (fs.existsSync(path.join(p, 'electron-v' + ELECTRON_VERSION + '-win32-x64.zip'))) return p;
    }
  } catch (e) {}
  return null;
}

try {
  L('== 画个游戏 打包 ==');
  L('node      = ' + process.version);
  L('输出       = ' + path.join(GAMEAPP, NAME));

  // ── 0) 前置检查 ──────────────────────────────────────────────────────────
  if (!MODS) {
    L('!! 找不到 @electron/packager。找过：');
    for (const c of MOD_CANDIDATES) L('     ' + c + ' → ' + (fs.existsSync(c) ? '存在但无包' : '不存在'));
    L('   → 先跑 node gameapp/_install_tools.cjs');
    flush(); process.exit(2);
  }
  L('packager  = ' + MODS);
  let packager;
  try {
    const entry = pathToFileURL(path.join(MODS, '@electron', 'packager', 'dist', 'index.js')).href;
    const mod = await import(entry);
    // v20 是具名导出 `packager`（没有 default）
    packager = mod.packager || mod.default;
    if (typeof packager !== 'function') throw new Error('packager 不是函数，导出键 = ' + Object.keys(mod).join(','));
  } catch (e) { L('!! import packager 失败：' + (e && e.message)); flush(); process.exit(2); }

  // v20 用纯 JS 的 resedit 改 exe 图标/版本信息（不再需要 rcedit，跨平台可跑）
  const hasResedit = fs.existsSync(path.join(MODS, 'resedit', 'package.json'));
  const zipDir = findElectronZipDir();
  L('resedit   = ' + (hasResedit ? 'ok（会写入 exe 图标与版本信息）' : '无 → 不传 icon，exe 图标保持 Electron 默认'));
  L('zip 缓存  = ' + (zipDir || '无 → 从网上下载 Electron'));

  // ── 1) 干净 staging：只放运行期需要的文件 ────────────────────────────────
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  let missing = 0;
  for (const f of FILES) {
    const s = path.join(ROOT, f), d = path.join(STAGE, f);
    if (!fs.existsSync(s)) { L('!! 缺少源文件: ' + f); missing++; continue; }
    fs.copyFileSync(s, d);
    L('   + ' + f + '  (' + fs.statSync(d).size + ' B)');
  }
  if (missing) { L('!! 有 ' + missing + ' 个必需文件缺失，中止'); flush(); process.exit(3); }

  // ── 2) index.html：摘掉对调试脚本的引用 ─────────────────────────────────
  // testlevel-debug.js（457KB 内嵌调试截图）只服务于编辑器里的 G 键"生成调试场景"，
  // 属于调试资产、按用户要求不进安装包。代码里那条分支本来就有兜底
  // （typeof window.TESTLEVEL_DEBUG_IMG === 'string' 判断 + 失败吐司），摘掉安全。
  const idxPath = path.join(STAGE, 'index.html');
  let html = fs.readFileSync(idxPath, 'utf-8');
  const n0 = Buffer.byteLength(html, 'utf-8');
  const re = /\s*<script src="testlevel-debug\.js"><\/script>/g;
  const hit = (html.match(re) || []).length;
  html = html.replace(re, '');
  fs.writeFileSync(idxPath, html, 'utf-8');
  L('   index.html 摘除调试脚本引用：命中 ' + hit + ' 处，' + n0 + ' -> ' + Buffer.byteLength(html, 'utf-8') + ' 字节');

  // ── 3) 精简 package.json（去掉 scripts/devDependencies：装包里不需要）────
  const pkgPath = path.join(STAGE, 'package.json');
  const p0 = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const pkg = {
    name: p0.name,               // 保持 drawagame → userData 路径与开发时一致
    version: p0.version,
    description: p0.description,
    main: p0.main,               // ↔ Electron 入口
    author: p0.author || '',
    license: p0.license || ''
  };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  L('   package.json 精简 -> ' + JSON.stringify(pkg));

  // ── 4) 打包 ──────────────────────────────────────────────────────────────
  const opts = {
    dir: STAGE,
    name: NAME,
    platform: 'win32',
    arch: 'x64',
    electronVersion: ELECTRON_VERSION,
    out: GAMEAPP,
    appVersion: pkg.version,
    overwrite: true,
    prune: false,        // staging 里没有 node_modules，无需 prune（也免得 packager 去调 npm）
    asar: false,         // 普通目录：源码可直接读，符合"任何路径都能读取到游戏源文件"
    quiet: false,
    // 明确把 staging 自己排除掉，避免 packager 递归把 _stage 也装进去
    ignore: [/(^|[\\/])_stage([\\/]|$)/, /(^|[\\/])_tools([\\/]|$)/, /(^|[\\/])_build\.log$/, /(^|[\\/])_install_tools\.cjs$/]
  };
  if (hasResedit) {
    opts.icon = path.join(STAGE, 'icon.ico');
    opts.win32metadata = {
      CompanyName: '', FileDescription: '画个游戏', ProductName: '画个游戏',
      InternalName: NAME, OriginalFilename: NAME + '.exe'
    };
  }
  if (zipDir) opts.electronZipDir = zipDir;

  L('== 开始打包（Electron ' + ELECTRON_VERSION + ' win32 x64）==');
  let outs;
  try { outs = await packager(opts); }
  catch (e) { L('!! 打包失败：' + (e && (e.stack || e.message))); flush(); process.exit(4); }
  L('   完成：' + JSON.stringify(outs));

  // ── 5) 目录名改成正好 HuageyouxiGame ─────────────────────────────────────
  const built = outs[0];
  const finalDir = path.join(GAMEAPP, NAME);
  if (path.resolve(built) !== path.resolve(finalDir)) {
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(built, finalDir);
    L('   目录改名：' + path.basename(built) + ' -> ' + NAME);
  }

  // ── 6) 清掉 Electron 自带的噪音/调试件 ──────────────────────────────────
  for (const j of [
    path.join(finalDir, 'resources', 'default_app.asar'),  // 我们用 resources/app，它没用
    path.join(finalDir, 'debug.log'),
    path.join(finalDir, 'resources', 'debug.log')
  ]) {
    if (fs.existsSync(j)) { fs.rmSync(j, { force: true }); L('   - 删除 ' + path.relative(finalDir, j)); }
  }

  // ── 7) 自检：exe / 源码 / 素材 是否都在；有没有把调试垃圾带进来 ──────────
  L('== 产物自检 ==');
  const exe = path.join(finalDir, NAME + '.exe');
  const appDir = path.join(finalDir, 'resources', 'app');
  L('   exe          : ' + (fs.existsSync(exe) ? 'OK  ' + fs.statSync(exe).size + ' B' : '!! 缺失'));
  L('   resources/app: ' + (fs.existsSync(appDir) ? 'OK' : '!! 缺失'));
  let okAll = fs.existsSync(exe) && fs.existsSync(appDir);
  for (const f of FILES) {
    const p = path.join(appDir, f);
    const ok = fs.existsSync(p);
    if (!ok) okAll = false;
    L('   ' + (ok ? 'OK  ' : '!!  ') + f + (ok ? '  (' + fs.statSync(p).size + ' B)' : ''));
  }
  const strays = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const rel = path.relative(appDir, p);
      if (/_shots|\.log$|testlevel|\.psd$|^_build|\.py$/i.test(rel)) strays.push(rel);
    }
  })(appDir);
  L('   调试残留     : ' + (strays.length ? JSON.stringify(strays) : '无'));
  if (strays.length) okAll = false;

  L('');
  L(okAll ? '>>> 打包成功' : '>>> 打包完成，但有上面标注的问题');
  flush();
  process.exit(okAll ? 0 : 5);
} catch (e) {
  L('!! 未捕获：' + (e && (e.stack || e.message)));
  flush(); process.exit(9);
}
