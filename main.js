// Electron 主进程：无边框、固定 4:3 尺寸的桌面游戏窗口
const path = require('path');
const fs = require('fs');

// ───────────────────────────────────────────────────────────────────────────
// 自愈守卫：防止「启动即崩溃」/「启动即被环境劫持」
//
// 某些终端环境会带上 ELECTRON_RUN_AS_NODE=1（典型是被 Electron 宿主程序
// 派生出来的终端）。这个变量会让 electron 退化成纯 Node，于是
// require('electron') 只返回一个「可执行文件路径字符串」，
// app / BrowserWindow / ipcMain 全都是 undefined，启动立刻报：
//     TypeError: Cannot read properties of undefined (reading 'handle')
//
// 第二类污染：宿主终端会注入 NODE_OPTIONS=--require=...node-language-shim.cjs，
// 里面挂着一个「安全删除」守卫：**一轮之内删掉超过 50 个文件就直接抛错**。
// 我们存档的一层瓦片就是几十上百个 PNG，整层重写必然踩线 —— 表现是
// 写存档莫名失败、旧瓦片删不掉。这跟游戏本身无关，纯粹是宿主环境带进来的。
//
// 检测到这两种情况就：剔掉污染变量 → 用真正的 Electron 重新拉起自己 →
// 本进程静候子进程结束再退出。干净环境启动时条件不成立，直接跳过，零开销。
// ───────────────────────────────────────────────────────────────────────────
const electronModule = require('electron');
const dirtyNodeOptions = /node-language-shim|safe-delete/i.test(process.env.NODE_OPTIONS || '');
const safeDeleteGuard = process.env.CODEBUDDY_SAFE_DELETE_ENABLED === '1';
const asPlainNode = typeof electronModule === 'string';

if (asPlainNode || dirtyNodeOptions || safeDeleteGuard) {
  const { spawn } = require('child_process');
  const childEnv = Object.assign({}, process.env);
  delete childEnv.ELECTRON_RUN_AS_NODE;   // ← 关键：不把它传给真正的 Electron
  delete childEnv.NODE_OPTIONS;           // ← 也不要把宿主的安全删除守卫带进去
  for (const k of Object.keys(childEnv)) {
    if (/^CODEBUDDY_SAFE_DELETE_/i.test(k)) delete childEnv[k];
  }
  // 故意用纯 ASCII：Windows 终端默认 GBK 代码页，中文日志容易变乱码
  console.log('[self-heal] inherited env is dirty ('
    + (asPlainNode ? 'ELECTRON_RUN_AS_NODE' : '')
    + (dirtyNodeOptions ? ' NODE_OPTIONS(shim)' : '')
    + (safeDeleteGuard ? ' SAFE_DELETE_GUARD' : '')
    + ' ) -> cleaned, relaunching with real Electron ...');
  const electronBin = asPlainNode ? electronModule : process.execPath;
  const child = spawn(electronBin, ['.'], {
    stdio: 'inherit',
    env: childEnv,
    cwd: __dirname
  });
  child.on('error', (err) => {
    console.error('[self-heal] 重新启动失败：', err && err.message);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code === null ? 0 : code));
  return;   // CommonJS 模块顶层 return：不再往下执行主进程代码
}

const { app, BrowserWindow, ipcMain, dialog, Menu } = electronModule;
// ───────────────────────────────────────────────────────────────────────────
// 应用名 = userData 目录名（%APPDATA%\<name>）。2026-09-25 起由 gamehalfcoustom
// 改为 drawagame。这里显式 setName 是**双保险**：万一 package.json 的 name / 打包
// 时的 productName 有漂移，userData 仍稳定落在 drawagame，不会出现「存档突然不见了」。
// 必须在**第一次** app.getPath('userData') 之前调用 —— 本文件此前没有取过该路径。
// ───────────────────────────────────────────────────────────────────────────
const APP_NAME = 'drawagame';
const LEGACY_APP_NAME = 'gamehalfcoustom';   // 旧 userData 名，只用于一次性迁移
app.setName(APP_NAME);

const hgyx = require('./hgyx');   // .hgyx 闯关包（ZIP 容器）打包/解包

let APP_VERSION = '0.4dev';
try { APP_VERSION = require('./package.json').version || APP_VERSION; } catch (e) {}

// GPU 子进程崩溃记录。以前这里只打一句「GPU 进程退出」，把 details.reason /
// exitCode 都丢了 —— 而那恰恰是判断「驱动崩了 / 显存爆了 / 被杀掉了」的唯一线索。
// 现在完整留存，供 SMOKE_TEST 诊断输出。
const gpuCrashes = [];

// ───────────────────────────────────────────────────────────────────────────
// 把窗口「提醒」到用户眼前（关闭被拦截时用）
//
// 老实现是临时 setAlwaysOnTop(true) 抢 Z 序、500ms 后再还原。两个问题：
//   ① 那期间窗口会**插到其它程序前面** —— 等于擅自改了用户看到的层序；
//   ② 窗口本来就在前台时（用户点标题栏 ✕ 正是这种情况）这一下纯属多余。
//      而装上原生边框之后，点 ✕ 必然意味着窗口是前台，这个 hack 更没有存在价值。
// 现在只做该做的两件事：① 还原最小化 / 显示出来；② 抢不到焦点就**闪任务栏**。
// 闪烁由 win.on('focus') 收尾 —— 用户一回到窗口就停，不会一直闪下去。
// ───────────────────────────────────────────────────────────────────────────
let attentionCount = 0;   // 供 CLOSE_TEST 断言"确实触发过提醒"（flashFrame 没有读状态的 API）

function attractAttention(win) {
  if (!win || win.isDestroyed()) return;

  if (win.isMinimized()) win.restore();     // 最小化 → 还原
  if (!win.isVisible()) win.show();         // 隐藏 → 显示
  win.focus();
  // Windows 的「前台锁定」会直接忽略后台进程的 focus()，抢不到是常态；
  // 这时候闪任务栏才是系统认可、也不会骚扰其它窗口的做法。
  if (!win.isFocused()) win.flashFrame(true);
  attentionCount++;
}

// 窗口标题栏文字。渲染端 <title> 也会覆盖它，所以下面拦了 page-title-updated。
const APP_TITLE = '画个游戏';

function createWindow() {
  // 隐藏原生菜单栏。两个理由：
  //   ① 外观与无边框时期一致（那时候根本没有菜单条）；
  //   ② **彻底避免它的加速键跟画布快捷键打架** —— Ctrl+0 / Ctrl+= / Ctrl+- / F12 / Ctrl+R
  //      这些都在默认菜单里挂着。注意：_kbd_probe.js 里那条「快捷键不被菜单抢」的实测结论
  //      是在 frame:false 下量出来的，换成原生边框后必须重新兜住（故这里直接把菜单摘掉）。
  Menu.setApplicationMenu(null);

  const win = new BrowserWindow({
    width: 960,               // 4:3
    height: 720,              // 4:3
    useContentSize: true,     // 尺寸按内容区算：内容区仍正好 960x720，标题栏额外占高
    frame: true,              // Windows 原生边框（拖动 / 最小化 / 关闭都由系统标题栏承担）
    icon: path.join(__dirname, 'icon.ico'),
    title: APP_TITLE,         // 标题栏文字
    resizable: false,         // 固定大小，禁止拖拽改尺寸
    maximizable: false,
    fullscreenable: false,
    show: false,              // 先不显示，等 HTML 渲染完再 show，避免白屏卡顿
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');
  // 页面 <title> 一变就会顶掉窗口标题 —— 挡掉它，保证标题栏始终是 APP_TITLE
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(APP_TITLE); });
  // 渲染完成后再显示窗口
  win.once('ready-to-show', () => { win.show(); });

  // 关闭拦截：编辑器模式下弹保存确认，并把窗口提醒到用户眼前
  let forceQuit = false;
  win.on('close', (e) => {
    // 渲染进程已经崩了就不能再拦 —— 否则弹不出对话框、又关不掉，用户被彻底锁死在外面
    if (forceQuit || process.env.SHOT_MODE === '1' || win.webContents.isCrashed()) return;
    e.preventDefault();
    attractAttention(win);    // 还原/显示 + 闪任务栏（不再篡改用户的置顶状态）
    win.webContents.send('app:close-request');
  });
  // 用户一回到窗口就停止闪任务栏（Windows 上闪到获得焦点为止，这里显式收尾更保险）
  win.on('focus', () => { if (!win.isDestroyed()) win.flashFrame(false); });
  ipcMain.on('app:force-quit', () => {
    forceQuit = true;
    if (!win.isDestroyed()) win.flashFrame(false);
    win.close();
  });

  // 打印 renderer 侧 console，便于定位问题（开发期调试用）
  win.webContents.on('console-message', (e, level, message) => {
    console.log('[renderer:' + level + ']', message);
  });

  // 瓦片画布自检：TILE_TEST=1 时在真实渲染进程里跑一遍「无限画布」验证并退出
  if (process.env.TILE_TEST === '1') {
    win.webContents.once('did-finish-load', () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        try {
          // 关键前置：画布读回依赖窗口真实可见。
          // 窗口一旦被遮挡，Chromium 会判定页面不可见而停止刷新 GPU 后端，
          // getImageData 就整批返回空白 → 碰撞被建空 → 出现「地板凭空消失」的假失败。
          win.show();
          win.focus();
          if (typeof win.moveTop === 'function') win.moveTop();
          win.setAlwaysOnTop(true);
          await sleep(900);
          const out = await win.webContents.executeJavaScript(`(async function () {
            var log = [];
            function say(s) { log.push(s); }
            function ok(name, cond, extra) { log.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '  [' + extra + ']')); }
            // 轮询等瓦片数到位：4096² PNG 解码耗时随机器负载浮动，固定 sleep 会偶发假失败
            async function waitTiles(T, n, ms) {
              var tries = Math.ceil((ms || 5000) / 100);
              for (var k = 0; k < tries && tileCount(T) !== n; k++) await new Promise(function (r) { setTimeout(r, 100); });
              return tileCount(T);
            }
            // 等惰性迁移「彻底完成」：瓦片建好 + 重挂载 + 重建碰撞行段，
            // 否则这套后处理会落在后续闯关断言中途，把碰撞数据重建掉造成假失败
            async function waitMigrate(T, ms) {
              var tries = Math.ceil((ms || 6000) / 100);
              for (var k = 0; k < tries && T._migrating; k++) await new Promise(function (r) { setTimeout(r, 100); });
              return !T._migrating;
            }

            // ---------- 0) 干净环境：一个存档 + 一关 + 一个地面图层 ----------
            var s = { id: 2, name: '瓦片测试', levels: [], createdAt: new Date(), author: '', epilogue: '', retryFromLevel: false, customMusic: false };
            s.levels.push(createLevel('第1关', null));
            saves = [s]; saveId = 3;
            currentEditing = s; currentLevelIdx = 0; currentLayerId = null;
            show(editScreen);
            loadLevel(0);
            document.querySelector('.ly-new-btn[data-type="ground"]').click();
            var L = currentLayer();
            if (!L) { say('FAIL  没有当前图层，测试中止'); return log.join('\\n'); }

            await new Promise(function (r) { setTimeout(r, 120); });

            // 相机归零，屏幕坐标 = 视口中心 + 世界坐标
            canvasScale = 1; panX = 0; panY = 0; applyZoom();
            document.querySelector('.pentool[data-pentool="brush"]').click();
            var bs = document.getElementById('brushSize'); bs.value = 20; bs.dispatchEvent(new Event('input'));
            document.getElementById('brushColor').value = '#ff0000';

            var el = document.getElementById('editCanvas');
            var cx = el.clientWidth / 2, cy = el.clientHeight / 2;
            var rect = el.getBoundingClientRect();
            function sc(w) { return { x: cx + panX + w.x * canvasScale, y: cy + panY + w.y * canvasScale }; }
            function fire(t, sx, sy) {
              el.dispatchEvent(new MouseEvent(t, { clientX: rect.left + sx, clientY: rect.top + sy, button: 0, bubbles: true }));
            }
            function stroke(a, b) {
              var p0 = sc(a), p1 = sc(b);
              fire('mousedown', p0.x, p0.y);
              for (var i = 1; i <= 16; i++) fire('mousemove', p0.x + (p1.x - p0.x) * i / 16, p0.y + (p1.y - p0.y) * i / 16);
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            }
            function alphaAtWorld(w) { var d = window.__inkSample(Math.round(w.x + 2048), Math.round(w.y + 2048)) || [0,0,0,0]; return d[3]; }

            // ---------- 1) 画到远超 ±2048 的正负象限 ----------
            stroke({ x: 6000, y: 4000 }, { x: 6050, y: 4000 });
            stroke({ x: -6000, y: -4000 }, { x: -6050, y: -4000 });
            ok('世界 (6000,4000) 留下笔迹', alphaAtWorld({ x: 6000, y: 4000 }) > 200, alphaAtWorld({ x: 6000, y: 4000 }));
            ok('世界 (-6000,-4000) 留下笔迹', alphaAtWorld({ x: -6000, y: -4000 }) > 200, alphaAtWorld({ x: -6000, y: -4000 }));
            ok('瓦片键 (2,1) 已创建', !!getTile(L, 2, 1, false));
            ok('瓦片键 (-3,-2) 已创建', !!getTile(L, -3, -2, false));
            ok('未绘制处仍为空 (6000+400,4000)', alphaAtWorld({ x: 6400, y: 4000 }) === 0);
            ok('原点附近未被污染 (0,0)', alphaAtWorld({ x: 0, y: 0 }) === 0);

            // ---------- 2) 跨瓦片长笔画：接缝不能断 ----------
            stroke({ x: -100, y: 0 }, { x: 4200, y: 0 });
            var seam = [-100, 0, 1000, 2040, 2060, 3000, 4180].map(function (x) { return alphaAtWorld({ x: x, y: 0 }); });
            ok('跨瓦片长笔画全程连续', seam.every(function (a) { return a > 200; }), seam.join('/'));
            ok('瓦片 (0,0) 与 (1,0) 都建出来了', !!getTile(L, 0, 0, false) && !!getTile(L, 1, 0, false));
            ok('瓦片 (-1,0) 已建出（-100 那一段）', !!getTile(L, -1, 0, false));

            // ---------- 2b) blitToLayer 要把位图落到**正确的世界位置** ----------
            // 事故：落点写成 dx 而不是 dx+sx → tx0 之后的所有瓦片整体左移 |sx|，
            //       src_x < 2·sx 的部分被裁到画布外。用户看到的就是"跨瓦片文字接缝处断裂"。
            if (gpuCrashed) {
              log.push('SKIP  blitToLayer 跨瓦片落点（GPU 崩溃，像素断言无意义）');
            } else {
              (function () {
                var pc = document.createElement('canvas'); pc.width = 400; pc.height = 40;
                var pctx = pc.getContext('2d');
                pctx.fillStyle = '#ff0000'; pctx.fillRect(200, 10, 40, 20);
                // 贴到 ink(3948,2108) → 世界 (1900,60)；红块应落世界 2100..2140
                //   = tile(1,0) 局部 x 52..92、局部 y 70..90
                blitToLayer(L, pc, 3948, 2108, 400, 40);
                function px(tx, lx, ly) {
                  var t = getTile(L, tx, 0, false);
                  if (!t) return null;
                  try { return t.ctx.getImageData(lx, ly, 1, 1).data; } catch (e) { return null; }
                }
                var inR = px(1, 70, 80);      // 红块正中（局部 52..92 内）
                var outR = px(1, 30, 80);     // 红块左侧（源图透明处）应为空
                ok('blitToLayer 跨瓦片：位图落到第二块瓦片的正确位置',
                   !!inR && inR[0] > 120 && inR[1] < 90 && inR[3] > 128,
                   inR ? ('rgba(' + inR[0] + ',' + inR[1] + ',' + inR[2] + ',' + inR[3] + ')') : 'null');
                ok('blitToLayer 跨瓦片：不该出现的位置保持为空',
                   !!outR && outR[3] === 0, outR ? ('a=' + outR[3]) : 'null');
              })();
            }

            // ---------- 3) 擦除跨瓦片（destination-out 逐瓦片生效） ----------
            document.querySelector('.pentool[data-pentool="eraser"]').click();
            stroke({ x: 2000, y: 0 }, { x: 2100, y: 0 });
            ok('擦除跨缝成功 (2050)', alphaAtWorld({ x: 2050, y: 0 }) === 0, alphaAtWorld({ x: 2050, y: 0 }));
            ok('擦除未误伤左侧 (1900)', alphaAtWorld({ x: 1900, y: 0 }) > 200);

            // ---------- 3b) 合成模式不得从橡皮擦泄漏到瓦片上下文 ----------
            // 事故：stampToTiles 只设不复原 composite op，擦过的瓦片永久停在 destination-out，
            //       之后打印跨瓦片文字会被"擦"空、接缝处断开。这条是**纯状态断言**，不吃 GPU。
            (function () {
              var leak = [];
              [[0, 0], [1, 0], [-1, 0], [2, 1], [-3, -2]].forEach(function (p) {
                var tt = getTile(L, p[0], p[1], false);
                if (tt && tt.ctx.globalCompositeOperation !== 'source-over') {
                  leak.push(p.join(',') + '=' + tt.ctx.globalCompositeOperation);
                }
              });
              ok('擦除后所有瓦片上下文回到 source-over（合成模式不泄漏）', leak.length === 0, leak.join(' ') || 'ok');
              ok('strokeOp 变量也已复位', strokeOp === 'source-over', strokeOp);
            })();

            // 端到端：往「刚擦过」的瓦片上打印跨缝文字，缝两侧都要写出像素
            if (gpuCrashed) {
              log.push('SKIP  跨缝文字在曾擦除的瓦片上写出（GPU 崩溃，像素断言无意义）');
            } else {
              (function () {
                var tc = document.createElement('canvas'); tc.width = 100; tc.height = 40;
                var tcx = tc.getContext('2d'); tcx.fillStyle = '#00ff00'; tcx.fillRect(0, 0, 100, 40);
                // 世界 (2018,300) → ink(4066,2348)，宽 100 → 世界 2018..2118，横跨 tile(0,0)/(1,0)
                blitToLayer(L, tc, 4066, 2348, 100, 40);
                var aL = alphaAtWorld({ x: 2030, y: 320 });
                var aR = alphaAtWorld({ x: 2060, y: 320 });
                ok('跨缝文字在曾擦除瓦片上写出（缝左侧）', aL > 200, aL);
                ok('跨缝文字在曾擦除瓦片上写出（缝右侧）', aR > 200, aR);
              })();
            }

            document.querySelector('.pentool[data-pentool="brush"]').click();

            // ---------- 4) 碰撞行段：世界坐标基准 + 稀疏行 ----------
            buildLayerSolids();
            ok('碰撞在 (6000,4000) 判定为固体', isSolid(6000, 4000) === true);
            ok('碰撞在 (6400,4000) 判定为空', isSolid(6400, 4000) === false);
            ok('碰撞在 (-6000,-4000) 判定为固体', isSolid(-6000, -4000) === true);
            ok('碰撞在远处 (90000,90000) 判定为空', isSolid(90000, 90000) === false);
            ok('rowHasSolid 世界行命中', rowHasSolid(0, 1000, 1000) === true);

            // ---------- 5) 序列化往返（新格式） ----------
            var j = layerToJSON(L);
            var keys = Object.keys(j.tiles).sort();
            // 长笔画压在 y=0 这条瓦片缝上 → 上下两行瓦片都要写入；预期 10 片
            var expect = ['-1,-1','-1,0','-3,-2','0,-1','0,0','1,-1','1,0','2,-1','2,0','2,1'].sort();
            ok('序列化瓦片键集合正确（含骑缝双行）', keys.join(' ') === expect.join(' '), keys.join(' '));
            var L2 = layerFromJSON(j);
            await new Promise(function (r) { setTimeout(r, 600); });
            var t2 = getTile(L2, 2, 1, false);
            var a2 = t2 ? t2.ctx.getImageData(1904, 1952, 1, 1).data[3] : -1;
            ok('往返后 (2,1) 瓦片像素可还原', a2 > 200, a2);
            var t3 = getTile(L2, -3, -2, false);
            var a3 = t3 ? t3.ctx.getImageData(120, 96, 1, 1).data[3] : -1;
            ok('往返后 (-3,-2) 瓦片像素可还原', a3 > 200, a3);

            // ---------- 6) 旧存档迁移：4096² 单图 → 瓦片 ----------
            var legacy = document.createElement('canvas');
            legacy.width = 4096; legacy.height = 4096;
            var lc = legacy.getContext('2d');
            lc.fillStyle = 'rgba(0,0,0,1)';
            lc.fillRect(3000, 1000, 40, 40);   // 旧墨迹坐标 (3000,1000) → 世界 (952,-1048) → 瓦片 (0,-1)
            var legacyURL = legacy.toDataURL('image/png');
            var LM = { id: 'lyM', name: '迁移', type: 'ground', z: 9, visible: true, locked: false, tiles: {} };
            legacyImageToTiles(LM, legacyURL, true);   // noMount：迁移层不进 DOM
            await waitTiles(LM, 1, 5000);
            var tm = getTile(LM, 0, -1, false);
            ok('旧图迁移出瓦片 (0,-1)', !!tm);
            // 旧墨迹 (3000,1000) → 世界 (952,-1048) → 瓦片(0,-1) 局部 (952,1000)；取方块中心
            var am = tm ? tm.ctx.getImageData(960, 1020, 1, 1).data[3] : -1;
            ok('旧图迁移像素落点正确', am > 200, am);
            ok('旧图空白象限没被建瓦片', !getTile(LM, -1, -1, false) && !getTile(LM, 0, 0, false) && !getTile(LM, -1, 0, false));
            // 惰性迁移：旧格式读档时先只保留原图，等这一关显示时才切瓦片
            var LX = layerFromJSON({ id: 'lyX', name: 'x', type: 'ground', z: 8, visible: true, locked: false, img: legacyURL });
            ok('旧格式读档只挂 legacyImg、不立即切瓦片', !!LX.legacyImg && tileCount(LX) === 0, 'legacy=' + !!LX.legacyImg + ' tiles=' + tileCount(LX));
            currentLayers().push(LX);
            renderLayerCanvases();   // 触发 materializeLegacyLayers
            await waitMigrate(LX, 6000);
            ok('进入关卡后旧图被惰性切成瓦片', !LX.legacyImg && tileCount(LX) === 1, 'legacy=' + !!LX.legacyImg + ' tiles=' + tileCount(LX));
            var lxTile = getTile(LX, 0, -1, false);
            ok('惰性迁移的瓦片像素正确', !!lxTile && lxTile.ctx.getImageData(960, 1020, 1, 1).data[3] > 200);
            ok('惰性迁移的瓦片已挂上 DOM', !!lxTile && !!lxTile.canvas.parentNode);
            var lxIdx = currentLayers().indexOf(LX);
            if (lxIdx >= 0) currentLayers().splice(lxIdx, 1);
            detachLayerTiles(LX);

            // ---------- 7) 挂载切换 + 孤儿瓦片清理 ----------
            var stackEl = document.getElementById('layerStack');
            tileList(L2).forEach(function (t) { stackEl.appendChild(t.canvas); });
            var dirty = document.querySelectorAll('#layerStack .ink-tile').length;
            ok('手动塞入非本关卡的瓦片后 DOM 变脏', dirty === 20, dirty);
            renderLayerCanvases();   // 编辑器重挂一次：不属于本关卡的瓦片应被清出 DOM
            var inEditClean = document.querySelectorAll('#layerStack .ink-tile').length;
            ok('重挂后孤儿瓦片被清出编辑器 DOM', inEditClean === 10, inEditClean);
            ok('孤儿瓦片仍留在内存（笔迹未丢）', tileCount(L2) === 10, tileCount(L2));
            tileHostMode = 'game'; renderLayerCanvases();
            var inGame = document.querySelectorAll('#gLayerStack .ink-tile').length;
            var inEdit = document.querySelectorAll('#layerStack .ink-tile').length;
            ok('游戏模式下瓦片搬进 #gLayerStack', inGame > 0 && inEdit === 0, 'game=' + inGame + ' edit=' + inEdit);
            tileHostMode = 'edit'; renderLayerCanvases();
            var inGame2 = document.querySelectorAll('#gLayerStack .ink-tile').length;
            var inEdit2 = document.querySelectorAll('#layerStack .ink-tile').length;
            ok('退出游戏后瓦片搬回 #layerStack', inEdit2 > 0 && inGame2 === 0, 'game=' + inGame2 + ' edit=' + inEdit2);
            ok('编辑器里只挂当前关卡的瓦片', inEdit2 === keys.length, inEdit2 + ' vs ' + keys.length);

            // ---------- 8) 主进程瓦片读写（真实落盘，测试后清理） ----------
            var TID = 999001;
            await window.gameAPI.deleteSave(TID);      // 先清干净，保证「写入前状态」可预期
            var w1 = await window.gameAPI.writeLayerTiles(TID, 0, 0, j.tiles);
            var r1 = await window.gameAPI.readLayerTiles(TID, 0, 0);
            var rk = Object.keys(r1.tiles).sort();
            ok('主进程写入瓦片成功', !!(w1 && w1.ok === true), JSON.stringify(w1 && w1.wrote));
            ok('写入结果带回写入前状态', !!(w1 && w1.beforeCount === 0), w1 && w1.beforeCount);
            ok('主进程读回瓦片键一致', rk.join(' ') === keys.join(' '), rk.join(' '));
            ok('新格式不会误报 legacy', r1.legacy === null);
            // 「上一版快照 + 一键恢复」已按用户要求整体移除（2026-09-23：有问题且不实用）：
            //   只留两条仍然成立的语义断言 —— ① 写入不再返回 backedUp；② 恢复通道确实没了。
            var wSnap = await window.gameAPI.writeLayerTiles(TID, 0, 0, j.tiles);
            ok('写入不再返回 backedUp（快照功能已移除）',
               !(wSnap && Object.prototype.hasOwnProperty.call(wSnap, 'backedUp')),
               JSON.stringify(wSnap));
            ok('恢复通道已从 preload 移除', typeof window.gameAPI.restoreLayerTiles === 'undefined',
               String(typeof window.gameAPI.restoreLayerTiles));
            // 空层重写：应当把旧文件清干净
            await window.gameAPI.writeLayerTiles(TID, 0, 0, {});
            var r2 = await window.gameAPI.readLayerTiles(TID, 0, 0);
            ok('空层重写后旧瓦片被清除', Object.keys(r2.tiles).length === 0 && r2.legacy === null,
               'tiles=' + Object.keys(r2.tiles).length + ' legacy=' + !!r2.legacy);
            // 旧格式回退
            await window.gameAPI.writeLayer(TID, 0, 1, legacyURL);
            var r3 = await window.gameAPI.readLayerTiles(TID, 0, 1);
            ok('目录无瓦片时回退旧单图', !!r3.legacy && Object.keys(r3.tiles).length === 0);
            // 元数据里的 allowEdit 必须真的落盘、且能原样读回
            await window.gameAPI.writeMeta(TID, { id: TID, name: 'meta-test', allowEdit: true, levels: [] });
            var mb = await window.gameAPI.readMeta(TID);
            ok('meta.json 落盘带 allowEdit 布尔', !!mb && mb.allowEdit === true,
               mb ? (typeof mb.allowEdit + ':' + mb.allowEdit) : 'null');
            await window.gameAPI.writeMeta(TID, { id: TID, name: 'meta-test', allowEdit: false, levels: [] });
            var mc = await window.gameAPI.readMeta(TID);
            ok('allowEdit=false 能原样读回（锁不会被写丢）', !!mc && mc.allowEdit === false,
               mc ? String(mc.allowEdit) : 'null');
            await window.gameAPI.deleteSave(TID);

            // ---------- 9) 真机闯关：世界坐标基准的物理（正/负象限都要能站住） ----------
            currentLayerId = null;
            s.levels[0].layers = [];
            renderLayers(); renderLayerCanvases();
            document.querySelector('.ly-new-btn[data-type="ground"]').click();
            document.querySelector('.pentool[data-pentool="brush"]').click();
            var bs2 = document.getElementById('brushSize'); bs2.value = 40; bs2.dispatchEvent(new Event('input'));
            show(editScreen);
            cx = el.clientWidth / 2; cy = el.clientHeight / 2;
            stroke({ x: -1500, y: 300 }, { x: 4500, y: 300 });      // 正坐标地板
            stroke({ x: -1500, y: -3000 }, { x: 1500, y: -3000 });  // 负坐标地板
            buildLayerSolids();
            var rowN = groundRle ? groundRle.rle.size : 0;
            ok('两条地板都进了碰撞行段（>60 行）', rowN > 60, rowN);

            var lv0t = currentLevel();
            lv0t.start = { x: 0, y: 0 };
            lv0t.goal = { x: 4400, y: -200 };
            lv0t.voidY = 9000;
            syncSpawnPos();

            startGameTest('edit', 'current');
            var gTiles = document.querySelectorAll('#gLayerStack .ink-tile').length;
            ok('进入闯关后瓦片挂在游戏世界层', !!game && gTiles > 0, 'gLayerStack=' + gTiles);
            ok('闯关时编辑器图层栈已清空', document.querySelectorAll('#layerStack .ink-tile').length === 0);

            for (var f1 = 0; f1 < 400 && game && !game.onGround; f1++) gameStep();
            ok('正坐标地板接住玩家 (py+17 在 279..321)', !!game && game.py + 17 >= 279 && game.py + 17 <= 321, game && (game.py + 17));
            ok('落地后 onGround 为真', !!game && game.onGround === true);

            if (game) { game.px = 0; game.py = -3100; game.vx = 0; game.vy = 0; game.onGround = false; game.sliding = false; }
            for (var f2 = 0; f2 < 400 && game && !game.onGround; f2++) gameStep();
            ok('负坐标地板接住玩家 (py+17 在 -3021..-2979)', !!game && game.py + 17 >= -3021 && game.py + 17 <= -2979, game && (game.py + 17));

            if (game) { game.px = 0; game.py = 283; game.vx = 0; game.vy = 0; game.onGround = true; game.right = true; }
            for (var f3 = 0; f3 < 60 && game; f3++) gameStep();
            ok('水平移动后仍站在地板上', !!game && game.py + 17 >= 279 && game.py + 17 <= 321, game && (game.py + 17));

            // ---- z 序回归：闯关时墨迹必须压在终点/玩家之下（曾因瓦片带 z-index 而盖住玩家）----
            (function () {
              var gl = document.getElementById('gLayerStack');
              var gpl = document.getElementById('gPlayer');
              var ggl = document.getElementById('gGoal');
              var zl = getComputedStyle(gl).zIndex;
              var zg = getComputedStyle(ggl).zIndex;
              var zp = getComputedStyle(gpl).zIndex;
              ok('游戏墨迹容器建立了层叠上下文（z-index 非 auto）', zl !== 'auto', 'z=' + zl);
              ok('z 序：墨迹 < 终点 < 玩家', Number(zl) < Number(zg) && Number(zg) < Number(zp),
                 zl + ' < ' + zg + ' < ' + zp);

              // 功能验证：临时打开 pointer-events，看玩家中心这点上「最上面」的元素是谁
              var tls = gl.querySelectorAll('.ink-tile');
              var back = [];
              for (var ti = 0; ti < tls.length; ti++) {
                back.push(tls[ti].style.pointerEvents);
                tls[ti].style.pointerEvents = 'auto';
              }
              var pBack = gpl.style.pointerEvents;
              gpl.style.pointerEvents = 'auto';
              var rr = gpl.getBoundingClientRect();
              var hitEl = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2);
              gpl.style.pointerEvents = pBack;
              for (var tj = 0; tj < tls.length; tj++) tls[tj].style.pointerEvents = back[tj];
              // GPU 崩溃时遮罩会盖住一切，这条断言必然误报 → 标记为环境原因跳过
              if (gpuCrashed) log.push('SKIP  玩家中心处最上层元素是玩家（GPU 崩溃遮罩挡住，环境问题）');
              else ok('玩家中心处最上层元素是玩家（墨迹没盖住）', hitEl === gpl,
                 hitEl ? (hitEl.id || hitEl.className || hitEl.tagName) : 'null');
            })();

            stopGameTest();
            ok('退出闯关后瓦片搬回编辑器', document.querySelectorAll('#layerStack .ink-tile').length > 0 && document.querySelectorAll('#gLayerStack .ink-tile').length === 0);

            ok('瓦片统计可读', /tiles=\\d+/.test(window.__tileStats()), window.__tileStats());

            // 自诊断：GPU 一旦崩溃，所有依赖画布像素的断言都会连带失败，必须显式标出来
            ok('GPU 未崩溃（否则像素类断言全部无意义）',
               typeof gpuCrashed === 'undefined' || !gpuCrashed);

            var passed = log.filter(function (x) { return x.indexOf('PASS') === 0; }).length;
            var failed = log.filter(function (x) { return x.indexOf('FAIL') === 0; }).length;
            log.push('SUMMARY passed=' + passed + ' failed=' + failed);
            return log.join('\\n');
          })()`);
          console.log('===== TILE_TEST =====');
          console.log(out);
          console.log('===== TILE_TEST END =====');
        } catch (e) {
          console.log('TILE_TEST_ERROR', e && (e.stack || e.message));
        }
        win.setAlwaysOnTop(false);
        app.exit(0);
      })();
    });
  }

  // 关闭拦截自检：CLOSE_TEST=1 时验证「拦截关闭 + 把窗口提醒到用户眼前 + 弹保存确认」
  if (process.env.CLOSE_TEST === '1') {
    win.webContents.once('did-finish-load', () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        const log = [];
        const ok = (name, cond, extra) =>
          log.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '  [' + extra + ']'));
        // 真实存档目录（main.js 不设假 userData）+ index.json 跑前快照，收尾时比对
        const savesDir = path.join(app.getPath('userData'), 'saves');
        const indexFile = path.join(savesDir, 'index.json');
        let indexBefore = null;
        try { indexBefore = fs.readFileSync(indexFile); } catch (e) {}
        try {
          await sleep(900);

          // ---- 1) 最小化的窗口能被「提醒」回前台 ----
          // 2026-09-24 起 bringToFront 换成 attractAttention。老实现是临时
          // setAlwaysOnTop(true) 抢 Z 序、500ms 后再还原，两个毛病：
          //   ① 那期间窗口会**插到别的程序前面**（擅自改了用户看到的层序）；
          //   ② 装了原生边框后，用户点标题栏 ✕ 必然说明窗口本来就是前台，这一下纯属多余。
          // 新实现只做该做的：还原最小化 / 显示 / 抢焦点，抢不到就闪任务栏。
          win.minimize();
          await sleep(400);
          const wasMin = win.isMinimized();
          const attentionBefore = attentionCount;
          attractAttention(win);
          await sleep(400);
          ok('minimize 生效（前置条件）', wasMin === true, 'minimized=' + wasMin);
          ok('attractAttention 还原了最小化窗口', win.isMinimized() === false, 'minimized=' + win.isMinimized());
          ok('attractAttention 后窗口可见', win.isVisible() === true);
          ok('attractAttention 真的执行了提醒（计数 +1）',
             attentionCount === attentionBefore + 1, attentionBefore + ' -> ' + attentionCount);
          ok('attractAttention 不篡改用户的置顶状态',
             win.isAlwaysOnTop() === false, 'onTop=' + win.isAlwaysOnTop());

          // ---- 2) 编辑器状态：关闭被拦截 + 提醒用户 + 弹出保存确认 ----
          const inEdit = await win.webContents.executeJavaScript(`(function () {
            var s = { id: 99, name: 'close-test', levels: [], createdAt: new Date(), author: '', epilogue: '', retryFromLevel: false, customMusic: false };
            s.levels.push(createLevel('L1', null));
            saves = [s]; saveId = 999; currentEditing = s; currentLevelIdx = 0; currentLayerId = null;
            show(editScreen); renderLayerCanvases();
            return editScreen.style.display !== 'none' && !!currentEditing;
          })()`);
          ok('已进入编辑器状态（前置条件）', inEdit === true);
          await sleep(300);

          // 顶部那条 #dragbar 已**整体删除**：它原本是 z-index:10 的覆盖层
          // （.edit-topbar 只有 z-index:3），会把最上面 28px 的点击整条吞掉
          // （老版本还挂着 app-region:drag，表现是"点一下变成拖窗口"）。
          // 现在这里必须能正常命中到编辑器自己的元素 —— 也就是顶部工具条点得到。
          const strip = await win.webContents.executeJavaScript(`(function () {
            var bar = document.getElementById('dragbar');
            var hit = document.elementFromPoint(Math.round(window.innerWidth / 2), 10);
            var tb = document.querySelector('.edit-topbar');
            return {
              hit: hit ? (hit.id || hit.className || hit.tagName) : 'null',
              barGone: !bar,
              topbarTop: tb ? Math.round(tb.getBoundingClientRect().top) : -999
            };
          })()`);
          ok('顶部覆盖层 #dragbar 已整体删除（元素查无此物）', strip.barGone === true);
          ok('顶部 28px 的点击不再被截走（命中到编辑器自己的元素，而不是 null / dragbar）',
             strip.hit !== 'dragbar' && strip.hit !== 'null',
             '命中=' + strip.hit + '；edit-topbar.top=' + strip.topbarTop);

          const attentionBeforeClose = attentionCount;
          win.close();          // 触发 close → 应被拦截，并把窗口提醒到用户眼前
          await sleep(700);

          ok('关闭被拦截：窗口未销毁', win.isDestroyed() === false);
          ok('关闭后窗口仍可见', win.isVisible() === true);
          ok('关闭后窗口未最小化', win.isMinimized() === false);
          ok('拦截时触发了提醒（attractAttention 计数 +1）',
             attentionCount === attentionBeforeClose + 1,
             attentionBeforeClose + ' -> ' + attentionCount);
          ok('提醒不留下置顶副作用', win.isAlwaysOnTop() === false, 'onTop=' + win.isAlwaysOnTop());

          // ⚠️ 「弹窗显示了吗」必须用**计算样式**判。原来写的 `m.style.display !== 'none'`
          //    在初始状态下内联 display 是**空串**，空串 !== 'none' **恒真** → 这条断言等于没断言。
          //    2026-09-24 它就是这样放过了一个真 bug（点 ✕ 根本不弹保存确认）。
          const modalShown = await win.webContents.executeJavaScript(
            "(function(){var m=document.getElementById('confirmModal');" +
            "return !!m && getComputedStyle(m).display !== 'none';})()");
          ok('渲染端弹出了保存确认弹窗', modalShown === true);

          // 弹窗文案必须指向"当前正在编辑的那个闯关"，而不是上一轮遗留的文字
          const modalMeta = await win.webContents.executeJavaScript(`(function () {
            var nb = document.getElementById('btnConfirmNoSave');
            return {
              title: document.getElementById('confirmTitle').textContent,
              text: document.getElementById('confirmText').textContent,
              okText: document.getElementById('btnConfirmOk').textContent,
              noSaveShown: getComputedStyle(nb).display !== 'none',
              noSaveText: nb.textContent
            };
          })()`);
          ok('弹窗文案指向当前闯关（标题/正文/按钮）',
             modalMeta.title === '保存确认' &&
             modalMeta.text.indexOf('close-test') >= 0 &&
             modalMeta.okText === '保存并关闭',
             modalMeta.title + ' / ' + modalMeta.text + ' / ' + modalMeta.okText);
          // 这个按钮以前只写「不保存」，用户不容易看出"点了就能退出去"
          // —— 2026-09-24 有用户正因找不到出口而报「点了保存并关闭退不出程序」，故文案写全
          ok('保存确认弹窗带「不保存并关闭」按钮（文案写全，别让用户找不到出口）',
             modalMeta.noSaveShown === true && modalMeta.noSaveText === '不保存并关闭',
             'shown=' + modalMeta.noSaveShown + ' label=' + modalMeta.noSaveText);

          // 整条链路的出口：点「保存并关闭」要**真的走到退出**（否则窗口关不掉）。
          // 但 CLOSE_TEST 跑在**真实 userData** 上（main.js 不设假 userData），而
          // `saveAllAndQuit → saveAllAsync` 会用内存里的 `saves = [只放了一条 close-test]`
          // **整份重写 index.json** —— 那等于把用户的存档列表清空（只剩一个 close-test）。
          // 所以这里把落盘与退出都换成桩，只验"点确认后会不会先保存、再走到退出"这条顺序；
          // 真正的落盘路径由 `_shots/_close_probe.js` 在**假 userData** 里完整覆盖
          // （真 preload + 全通道桩 IPC + 查盘 + 遮罩时间线）。
          // **真实退出**（IPC → 主进程 → window-all-closed → app.quit）由 `_shots/_quit_probe.js`
          // 在假 userData 里端到端覆盖，四个场景：editor / menu / locked / savefail。
          // ⚠️ 两种**相反**的预期：editor / menu 要"真的退出"；locked / savefail 要"**不许**退出"
          //    （保存失败 → 吐司 + 留在编辑器，见下面第 3 段）。
          // （2026-09-24 用户先报「点了保存并关闭退不出程序」，随后又把语义定为
          //   "保存失败一律吐司 + 留在编辑器"，于是 locked 从"要退"翻转成了"不许退"。）
          // ⚠️⚠️ 桩必须打在**页面自己的全局函数**上（`saveAllAsync` / `forceQuitNow`），
          //   **绝不能**去改 `window.gameAPI.*` —— 那是 preload 用 contextBridge 暴露的，
          //   属性是**只读**的：赋值在非严格模式下静默失败 → 真 IPC 照发 → 窗口真的被关掉
          //   → `window-all-closed` → `app.quit()` → 整个 Electron 在套件还没打印时就退了。
          //   症状极像"没设环境变量"：日志只剩 516 字节的启动前缀 + `exit=0`（见教训 22 的姊妹坑）。
          //   而 `saveAllAsync` / `forceQuitNow` 都是顶层 `function` 声明 → 挂在 window 上、可写。
          const quit = await win.webContents.executeJavaScript(`(async function () {
            var quitCalls = 0, saveCalls = 0;
            var origQuitNow = window.forceQuitNow;
            var origSave = window.saveAllAsync;
            window.forceQuitNow = function () { quitCalls++; };
            window.saveAllAsync = async function () { saveCalls++; };
            var t0 = Date.now();
            document.getElementById('btnConfirmOk').click();
            var overlayOn = document.getElementById('loadingOverlay').classList.contains('on');
            for (var i = 0; i < 60 && quitCalls === 0; i++) {
              await new Promise(function (r) { setTimeout(r, 50); });
              if (!overlayOn) overlayOn = document.getElementById('loadingOverlay').classList.contains('on');
            }
            var ms = Date.now() - t0;
            window.forceQuitNow = origQuitNow;
            window.saveAllAsync = origSave;
            return { quitCalls: quitCalls, saveCalls: saveCalls, ms: ms, overlayOn: overlayOn };
          })()`);
          ok('确认「保存并关闭」会走到退出（窗口真的关得掉）',
             quit.quitCalls === 1, 'forceQuitNow 被调 ' + quit.quitCalls + ' 次，耗时 ' + quit.ms + 'ms');
          ok('退出前先落盘（saveAllAndQuit 的顺序：先 await 保存，再退）',
             quit.saveCalls === 1, 'saveCalls=' + quit.saveCalls);
          ok('落盘/退出都已被桩接管，本轮绝不会碰到真实存档',
             quit.saveCalls === 1 && quit.quitCalls === 1);
          ok('退出前亮出过「保存中」遮罩（保存没被腰斩）',
             quit.overlayOn === true, 'overlayOn=' + quit.overlayOn + '，耗时 ' + quit.ms + 'ms');

          // ---- 3) 保存失败：**不该退出**（2026-09-24 用户定的语义）----------------
          // 用户要求：点「保存并退出」若保存失败 → **保存界面消失后弹吐司，并保留在编辑器界面**，
          //   直到玩家再次操作保存成功为止（对话框关闭，不自动退、也不再重弹确认框）。
          // 这里用"抛错的 saveAllAsync"造失败，断言六件事：不退出 / 试过写盘 / 确认框收掉 /
          //   遮罩关掉 / 还在编辑器 / 弹了「保存失败」吐司 —— 且吐司是在**遮罩关掉之后**才弹的
          //   （顺序也是用户明确要求的，只看最终状态验不出来）。
          const failAsk = await win.webContents.executeJavaScript(`(function () {
            askConfirm('是否保存对闯关「close-test」的更改？', { kind: 'close' }, '保存确认', '保存并关闭');
            return getComputedStyle(document.getElementById('confirmModal')).display !== 'none';
          })()`);
          ok('（前置）重新摆出关窗确认框', failAsk === true);

          const failRun = await win.webContents.executeJavaScript(`(async function () {
            var quitCalls = 0, saveCalls = 0;
            var origQuitNow = window.forceQuitNow;
            var origSave = window.saveAllAsync;
            var origToast = window.showToast;
            var toasts = [];
            window.forceQuitNow = function () { quitCalls++; };
            window.saveAllAsync = async function () {
              saveCalls++;
              throw new Error('磁盘写入失败(自检桩)');
            };
            window.showToast = function (msg, opt) {
              try {
                toasts.push({ msg: String(msg),
                              overlayOn: document.getElementById('loadingOverlay').classList.contains('on') });
              } catch (e) {}
              return origToast.apply(window, arguments);
            };
            document.getElementById('btnConfirmOk').click();
            for (var i = 0; i < 40 && toasts.length === 0; i++) await new Promise(function (r) { setTimeout(r, 50); });
            await new Promise(function (r) { setTimeout(r, 250); });
            var r = {
              quitCalls: quitCalls, saveCalls: saveCalls, toasts: toasts,
              modal: getComputedStyle(document.getElementById('confirmModal')).display !== 'none',
              overlay: document.getElementById('loadingOverlay').classList.contains('on'),
              editShown: getComputedStyle(editScreen).display !== 'none'
            };
            window.forceQuitNow = origQuitNow;
            window.saveAllAsync = origSave;
            window.showToast = origToast;
            return r;
          })()`);
          const fToast = (failRun.toasts || []).filter(function (t) { return t.msg.indexOf('保存失败') === 0; }).pop();
          ok('保存失败时**没有**退出（forceQuitNow 未被调用）', failRun.quitCalls === 0, 'quitCalls=' + failRun.quitCalls);
          ok('保存失败时确实尝试过写盘（saveAllAsync 被调 1 次）', failRun.saveCalls === 1, 'saveCalls=' + failRun.saveCalls);
          ok('保存失败：确认框已收掉（不留残框）', failRun.modal === false, 'modal=' + failRun.modal);
          ok('保存失败："保存中"遮罩已消失（保存界面消失）', failRun.overlay === false, 'overlay=' + failRun.overlay);
          ok('保存失败：仍留在编辑器界面', failRun.editShown === true, 'editShown=' + failRun.editShown);
          ok('保存失败：弹了一条「保存失败」吐司', !!fToast, fToast ? fToast.msg : '(没弹)');
          ok('保存失败：吐司是在遮罩关掉之后才弹的（顺序符合要求）',
             !!fToast && fToast.overlayOn === false, fToast ? ('弹时 overlayOn=' + fToast.overlayOn) : '');

        } catch (e) {
          log.push('CLOSE_TEST_ERROR ' + (e && (e.stack || e.message)));
        }
        // ── 真实存档兜底校验 ────────────────────────────────────────────────
        // 按 runbook「测试别往真实 saves/ 留垃圾」的规矩：可能写盘的套件都得留一道网。
        // 这里直接比对 index.json 的字节内容 —— 它一旦被改写，用户的存档列表就变了。
        // 本轮已用空实现接管落盘，正常情况下必须**一字节不差**。
        let indexAfter = null;
        try { indexAfter = fs.readFileSync(indexFile); } catch (e) {}
        const indexSame = (indexBefore === null && indexAfter === null)
          || (!!indexBefore && !!indexAfter && indexBefore.equals(indexAfter));
        ok('真实 index.json 未被本轮测试改写（用户存档列表安全）', indexSame,
           'before=' + (indexBefore ? indexBefore.length + 'B' : 'null')
           + ' after=' + (indexAfter ? indexAfter.length + 'B' : 'null')
           + ' file=' + indexFile);
        if (!indexSame && indexBefore) {
          // 万一真被改了：立刻写回原文，绝不让用户数据留在被破坏的状态
          try { fs.writeFileSync(indexFile, indexBefore); log.push('已按兜底逻辑把 index.json 写回原样'); }
          catch (e) { log.push('兜底写回 index.json 失败：' + (e && e.message)); }
        }
        const passed = log.filter((x) => x.indexOf('PASS') === 0).length;
        const failed = log.filter((x) => x.indexOf('FAIL') === 0).length;
        log.push('SUMMARY passed=' + passed + ' failed=' + failed);
        console.log('===== CLOSE_TEST =====');
        console.log(log.join('\n'));
        console.log('===== CLOSE_TEST END =====');
        app.exit(0);
      })();
    });
  }

  // 文字工具纯文本粘贴自检：TEXT_TEST=1 时验证「粘贴/拖入只保留文字工具自身的格式」
  // 全部是 DOM 级断言，不读画布像素 —— 不受 GPU 进程抖动影响，可稳定复现
  if (process.env.TEXT_TEST === '1') {
    win.webContents.once('did-finish-load', () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        try {
          await sleep(900);
          const out = await win.webContents.executeJavaScript(`(async function () {
            var log = [];
            function ok(name, cond, extra) { log.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '  [' + extra + ']')); }
            // Chromium 会把 style.color 规范化成 rgb(...)，两种写法都算工具色
            function isToolGreen(c) { return c === '#00ff00' || c === 'rgb(0, 255, 0)'; }
            try {
              var s = { id: 3, name: 'text-test', levels: [], createdAt: new Date(), author: '', epilogue: '', retryFromLevel: false, customMusic: false };
              s.levels.push(createLevel('L1', null));
              saves = [s]; saveId = 4; currentEditing = s; currentLevelIdx = 0; currentLayerId = null;
              show(editScreen);
              loadLevel(0);
              document.querySelector('.ly-new-btn[data-type="ground"]').click();
              await new Promise(function (r) { setTimeout(r, 120); });

              var T = window.__textToolTest;
              if (!T) { log.push('FAIL  缺少 __textToolTest 钩子'); return log.join('\\n'); }

              // 工具侧格式：绿色 + 粗体（用来验证来源格式进不来、工具格式也不被覆盖）
              var tc = document.getElementById('tpTextColor');
              tc.value = '#00ff00';
              tc.dispatchEvent(new Event('input'));
              document.querySelector('.fmt-btn[data-fmt="bold"]').classList.add('active');

              T.enter();
              T.create(200, 200);
              T.beginEdit();
              ok('文本框已建立且处于编辑态', !!T.current() && T.current().contentEditable === 'true');
              var st0 = T.style();
              ok('文本框带着工具设置的格式', isToolGreen(st0.color) && st0.fontWeight === 'bold', st0.color + '/' + st0.fontWeight);
              ok('8 个缩放点存在', T.current().querySelectorAll('.tb-handle').length === 8);
              ok('缩放点与占位零宽空格不计入内容', T.plain() === '', JSON.stringify(T.plain()));

              // 富文本粘贴：HTML 里塞满 span/字号/背景色，纯文本给两行
              var RICH = '<b style="color:red;font-size:40px">Hello </b><span style="background:#ffff00;font-family:SimSun">世界</span><br>第二行';
              var r1 = T.fire('paste', 'Hello 世界\\n第二行', RICH);
              ok('粘贴被接管（默认行为已阻止）', r1.prevented === true);
              ok('粘贴后文本框内没有任何格式元素', T.formatElements() === 0, 'fmtEls=' + T.formatElements());
              ok('粘贴未带入源样式/标签', r1.html.indexOf('font-size:40px') < 0 && r1.html.indexOf('background:#ffff00') < 0 && r1.html.indexOf('<b ') < 0 && r1.html.indexOf('<span') < 0);
              ok('取到剪贴板纯文本（两行都在）', r1.text === 'Hello 世界\\n第二行', JSON.stringify(r1.text));
              var st1 = T.style();
              ok('工具格式未被来源格式覆盖', isToolGreen(st1.color) && st1.fontWeight === 'bold' && st1.fontSize === st0.fontSize && st1.fontFamily === st0.fontFamily,
                 st1.color + '/' + st1.fontWeight + '/' + st1.fontSize);

              // 拖入同样只取纯文本
              var r2 = T.fire('drop', '拖入的纯文本', '<i style="color:blue">拖入的纯文本</i>');
              ok('拖放也被接管', r2.prevented === true);
              ok('拖放后仍无格式元素', T.formatElements() === 0, 'fmtEls=' + T.formatElements());
              ok('拖放内容为纯文本', r2.text.indexOf('拖入的纯文本') >= 0, JSON.stringify(r2.text));
              ok('粘贴两行 + 拖入追加，换行结构正确', r2.text.split('\\n').length === 2 && r2.text.indexOf('第二行拖入') > 0, JSON.stringify(r2.text));

              // 打印取文本：块级 / <br> / 富文本 / 实体 一律还原成纯文本
              var D1 = T.plainFromHTML('<div>a</div><div>b</div>');
              ok('块级 div 还原成换行', D1 === 'a\\nb', JSON.stringify(D1));
              var D2 = T.plainFromHTML('a<br>b');
              ok('<br> 还原成换行', D2 === 'a\\nb', JSON.stringify(D2));
              var D3 = T.plainFromHTML('<span style="color:red">红</span><b>粗</b>');
              ok('富文本只取文字', D3 === '红粗', JSON.stringify(D3));
              var D4 = T.plainFromHTML('a&nbsp;b');
              ok('&nbsp; 归一为空格', D4 === 'a b', JSON.stringify(D4));
              var D5 = T.plainFromHTML('2\\u200b');
              ok('零宽空格被清掉', D5 === '2', JSON.stringify(D5));

              // 打印落层：只做结构断言（像素依赖 GPU，崩溃时无意义，由 TILE_TEST 覆盖）
              var box = T.current();
              var printed = T.plain();     // 打印取的就是这个值
              document.getElementById('tpOk').click();
              await new Promise(function (r) { setTimeout(r, 200); });
              ok('点确定后文本框被移除（打印流程跑通）', !T.current() && !box.parentNode);
              ok('打印取文本与应用内内容一致', printed === r2.text, JSON.stringify(printed));
              var L2 = currentLayer();
              var nonEmpty = 0;
              if (L2 && L2.tiles) { for (var k in L2.tiles) if (L2.tiles[k].nonEmpty) nonEmpty++; }
              ok('打印的位图落进了瓦片', nonEmpty > 0, 'nonEmptyTiles=' + nonEmpty);
              T.reset();
            } catch (err) {
              log.push('FAIL  运行时异常 ' + (err && (err.stack || err.message)));
            }
            var passed = log.filter(function (x) { return x.indexOf('PASS') === 0; }).length;
            var failed = log.filter(function (x) { return x.indexOf('FAIL') === 0; }).length;
            log.push('SUMMARY passed=' + passed + ' failed=' + failed);
            return log.join('\\n');
          })()`);
          console.log('===== TEXT_TEST =====');
          console.log(out);
          console.log('===== TEXT_TEST END =====');
        } catch (e) {
          console.log('TEXT_TEST_ERROR', e && (e.stack || e.message));
        }
        app.exit(0);
      })();
    });
  }

  // 界面冒烟自检：UI_TEST=1 时验「Electron 形态（原生边框 / 无白框 / 标题栏）+ 关闭链路 + 主菜单三键」
  // 这几项是网页形态下必然失效的：网页形态按设计保留 20px 边距，也没有原生边框与标题栏。
  if (process.env.UI_TEST === '1') {
    // 关键：加载期一旦有未捕获异常，同一个 <script> 块后面的代码会全部不执行
    //（主菜单按钮、electron-mode、关闭按钮一起失效），所以必须把它当成一等断言
    const loadErrors = [];
    win.webContents.on('console-message', (e, level, message) => {
      if (message && message.indexOf('Uncaught') >= 0) loadErrors.push(message);
    });
    win.webContents.once('did-finish-load', () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        try {
          await sleep(900);
          // 窗口形态事实（原生边框 / 标题 / 固定尺寸 / 菜单）只能在主进程量出来，
          // 但断言要跟渲染侧共用一个 SUMMARY —— 所以量好当参数传进去。
          const boundsOuter = win.getBounds();
          const boundsContent = win.getContentBounds();
          const frameInfo = {
            title: win.getTitle(),
            outerW: boundsOuter.width, outerH: boundsOuter.height,
            contentW: boundsContent.width, contentH: boundsContent.height,
            resizable: win.isResizable(), maximizable: win.isMaximizable(),
            menuNull: Menu.getApplicationMenu() === null
          };
          const out = await win.webContents.executeJavaScript(`(async function (loadErrCount, loadErrFirst, frameInfo) {
            var log = [];
            function ok(name, cond, extra) { log.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '  [' + extra + ']')); }
            function cs(el) { return getComputedStyle(el); }
            function vis(el) { return !!el && cs(el).display !== 'none' && el.getBoundingClientRect().width > 0; }

            ok('加载期无未捕获异常', loadErrCount === 0,
               'count=' + loadErrCount + (loadErrCount ? ' | ' + loadErrFirst : ''));

            // ---- 1) Electron 形态：决定有没有"外围白框" ----
            ok('运行在 Electron 内', navigator.userAgent.indexOf('Electron') !== -1, navigator.userAgent.slice(0, 46));
            ok('body 带 electron-mode', document.body.classList.contains('electron-mode'), document.body.className);
            ok('body 无 padding（不会出现外围白框）', cs(document.body).padding === '0px', cs(document.body).padding);
            var gr = document.getElementById('game').getBoundingClientRect();
            ok('#game 铺满窗口（无白框）',
               Math.abs(gr.width - window.innerWidth) < 2 && Math.abs(gr.height - window.innerHeight) < 2,
               Math.round(gr.width) + 'x' + Math.round(gr.height) + ' vs win ' + window.innerWidth + 'x' + window.innerHeight);
            ok('未落到网页形态提示', document.getElementById('hint').textContent.indexOf('网页形态') < 0,
               JSON.stringify(document.getElementById('hint').textContent));

            // ---- 2) 窗口形态：改用 Windows 原生边框（推翻无边框方案）----
            // 2026-09-24：拖动 / 最小化 / 关闭全交回系统标题栏，于是"自绘拖动条 + 自绘关闭按钮"
            // 这套东西必须消失，而**边框本身**要在场。
            ok('窗口标题为「画个游戏」', frameInfo.title === '画个游戏', frameInfo.title);
            ok('已是原生边框：外框高于内容区（高出来的正是系统标题栏）',
               frameInfo.outerH - frameInfo.contentH >= 20,
               'outer ' + frameInfo.outerW + 'x' + frameInfo.outerH +
               ' vs content ' + frameInfo.contentW + 'x' + frameInfo.contentH);
            ok('内容区仍正好 960x720（useContentSize 没被标题栏顶掉）',
               frameInfo.contentW === 960 && frameInfo.contentH === 720,
               frameInfo.contentW + 'x' + frameInfo.contentH);
            ok('窗口保持固定尺寸（不可缩放 / 不可最大化）',
               frameInfo.resizable === false && frameInfo.maximizable === false,
               'resizable=' + frameInfo.resizable + ' maximizable=' + frameInfo.maximizable);
            ok('原生菜单栏已摘除（免得菜单加速键抢画布快捷键）',
               frameInfo.menuNull === true, 'menu=' + frameInfo.menuNull);

            // 回归哨兵：下面这三样都是"无边框时代"的遗物，改原生边框后必须查无此物
            ok('自定义关闭按钮 #closeBtn 已删除', !document.getElementById('closeBtn'));
            ok('编辑器里的 #btnEditClose 已删除', !document.getElementById('btnEditClose'));

            ok('顶部 #dragbar 元素已整体删除（连覆盖层都不留）',
               !document.getElementById('dragbar'));
            // "拖动功能已删除"要落到 CSS 上验：样式表里不能再有指向它的 app-region: drag
            var dragRules = [];
            Array.prototype.forEach.call(document.styleSheets, function (ss) {
              var rules; try { rules = ss.cssRules; } catch (e) { return; }
              if (!rules) return;
              Array.prototype.forEach.call(rules, function (rl) {
                var t = rl.cssText || '';
                if (t.indexOf('-webkit-app-region') >= 0 && t.indexOf('drag') >= 0) {
                  dragRules.push(rl.selectorText || t.slice(0, 40));
                }
              });
            });
            var dragOnStrip = dragRules.filter(function (s) {
              return s.indexOf('dragbar') >= 0 || s.indexOf('edit-topbar') >= 0;
            });
            ok('拖动条 / 顶部工具栏不再是拖动区（样式表里无对应 app-region: drag）',
               dragOnStrip.length === 0,
               dragOnStrip.length ? dragOnStrip.join(' + ') : ('其它 drag 规则 ' + dragRules.length + ' 条'));
            // 元素删了，样式表里也不该再留下它的规则 —— 否则就是"删了元素没删 CSS"的半拉子清理。
            var barRules = [];
            Array.prototype.forEach.call(document.styleSheets, function (ss) {
              var rules; try { rules = ss.cssRules; } catch (e) { return; }
              if (!rules) return;
              Array.prototype.forEach.call(rules, function (rl) {
                var sel = rl.selectorText || '';
                if (sel.indexOf('#dragbar') >= 0) barRules.push(sel);
              });
            });
            ok('样式表里已无 #dragbar 规则（CSS 也清干净了）',
               barRules.length === 0,
               barRules.length ? barRules.join(' + ') : '0 条');

            // ---- 3) 主菜单三个按钮 ----
            var mainMenu = document.getElementById('mainMenu');
            var saveScreen = document.getElementById('saveScreen');
            var helpScreen = document.getElementById('helpScreen');
            var settingsModal = document.getElementById('settingsModal');
            ok('主菜单初始可见', cs(mainMenu).display !== 'none', cs(mainMenu).display);
            document.getElementById('btnStart').click();
            ok('开始：切到闯关列表', cs(saveScreen).display !== 'none' && cs(mainMenu).display === 'none',
               'save=' + cs(saveScreen).display + ' main=' + cs(mainMenu).display);
            document.getElementById('btnBack').click();
            ok('返回：回到主菜单', cs(mainMenu).display !== 'none' && cs(saveScreen).display === 'none');
            document.getElementById('btnSettings').click();
            ok('设置：弹窗打开', settingsModal.classList.contains('on'));
            document.getElementById('btnSettingsClose').click();
            ok('设置：弹窗可关闭', !settingsModal.classList.contains('on'));
            document.getElementById('btnHelp').click();
            ok('帮助：切到帮助页', cs(helpScreen).display !== 'none');
            document.getElementById('btnHelpBack').click();
            ok('帮助：可返回', cs(helpScreen).display === 'none');

            // ---- 4) 导出弹窗：标题 + 两排导出按钮 + 底部返回 ----
            // 这一组同时是「id 缺失 → null 崩溃拖垮整块脚本」的回归哨兵
            var exModal = document.getElementById('exportModal');
            var exFull = document.getElementById('btnExportFull');
            var exPlay = document.getElementById('btnExportPlay');
            var exBack = document.getElementById('btnExportBack');
            var exTitle = exModal && exModal.querySelector('.modal-title');
            ok('#exportModal 存在', !!exModal);
            ok('导出弹窗标题为「导出」', !!exTitle && exTitle.textContent.trim() === '导出',
               exTitle && exTitle.textContent.trim());
            ok('两排导出按钮文案正确',
               !!exFull && !!exPlay &&
               exFull.textContent.trim() === '导出完整闯关' && exPlay.textContent.trim() === '导出仅游玩闯关',
               (exFull ? exFull.textContent.trim() : 'null') + ' / ' + (exPlay ? exPlay.textContent.trim() : 'null'));
            ok('两个导出按钮用 .action-btn 样式',
               !!exFull && !!exPlay &&
               exFull.classList.contains('action-btn') && exPlay.classList.contains('action-btn'),
               (exFull ? exFull.className : 'null') + ' / ' + (exPlay ? exPlay.className : 'null'));
            ok('底部有「返回」按钮', !!exBack && exBack.textContent.trim() === '返回',
               exBack && exBack.textContent.trim());
            ok('导出弹窗初始关闭', !!exModal && !exModal.classList.contains('on'));
            document.getElementById('btnExport').click();
            ok('点导出按钮：弹窗打开', !!exModal && exModal.classList.contains('on'));
            // 布局断言必须在打开之后（display:none 时所有 rect 都是 0）
            var rFull = exFull.getBoundingClientRect(), rPlay = exPlay.getBoundingClientRect(), rBack = exBack.getBoundingClientRect();
            ok('两个导出按钮各占一排（竖直排列）',
               rFull.top < rPlay.top && Math.abs(rFull.left - rPlay.left) < 1,
               'top ' + Math.round(rFull.top) + ' < ' + Math.round(rPlay.top));
            ok('「返回」在导出按钮下方',
               rBack.top > rPlay.top, Math.round(rPlay.top) + ' -> ' + Math.round(rBack.top));
            ok('两个导出按钮宽度与「返回」一致（.action-btn 未被 92% 默认宽度带偏）',
               Math.abs(rFull.width - rBack.width) < 1,
               'export ' + Math.round(rFull.width) + ' vs back ' + Math.round(rBack.width));
            var exToast = document.getElementById('toast');
            ok('exportCurrentSave 是导出实现（不是占位提示）',
               typeof exportCurrentSave === 'function' && exportCurrentSave.length === 1 &&
               exportCurrentSave.toString().indexOf('exportSave') >= 0);
            // 没有进入任何闯关时点导出：给提示、不弹「另存为」、不抛错
            exFull.click();
            ok('未进入闯关时点「导出完整闯关」：只给提示',
               exToast.textContent.indexOf('请先进入一个闯关') >= 0, exToast.textContent);
            exPlay.click();
            ok('未进入闯关时点「导出仅游玩闯关」：只给提示',
               exToast.textContent.indexOf('请先进入一个闯关') >= 0, exToast.textContent);
            exBack.click();
            ok('点「返回」：弹窗关闭', !!exModal && !exModal.classList.contains('on'));

            // 导入按钮：存在、标题正确、绑的是导入实现（不是个点不动的空按钮）
            var imBtn = document.getElementById('btnImport');
            ok('列表页有导入按钮且标题为「导入闯关」',
               !!imBtn && imBtn.title === '导入闯关', imBtn ? imBtn.title : 'null');
            ok('importSaveFromFile 是导入实现（走 importSave 通道，不是空函数）',
               typeof importSaveFromFile === 'function' &&
               importSaveFromFile.toString().indexOf('importSave') >= 0);
            ok('渲染端已拿到 importSave 通道',
               !!(window.gameAPI && typeof window.gameAPI.importSave === 'function'));

            // ---- 5) 存档元数据 allowEdit：false 的只能游玩、不能进编辑器 ----
            var origSaves = saves;
            var okSave = { id: 9001, name: '可编辑关', createdAt: new Date(), allowEdit: true, levels: [createLevel('第1关', null)] };
            var lockSave = { id: 9002, name: '锁定关', createdAt: new Date(), allowEdit: false, levels: [createLevel('第1关', null)] };
            saves = [okSave, lockSave];
            renderSaves();
            var cards2 = document.querySelectorAll('#saveBody .save-card');
            ok('列表渲染出 2 张存档卡片', cards2.length === 2, cards2.length);
            function actsOf(i) { return document.querySelectorAll('#saveBody .save-card')[i].querySelectorAll('.save-act-btn'); }
            ok('allowEdit=true：编辑按钮未锁定',
               actsOf(0).length === 3 && !actsOf(0)[0].classList.contains('locked'));
            ok('allowEdit=false：编辑按钮已锁定',
               actsOf(1)[0].classList.contains('locked') && actsOf(1)[0].getAttribute('data-locked') === '1',
               actsOf(1)[0].className);
            ok('锁定时改用挂锁图标 + 说明原因', actsOf(1)[0].title.indexOf('不允许编辑') >= 0, actsOf(1)[0].title);
            ok('锁定时「游玩」按钮不受影响', !actsOf(1)[1].classList.contains('locked'));
            ok('canEnterEditor：allowEdit=false 拒绝', canEnterEditor({ allowEdit: false }) === false);
            ok('canEnterEditor：playOnly 通道放行（否则锁死存档连玩都玩不了）',
               canEnterEditor({ allowEdit: false }, { playOnly: true }) === true);
            ok('canEnterEditor：allowEdit=true 放行', canEnterEditor({ allowEdit: true }) === true);
            ok('canEnterEditor：缺字段的老存档视为可编辑',
               canEnterEditor({}) === true && canEnterEditor(null) === true);
            var editScreenEl = document.getElementById('editScreen');
            var beforeEditing = currentEditing;
            actsOf(1)[0].click();
            ok('点锁定的编辑按钮：不进入编辑器',
               cs(editScreenEl).display === 'none' && currentEditing === beforeEditing,
               'edit=' + cs(editScreenEl).display);
            ok('点锁定的编辑按钮：给出原因提示',
               document.getElementById('toast').textContent.indexOf('不允许编辑') >= 0,
               document.getElementById('toast').textContent);
            openEdit(lockSave);
            ok('别的入口直接调 openEdit 也拦得住',
               cs(editScreenEl).display === 'none' && currentEditing === beforeEditing,
               'edit=' + cs(editScreenEl).display);
            ok('serializeSaves 写出 allowEdit 布尔',
               serializeSaves()[0].allowEdit === true && serializeSaves()[1].allowEdit === false,
               serializeSaves()[0].allowEdit + ' / ' + serializeSaves()[1].allowEdit);

            // ---- 5b) 通关状态：锁定的闯关把「共 X 关」换成「未通关／已通关」----
            // 计数位是 .save-meta 的最后一个 span（前面那个是日期）
            function cntOf(i) {
              var m = document.querySelectorAll('#saveBody .save-card')[i].querySelector('.save-meta');
              return m ? m.lastElementChild : null;
            }
            var okCnt = cntOf(0), lockCnt = cntOf(1);
            ok('可编辑的闯关：计数位仍是「共 X 关」（自己建的关不需要通关状态）',
               !!okCnt && okCnt.textContent === '共 1 关', okCnt ? okCnt.textContent : 'null');
            ok('锁定的闯关：计数位改成「未通关」',
               !!lockCnt && lockCnt.textContent === '未通关', lockCnt ? lockCnt.textContent : 'null');
            ok('未通关不再显示关卡数', !!lockCnt && lockCnt.textContent.indexOf('共') < 0, lockCnt ? lockCnt.textContent : 'null');
            ok('未通关挂 save-clear / is-uncleared（灰辉光样式的钩子）',
               !!lockCnt && lockCnt.classList.contains('save-clear') && lockCnt.classList.contains('is-uncleared'),
               lockCnt ? lockCnt.className : 'null');
            ok('未通关用指定样式（白字 + 灰#bcbcbc 3px ×3 + 黑 3px）',
               !!lockCnt && cs(lockCnt).color === 'rgb(255, 255, 255)' &&
               cs(lockCnt).textShadow.indexOf('rgb(188, 188, 188)') >= 0 &&
               cs(lockCnt).textShadow.indexOf('rgb(0, 0, 0)') >= 0,
               lockCnt ? (cs(lockCnt).color + ' | ' + cs(lockCnt).textShadow) : 'null');

            lockSave.cleared = true; renderSaves();
            var lockCnt2 = cntOf(1);
            ok('通关后显示「已通关」', !!lockCnt2 && lockCnt2.textContent === '已通关', lockCnt2 ? lockCnt2.textContent : 'null');
            ok('已通关挂 is-cleared', !!lockCnt2 && lockCnt2.classList.contains('is-cleared'), lockCnt2 ? lockCnt2.className : 'null');
            ok('已通关用指定样式（白字 + 黄#f4ff00 3px ×4）',
               !!lockCnt2 && cs(lockCnt2).color === 'rgb(255, 255, 255)' &&
               cs(lockCnt2).textShadow.indexOf('rgb(244, 255, 0)') >= 0 &&
               cs(lockCnt2).textShadow.indexOf('rgb(188, 188, 188)') < 0,
               lockCnt2 ? (cs(lockCnt2).color + ' | ' + cs(lockCnt2).textShadow) : 'null');
            ok('已通关后编辑按钮照样锁定（通关 ≠ 解锁）',
               document.querySelectorAll('#saveBody .save-card')[1].querySelectorAll('.save-act-btn')[0].classList.contains('locked'));

            // 落盘：读 meta → 补 cleared → 原样写回。整体读改写，别的字段一个都不能丢。
            await window.gameAPI.writeMeta(9002, { id: 9002, name: '锁定关', author: '作者甲', allowEdit: false, cleared: false, levels: [] });
            lockSave.cleared = false;
            await markSaveCleared(lockSave);
            var mClear = await window.gameAPI.readMeta(9002);
            ok('markSaveCleared：cleared 真的落到 meta.json', !!mClear && mClear.cleared === true,
               mClear ? String(mClear.cleared) : 'null');
            ok('markSaveCleared：只补字段，别的字段原样保留',
               !!mClear && mClear.author === '作者甲' && mClear.allowEdit === false && mClear.name === '锁定关',
               mClear ? JSON.stringify(mClear) : 'null');
            ok('markSaveCleared：内存里的 save 对象同步翻成已通关', lockSave.cleared === true);
            var mSnap = JSON.stringify(mClear);
            await markSaveCleared(lockSave);
            var mAgain = await window.gameAPI.readMeta(9002);
            ok('markSaveCleared 幂等：重复通关不再改写 meta', JSON.stringify(mAgain) === mSnap);
            // 收尾用的临时 meta 由本次断言留下，后面统一随 9001/9002 一起删掉

            saves = origSaves; renderSaves();

            var passed = log.filter(function (x) { return x.indexOf('PASS') === 0; }).length;
            var failed = log.filter(function (x) { return x.indexOf('FAIL') === 0; }).length;
            log.push('SUMMARY passed=' + passed + ' failed=' + failed);
            return log.join('\\n');
          })(${loadErrors.length}, ${JSON.stringify(loadErrors[0] || '')}, ${JSON.stringify(frameInfo)})`);
          console.log('===== UI_TEST =====');
          console.log(out);
          console.log('===== UI_TEST END =====');
          // 目视证据：主菜单 + 顶部拖动条 + 右上角关闭按钮
          const shotDir = path.join(__dirname, '_shots');
          if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir);
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(shotDir, 'ui-mainmenu.png'), img.toPNG());
          console.log('SHOT ui-mainmenu.png');
          // 导出的目视证据：把弹窗打开再拍一张
          await win.webContents.executeJavaScript("document.getElementById('btnExport').click()");
          await sleep(300);
          const imgEx = await win.webContents.capturePage();
          fs.writeFileSync(path.join(shotDir, 'ui-export-modal.png'), imgEx.toPNG());
          console.log('SHOT ui-export-modal.png');
          // 目视证据：allowEdit=false 的存档 = 挂锁按钮 + 计数位「未通关／已通关」
          await win.webContents.executeJavaScript(`
            (function () {
              document.getElementById('exportModal').classList.remove('on');
              saves = [
                { id: 9101, name: '可编辑的关', createdAt: new Date(), allowEdit: true, levels: [createLevel('第1关', null)] },
                { id: 9102, name: '锁定的关（仅游玩）', createdAt: new Date(), allowEdit: false, levels: [createLevel('第1关', null)] },
                { id: 9103, name: '已通关的关（仅游玩）', createdAt: new Date(), allowEdit: false, cleared: true, levels: [createLevel('第1关', null)] }
              ];
              hide(document.getElementById('mainMenu'));
              show(document.getElementById('saveScreen'));
              renderSaves();
              return true;
            })()
          `);
          await sleep(400);
          const imgLock = await win.webContents.capturePage();
          fs.writeFileSync(path.join(shotDir, 'ui-locked-save.png'), imgLock.toPNG());
          console.log('SHOT ui-locked-save.png');
        } catch (e) {
          console.log('UI_TEST_ERROR', e && (e.stack || e.message));
        }
        // 收尾：UI_TEST 用的假存档 id 只在内存里，但只要有哪个入口触发了 saveAll()，
        // 就会在 saves/ 留下 9001/9002/9101/9102 这类空壳目录 —— 它们不在 index.json 里，
        // 用户在列表里看不见，却会一直堆着。每次跑完统一收掉。
        for (const tid of [9001, 9002, 9101, 9102, 9103]) {
          try { fs.rmSync(path.join(savesRoot(), String(tid)), { recursive: true, force: true }); } catch (e) {}
        }
        app.exit(0);
      })();
    });
  }

  // 导出 .hgyx 自检：EXPORT_TEST=1
  // 不弹「另存为」的前提下，验证包能被真正解出来、内容齐全、两种模式只差 allowEdit。
  if (process.env.EXPORT_TEST === '1') {
    win.webContents.once('did-finish-load', async () => {
      const log = [];
      const ok = (n, c, extra) => log.push((c ? 'PASS  ' : 'FAIL  ') + n + (extra === undefined ? '' : '  [' + extra + ']'));
      const TID = 999501;
      try {
        // ---- 1) 造一个真实闯关：2 关 3 层，瓦片 + 旧单图 + 音乐 + 缩略图 ----
        const meta = {
          id: TID, name: '导出测试关', createdAt: new Date().toISOString(),
          author: '测试作者', epilogue: '致言', retryFromLevel: false,
          allowEdit: true, customMusic: true, customMusicData: null,
          levels: [
            { name: '第1关', bgColor: '#102030', start: { x: 12, y: -34 }, goal: { x: 56, y: -78 }, voidY: 900,
              layers: [
                { id: 'ly0_0', name: '地面', type: 'ground', z: 0, visible: true, locked: false },
                { id: 'ly0_1', name: '背景板', type: 'bg', z: -1, visible: true, locked: false }
              ] },
            { name: '第2关', bgColor: '#203040', start: { x: 1, y: 2 }, goal: { x: 3, y: 4 }, voidY: 500,
              layers: [ { id: 'ly1_0', name: '地面', type: 'ground', z: 0, visible: true, locked: false } ] }
          ]
        };
        fs.writeFileSync(path.join(saveDir(TID), 'meta.json'), JSON.stringify(meta), 'utf-8');
        const tileA = Buffer.from('tileA-bytes-0123456789');
        const tileB = Buffer.from('tileB-bytes-abcdefghij');
        const d00 = layerTileDir(TID, 0, 0);
        fs.mkdirSync(d00, { recursive: true });
        fs.writeFileSync(path.join(d00, 't-1_-1.png'), tileA);
        fs.writeFileSync(path.join(d00, 't0_0.png'), tileB);
        const legacyBytes = Buffer.from('legacy-single-layer-png-bytes');
        fs.writeFileSync(path.join(layersDir(TID), 'L0_ly1.png'), legacyBytes);
        const musicBytes = Buffer.alloc(300, 7);   // >128 字节：会走 deflate 分支
        fs.writeFileSync(path.join(saveDir(TID), 'custom.mp3'), musicBytes);
        fs.writeFileSync(path.join(saveDir(TID), 'thumbnail.png'), Buffer.from('thumb-bytes'));

        // ---- 2) 完整版打包 ----
        const full = buildHgyxBuffer(TID, 'full');
        ok('完整版打包成功', !!full.ok, full.error);
        ok('产物是 ZIP 容器（PK.. 开头，改后缀即可用解压软件打开）',
           full.buf.slice(0, 4).toString('hex') === '504b0304', full.buf.slice(0, 4).toString('hex'));
        const pack = hgyx.read(full.buf);
        const names = Object.keys(pack).sort();
        ok('包内含 manifest.json / save.json',
           names.indexOf('manifest.json') >= 0 && names.indexOf('save.json') >= 0, names.join(','));
        ok('瓦片按存档同构目录存放',
           names.indexOf('layers/L0_ly0/t-1_-1.png') >= 0 && names.indexOf('layers/L0_ly0/t0_0.png') >= 0,
           names.filter((n) => n.indexOf('layers/') === 0).join(','));
        ok('旧版单图也一并带上', names.indexOf('layers/L0_ly1.png') >= 0);
        ok('音乐与缩略图被带上', names.indexOf('music.mp3') >= 0 && names.indexOf('thumb.png') >= 0);
        ok('瓦片字节与原文件逐字节一致',
           pack['layers/L0_ly0/t-1_-1.png'].equals(tileA), pack['layers/L0_ly0/t-1_-1.png'].length + 'B');
        ok('300 字节音乐往返无损（deflate 分支）',
           pack['music.mp3'].equals(musicBytes), pack['music.mp3'].length + 'B');
        ok('中文文件名/内容不乱码（UTF-8 标记位生效）',
           JSON.parse(pack['save.json'].toString('utf-8')).name === '导出测试关');
        const man = JSON.parse(pack['manifest.json'].toString('utf-8'));
        ok('清单声明格式与类型',
           man.format === 'hgyx' && man.formatVersion === 1 && man.kind === 'full',
           man.format + '/' + man.formatVersion + '/' + man.kind);
        ok('清单统计与实际相符',
           man.levels === 2 && man.layerTiles === 2 && man.layerImages === 1 &&
           man.hasMusic === true && man.hasThumb === true,
           JSON.stringify({ lv: man.levels, t: man.layerTiles, i: man.layerImages, m: man.hasMusic, th: man.hasThumb }));
        const sj = JSON.parse(pack['save.json'].toString('utf-8'));
        ok('元数据完整（作者 / 致言 / 自定义音乐标记）',
           sj.author === '测试作者' && sj.epilogue === '致言' && sj.customMusic === true);
        ok('背景色 / 起点 / 终点 / 死亡界限都在',
           sj.levels[0].bgColor === '#102030' && sj.levels[0].start.x === 12 && sj.levels[0].start.y === -34 &&
           sj.levels[0].goal.x === 56 && sj.levels[0].goal.y === -78 && sj.levels[0].voidY === 900,
           JSON.stringify(sj.levels[0].start) + ' ' + JSON.stringify(sj.levels[0].goal));
        ok('图层清单（含 z 序）都在',
           sj.levels[0].layers.length === 2 && sj.levels[0].layers[1].z === -1 && sj.levels[0].layers[1].name === '背景板');
        ok('完整版保留 allowEdit=true', sj.allowEdit === true, sj.allowEdit);

        // ---- 3) 仅游玩版：内容一致，只有 allowEdit 变 false ----
        const play = buildHgyxBuffer(TID, 'play');
        const pack2 = hgyx.read(play.buf);
        const sj2 = JSON.parse(pack2['save.json'].toString('utf-8'));
        const man2 = JSON.parse(pack2['manifest.json'].toString('utf-8'));
        ok('仅游玩版：allowEdit=false', sj2.allowEdit === false, sj2.allowEdit);
        ok('仅游玩版：关卡结构（背景/起点/终点/图层）与完整版完全一致',
           JSON.stringify(sj2.levels) === JSON.stringify(sj.levels));
        ok('仅游玩版：笔迹瓦片同样在里面且一致', pack2['layers/L0_ly0/t0_0.png'].equals(tileB));
        ok('仅游玩版：清单类型标记为 play', man2.kind === 'play' && man2.allowEdit === false);
        ok('导出仅游玩版不会反过来锁住本机存档（磁盘 meta 未被改写）',
           fs.readFileSync(path.join(saveDir(TID), 'meta.json'), 'utf-8').indexOf('"allowEdit":true') >= 0);

        // ---- 4) 落盘 + 文件名规则 ----
        const outDir = path.join(__dirname, '_shots');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
        const outFile = path.join(outDir, 'export-test.hgyx');
        fs.writeFileSync(outFile, full.buf);
        ok('文件可落盘且非空',
           fs.statSync(outFile).size === full.buf.length && full.buf.length > 200, fs.statSync(outFile).size + 'B');
        ok('落盘文件能再次解包（等于用户拿到文件后能打开）',
           Object.keys(hgyx.read(fs.readFileSync(outFile))).length === names.length);
        ok('默认文件名 = 闯关名称.hgyx', safeSaveName(meta.name, 'x') + '.hgyx' === '导出测试关.hgyx');
        ok('非法文件名字符被替换',
           safeSaveName('a/b:c*d?e"f<g>h|i', 'x') === 'a_b_c_d_e_f_g_h_i', safeSaveName('a/b:c*d?e"f<g>h|i', 'x'));
        ok('结尾的点/空格被去掉（Windows 不允许）',
           safeSaveName('名字... ', 'x') === '名字', '[' + safeSaveName('名字... ', 'x') + ']');
        ok('名称全非法时用兜底名', safeSaveName('   ', 'fallback') === 'fallback');
        ok('不存在的闯关 → 明确报错而不是产出空包', buildHgyxBuffer(999502, 'full').ok === false);

        // ---- 5) 渲染端：没进入闯关时点导出，不该弹「另存为」 ----
        const guard = await win.webContents.executeJavaScript(
          "(function(){ var t=document.getElementById('toast'); currentEditing=null; exportCurrentSave('full'); return t.textContent; })()");
        ok('未进入闯关时导出被前置拦住（不会弹出系统对话框）',
           String(guard).indexOf('请先进入一个闯关') >= 0, guard);
        ok('渲染端已拿到 exportSave 通道',
           await win.webContents.executeJavaScript('!!(window.gameAPI && window.gameAPI.exportSave)') === true);
      } catch (e) {
        log.push('FAIL  异常：' + (e && (e.stack || e.message)));
      } finally {
        // 测试数据不留存
        for (const id of [TID, 999502]) {
          try { fs.rmSync(path.join(savesRoot(), String(id)), { recursive: true, force: true }); } catch (e2) {}
        }
      }
      const passed = log.filter((x) => x.indexOf('PASS') === 0).length;
      const failed = log.filter((x) => x.indexOf('FAIL') === 0).length;
      log.push('SUMMARY passed=' + passed + ' failed=' + failed);
      console.log('===== EXPORT_TEST =====');
      console.log(log.join('\n'));
      console.log('===== EXPORT_TEST END =====');
      app.exit(failed ? 1 : 0);
    });
  }

  // 导入 .hgyx 自检：IMPORT_TEST=1
  // 真造一个闯关 → 导出成包 → 删掉原闯关 → 用导出产物导入回来，验证内容逐字节一致。
  // 只有最后一段完整流程会写 index.json，那段前后都做了备份/还原。
  if (process.env.IMPORT_TEST === '1') {
    win.webContents.once('did-finish-load', async () => {
      const log = [];
      const ok = (n, c, extra) => log.push((c ? 'PASS  ' : 'FAIL  ') + n + (extra === undefined ? '' : '  [' + extra + ']'));
      const zlib = require('zlib');
      const SRC = 999601;      // 造出来的「原始闯关」
      const DEST = 999602;     // materializeImport 的固定目标 id
      const outDir = path.join(__dirname, '_shots');
      const outFile = path.join(outDir, 'import-test.hgyx');
      const txtFile = path.join(outDir, 'import-test-not-a-package.txt');
      let indexBackup = null, e2eId = null;

      // 手搓一个真 PNG（导入端会校验 PNG 魔数，导出测试那种假字节过不去）
      const pngChunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
        const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(hgyx.crc32(td), 0);
        return Buffer.concat([len, td, crc]);
      };
      const makePng = (w, h, rgb) => {
        const ihdr = Buffer.alloc(13);
        ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
        ihdr[8] = 8; ihdr[9] = 2;   // 8bit truecolor
        const rows = [];
        for (let y = 0; y < h; y++) {
          const line = Buffer.alloc(1 + w * 3);
          for (let x = 0; x < w; x++) {
            line[1 + x * 3] = rgb[0]; line[2 + x * 3] = rgb[1]; line[3 + x * 3] = rgb[2];
          }
          rows.push(line);
        }
        return Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          pngChunk('IHDR', ihdr),
          pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
          pngChunk('IEND', Buffer.alloc(0))
        ]);
      };

      const metaOf = (id) => JSON.parse(fs.readFileSync(path.join(savesRoot(), String(id), 'meta.json'), 'utf-8'));
      const readTile = (id, li, ci, name) =>
        fs.readFileSync(path.join(layerTileDir(id, li, ci), name));

      try {
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

        // ---- 0) 自检用的 PNG 本身要合法，否则后面全是假失败 ----
        const pngA = makePng(4, 4, [255, 0, 0]);
        const pngB = makePng(4, 4, [0, 128, 255]);
        const pngC = makePng(2, 2, [0, 255, 0]);
        ok('自检用 PNG 本身合法（魔数正确）', pngA.slice(0, 4).equals(PNG_MAGIC) && pngA.length > 40, pngA.length + 'B');

        // ---- 1) 造一个真实闯关（2 关 3 层 + 旧单图 + 音乐 + 缩略图）----
        const srcMeta = {
          id: SRC, name: '导入测试关', createdAt: '2026-01-02T03:04:05.000Z',
          author: '原作者', epilogue: '致言文本', retryFromLevel: true,
          allowEdit: true, customMusic: true, customMusicData: null,
          cleared: true,     // 故意带上：通关状态是本机进度，不许跟着包走（下面断言导入后必须是 false）
          levels: [
            { name: '第1关', bgColor: '#102030', start: { x: 12, y: -34 }, goal: { x: 56, y: -78 }, voidY: 900,
              layers: [
                { id: 'ly0_0', name: '地面', type: 'ground', z: 0, visible: true, locked: false },
                { id: 'ly0_1', name: '背景板', type: 'bg', z: -1, visible: true, locked: false }
              ] },
            { name: '第2关', bgColor: '#203040', start: { x: 1, y: 2 }, goal: { x: 3, y: 4 }, voidY: 500,
              layers: [ { id: 'ly1_0', name: '地面', type: 'ground', z: 0, visible: true, locked: false } ] }
          ]
        };
        fs.mkdirSync(saveDir(SRC), { recursive: true });
        fs.writeFileSync(path.join(saveDir(SRC), 'meta.json'), JSON.stringify(srcMeta), 'utf-8');
        const d00 = layerTileDir(SRC, 0, 0);
        fs.mkdirSync(d00, { recursive: true });
        fs.writeFileSync(path.join(d00, 't-1_-1.png'), pngA);
        fs.writeFileSync(path.join(d00, 't0_0.png'), pngB);
        const d01 = layerTileDir(SRC, 0, 1);
        fs.mkdirSync(d01, { recursive: true });
        fs.writeFileSync(path.join(d01, 't0_0.png'), pngC);
        fs.writeFileSync(path.join(layersDir(SRC), 'L1_ly0.png'), pngC);          // 旧单图
        const musicBytes = Buffer.alloc(300, 7);
        fs.writeFileSync(path.join(saveDir(SRC), 'custom.mp3'), musicBytes);
        fs.writeFileSync(path.join(saveDir(SRC), 'thumbnail.png'), pngC);

        const full = buildHgyxBuffer(SRC, 'full');
        const play = buildHgyxBuffer(SRC, 'play');
        ok('原始闯关打包成功', !!full.ok && !!play.ok, full.error);
        fs.writeFileSync(outFile, full.buf);

        // 原闯关删掉：后面导入出来的东西只可能来自包本身，不是捡现成的
        fs.rmSync(path.join(savesRoot(), String(SRC)), { recursive: true, force: true });

        // ---- 2) 解析 + 校验 ----
        const parsed = parseHgyx(full.buf);
        ok('包能解析通过', parsed.ok === true, parsed.error);
        ok('清单宣告格式/版本/类型', parsed.manifest.format === 'hgyx'
           && parsed.manifest.formatVersion === hgyx.FORMAT_VERSION && parsed.manifest.kind === 'full',
           JSON.stringify({ f: parsed.manifest.format, v: parsed.manifest.formatVersion, k: parsed.manifest.kind }));
        ok('元数据（名称/作者/致言/创建时间）读出来了',
           parsed.saveJson.name === '导入测试关' && parsed.saveJson.author === '原作者'
           && parsed.saveJson.epilogue === '致言文本' && parsed.saveJson.createdAt === '2026-01-02T03:04:05.000Z');

        // ---- 3) 落盘到固定 id（不碰 index.json）----
        const mat = materializeImport(parsed, DEST);
        ok('落盘成功', mat.ok === true);
        ok('瓦片数 / 旧单图数正确', mat.tiles === 3 && mat.legacies === 1,
           'tiles=' + mat.tiles + ' legacy=' + mat.legacies);
        const m1 = metaOf(DEST);
        ok('id 被换成新分配的（不会和本机别的闯关撞号）', m1.id === DEST, m1.id);
        ok('名称/作者/致言/重试标记原样保留',
           m1.name === '导入测试关' && m1.author === '原作者' && m1.epilogue === '致言文本' && m1.retryFromLevel === true);
        ok('创建时间原样保留', m1.createdAt === '2026-01-02T03:04:05.000Z', m1.createdAt);
        ok('笔迹瓦片逐字节一致（含二级目录的那张）',
           readTile(DEST, 0, 0, 't-1_-1.png').equals(pngA) && readTile(DEST, 0, 0, 't0_0.png').equals(pngB)
           && readTile(DEST, 0, 1, 't0_0.png').equals(pngC));
        ok('旧版单图层也还原了', fs.readFileSync(path.join(layersDir(DEST), 'L1_ly0.png')).equals(pngC));
        ok('自定义音乐还原且标记为 true',
           fs.readFileSync(path.join(saveDir(DEST), 'custom.mp3')).equals(musicBytes) && m1.customMusic === true);
        ok('缩略图还原', fs.readFileSync(path.join(saveDir(DEST), 'thumbnail.png')).equals(pngC));
        ok('关卡结构（背景色/起点/终点/死亡界限）原样保留',
           m1.levels[0].bgColor === '#102030' && m1.levels[0].start.x === 12 && m1.levels[0].start.y === -34
           && m1.levels[0].goal.x === 56 && m1.levels[0].goal.y === -78 && m1.levels[0].voidY === 900);
        ok('图层描述（名称/类型/z 序）原样保留',
           m1.levels[0].layers.length === 2 && m1.levels[0].layers[1].type === 'bg' && m1.levels[0].layers[1].z === -1);
        ok('有二级目录的图层也被还原', m1.levels[0].layers.length >= 2);

        // ---- 4) 渲染端能按正常路径读到（走 preload + IPC，不是我自己读自己）----
        const viaIpc = await win.webContents.executeJavaScript(
          "window.gameAPI.readLayerTiles(" + DEST + ",0,0).then(function(p){" +
          "return JSON.stringify({k:Object.keys(p.tiles||{}).sort(), legacy:!!p.legacy, b64:(p.tiles&&p.tiles['0,0']||'').slice(0,22)});})");
        const ipcObj = JSON.parse(viaIpc);
        // IPC 的键是 "tx,ty"（磁盘上才是 t{tx}_{ty}.png），别拿文件名去当键
        ok('渲染端经 IPC 读回瓦片键一致', ipcObj.k.join(' ') === '-1,-1 0,0', viaIpc);
        ok('渲染端拿到的是 data:image/png base64', ipcObj.b64 === 'data:image/png;base64,', ipcObj.b64);

        // ---- 5) 仅游玩包：内容不变，只有 allowEdit 变 false（导入后就是锁的）----
        const matPlay = materializeImport(parseHgyx(play.buf), DEST);
        const m2 = metaOf(DEST);
        ok('导入「仅游玩」包 → allowEdit=false（列表里会挂锁）', m2.allowEdit === false && matPlay.allowEdit === false);
        ok('导入「仅游玩」包 → 关卡结构一字不差',
           JSON.stringify(m2.levels) === JSON.stringify(m1.levels));
        ok('导入「仅游玩」包 → 笔迹同样完整', readTile(DEST, 0, 0, 't0_0.png').equals(pngB));
        // 通关状态跟着包走的话，刚导入就顶着「已通关」，玩家连玩都没玩 —— 必须一律重置
        ok('包里带 cleared=true 也不认：导入的闯关一律「未通关」',
           m2.cleared === false && m1.cleared === false, 'full=' + m1.cleared + ' play=' + m2.cleared);

        // ---- 6) meta 与瓦片对不上时，以实际文件为准补齐图层（否则笔迹会「导入成功但看不见」）----
        const brokenJson = JSON.parse(JSON.stringify(parsed.saveJson));
        delete brokenJson.levels[0].layers;          // 第 1 关的图层清单整个丢掉
        const brokenBuf = hgyx.write([
          { name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'hgyx', formatVersion: 1, kind: 'full' }), 'utf-8') },
          { name: 'save.json', data: Buffer.from(JSON.stringify(brokenJson), 'utf-8') },
          { name: 'layers/L0_ly0/t0_0.png', data: pngB },
          { name: 'layers/L0_ly1/t0_0.png', data: pngC },
          { name: 'layers/L2_ly0/t0_0.png', data: pngA }        // 还多出一关
        ]);
        const matBroken = materializeImport(parseHgyx(brokenBuf), DEST);
        const m3 = metaOf(DEST);
        ok('图层清单缺失时按实际瓦片补齐（第1关补到 2 层）',
           m3.levels[0].layers.length === 2, 'layers=' + m3.levels[0].layers.length);
        ok('包里多出的关卡也被补上（否则那关的笔迹永远读不出来）',
           m3.levels.length === 3 && m3.levels[2].layers.length === 1, 'levels=' + m3.levels.length);
        ok('补出来的图层有完整默认字段（能直接进编辑器）',
           !!m3.levels[0].layers[0].id && m3.levels[0].layers[0].type === 'ground' && m3.levels[0].layers[0].visible === true);
        ok('补齐后仍写盘了 3 张瓦片', matBroken.tiles === 3, matBroken.tiles);

        // ---- 7) 坏包必须明确拒绝，而不是写出一份坏存档 ----
        const badZip = hgyx.write([
          { name: 'save.json', data: Buffer.from('{"levels":[]}', 'utf-8') }
        ]);                                                       // 缺 manifest.json
        ok('缺 manifest.json → 拒绝', parseHgyx(badZip).ok === false, parseHgyx(badZip).error);
        const badFmt = hgyx.write([
          { name: 'manifest.json', data: Buffer.from('{"format":"other"}', 'utf-8') },
          { name: 'save.json', data: Buffer.from('{"levels":[]}', 'utf-8') }
        ]);
        ok('不是本程序的包 → 拒绝', parseHgyx(badFmt).ok === false, parseHgyx(badFmt).error);
        const badVer = hgyx.write([
          { name: 'manifest.json', data: Buffer.from('{"format":"hgyx","formatVersion":99}', 'utf-8') },
          { name: 'save.json', data: Buffer.from('{"levels":[]}', 'utf-8') }
        ]);
        const rVer = parseHgyx(badVer);
        ok('包格式比本程序新 → 提示升级而不是硬读',
           rVer.ok === false && String(rVer.error).indexOf('升级') >= 0, rVer.error);
        const noLevels = hgyx.write([
          { name: 'manifest.json', data: Buffer.from('{"format":"hgyx","formatVersion":1}', 'utf-8') },
          { name: 'save.json', data: Buffer.from('{"name":"x"}', 'utf-8') }
        ]);
        ok('save.json 缺 levels → 拒绝', parseHgyx(noLevels).ok === false, parseHgyx(noLevels).error);
        ok('不是 ZIP 的随机文件 → 拒绝', parseHgyx(Buffer.from('这不是压缩包，只是一段文字而已')).ok === false);
        ok('空文件 → 拒绝', parseHgyx(Buffer.alloc(0)).ok === false);
        fs.writeFileSync(txtFile, 'not a package');
        const rTxt = importHgyxFromPath(txtFile);
        ok('非 .hgyx 后缀 → 拒绝（对话框过滤不能当唯一防线）',
           rTxt.ok === false && String(rTxt.error).indexOf('.hgyx') >= 0, rTxt.error);
        ok('不存在的文件 → 明确报错', importHgyxFromPath(path.join(outDir, 'no-such-file.hgyx')).ok === false);
        ok('坏包不会在磁盘上留下空壳',
           !fs.existsSync(path.join(savesRoot(), '999603')), '999603');

        // ---- 8) 纯函数：id 分配与重名后缀 ----
        // 只断言「性质」不断言具体数值：本机 saves/ 里本来就有 1..11 的真实目录，
        // 而 allocateSaveId 会刻意跳过已存在的目录（正是要验证的行为），写死数字必假失败。
        const aid1 = allocateSaveId({ nextId: 5, saves: [{ id: 5 }, { id: 6 }] });
        ok('分配 id：不撞已有条目、也不小于 nextId', aid1 > 6 && aid1 !== 5 && aid1 !== 6, aid1);
        const aid2 = allocateSaveId({ nextId: 1, saves: [{ id: 9 }] });
        ok('分配 id：nextId 落后时也不会撞已有条目', aid2 > 9, aid2);
        ok('分配 id：没有冲突时就用 nextId 本身',
           allocateSaveId({ nextId: 999900, saves: [] }) === 999900,
           allocateSaveId({ nextId: 999900, saves: [] }));
        ok('分配 id：跳过磁盘上残留的孤儿目录（否则会把别人的存档整层覆盖）',
           allocateSaveId({ nextId: DEST, saves: [] }) > DEST, allocateSaveId({ nextId: DEST, saves: [] }));
        ok('重名 → 加「（导入）」后缀', uniqueSaveName('甲', { saves: [{ name: '甲' }] }) === '甲（导入）',
           uniqueSaveName('甲', { saves: [{ name: '甲' }] }));
        ok('重名两次 → 「（导入2）」',
           uniqueSaveName('甲', { saves: [{ name: '甲' }, { name: '甲（导入）' }] }) === '甲（导入2）',
           uniqueSaveName('甲', { saves: [{ name: '甲' }, { name: '甲（导入）' }] }));
        ok('不重名 → 原样', uniqueSaveName('乙', { saves: [{ name: '甲' }] }) === '乙');
        ok('重名后缀也走文件名安全化', uniqueSaveName('a/b', { saves: [] }) === 'a_b');

        // ---- 9) 完整流程（唯一会写 index.json 的一段：前后都备份/还原）----
        const idxPath = path.join(savesRoot(), 'index.json');
        indexBackup = fs.existsSync(idxPath) ? fs.readFileSync(idxPath, 'utf-8') : null;
        const e2e = importHgyxBuffer(full.buf);
        ok('端到端导入成功', e2e.ok === true, e2e.error);
        e2eId = e2e.ok ? e2e.id : null;
        ok('端到端：名称原样（本机列表里没有同名的）', e2e.name === '导入测试关', e2e.name);
        ok('端到端：完整版 allowEdit=true（可继续编辑）', e2e.allowEdit === true, e2e.allowEdit);
        ok('端到端：关卡数 / 瓦片数正确', e2e.levels === 2 && e2e.tiles === 3,
           'levels=' + e2e.levels + ' tiles=' + e2e.tiles);
        const idxAfter = readIndexJson();
        const e2eEntry = idxAfter.saves.filter((s) => s.id === e2eId)[0];
        ok('新闯关挂进了 index.json（列表里能看见）', !!e2eEntry, JSON.stringify(e2eEntry));
        ok('index 条目字段齐全（allowEdit / 音乐标记都在）',
           !!e2eEntry && e2eEntry.allowEdit === true && e2eEntry.customMusic === true
           && e2eEntry.retryFromLevel === true && e2eEntry.name === '导入测试关');
        ok('nextId 已推进（下次新建不会撞号）', idxAfter.nextId > e2eId, 'nextId=' + idxAfter.nextId + ' id=' + e2eId);
        ok('端到端落盘的 meta 可读回且 id 正确', metaOf(e2eId) && metaOf(e2eId).id === e2eId);
        const e2eFile = path.join(savesRoot(), String(e2eId), 'layers', 'L0_ly0', 't0_0.png');
        ok('端到端落盘的瓦片在磁盘上', fs.existsSync(e2eFile) && fs.readFileSync(e2eFile).equals(pngB));

        // 同名再导入一次 → 应拿到带后缀的新条目，且两条并存
        const e2e2 = importHgyxBuffer(full.buf);
        ok('同名再导入 → 自动改名不覆盖', e2e2.ok === true && e2e2.name === '导入测试关（导入）', e2e2.name);
        ok('同名再导入 → 两条并存（原条目没被顶掉）',
           readIndexJson().saves.filter((s) => s.id === e2eId).length === 1 && e2e2.id !== e2eId);
        if (e2e2.ok) { try { fs.rmSync(path.join(savesRoot(), String(e2e2.id)), { recursive: true, force: true }); } catch (e) {} }

        // ---- 10) 渲染端：按钮与通道就位 ----
        const ui = await win.webContents.executeJavaScript(
          "(function(){var b=document.getElementById('btnImport');" +
          "return JSON.stringify({has:!!b,title:b?b.title:'',fn:typeof importSaveFromFile});})()");
        const uiObj = JSON.parse(ui);
        ok('列表页有导入按钮且标题为「导入闯关」', uiObj.has === true && uiObj.title === '导入闯关', ui);
        ok('导入函数已定义（按钮绑的是它）', uiObj.fn === 'function', uiObj.fn);
        ok('渲染端已拿到 importSave 通道',
           await win.webContents.executeJavaScript('!!(window.gameAPI && window.gameAPI.importSave)') === true);
      } catch (e) {
        log.push('FAIL  异常：' + (e && (e.stack || e.message)));
      } finally {
        // 收尾。⚠️ 整段必须再包一层 try/catch：finally 里抛出的异常会**吃掉后面所有代码**，
        // 连 app.exit() 都到不了 —— 于是这是个永远不退出的 Electron，PowerShell 卡在
        // `& $el` 上，后续套件一个都不会跑（2026-09-21 真踩过：一个手误的未声明变量
        // 让整套回归静默挂死 9 分钟）。清理失败无关紧要，退出才是必须的。
        try {
          const idxPath2 = path.join(savesRoot(), 'index.json');
          if (indexBackup !== null) fs.writeFileSync(idxPath2, indexBackup, 'utf-8');
          else if (fs.existsSync(idxPath2)) fs.rmSync(idxPath2, { force: true });
        } catch (e3) {}
        try {
          // 「同名再导入」那次的目录在上面就地删掉了，这里不必再列
          for (const id of [SRC, DEST, e2eId, 999603]) {
            if (id === null || id === undefined) continue;
            try { fs.rmSync(path.join(savesRoot(), String(id)), { recursive: true, force: true }); } catch (e4) {}
          }
          if (fs.existsSync(txtFile)) fs.rmSync(txtFile, { force: true });
        } catch (e5) {}
      }
      const passed = log.filter((x) => x.indexOf('PASS') === 0).length;
      const failed = log.filter((x) => x.indexOf('FAIL') === 0).length;
      log.push('SUMMARY passed=' + passed + ' failed=' + failed);
      console.log('===== IMPORT_TEST =====');
      console.log(log.join('\n'));
      console.log('===== IMPORT_TEST END =====');
      app.exit(failed ? 1 : 0);
    });
  }

  // 撤销 / 重做自检：UNDO_TEST=1
  // 纯渲染端内存里的操作，**不碰磁盘、不碰用户的存档**（假存档只在内存里，
  // 且把 saveAll 临时换成空函数，避免任何路径顺手写盘）。
  if (process.env.UNDO_TEST === '1') {
    win.webContents.once('did-finish-load', async () => {
      const log = [];
      const ok = (n, c, extra) => log.push((c ? 'PASS  ' : 'FAIL  ') + n + (extra === undefined ? '' : '  [' + extra + ']'));
      let out = '';
      try {
        await new Promise((r) => setTimeout(r, 900));
        out = await win.webContents.executeJavaScript(`(async function () {
          var log = [];
          function ok(name, cond, extra) { log.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '  [' + extra + ']')); }
          var H = window.__histTest;
          if (!H) { log.push('FAIL  未找到 window.__histTest'); return log.join('\\n'); }
          var depth = function () { return H.state().idx + 1; };

          // 备份会被测试改动的全局，跑完原样还原
          var bak = {
            saves: saves, editing: currentEditing, idx: currentLevelIdx, layerId: currentLayerId,
            tool: currentTool, pen: currentPenTool, shape: brushShape, op: strokeOp,
            color: strokeColor, brush: brushRange.value, saveAll: saveAll, scr: editScreen
          };
          function mkLayers(lv, n) {
            for (var i = 0; i < n; i++) {
              lv.layers.push({ id: 'lyt' + (layerSeq++), name: '图层' + (i + 1), type: 'ground',
                               z: n - 1 - i, visible: true, locked: false, tiles: {} });
            }
            return lv;
          }
          function mkSave(lock) {
            var s = { id: 999801, name: '撤销测试关', createdAt: new Date(), allowEdit: !lock, levels: [] };
            s.levels.push(mkLayers(createLevel('第1关', null), 2));
            return s;
          }
          function px(L, x, y) {
            var t = getTile(L, 0, 0, false);            // 测试只用瓦片 (0,0)
            if (!t) return null;
            var d = t.ctx.getImageData(x, y, 1, 1).data;
            return [d[0], d[1], d[2], d[3]];
          }
          function red() { return '[255,0,0,255]'; }
          function none() { return '[0,0,0,0]'; }
          function paint(ix, iy, size, color) {
            currentPenTool = 'brush'; brushShape = 'square'; brushRange.value = size;
            strokeOp = 'source-over'; strokeColor = color;
            H.begin('笔迹'); drawSquareStamp(ix, iy); H.commit();
          }
          function erase(ix, iy, size) {
            currentPenTool = 'eraser'; brushShape = 'square'; brushRange.value = size;
            strokeOp = 'destination-out'; strokeColor = 'rgba(0,0,0,1)';
            H.begin('笔迹'); drawSquareStamp(ix, iy); H.commit();
          }

          // ── 进入「编辑器」：不碰真存档，直接在内存里搭一个 ──
          saves = [mkSave()];
          currentEditing = saves[0];
          currentLevelIdx = 0;
          var L0 = currentEditing.levels[0].layers[0];
          currentLayerId = L0.id;
          H.enter();
          renderEditLevels();
          var st = H.state();
          ok('进入编辑器：记录已启用且为空', st.enabled === true && st.n === 0 && st.idx === -1, JSON.stringify(st));

          // ── A) 笔迹：一笔 = 一步；撤销把像素还原、把新建的瓦片收掉 ──
          paint(2048 + 100, 2048 + 100, 20, '#ff0000');
          ok('落笔后瓦片里有红色像素', JSON.stringify(px(L0, 100, 100)) === red(), JSON.stringify(px(L0, 100, 100)));
          st = H.state();
          ok('一笔只入栈一步', st.n === 1 && st.idx === 0, JSON.stringify({ n: st.n, idx: st.idx }));
          ok('记的是小矩形补丁，不是整张瓦片（一张瓦片 16MB）',
             st.patches >= 1 && st.bytes > 0 && st.bytes < 1024 * 1024,
             'patches=' + st.patches + ' bytes=' + st.bytes);
          H.undo();
          // 这一笔是「从无到有」新建的瓦片，撤销后瓦片被整个收掉 → 读不到像素，等价于透明
          ok('撤销笔迹：像素回到透明', px(L0, 100, 100) === null || JSON.stringify(px(L0, 100, 100)) === none(),
             JSON.stringify(px(L0, 100, 100)));
          ok('撤销笔迹：这一笔新建的瓦片被收掉（没留空瓦片）', getTile(L0, 0, 0, false) === null);
          ok('撤销笔迹：画布上的瓦片元素也清掉了',
             document.querySelectorAll('#layerStack .ink-tile').length === 0,
             document.querySelectorAll('#layerStack .ink-tile').length);
          ok('撤销到最底下之后就撤不动了', H.state().idx === -1 && H.undo() === false);
          H.redo();
          ok('重做笔迹：红色像素回来了', JSON.stringify(px(L0, 100, 100)) === red(), JSON.stringify(px(L0, 100, 100)));
          ok('重做笔迹：瓦片重新挂回画布', document.querySelectorAll('#layerStack .ink-tile').length === 1,
             document.querySelectorAll('#layerStack .ink-tile').length);

          // ── B) 擦除：撤销把擦掉的像素补回来 ──
          erase(2048 + 100, 2048 + 100, 40);
          ok('擦除后该处变透明', JSON.stringify(px(L0, 100, 100)) === none(), JSON.stringify(px(L0, 100, 100)));
          H.undo();
          ok('撤销擦除：红色像素补回来了', JSON.stringify(px(L0, 100, 100)) === red(), JSON.stringify(px(L0, 100, 100)));
          H.redo();
          ok('重做擦除：又擦干净了', JSON.stringify(px(L0, 100, 100)) === none(), JSON.stringify(px(L0, 100, 100)));
          H.undo(); H.undo();
          ok('连撤两步回到最初始（无笔迹、无瓦片、无一步可撤）',
             getTile(L0, 0, 0, false) === null && H.state().idx === -1,
             'tile=' + !!getTile(L0, 0, 0, false) + ' idx=' + H.state().idx);

          // ── C) 重叠印子：同一笔里第 2 个印子记下的「改动前」已含第 1 个印子的像素，
          //        还原必须倒序贴回，否则重叠区会残留绿色（这是本功能最容易错的地方）──
          paint(2048 + 220, 2048 + 200, 60, '#ff0000');           // 红色方块 x∈[190,250)
          currentPenTool = 'brush'; brushShape = 'square'; brushRange.value = 60;
          strokeOp = 'source-over'; strokeColor = '#00ff00';
          H.begin('笔迹');
          drawSquareStamp(2048 + 250, 2048 + 200);                // 绿 x∈[220,280)
          drawSquareStamp(2048 + 280, 2048 + 200);                // 绿 x∈[250,310)
          H.commit();
          ok('一笔两个印子后：重叠处是绿',
             JSON.stringify(px(L0, 260, 200)) === '[0,255,0,255]', JSON.stringify(px(L0, 260, 200)));
          H.undo();
          ok('撤销这一笔：先铺的红完整保留', JSON.stringify(px(L0, 200, 200)) === red(), JSON.stringify(px(L0, 200, 200)));
          ok('撤销这一笔：重叠区精确回到「笔前」（不能残留绿色）',
             JSON.stringify(px(L0, 260, 200)) === none(), JSON.stringify(px(L0, 260, 200)));
          ok('撤销这一笔：更右边也是干净的', JSON.stringify(px(L0, 300, 200)) === none(), JSON.stringify(px(L0, 300, 200)));
          H.redo();
          ok('重做这一笔：绿色原样回来',
             JSON.stringify(px(L0, 260, 200)) === '[0,255,0,255]' && JSON.stringify(px(L0, 300, 200)) === '[0,255,0,255]',
             JSON.stringify(px(L0, 260, 200)) + ' / ' + JSON.stringify(px(L0, 300, 200)));
          H.undo();   // 回到「只有红色底子」

          // ── D) 跨瓦片：世界坐标 ± 真的会落到别的瓦片上 ──
          paint(2048 - 952, 2048 - 952, 20, '#ff0000');           // world -952 → 瓦片 -1,-1
          ok('负象限的瓦片也建出来了', getTile(L0, -1, -1, false) !== null);
          H.undo();
          ok('撤销后负象限瓦片一并收回', getTile(L0, -1, -1, false) === null);

          // ── E) 图层：新建 / 删除（带笔迹）/ 移动 / 重命名 ──
          var base = currentEditing.levels[0].layers.length;
          var d0 = depth();
          document.querySelector('.ly-new-btn[data-type="ground"]').click();
          ok('新建图层：图层 +1、记录 +1 步', currentEditing.levels[0].layers.length === base + 1 && depth() === d0 + 1,
             'layers=' + currentEditing.levels[0].layers.length + ' depth=' + depth());
          H.undo();
          ok('撤销新建图层：图层数回退', currentEditing.levels[0].layers.length === base, currentEditing.levels[0].layers.length);
          H.redo();
          ok('重做新建图层：图层又回来', currentEditing.levels[0].layers.length === base + 1);
          H.undo();
          ok('撤销之后重做分支仍然在（这一步还能重做回去）', H.redo() === true);
          currentLayerId = L0.id;
          H.undo();
          // 撤销之后再做一个**新**操作 → 重做分支必须被截断（历史栈的基本语义）
          paint(2048 + 520, 2048 + 520, 10, '#00ffff');
          ok('撤销后做了新操作 → 重做分支被截断', H.redo() === false);
          H.undo();   // 撤掉这条探索性笔迹，把状态恢复到与之前一致

          currentLayerId = L0.id;
          paint(2048 + 500, 2048 + 500, 30, '#ffaa00');
          ok('L0 上有橙色笔迹', JSON.stringify(px(L0, 500, 500)) === '[255,170,0,255]', JSON.stringify(px(L0, 500, 500)));
          var dDel = depth();
          var rows0 = document.querySelectorAll('#layerList .ly-item');
          ok('图层列表渲染出 2 行', rows0.length === 2, rows0.length);
          rows0[0].querySelectorAll('.ly-btn')[1].click();     // 第 2 个按钮 = 删除
          ok('删除图层：图层 -1、记录 +1 步', currentEditing.levels[0].layers.length === base - 1 && depth() === dDel + 1,
             'layers=' + currentEditing.levels[0].layers.length + ' depth=' + depth());
          H.undo();
          ok('撤销删除图层：图层回来了', currentEditing.levels[0].layers.length === base, currentEditing.levels[0].layers.length);
          ok('撤销删除图层：图层里的笔迹一起回来了（不是空图层）',
             JSON.stringify(px(L0, 500, 500)) === '[255,170,0,255]', JSON.stringify(px(L0, 500, 500)));
          ok('撤销删除图层：瓦片元素挂在画布上', document.querySelectorAll('#layerStack .ink-tile').length >= 1,
             document.querySelectorAll('#layerStack .ink-tile').length);

          // 移动图层：L0 从 index 0 下移到 index 1
          currentLayerId = L0.id;
          var dMv = depth();
          document.getElementById('btnLyDown').click();
          ok('下移图层：顺序真的换了（L0 到第 2 位）',
             currentEditing.levels[0].layers[1].id === L0.id && depth() === dMv + 1,
             currentEditing.levels[0].layers.map(function (x) { return x.id; }).join(','));
          H.undo();
          ok('撤销移动图层：顺序原样回退',
             currentEditing.levels[0].layers[0].id === L0.id && depth() === dMv,
             currentEditing.levels[0].layers.map(function (x) { return x.id; }).join(','));

          // 重命名图层
          var oldLayerName = L0.name;
          openRenameLayer(L0);
          document.getElementById('levelNameInput').value = '屋顶';
          document.getElementById('btnModalOk').click();
          ok('重命名图层生效', L0.name === '屋顶', L0.name);
          H.undo();
          ok('撤销重命名图层', L0.name === oldLayerName, L0.name);

          // ── F) 关卡：新建 / 重命名 / 上移 / 复制 / 删除 ──
          var nLv = currentEditing.levels.length;
          var dLev = depth();
          document.getElementById('btnErAdd').click();
          ok('新建关卡：关卡 +1、记录 +1 步', currentEditing.levels.length === nLv + 1 && depth() === dLev + 1,
             'levels=' + currentEditing.levels.length);
          ok('新建关卡后自动切到新关', currentLevelIdx === nLv, currentLevelIdx);
          H.undo();
          ok('撤销新建关卡：关卡数回退', currentEditing.levels.length === nLv, currentEditing.levels.length);
          ok('撤销新建关卡：当前关序号也回到原处', currentLevelIdx === 0, currentLevelIdx);
          H.redo();
          ok('重做新建关卡', currentEditing.levels.length === nLv + 1);

          var lv2 = currentEditing.levels[1];
          openRenameLevel(lv2);
          document.getElementById('levelNameInput').value = '第二关';
          document.getElementById('btnModalOk').click();
          ok('重命名关卡生效', lv2.name === '第二关', lv2.name);
          H.undo();
          ok('撤销重命名关卡', currentEditing.levels[1].name !== '第二关', currentEditing.levels[1].name);

          var dOrd = depth();
          document.getElementById('btnErUp').click();
          ok('上移关卡：两关顺序互换、记录 +1 步', depth() === dOrd + 1 && currentLevelIdx === 0, currentLevelIdx);
          H.undo();
          ok('撤销上移关卡：顺序回退', depth() === dOrd);

          var dCp = depth();
          document.getElementById('btnErCopy').click();
          ok('复制关卡：关卡 +1、记录 +1 步', currentEditing.levels.length === nLv + 2 && depth() === dCp + 1,
             currentEditing.levels.length);
          ok('复制关卡：新关名带「副本」',
             currentEditing.levels[currentLevelIdx].name.indexOf('副本') >= 0,
             currentEditing.levels[currentLevelIdx].name);
          H.undo();
          ok('撤销复制关卡', currentEditing.levels.length === nLv + 1, currentEditing.levels.length);

          // 删除关卡走确认弹窗
          var beforeDel = currentEditing.levels.length;
          var dLd = depth();
          var lvRows = document.querySelectorAll('#editLevelList .er-item');
          lvRows[lvRows.length - 1].querySelectorAll('.er-del')[1].click();   // 第 2 个 = 删除
          document.getElementById('btnConfirmOk').click();
          ok('删除关卡：关卡 -1、记录 +1 步', currentEditing.levels.length === beforeDel - 1 && depth() === dLd + 1,
             currentEditing.levels.length);
          H.undo();
          ok('撤销删除关卡：关卡回来了', currentEditing.levels.length === beforeDel, currentEditing.levels.length);

          // ── G) 背景颜色：色盘连续 input 只算一步 ──
          // F 段把当前关切走了（新建/复制关卡会正确切到新关，并清空 currentLayerId）。
          // G~M 段的断言都是按「当前关 = 第 1 关、当前图层 = L0」写的，这里显式摆回该状态。
          loadLevel(0);
          currentLayerId = L0.id;
          var lvA = currentLevel();
          var oldBg = lvA.bgColor;
          var dBg = depth();
          bgColorInput.value = '#112233';
          bgColorInput.dispatchEvent(new Event('input'));
          bgColorInput.value = '#445566';
          bgColorInput.dispatchEvent(new Event('input'));
          bgColorInput.value = '#778899';
          bgColorInput.dispatchEvent(new Event('input'));
          ok('色盘拖动过程里还没单独入栈（合并成一步）', depth() === dBg, 'depth=' + depth() + ' open=' + H.state().open);
          bgColorInput.dispatchEvent(new Event('change'));
          ok('关掉色盘后收尾成 1 步', depth() === dBg + 1, depth());
          ok('背景色已是最后选的那个', lvA.bgColor === '#778899', lvA.bgColor);
          H.undo();
          ok('撤销背景颜色：回到原来的色', lvA.bgColor === oldBg, lvA.bgColor);
          H.redo();
          ok('重做背景颜色', lvA.bgColor === '#778899', lvA.bgColor);
          H.undo();

          // ── H) 死亡界限 ──
          var oldVoid = currentEditing.levels[0].voidY;
          var dV = depth();
          document.getElementById('voidYInput').value = '777';
          document.getElementById('btnVoidOk').click();
          ok('改死亡界限：值生效、记录 +1 步', currentEditing.levels[0].voidY === 777 && depth() === dV + 1,
             currentEditing.levels[0].voidY);
          H.undo();
          ok('撤销死亡界限', currentEditing.levels[0].voidY === oldVoid, currentEditing.levels[0].voidY);

          // ── I) 起点 / 终点 ──
          var cvEl = document.getElementById('editCanvas');
          var rect0 = cvEl.getBoundingClientRect();
          var oldStart = JSON.stringify(currentEditing.levels[0].start);
          currentTool = 'start';
          cvEl.dispatchEvent(new MouseEvent('click', {
            bubbles: true, clientX: rect0.left + rect0.width / 2 + 120, clientY: rect0.top + rect0.height / 2 + 60
          }));
          var movedStart = JSON.stringify(currentEditing.levels[0].start);
          ok('点画布放置起点：位置变了', movedStart !== oldStart, movedStart);
          H.undo();
          ok('撤销起点：回到原位', JSON.stringify(currentEditing.levels[0].start) === oldStart,
             JSON.stringify(currentEditing.levels[0].start));
          currentTool = 'goal';
          var oldGoal = JSON.stringify(currentEditing.levels[0].goal);
          cvEl.dispatchEvent(new MouseEvent('click', {
            bubbles: true, clientX: rect0.left + rect0.width / 2 - 90, clientY: rect0.top + rect0.height / 2 - 40
          }));
          ok('点画布放置终点：位置变了', JSON.stringify(currentEditing.levels[0].goal) !== oldGoal,
             JSON.stringify(currentEditing.levels[0].goal));
          H.undo();
          ok('撤销终点：回到原位', JSON.stringify(currentEditing.levels[0].goal) === oldGoal,
             JSON.stringify(currentEditing.levels[0].goal));
          currentTool = null;

          // ── J) 闯关信息（名称/作者/致言/失败重试）──
          // 临时把 saveAll 换成空函数：这个入口本来会立刻写盘，测试不许碰用户存档
          saveAll = function () { return true; };
          var oldName = currentEditing.name;
          var dInfo = depth();
          openEditInfo();
          document.getElementById('infoName').value = '改过名的关';
          document.getElementById('infoAuthor').value = '作者乙';
          document.getElementById('btnInfoOk').click();
          ok('改闯关信息：名称生效、记录 +1 步',
             currentEditing.name === '改过名的关' && currentEditing.author === '作者乙' && depth() === dInfo + 1,
             currentEditing.name + '/' + currentEditing.author);
          H.undo();
          ok('撤销闯关信息：名称与作者一起回退',
             currentEditing.name === oldName && currentEditing.author !== '作者乙',
             currentEditing.name + '/' + currentEditing.author);
          H.redo();
          ok('重做闯关信息', currentEditing.name === '改过名的关', currentEditing.name);
          H.undo();
          saveAll = bak.saveAll;

          // ── K) 上限 30 步 ──
          H.enter();
          for (var i = 0; i < 35; i++) {
            H.step('第' + i + '步', (function (k) {
              return function () { currentEditing.levels[0].bgColor = '#' + ('00000' + k).slice(-6); };
            })(i));
          }
          var st35 = H.state();
          ok('连续 35 步 → 只留最新 30 步', st35.n === 30 && st35.idx === 29, JSON.stringify({ n: st35.n, idx: st35.idx }));
          ok('被丢掉的确实是最旧的（第0步不在了）', st35.tags.indexOf('第0步') < 0, st35.tags.slice(0, 3).join(','));
          ok('最新的那步还在', st35.tags[29] === '第34步', st35.tags[29]);
          ok('上限就是 30（不是写着好看）', st35.max === 30, st35.max);
          H.undo(); H.undo(); H.undo();
          ok('撤销三次 → 深度 27', depth() === 27, depth());
          H.enter();

          // ── L) 内存量级：30 笔 100px 的笔迹，不能按「整张瓦片」算（一张 16MB）──
          var t0 = performance.now();
          for (var j = 0; j < 30; j++) paint(2048 + 600 + j * 12, 2048 + 600, 100, '#ff0000');
          var stMem = H.state();
          ok('30 笔只花了很少的内存（远小于 30×16MB）', stMem.bytes < 32 * 1024 * 1024,
             'bytes=' + stMem.bytes + ' (' + Math.round(stMem.bytes / 1024) + 'KB), n=' + stMem.n);
          ok('30 笔都记下了', stMem.n === 30, stMem.n);
          ok('30 笔的补丁数合理（每笔每瓦片一条）', stMem.patches <= 30 * 4, stMem.patches);
          H.enter();

          // ── M) 退出编辑器就清空 ──
          paint(2048 + 700, 2048 + 700, 20, '#ff0000');
          ok('退出前确实有记录', H.state().n === 1 && H.state().bytes > 0, JSON.stringify(H.state()));
          H.leave();
          var stOff = H.state();
          ok('退出编辑器：记录整体清空（步数/深度/内存全归零）',
             stOff.n === 0 && stOff.idx === -1 && stOff.bytes === 0 && stOff.enabled === false, JSON.stringify(stOff));
          ok('退出编辑器后不再记录新操作（begin 被拒）', H.begin('x') === false && H.state().open === false);
          ok('退出编辑器后撤销被拒绝（不会误改列表里的数据）', H.undo() === false && H.redo() === false);

          // ── N) 入口接线：openEdit 正常进 → 有记录；playOnly 进 → 不给记录 ──
          var s2 = mkSave(true);
          await new Promise(function (r) {
            openEdit(s2, function () { r(); }, { playOnly: true });
            setTimeout(r, 800);
          });
          ok('「只游玩」进来的编辑会话：不给撤销记录', window.__histTest.state().enabled === false,
             window.__histTest.state().enabled);
          var s3 = mkSave(false);
          await new Promise(function (r) {
            openEdit(s3, function () { r(); });
            setTimeout(r, 800);
          });
          ok('正常进编辑器：记录启用且是空的（新会话不继承上次的）',
             window.__histTest.state().enabled === true && window.__histTest.state().n === 0,
             JSON.stringify(window.__histTest.state()));

          // ── O) 键盘 Ctrl+Z / Ctrl+Shift+Z ──
          currentLayerId = currentEditing.levels[0].layers[0].id;
          paint(2048 + 900, 2048 + 900, 20, '#ff0000');
          var stK = window.__histTest.state();
          ok('键盘测试前有一步', stK.idx === 0, stK.idx);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
          ok('Ctrl+Z 撤销', window.__histTest.state().idx === -1, window.__histTest.state().idx);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
          ok('Ctrl+Shift+Z 重做', window.__histTest.state().idx === 0, window.__histTest.state().idx);
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
          ok('Ctrl+Y 重做后 Ctrl+Z 又能撤销', window.__histTest.state().idx === -1, window.__histTest.state().idx);
          // 带 Alt 的 Ctrl 组合一律不动撤销栈（历史上是给 Ctrl+Alt+Z「恢复上一版笔迹」让路；
          // 该功能 2026-09-23 已整体移除，但这条守卫保留 —— Ctrl+Alt+Z 仍不该触发撤销）
          var idxBeforeAlt = window.__histTest.state().idx;
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, altKey: true, bubbles: true }));
          ok('带 Alt 的 Ctrl+Z 不动撤销栈',
             window.__histTest.state().idx === idxBeforeAlt, window.__histTest.state().idx);

          // ── 还原现场 ──
          H.leave();
          saves = bak.saves;
          currentEditing = bak.editing;
          currentLevelIdx = bak.idx;
          currentLayerId = bak.layerId;
          currentTool = bak.tool;
          currentPenTool = bak.pen;
          brushShape = bak.shape;
          strokeOp = bak.op;
          strokeColor = bak.color;
          brushRange.value = bak.brush;
          saveAll = bak.saveAll;
          hide(document.getElementById('editScreen'));
          show(document.getElementById('saveScreen'));
          renderSaves();
          return log.join('\\n');
        })()`);
        console.log('===== UNDO_TEST =====');
        console.log(out);
        console.log('===== UNDO_TEST END =====');
      } catch (e) {
        log.push('FAIL  异常：' + (e && (e.stack || e.message)));
      }
      const lines = out.split('\n').concat(log);
      const passed = lines.filter((x) => x.indexOf('PASS') === 0).length;
      const failed = lines.filter((x) => x.indexOf('FAIL') === 0).length;
      if (log.length) console.log(log.join('\n'));
      console.log('SUMMARY passed=' + passed + ' failed=' + failed);
      // 收尾：本套用的假存档 id 只在内存里，但 N 段的 openEdit() 是**真入口**，
      // 顺手就会在 saves/ 下留下一个空壳目录 —— 不在 index.json 里、用户在列表里看不见，
      // 却会一直堆着。每次跑完统一收掉（和 UI_TEST / EXPORT_TEST 同一做法）。
      for (const tid of [999801, 999802]) {
        try { fs.rmSync(path.join(savesRoot(), String(tid)), { recursive: true, force: true }); } catch (e) {}
      }
      app.exit(failed ? 1 : 0);
    });
  }

  // 启动冒烟诊断：SMOKE_TEST=1 时正常启动并静置 SMOKE_MS 毫秒，全程记录
  // GPU 特性状态 / GPU 崩溃原因 / 渲染端 console，然后退出。
  // 专治「一打开就 GPU 报错」：把环境侧与代码侧的线索一次性摊开。
  //   SMOKE_MS   静置时长（默认 15000）
  //   SMOKE_OPEN 可选，存档下标；设了就先进入该存档的编辑器（复现「打开关卡」路径）
  if (process.env.SMOKE_TEST === '1') {
    const smokeMs = Number(process.env.SMOKE_MS || 15000);
    const openIdx = process.env.SMOKE_OPEN === undefined ? null : Number(process.env.SMOKE_OPEN);
    const msgs = [];
    const probeJs =
      "(function(){var o={};" +
      "o.gpuCrashed=(typeof gpuCrashed!=='undefined')?gpuCrashed:'n/a';" +
      "var el=document.getElementById('gpuCrashOverlay');o.overlayOn=!!(el&&el.classList.contains('on'));" +
      "o.tiles=(typeof window.__tileStats==='function')?window.__tileStats():'n/a';" +
      "o.canvases=document.querySelectorAll('canvas').length;" +
      "o.mountedTiles=document.querySelectorAll('.ink-tile').length;" +
      "o.heavyCanvas=0;" +
      "Array.prototype.forEach.call(document.querySelectorAll('canvas'),function(c){if(c.width>=2048||c.height>=2048)o.heavyCanvas++;});" +
      "o.saves=(typeof saves!=='undefined')?saves.length:'n/a';" +
      "o.legacyLayers=(typeof saves!=='undefined')?saves.reduce(function(a,s){return a+(s.levels||[]).reduce(function(b,lv){return b+(lv.layers||[]).filter(function(L){return !!L.legacyImg;}).length;},0);},0):'n/a';" +
      "o.editing=(typeof currentEditing!=='undefined'&&currentEditing)?currentEditing.name:'none';" +
      "return JSON.stringify(o);})()";
    win.webContents.on('console-message', (e, level, message) => {
      if (message) msgs.push('[lvl' + level + '] ' + message);
    });
    win.webContents.once('did-finish-load', () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        let probeBefore = 'n/a', probeAfter = 'n/a', openResult = 'n/a';
        try {
          await sleep(Math.max(1500, Math.round(smokeMs * 0.3)));
          probeBefore = await win.webContents.executeJavaScript(probeJs);
          if (openIdx !== null && !isNaN(openIdx)) {
            openResult = await win.webContents.executeJavaScript(
              "(function(){var s=saves[" + openIdx + "];if(!s)return 'no save at " + openIdx + "';" +
              "openEdit(s,function(){});" +
              "return 'openEdit(' + s.name + ') levels=' + s.levels.length;})()");
            await sleep(smokeMs);
            probeAfter = await win.webContents.executeJavaScript(probeJs);
          }
        } catch (e) { probeAfter = 'PROBE_ERROR ' + (e && (e.message || e)); }
        console.log('===== SMOKE_TEST =====');
        console.log('smokeMs=' + smokeMs + ' openIdx=' + openIdx);
        console.log('gpuFeatureStatus=' + JSON.stringify(app.getGPUFeatureStatus()));
        console.log('gpuCrashCount=' + gpuCrashes.length + (gpuCrashes.length ? ' ' + gpuCrashes.join(' | ') : ''));
        console.log('openResult=' + openResult);
        console.log('probeBefore=' + probeBefore);
        console.log('probeAfter=' + probeAfter);
        console.log('--- renderer console lines=' + msgs.length + ' ---');
        console.log(msgs.join('\n'));
        console.log('===== SMOKE_TEST END =====');
        app.exit(0);
      })();
    });
  }

  // GPU 崩溃后果诊断：GPU_STEP_TEST=1 时验证「崩溃之后像素读回还可不可靠」。
  // 这决定了「一崩就锁死存档」到底是必要保护还是过度保护。
  if (process.env.GPU_STEP_TEST === '1') {
    win.webContents.once('did-finish-load', () => {
      (async () => {
        try {
          await new Promise((r) => setTimeout(r, 2500));
          const out = await win.webContents.executeJavaScript(`(async function () {
            var log = [];
            function rec(s) { log.push(s); }
            async function wait(ms) { await new Promise(function (r) { setTimeout(r, ms); }); }
            rec('crashed(before any canvas op)=' + gpuCrashed);
            async function checkPx(label, size, color, expect) {
              var val = null, err = null;
              try {
                var c = document.createElement('canvas'); c.width = size; c.height = size;
                var x = c.getContext('2d');
                x.fillStyle = color; x.fillRect(0, 0, size, size);
                var d = x.getImageData(size >> 1, size >> 1, 1, 1).data;
                val = d[0] + ',' + d[1] + ',' + d[2] + ',' + d[3];
              } catch (e) { err = String((e && e.message) || e); }
              await wait(60);
              rec('PIX ' + label + ' size=' + size + ' val=[' + val + '] expect=[' + expect + ']' +
                  (err ? ' ERR=' + err : '') + (val === expect ? ' OK' : ' MISMATCH') +
                  ' crashed=' + gpuCrashed);
            }
            await checkPx('red', 64, '#ff0000', '255,0,0,255');
            await checkPx('green', 2048, '#00ff00', '0,255,0,255');
            await checkPx('blue', 4096, '#0000ff', '0,0,255,255');
            // 模拟旧档迁移：4096 源 → 2048 瓦片，验证像素落点是否正确
            try {
              var big = document.createElement('canvas'); big.width = 4096; big.height = 4096;
              var bx = big.getContext('2d');
              bx.fillStyle = '#ffffff'; bx.fillRect(0, 0, 4096, 4096);
              bx.fillStyle = '#ff0000'; bx.fillRect(1024, 1024, 512, 512);
              var tile = document.createElement('canvas'); tile.width = 2048; tile.height = 2048;
              var tx = tile.getContext('2d');
              tx.drawImage(big, 0, 0, 2048, 2048, 0, 0, 2048, 2048);
              var p = tx.getImageData(1200, 1200, 1, 1).data;
              var q = tx.getImageData(100, 100, 1, 1).data;
              rec('MIGRATE inRed(1200,1200)=[' + p[0] + ',' + p[1] + ',' + p[2] + ',' + p[3] + '] expect 255,0,0,255' +
                  (p[0] === 255 && p[1] === 0 && p[2] === 0 ? ' OK' : ' MISMATCH'));
              rec('MIGRATE inWhite(100,100)=[' + q[0] + ',' + q[1] + ',' + q[2] + ',' + q[3] + '] expect 255,255,255,255' +
                  (q[0] === 255 && q[1] === 255 && q[2] === 255 ? ' OK' : ' MISMATCH'));
              // toDataURL 是存档序列化用的路径
              var url = tx.canvas ? tx.canvas.toDataURL() : tile.toDataURL();
              rec('MIGRATE toDataURL len=' + url.length + (url.length > 1000 ? ' OK' : ' SUSPECT'));
            } catch (e) { rec('MIGRATE ERR ' + e.message); }
            await wait(100);
            rec('crashed(after all ops)=' + gpuCrashed);
            return log.join('\\n');
          })()`);
          console.log('===== GPU_STEP_TEST =====');
          console.log(out);
          console.log('gpuCrashCount=' + gpuCrashes.length + (gpuCrashes.length ? ' ' + gpuCrashes.join(' | ') : ''));
          console.log('===== GPU_STEP_TEST END =====');
        } catch (e) {
          console.log('GPU_STEP_TEST_ERROR', e && (e.stack || e.message));
        }
        app.exit(0);
      })();
    });
  }

  // GPU 崩溃恢复自检：GPU_RECOVER_TEST=1
  // 验「瞬时 GPU 崩溃不再把程序锁死」：前两次照常可用（含主菜单真的能点），
  // 连续第 3 次才升级为真故障（红屏 + 锁存档）。
  if (process.env.GPU_RECOVER_TEST === '1') {
    win.webContents.once('did-finish-load', () => {
      (async () => {
        try {
          await new Promise((r) => setTimeout(r, 900));
          const out = await win.webContents.executeJavaScript(`(function () {
            var log = [];
            function ok(name, cond, extra) { log.push((cond ? 'PASS  ' : 'FAIL  ') + name + (extra === undefined ? '' : '  [' + extra + ']')); }
            var ov = document.getElementById('gpuCrashOverlay');
            var mainMenu = document.getElementById('mainMenu');
            var saveScreen = document.getElementById('saveScreen');
            function overlayOn() { return !!ov && ov.classList.contains('on'); }

            ok('savesLocked() 存在', typeof savesLocked === 'function');
            ok('初始未崩溃', gpuCrashCount === 0 && gpuCrashed === false && savesLocked() === false,
               'count=' + gpuCrashCount + ' locked=' + savesLocked());
            ok('初始无红屏', !overlayOn());

            // 第 1 次崩溃：应自愈，且程序仍可用
            window.__onGpuCrash();
            ok('第 1 次崩溃后不锁存档', savesLocked() === false, 'count=' + gpuCrashCount);
            ok('第 1 次崩溃后不弹红屏', !overlayOn());
            document.getElementById('btnStart').click();
            var navOk = getComputedStyle(saveScreen).display !== 'none' && getComputedStyle(mainMenu).display === 'none';
            ok('第 1 次崩溃后主菜单仍可点击（没被挡死）', navOk,
               'save=' + getComputedStyle(saveScreen).display + ' main=' + getComputedStyle(mainMenu).display);
            document.getElementById('btnBack').click();
            ok('第 1 次崩溃后可返回主菜单', getComputedStyle(mainMenu).display !== 'none');

            // 第 2 次崩溃：仍然自愈
            window.__onGpuCrash();
            ok('第 2 次崩溃后仍不锁存档', savesLocked() === false, 'count=' + gpuCrashCount);
            ok('第 2 次崩溃后仍无红屏', !overlayOn());

            // 第 3 次崩溃：升级为真故障
            window.__onGpuCrash();
            ok('第 3 次崩溃后锁存档', savesLocked() === true, 'count=' + gpuCrashCount);
            ok('第 3 次崩溃后弹红屏', overlayOn());
            ok('崩溃次数记为 3', gpuCrashCount === 3, gpuCrashCount);

            // 继续崩不应出错
            window.__onGpuCrash();
            ok('再次崩溃不抛异常且仍锁定', savesLocked() === true && gpuCrashCount === 4, gpuCrashCount);

            var passed = log.filter(function (x) { return x.indexOf('PASS') === 0; }).length;
            var failed = log.filter(function (x) { return x.indexOf('FAIL') === 0; }).length;
            log.push('SUMMARY passed=' + passed + ' failed=' + failed);
            return log.join('\\n');
          })()`);
          console.log('===== GPU_RECOVER_TEST =====');
          console.log(out);
          console.log('===== GPU_RECOVER_TEST END =====');
        } catch (e) {
          console.log('GPU_RECOVER_TEST_ERROR', e && (e.stack || e.message));
        }
        app.exit(0);
      })();
    });
  }

  // 瓦片接缝视觉自检：TILE_SHOT=1 时在跨瓦片长线 + 1:1 接缝特写 + 闯关画面各截一张，人工肉眼确认无错位
  if (process.env.TILE_SHOT === '1') {
    win.webContents.once('did-finish-load', () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        const shotDir = path.join(__dirname, '_shots');
        if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir);
        const shot = async (name) => {
          const image = await win.webContents.capturePage();
          fs.writeFileSync(path.join(shotDir, name), image.toPNG());
          console.log('SHOT', name);
        };
        try {
          await sleep(700);
          await win.webContents.executeJavaScript(`
            (function () {
              var s = { id: 5, name: '接缝检查', levels: [], createdAt: new Date(), author: '', epilogue: '', retryFromLevel: false, customMusic: false };
              s.levels.push(createLevel('第1关', null));
              saves = [s]; saveId = 6;
              currentEditing = s; currentLevelIdx = 0; currentLayerId = null;
              show(editScreen); loadLevel(0);
              document.querySelector('.ly-new-btn[data-type="ground"]').click();
              var el = document.getElementById('editCanvas');
              var cx = el.clientWidth / 2, cy = el.clientHeight / 2;
              canvasScale = 1; panX = 0; panY = 0; applyZoom();
              var rect = el.getBoundingClientRect();
              function fire(t, sx, sy) {
                el.dispatchEvent(new MouseEvent(t, { clientX: rect.left + sx, clientY: rect.top + sy, button: 0, bubbles: true }));
              }
              function sc(x, y) { return { x: cx + panX + x * canvasScale, y: cy + panY + y * canvasScale }; }
              function line(x0, y0, x1, y1) {
                var a = sc(x0, y0), b = sc(x1, y1);
                fire('mousedown', a.x, a.y);
                for (var i = 1; i <= 60; i++) fire('mousemove', a.x + (b.x - a.x) * i / 60, a.y + (b.y - a.y) * i / 60);
                document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              }
              document.querySelector('.pentool[data-pentool="brush"]').click();
              var bs = document.getElementById('brushSize'); bs.value = 24; bs.dispatchEvent(new Event('input'));
              document.getElementById('brushColor').value = '#ff0000';
              line(-3000, 0, 3000, 0);      // 横线正好骑在 y=0 瓦片缝上
              document.getElementById('brushColor').value = '#0000ff';
              line(0, -3000, 0, 3000);      // 竖线正好骑在 x=0 瓦片缝上
              // 缩到能看全十字
              var need = Math.max(3200 / cx, 3200 / cy);
              canvasScale = Math.max(0.1, 1 / need);
              panX = 0; panY = 0; applyZoom();
              return 'ok';
            })()
          `);
          await sleep(500);
          await shot('tile-cross-full.png');
          const probe = await win.webContents.executeJavaScript(`
            (function () {
              var L = currentLayer();
              var t = getTile(L, 0, 0, false);
              var out = [];
              out.push('tileHostMode=' + tileHostMode);
              out.push('layerStack children=' + document.getElementById('layerStack').children.length);
              out.push('tiles in stack=' + document.querySelectorAll('#layerStack .ink-tile').length);
              if (t) {
                out.push('tile00 parentId=' + (t.canvas.parentNode && t.canvas.parentNode.id));
                out.push('tile00 inline=' + t.canvas.style.cssText);
                out.push('tile00 css=' + getComputedStyle(t.canvas).position + '/' + getComputedStyle(t.canvas).width + '/' + getComputedStyle(t.canvas).height + '/z=' + getComputedStyle(t.canvas).zIndex + '/d=' + getComputedStyle(t.canvas).display + '/vis=' + getComputedStyle(t.canvas).visibility + '/op=' + getComputedStyle(t.canvas).opacity);
                var r = t.canvas.getBoundingClientRect();
                out.push('tile00 rect=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
                out.push('tile00 alphaAt(500,500)=' + t.ctx.getImageData(500, 500, 1, 1).data[3]);
              } else out.push('tile00 MISSING');
              var st = document.getElementById('layerStack');
              out.push('stack css=' + getComputedStyle(st).position + '/' + getComputedStyle(st).zIndex + '/' + getComputedStyle(st).overflow);
              var w = document.getElementById('world');
              var rw = w.getBoundingClientRect();
              out.push('world rect=' + Math.round(rw.left) + ',' + Math.round(rw.top) + ' ' + Math.round(rw.width) + 'x' + Math.round(rw.height) + ' tf=' + w.style.transform);
              var ec = document.getElementById('editCanvas');
              var rc = ec.getBoundingClientRect();
              out.push('editCanvas rect=' + Math.round(rc.left) + ',' + Math.round(rc.top) + ' ' + Math.round(rc.width) + 'x' + Math.round(rc.height) + ' ov=' + getComputedStyle(ec).overflow);
              out.push('canvasScale=' + canvasScale + ' pan=' + panX + ',' + panY);
              out.push(window.__tileStats());
              out.push('host=' + (currentTileHost() ? currentTileHost().id : 'NULL'));
              out.push('gLayerStack tiles=' + document.querySelectorAll('#gLayerStack .ink-tile').length);
              out.push('all .ink-tile in doc=' + document.querySelectorAll('.ink-tile').length);
              return out.join(' | ');
            })()
          `);
          console.log('PROBE', probe);
          // 1:1 特写：接缝交点落在视口中心，任何错位/断线都会直接看到
          await win.webContents.executeJavaScript(`canvasScale = 1; panX = 0; panY = 0; applyZoom(); 'ok'`);
          await sleep(400);
          await shot('tile-seam-100pct.png');
          // 缩小后加一段骑缝斜线，再截一张
          await win.webContents.executeJavaScript(`
            (function () {
              var el = document.getElementById('editCanvas');
              var cx = el.clientWidth / 2, cy = el.clientHeight / 2;
              var rect = el.getBoundingClientRect();
              function fire(t, sx, sy) {
                el.dispatchEvent(new MouseEvent(t, { clientX: rect.left + sx, clientY: rect.top + sy, button: 0, bubbles: true }));
              }
              document.getElementById('brushColor').value = '#008000';
              var a = { x: cx - 260, y: cy - 220 }, b = { x: cx + 260, y: cy + 220 };
              fire('mousedown', a.x, a.y);
              for (var i = 1; i <= 60; i++) fire('mousemove', a.x + (b.x - a.x) * i / 60, a.y + (b.y - a.y) * i / 60);
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              return window.__tileStats();
            })()
          `);
          await sleep(400);
          await shot('tile-seam-diagonal.png');
          // 闯关画面：确认游戏世界层里的瓦片显示正常
          await win.webContents.executeJavaScript(`
            (function () {
              var lv = currentLevel();
              lv.start = { x: 0, y: 0 };
              lv.goal = { x: 900, y: -300 };
              lv.voidY = 4000;
              syncSpawnPos();
              buildLayerSolids();
              startGameTest('edit', 'current');
              for (var i = 0; i < 90; i++) gameStep();
              return 'ok';
            })()
          `);
          await sleep(600);
          await shot('tile-game.png');
        } catch (e) {
          console.log('TILE_SHOT_ERROR', e && (e.stack || e.message));
        }
        app.exit(0);
      })();
    });
  }

  // 自检模式：启动后依次截取主菜单 / 关卡列表 / 命名弹窗三张图并退出
  if (process.env.SHOT_MODE === '1') {
    win.webContents.once('did-finish-load', () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      (async () => {
        const shotDir = path.join(__dirname, '_shots');
        if (!fs.existsSync(shotDir)) fs.mkdirSync(shotDir);
        const shot = async (name) => {
          const image = await win.webContents.capturePage();
          fs.writeFileSync(path.join(shotDir, name), image.toPNG());
        };
        try {
          await sleep(500);
          // 自检前置清理：清空上次残留的测试数据，保证每次从干净状态开始
          await win.webContents.executeJavaScript(`
            localStorage.removeItem('gagame_saves_v1');
            saves = []; saveId = 1;
            renderSaves();
          `);
          await shot('electron-window.png'); // 主菜单
          await win.webContents.executeJavaScript(`document.getElementById('btnStart').click()`);
          await sleep(300);
          await shot('electron-saves.png'); // 闯关列表（空）
          await win.webContents.executeJavaScript(`document.getElementById('btnAddLevel').click()`);
          await sleep(300);
          await shot('electron-modal.png'); // 命名弹窗
          await win.webContents.executeJavaScript(`
            document.getElementById('levelNameInput').value = '数学闯关';
            document.getElementById('btnModalOk').click();
          `);
          await sleep(300);
          await shot('electron-saves-filled.png'); // 闯关列表（1 个闯关卡片）
          await win.webContents.executeJavaScript(`
            ['成语闯关', '地理闯关', '历史闯关', '科学闯关', '物理闯关', '化学闯关', '生物闯关', '英语闯关'].forEach(function (n) {
              document.getElementById('btnAddLevel').click();
              document.getElementById('levelNameInput').value = n;
              document.getElementById('btnModalOk').click();
            });
          `);
          await sleep(300);
          await shot('electron-saves-multi.png'); // 5 个闯关卡片（验证 1/4 宽 + 换行）
          // 给第一个闯关预置 3 个关卡，点击卡片直接进入编辑器（验证编辑器 UI + 右侧关卡列表）
          await win.webContents.executeJavaScript(`
            var s = saves[0];
            s.levels.push({ name: '起跳' }, { name: '跨越' }, { name: '冲刺' });
            document.querySelector('#saveBody .save-card').click();
          `);
          await sleep(300);
          // 目验死亡界限红线：临时把死亡界限调近（世界 y=300），截图后恢复默认
          await win.webContents.executeJavaScript(`
            currentEditing.levels[currentLevelIdx].voidY = 300;
            updateVoidLine();
            updateVoidLabel();
          `);
          await shot('electron-edit-voidline.png');
          await win.webContents.executeJavaScript(`
            currentEditing.levels[currentLevelIdx].voidY = 1000;
            updateVoidLine();
            updateVoidLabel();
          `);
          await shot('electron-edit.png');
          // 复现弹窗文字污染场景：先开"保存确认"再取消，随后开"删除关卡"，检查文字是否正确
          // 注意：编辑器里自绘的那个 ✕（#btnEditClose）已随无边框方案删除，现在关窗只剩一条路
          // —— 主进程 win.on('close') 拦下 → 发 app:close-request → 渲染侧 handleAppCloseRequest。
          // 这里就直接发那条 IPC（等价于用户点了标题栏的 ✕），顺带把整条链路也验了。
          win.webContents.send('app:close-request');
          await sleep(250);
          await win.webContents.executeJavaScript(`
            document.getElementById('btnConfirmCancel').click();
          `);
          const modalCheck = await win.webContents.executeJavaScript(`
            (function () {
              document.querySelector('#editLevelList .er-del[title="删除关卡"]').click();
              var t = document.getElementById('confirmTitle').textContent;
              var ok = document.getElementById('btnConfirmOk').textContent;
              var txt = document.getElementById('confirmText').textContent;
              document.getElementById('btnConfirmCancel').click();
              return t + '|' + ok + '|' + txt;
            })()
          `);
          console.log('MODAL_CHECK', modalCheck);
          // 背景取色（瞬时按钮）：点 bg 不切工具/不保持选中；选色应用到画布与数据
          const bgCheck = await win.webContents.executeJavaScript(`
            (function () {
              var el = document.getElementById('editCanvas');
              var input = document.getElementById('bgColorInput');
              var toolBefore = currentTool;
              var orig = input.click.bind(input);
              input.click = function () {};
              document.querySelector('.shape-btn[data-tool="bg"]').click();
              var bgActive = document.querySelector('.shape-btn[data-tool="bg"]').classList.contains('active');
              var toolAfter = currentTool;
              input.click = orig;
              input.value = '#123456';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              var bg = el.style.background;
              var saved = currentEditing.levels[currentLevelIdx].bgColor;
              input.value = '#000000';
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return 'bgActive=' + bgActive + ' tool=' + (toolBefore === toolAfter) + ' bg=' + bg + ' saved=' + saved;
            })()
          `);
          console.log('BG_CHECK', bgCheck);
          // 保存确认弹窗应显示「不保存并关闭」按钮；删除关卡弹窗不应显示
          // （同样走 app:close-request，不再用已删除的 #btnEditClose）
          win.webContents.send('app:close-request');
          await sleep(250);
          const noSaveCheck = await win.webContents.executeJavaScript(`
            (function () {
              var btn = document.getElementById('btnConfirmNoSave');
              var closeShown = btn.style.display !== 'none';
              var closeLabel = btn.textContent;          // 关窗场景写全「不保存并关闭」
              document.getElementById('btnConfirmCancel').click();
              document.querySelector('#editLevelList .er-del[title="删除关卡"]').click();
              var delHidden = btn.style.display === 'none';
              var delLabel = btn.textContent;            // 非关窗场景回落成「不保存」
              document.getElementById('btnConfirmCancel').click();
              return 'close=' + closeShown + ' del=' + delHidden +
                     ' closeLabel=' + closeLabel + ' delLabel=' + delLabel;
            })()
          `);
          console.log('NOSAVE_CHECK', noSaveCheck);
          // 调色盘选中唯一性：初始化 1 个 active，点第二个色块后仍只有 1 个
          const paletteCheck = await win.webContents.executeJavaScript(`
            (function () {
              var cells = document.querySelectorAll('.palette-cell');
              var init = document.querySelectorAll('.palette-cell.active').length;
              cells[1].click();
              var after = document.querySelectorAll('.palette-cell.active').length;
              cells[0].click();
              return 'init=' + init + ' after=' + after;
            })()
          `);
          console.log('PALETTE_CHECK', paletteCheck);
          // 验证 move 拖移：grab 光标类 + 拖动改变世界层 transform
          const dragCheck = await win.webContents.executeJavaScript(`
            (function () {
              var el = document.getElementById('editCanvas');
              document.querySelector('.pentool[data-pentool="move"]').click();
              var grab = el.classList.contains('grab');
              var t0 = document.getElementById('world').style.transform;
              el.dispatchEvent(new MouseEvent('mousedown', { clientX: 200, clientY: 200, button: 0, bubbles: true }));
              document.dispatchEvent(new MouseEvent('mousemove', { clientX: 120, clientY: 150, bubbles: true }));
              var t1 = document.getElementById('world').style.transform;
              var grabbing = el.classList.contains('grabbing');
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              var grab2 = el.classList.contains('grab');
              document.querySelector('.pentool[data-pentool="brush"]').click();
              var grab3 = el.classList.contains('grab');
              return 'grab=' + grab + ' grabbing=' + grabbing + ' changed=' + (t0 !== t1) + ' restore=' + grab2 + ' brushClears=' + (!grab3);
            })()
          `);
          console.log('DRAG_CHECK', dragCheck);
          // 验证画笔/擦除（位图方案）：画一条线，再擦除中段，直接读像素 alpha
          const inkCheck = await win.webContents.executeJavaScript(`
            (function () {
              // 图层系统：清空当前关卡图层并新建干净地面层（保证画笔可绘、且墨迹不污染后续碰撞自检的回退路径）
              currentEditing.levels[currentLevelIdx].layers = [];
              renderLayers();
              renderLayerCanvases();
              document.querySelector('.ly-new-btn[data-type="ground"]').click();
              var el = document.getElementById('editCanvas');
              document.querySelector('.pentool[data-pentool="brush"]').click();
              var cx = el.clientWidth / 2, cy = el.clientHeight / 2;
              var rect = el.getBoundingClientRect();
              function fire(t, x, y) {
                el.dispatchEvent(new MouseEvent(t, { clientX: rect.left + x, clientY: rect.top + y, button: 0, bubbles: true }));
              }
              fire('mousedown', cx - 120, cy);
              fire('mousemove', cx - 60, cy);
              fire('mousemove', cx, cy);
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              var cursorOn = document.getElementById('brushCursor').style.display === 'block';
              document.querySelector('.pentool[data-pentool="eraser"]').click();
              fire('mousedown', cx - 60, cy);
              fire('mousemove', cx - 55, cy);
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              // 世界坐标 → 墨迹坐标（+2048），经调试桥读当前图层的瓦片像素
              function alphaAt(sx, sy) {
                var wx = (sx - cx - panX) / canvasScale;
                var wy = (sy - cy - panY) / canvasScale;
                var d = window.__inkSample(Math.round(wx + 2048), Math.round(wy + 2048)) || [0, 0, 0, 0];
                return d[3];
              }
              var aLeft = alphaAt(cx - 110, cy);
              var aMid = alphaAt(cx - 60, cy);
              var aRight = alphaAt(cx + 20, cy);
              // 方形笔刷：切回画笔，光标变方形（borderRadius 0），画一条方笔迹
              document.querySelector('.pentool[data-pentool="brush"]').click();
              document.querySelector('.shape-mini[data-brushshape="square"]').click();
              var sqShape = document.getElementById('brushCursor').style.borderRadius;
              fire('mousedown', cx - 100, cy + 40);
              fire('mousemove', cx - 50, cy + 40);
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              var sqAlpha = alphaAt(cx - 50, cy + 40);
              // 模拟用户场景：先切到拖移，再点方形按钮 → 应自动切回画笔并可画
              document.querySelector('.pentool[data-pentool="move"]').click();
              document.querySelector('.shape-mini[data-brushshape="square"]').click();
              var toolAuto = document.querySelector('.pentool[data-pentool="brush"]').classList.contains('active');
              fire('mousedown', cx - 100, cy + 80);
              fire('mousemove', cx - 50, cy + 80);
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              var sqAlpha2 = alphaAt(cx - 50, cy + 80);
              document.querySelector('.shape-mini[data-brushshape="round"]').click();
              // 换色后第一次绘制 BUG 回归：换色（含换尺寸后重建模板）后的新笔迹必须=新颜色，不得为白色
              function rgbAt(sx, sy) {
                var wx = (sx - cx - panX) / canvasScale;
                var wy = (sy - cy - panY) / canvasScale;
                var d = window.__inkSample(Math.round(wx + 2048), Math.round(wy + 2048)) || [0, 0, 0, 0];
                return d[0] + ',' + d[1] + ',' + d[2];
              }
              var cIn = document.getElementById('brushColor');
              var oldCol = cIn.value;
              cIn.value = '#ff0000';
              fire('mousedown', cx - 100, cy + 120);
              fire('mousemove', cx - 60, cy + 120);
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              var colAfter1 = rgbAt(cx - 80, cy + 120);
              // 换尺寸 + 换色：模板按新半径重建后再上色
              var bs = document.getElementById('brushSize');
              bs.value = 20;
              bs.dispatchEvent(new Event('input'));
              cIn.value = '#00ff00';
              fire('mousedown', cx - 100, cy + 160);
              fire('mousemove', cx - 60, cy + 160);
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              var colAfter2 = rgbAt(cx - 80, cy + 160);
              cIn.value = oldCol;
              document.querySelector('.shape-mini[data-brushshape="round"]').click();
              return 'cursor=' + cursorOn + ' left=' + aLeft + ' mid=' + aMid + ' right=' + aRight + ' sqShape=' + sqShape + ' sqAlpha=' + sqAlpha + ' toolAuto=' + toolAuto + ' sqAlpha2=' + sqAlpha2 + ' colorAfter1=' + colAfter1 + ' colorAfter2=' + colAfter2;
            })()
          `);
          console.log('INK_CHECK', inkCheck);
          // 图层隔离自检：新建障碍层画点，切回地面层读各自 alpha
          const layerCheck = await win.webContents.executeJavaScript(`
            (function () {
              var el = document.getElementById('editCanvas');
              var cx = el.clientWidth / 2, cy = el.clientHeight / 2;
              var rect = el.getBoundingClientRect();
              function fire(t, x, y) {
                el.dispatchEvent(new MouseEvent(t, { clientX: rect.left + x, clientY: rect.top + y, button: 0, bubbles: true }));
              }
              function wxOf(sx, sy) {
                return { x: (sx - cx - panX) / canvasScale + 2048, y: (sy - cy - panY) / canvasScale + 2048 };
              }
              // 新建障碍层（自动选中），画一个点
              document.querySelector('.ly-new-btn[data-type="hazard"]').click();
              document.querySelector('.pentool[data-pentool="brush"]').click();
              fire('mousedown', cx - 130, cy - 60);
              document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              var p = wxOf(cx - 130, cy - 60);
              var hazAlpha = (window.__inkSample(p.x, p.y) || [0, 0, 0, 0])[3];
              // 切回地面层（按类型查找，列表顶部=最顶层）：障碍点位置应读不到墨迹（层隔离）
              var gIdx = -1;
              currentLayers().forEach(function (L, i) { if (L.type === 'ground') gIdx = i; });
              document.querySelectorAll('#layerList .ly-item')[gIdx].click();
              var gAlpha = (window.__inkSample(p.x, p.y) || [0, 0, 0, 0])[3];
              // 图层重命名：点铅笔 → 输入 → 确定 → 图层名更新
              document.querySelectorAll('#layerList .ly-item')[gIdx].querySelector('.ly-btn[title="重命名图层"]').click();
              document.getElementById('levelNameInput').value = '我的地面';
              document.getElementById('btnModalOk').click();
              var renamed = currentLayers()[gIdx].name;
              // 图层上移：ground 在列表中的位置前移（index 变小）→ 层级更靠前
              var iBefore = gIdx;
              document.getElementById('btnLyUp').click();
              var gIdx2 = -1;
              currentLayers().forEach(function (L, i) { if (L.type === 'ground') gIdx2 = i; });
              var moved = gIdx2 < iBefore;
              var zOrder = currentLayers().map(function (L) { return L.z; }).join(',');
              return 'haz=' + hazAlpha + ' groundAtHaz=' + gAlpha + ' layers=' + currentLayers().length + ' renamed=' + renamed + ' idx=' + iBefore + '>' + gIdx2 + ' moved=' + moved + ' zs=' + zOrder;
            })()
          `);
          console.log('LAYER_CHECK', layerCheck);
          // 虚空判定对话框：× 打开 → 输入 → 确定保存 → 关闭
          const voidCheck = await win.webContents.executeJavaScript(`
            (function () {
              document.getElementById('btnVoid').click();
              var open = document.getElementById('voidModal').classList.contains('on');
              var shown = document.getElementById('voidModal').style.display !== 'none' || getComputedStyle(document.getElementById('voidModal')).display !== 'none';
              var title = document.querySelector('#voidModal .modal-title').textContent;
              var label = document.querySelector('#voidModal .void-label').textContent;
              var defVal = document.getElementById('voidYInput').value;
              document.getElementById('voidYInput').value = '1234';
              document.getElementById('btnVoidOk').click();
              var saved = currentEditing.levels[currentLevelIdx].voidY;
              var closed = !document.getElementById('voidModal').classList.contains('on');
              document.getElementById('btnVoid').click();
              document.getElementById('btnVoidClose').click();
              var closeOk = !document.getElementById('voidModal').classList.contains('on');
              return 'open=' + open + ' shown=' + shown + ' title=' + title + ' label=' + label + ' def=' + defVal + ' saved=' + saved + ' closed=' + closed + ' closeOk=' + closeOk;
            })()
          `);
          console.log('VOID_CHECK', voidCheck);
          // 返回列表（不再做删光关卡截图：避免多层画布重建卡死）
          // ⚠️ btnEditBack 现在会**先 await 真正写盘成功**再回列表（见 saveNow / 2026-09-24）→
          //    不能再 sleep 固定时间：写盘耗时会变（几十 ms ~ 2.5s），固定 sleep 会读到编辑器状态。
          //    改为轮询等编辑器真的收起（最多 8s）。
          await win.webContents.executeJavaScript(`document.getElementById('btnEditBack').click()`);
          let leftEdit = false;
          for (let i = 0; i < 80; i++) {
            leftEdit = await win.webContents.executeJavaScript(
              "getComputedStyle(document.getElementById('editScreen')).display === 'none'");
            if (leftEdit) break;
            await sleep(100);
          }
          console.log('LEAVE_EDIT_CHECK', leftEdit);
          // 返回列表后画笔光标环必须隐藏（此前画笔/擦除工具已激活过）
          const cursorHidden = await win.webContents.executeJavaScript(`
            document.getElementById('brushCursor').style.display + '|' + document.getElementById('editCanvas').className
          `);
          console.log('CURSOR_CHECK', cursorHidden);
          // 重进编辑器保留上次相机位置与缩放（pan/scale 不重置）
          const cameraCheck = await win.webContents.executeJavaScript(`
            (async function () {
              // ⚠️ btnEditBack 是异步的（要等真正写盘成功才回列表）→ 每次点完必须等编辑器真的收起，
              //    否则"返回列表再重新进入"的顺序被打乱，读到的相机值就不是"重进后恢复"的值。
              var waitLeave = async function () {
                for (var i = 0; i < 80; i++) {
                  if (getComputedStyle(document.getElementById('editScreen')).display === 'none') return true;
                  await new Promise(function (r) { setTimeout(r, 100); });
                }
                return false;
              };
              document.querySelector('#saveBody .save-card').click();
              panX = 123; panY = -45; canvasScale = 0.7; applyZoom();
              document.getElementById('btnEditBack').click();
              await waitLeave();
              document.querySelector('#saveBody .save-card').click();
              var out = Math.round(panX) + ',' + Math.round(panY) + ',' + canvasScale;
              document.getElementById('btnEditBack').click();
              await waitLeave();
              return out;
            })()
          `);
          console.log('CAMERA_CHECK', cameraCheck);
          // 起点/终点放置工具：激活时画笔停用+光标环隐藏+预览跟随+点击放置（世界坐标）
          const spawnCheck = await win.webContents.executeJavaScript(`
            (function () {
              document.querySelector('#saveBody .save-card').click();
              panX = 0; panY = 0; canvasScale = 1; applyZoom();
              var cv = document.getElementById('editCanvas');
              var rect = cv.getBoundingClientRect();
              var cx = cv.clientWidth / 2, cy = cv.clientHeight / 2;
              // 激活起点
              document.querySelector('.shape-btn[data-tool="start"]').click();
              var t1 = currentTool + '/' + currentPenTool + '/' + document.getElementById('brushCursor').style.display + '/' + cv.className;
              // 预览跟随鼠标（画布屏幕坐标 → pvStart 屏幕定位）
              var ev1 = new MouseEvent('mousemove', { clientX: rect.left + cx + 120, clientY: rect.top + cy + 60, bubbles: true });
              cv.dispatchEvent(ev1);
              var pv1 = document.getElementById('pvStart');
              var pv1s = pv1.style.display + '@' + pv1.style.left + ',' + pv1.style.top;
              // 点击放置起点：世界坐标 (100, 50)
              var ev2 = new MouseEvent('click', { clientX: rect.left + cx + 100, clientY: rect.top + cy + 50, bubbles: true });
              cv.dispatchEvent(ev2);
              var stEl = document.getElementById('cvStart');
              var stPos = stEl.style.left + ',' + stEl.style.top + '|' + stEl.offsetLeft + ',' + stEl.offsetTop;
              // 激活终点并放置
              document.querySelector('.shape-btn[data-tool="goal"]').click();
              var ev3 = new MouseEvent('click', { clientX: rect.left + cx - 200, clientY: rect.top + cy - 100, bubbles: true });
              cv.dispatchEvent(ev3);
              var goEl = document.getElementById('cvGoal');
              var goPos = goEl.style.left + ',' + goEl.style.top;
              var pv2 = document.getElementById('pvGoal');
              var pv2s = pv2.style.display;
              // 切回画笔：起点/终点取消激活
              document.querySelector('.pentool[data-pentool="brush"]').click();
              var t2 = currentTool + '/' + document.querySelector('.shape-btn[data-tool="start"]').className;
              return 't1=' + t1 + ' pv1=' + pv1s + ' st=' + stPos + ' go=' + goPos + ' pv2=' + pv2s + ' t2=' + t2;
            })()
          `);
          console.log('SPAWN_CHECK', spawnCheck);
          // 起点/终点按钮激活后再次点击：相机定位到物件中心（画布中心对准世界坐标）
          const centerCheck = await win.webContents.executeJavaScript(`
            (function () {
              panX = 0; panY = 0; canvasScale = 1; applyZoom();
              // 移动起点到世界 (300, 200)，再激活起点按钮并二次点击
              var stE = document.getElementById('cvStart');
              stE.style.left = '300px'; stE.style.top = '200px';
              var btnS = document.querySelector('.shape-btn[data-tool="start"]');
              btnS.click();
              btnS.click();
              var panS = Math.round(panX) + ',' + Math.round(panY);
              var expectS = Math.round(-(stE.offsetLeft + 18.5)) + ',' + Math.round(-(stE.offsetTop + 18.5));
              // 终点
              var goE = document.getElementById('cvGoal');
              goE.style.left = '-400px'; goE.style.top = '-300px';
              var btnG = document.querySelector('.shape-btn[data-tool="goal"]');
              btnG.click();
              btnG.click();
              var panG = Math.round(panX) + ',' + Math.round(panY);
              var expectG = Math.round(-(goE.offsetLeft + 25)) + ',' + Math.round(-(goE.offsetTop + 25));
              return 'start=' + panS + '~' + expectS + ' goal=' + panG + '~' + expectG;
            })()
          `);
          console.log('CENTER_CHECK', centerCheck);
          // 关卡切换与继承：新建关卡自动命名 + 继承 bgColor/voidY + 默认 start/goal + 图层空 + 切回独立
          const levelCheck = await win.webContents.executeJavaScript(`
            (function () {
              var card = document.querySelector('#saveBody .save-card');
              if (!card) return 'nocards';
              card.click();
              var e0 = currentEditing;
              var nBefore = e0.levels.length;
              var lv0 = currentLevel();
              var bg0 = lv0.bgColor, vy0 = lv0.voidY;
              lv0.bgColor = '#112233'; lv0.voidY = 555;
              document.getElementById('btnErAdd').click();   // 自动新建「第X关」
              var lv1 = currentLevel();
              var nAfter = e0.levels.length;
              var name1 = lv1.name;
              var inheritBg = lv1.bgColor === '#112233';
              var inheritVoid = lv1.voidY === 555;
              var startDef = lv1.start.x === 0 && lv1.start.y === 0;
              var goalDef = lv1.goal.x === 0 && lv1.goal.y === -50;
              var layersEmpty = lv1.layers.length === 0;
              // 切回第一关：数据独立（bg/voidY 保持各自的值）
              var rows = document.querySelectorAll('#editLevelList .er-item');
              if (rows[0]) rows[0].click();
              var back = currentLevel();
              var sameBg = back.bgColor === '#112233';
              return 'n=' + nBefore + '>' + nAfter + ' name=' + name1 + ' inheritBg=' + inheritBg + ' inheritVoid=' + inheritVoid + ' start=' + startDef + ' goal=' + goalDef + ' layers=' + layersEmpty + ' sameBg=' + sameBg;
            })()
          `);
          console.log('LEVEL_CHECK', levelCheck);
          console.log('PRE_STORE');
          // 本地存储往返：新建独立数据 → saveAll → 模拟重启 loadAll → 数据一致（含图层 PNG 序列化）
          const storeCheck = await win.webContents.executeJavaScript(`
            (function () {
              var oldSaves = saves, oldId = saveId;
              var testSave = {
                id: 90001, name: '存储测试',
                levels: [
                  { name: '第1关', bgColor: '#123456', start: { x: 11, y: 22 }, goal: { x: 33, y: -44 }, voidY: 777,
                    layers: [{ id: 'lyT', name: '图层T', type: 'ground', z: 1, visible: true, locked: false, tiles: {} }] }
                ], createdAt: new Date('2026-01-02T03:04:05Z')
              };
              var L = testSave.levels[0].layers[0];
              // 瓦片引擎：旧墨迹坐标 (0,0) 起 64×64 的方块落在瓦片 (-1,-1)
              var t0 = getTile(L, -1, -1, true);
              t0.ctx.fillStyle = '#ffffff';
              t0.ctx.fillRect(10, 10, 20, 20);
              t0.nonEmpty = true;
              saves = [testSave]; saveId = 90002;
              var okSave = saveAll();
              var json = localStorage.getItem('gagame_saves_v1');
              var parsed = JSON.parse(json);
              saves = []; saveId = 1;
              var okLoad = loadAll();
              var s2 = saves[0];
              var lv2 = s2.levels[0];
              var pix = null;
              var tR = getTile(lv2.layers[0], -1, -1, false);
              if (tR) {
                var d = tR.ctx.getImageData(12, 12, 1, 1).data;
                pix = d[3];
              }
              var out = 'save=' + okSave + ' ver=' + parsed.version + ' load=' + okLoad +
                        ' name=' + s2.name + ' bg=' + lv2.bgColor + ' start=' + lv2.start.x + ',' + lv2.start.y +
                        ' goal=' + lv2.goal.x + ',' + lv2.goal.y + ' voidY=' + lv2.voidY +
                        ' layers=' + lv2.layers.length + ' imgPixel=' + pix + ' id=' + s2.id;
              saves = oldSaves; saveId = oldId;
              localStorage.removeItem('gagame_saves_v1');
              return out;
            })()
          `);
          console.log('STORE_CHECK', storeCheck);
        } catch (e) {
          console.error('截图失败:', e);
        }
        // 终局清理：测试数据不留存，用户下次打开是干净列表
        try {
          await win.webContents.executeJavaScript(`
            localStorage.removeItem('gagame_saves_v1');
            saves = []; saveId = 1;
            renderSaves();
          `);
          console.log('FINAL_CLEAN ok');
        } catch (e2) {
          console.error('终局清理失败:', e2);
        }
        app.quit();
      })();
    });
  }
}


// ===== 文件系统存档 IPC =====

// userData 是否被外部改过（自检探针 / 脚本会 app.setPath('userData', 假目录)）。
// 改过就必须完全尊重它 —— 否则迁移会把真实存档搬进探针的临时目录，或者反过来
// 让探针写脏真档。判据：当前 userData != %APPDATA%\<APP_NAME>。
function userDataOverridden() {
  try {
    return path.resolve(app.getPath('userData')) !==
           path.resolve(path.join(app.getPath('appData'), APP_NAME));
  } catch (e) { return false; }
}

// 一次性迁移：旧 userData 名（gamehalfcoustom）里的存档 → 新的（drawagame）。
// 判据：新位置**还没有** index.json，且旧位置**有** → 整树拷一份过去。
// 只拷不删：旧目录原样保留作保险，确认无恙后由用户自行清理。
// 幂等：本次进程内只跑一次；已迁过（新位置有 index.json）直接跳过。
let _legacySavesMigrated = false;
function migrateLegacySavesOnce() {
  if (_legacySavesMigrated) return;
  _legacySavesMigrated = true;
  try {
    if (userDataOverridden()) return;                     // 探针/脚本改过 userData → 不介入
    const cur = path.join(app.getPath('userData'), 'saves');
    if (fs.existsSync(path.join(cur, 'index.json'))) return;   // 新位置已有存档
    const legacy = path.join(app.getPath('appData'), LEGACY_APP_NAME, 'saves');
    if (!fs.existsSync(path.join(legacy, 'index.json'))) return; // 旧位置也没有 → 无事可做
    fs.mkdirSync(cur, { recursive: true });
    fs.cpSync(legacy, cur, { recursive: true });
    console.log('[saves] 旧存档已迁移（只拷不删）：' + legacy + '  ->  ' + cur);
  } catch (e) {
    console.error('[saves] 旧存档迁移失败（旧目录原样保留，不影响启动）：', e && e.message);
  }
}

function savesRoot() {
  migrateLegacySavesOnce();
  const dir = path.join(app.getPath('userData'), 'saves');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function saveDir(id) {
  const dir = path.join(savesRoot(), String(id));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function layersDir(id) {
  const dir = path.join(saveDir(id), 'layers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 读列表（index.json）。导入也要用它分配新 id，所以抽成一个共用函数，
// 免得两处对「文件损坏 / 字段缺失」的处理越走越远。
function readIndexJson() {
  try {
    const f = path.join(savesRoot(), 'index.json');
    if (!fs.existsSync(f)) return { nextId: 1, saves: [] };
    const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { nextId: 1, saves: [] };
    if (!Array.isArray(d.saves)) d.saves = [];
    if (typeof d.nextId !== 'number' || !(d.nextId >= 1)) d.nextId = 1;
    return d;
  } catch (e) { return { nextId: 1, saves: [] }; }
}

ipcMain.handle('game:read-index', () => readIndexJson());

ipcMain.handle('game:write-index', (e, data) => {
  try {
    fs.writeFileSync(path.join(savesRoot(), 'index.json'), JSON.stringify(data), 'utf-8');
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('game:read-meta', (e, saveId) => {
  try {
    const f = path.join(saveDir(saveId), 'meta.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e) { return null; }
});

ipcMain.handle('game:write-meta', (e, saveId, meta) => {
  try {
    fs.writeFileSync(path.join(saveDir(saveId), 'meta.json'), JSON.stringify(meta), 'utf-8');
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('game:read-layer', (e, saveId, levelIdx, layerIdx) => {
  try {
    const f = path.join(layersDir(saveId), 'L' + levelIdx + '_ly' + layerIdx + '.png');
    if (!fs.existsSync(f)) return null;
    return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  } catch (e) { return null; }
});

ipcMain.handle('game:write-layer', (e, saveId, levelIdx, layerIdx, dataUrl) => {
  try {
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(layersDir(saveId), 'L' + levelIdx + '_ly' + layerIdx + '.png'), Buffer.from(base64, 'base64'));
    return true;
  } catch (e) { return false; }
});

// ===== 瓦片化图层 IO：一层一个目录 layers/L{level}_ly{layer}/t{tx}_{ty}.png =====
function layerTileDir(id, levelIdx, layerIdx) {
  return path.join(layersDir(id), 'L' + levelIdx + '_ly' + layerIdx);
}
function listTileFiles(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir).filter((f) => /^t-?\d+_-?\d+\.png$/.test(f));
  } catch (e) { return []; }
}
// 一层当前的落盘状况：瓦片文件数 / 总字节 / 是否有旧版单图
function layerStat(id, levelIdx, layerIdx) {
  const dir = layerTileDir(id, levelIdx, layerIdx);
  const files = listTileFiles(dir);
  let bytes = 0;
  for (const f of files) { try { bytes += fs.statSync(path.join(dir, f)).size; } catch (e) {} }
  const legacy = path.join(layersDir(id), 'L' + levelIdx + '_ly' + layerIdx + '.png');
  const hasLegacy = fs.existsSync(legacy);
  if (hasLegacy) { try { bytes += fs.statSync(legacy).size; } catch (e) {} }
  return { dir, files, legacy, hasLegacy, count: files.length, bytes };
}
ipcMain.handle('game:read-layer-tiles', (e, saveId, levelIdx, layerIdx) => {
  const out = { tiles: {}, legacy: null };
  try {
    const dir = layerTileDir(saveId, levelIdx, layerIdx);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      for (const f of fs.readdirSync(dir)) {
        const m = /^t(-?\d+)_(-?\d+)\.png$/.exec(f);
        if (!m) continue;
        out.tiles[m[1] + ',' + m[2]] =
          'data:image/png;base64,' + fs.readFileSync(path.join(dir, f)).toString('base64');
      }
    }
    // 目录里没瓦片 → 回退旧版单张 4096² PNG（渲染端读入时会自动切成瓦片）
    if (!Object.keys(out.tiles).length) {
      const lf = path.join(layersDir(saveId), 'L' + levelIdx + '_ly' + layerIdx + '.png');
      if (fs.existsSync(lf)) {
        out.legacy = 'data:image/png;base64,' + fs.readFileSync(lf).toString('base64');
      }
    }
  } catch (e) { /* 返回空包，视为空层 */ }
  return out;
});

ipcMain.handle('game:write-layer-tiles', (e, saveId, levelIdx, layerIdx, tiles) => {
  const keys = Object.keys(tiles || {});
  let before = { count: 0, bytes: 0 };
  try {
    const dir = layerTileDir(saveId, levelIdx, layerIdx);
    const legacy = path.join(layersDir(saveId), 'L' + levelIdx + '_ly' + layerIdx + '.png');
    const st = layerStat(saveId, levelIdx, layerIdx);
    before = { count: st.count, bytes: st.bytes };
    // ① 历史遗留清理：旧版「上一版快照」目录（.lastgood）。该功能已按用户要求整体移除
    //   （2026-09-23：反馈有问题且不实用）——没有恢复入口了，留着只是白占一倍磁盘。
    //   清的是本程序自己生成的副本；原始瓦片在 L{关}_ly{层}/ 下，不会丢用户数据。
    try {
      fs.rmSync(path.join(layersDir(saveId), '.lastgood', 'L' + levelIdx + '_ly' + layerIdx),
        { recursive: true, force: true });
    } catch (e0) {}

    // ② 先整体写进临时目录，成功后再原子替换 —— 写到一半失败也不会留下残缺层
    const tmp = dir + '.__writing';
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    let afterBytes = 0;
    for (const k of keys) {
      const m = /^(-?\d+),(-?\d+)$/.exec(k);
      if (!m) continue;
      const b64 = String(tiles[k]).replace(/^data:image\/png;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      afterBytes += buf.length;
      fs.writeFileSync(path.join(tmp, 't' + m[1] + '_' + m[2] + '.png'), buf);
    }
    // ③ 替换：整层重写，旧瓦片目录和旧单图一并清掉，避免被擦除的笔迹残留
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(legacy)) fs.rmSync(legacy, { force: true });
    if (keys.length) fs.renameSync(tmp, dir);
    else fs.rmSync(tmp, { recursive: true, force: true });

    return {
      ok: true,
      wrote: keys.length,
      beforeCount: before.count,
      beforeBytes: before.bytes,
      afterBytes: afterBytes,
      // 体积塌陷（内容成数量级缩水）→ 疑似「读到空白后落盘」，渲染端据此给个提示
      shrunk: before.bytes > 4096 && afterBytes * 8 < before.bytes
    };
  } catch (err) {
    // 失败兜底：临时目录清掉，原目录在被删之前就报错的话内容还在，不会白写
    try { fs.rmSync(layerTileDir(saveId, levelIdx, layerIdx) + '.__writing', { recursive: true, force: true }); } catch (e2) {}
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('game:read-custom-music', (e, saveId) => {
  try {
    const f = path.join(saveDir(saveId), 'custom.mp3');
    if (!fs.existsSync(f)) return null;
    return 'data:audio/mpeg;base64,' + fs.readFileSync(f).toString('base64');
  } catch (e) { return null; }
});

ipcMain.handle('game:write-custom-music', (e, saveId, dataUrl) => {
  try {
    const base64 = dataUrl.replace(/^data:audio\/[\w]+;base64,/, '');
    fs.writeFileSync(path.join(saveDir(saveId), 'custom.mp3'), Buffer.from(base64, 'base64'));
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('game:delete-save', (e, saveId) => {
  try {
    const dir = saveDir(saveId);
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (e) { return false; }
});

ipcMain.handle('game:migrate-local', () => {
  // 由 renderer 传旧 localStorage 数据过来，主进程直接写文件
  return true;
});


ipcMain.handle('game:capture-thumbnail', async (e, saveId, canvasScale, cx, cy) => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return false;
    const image = await win.webContents.capturePage();
    const size = image.getSize();
    const scale = size.width / 960; // DPI 缩放
    // 屏幕像素 704.4x440.229（不乘缩放）
    const cropW = 704.4 * scale, cropH = 440.229 * scale;
    cx = (cx || size.width / 2) * scale;
    cy = (cy || size.height / 2) * scale;
    const sx = Math.max(0, Math.round(cx - cropW / 2));
    const sy = Math.max(0, Math.round(cy - cropH / 2));
    const sw = Math.min(size.width - sx, Math.round(cropW));
    const sh = Math.min(size.height - sy, Math.round(cropH));
    // 裁剪 + 缩放到 210.45x131.525
    const { nativeImage } = require('electron');
    const cropped = nativeImage.createFromBitmap(image.getBitmap(), { width: size.width, height: size.height });
    // 用 resize + crop
    const thumb = image.crop({ x: sx, y: sy, width: sw, height: sh });
    const resized = thumb.resize({ width: 210, height: 132, quality: 'good' });
    const png = resized.toPNG();
    const dir = path.join(saveDir(saveId));
    fs.writeFileSync(path.join(dir, 'thumbnail.png'), png);
    return true;
  } catch (e) { console.error('thumb', e); return false; }
});

ipcMain.handle('game:read-thumbnail', (e, saveId) => {
  try {
    const f = path.join(saveDir(saveId), 'thumbnail.png');
    if (!fs.existsSync(f)) return null;
    return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  } catch (e) { return null; }
});

// ===== 导出：.hgyx 闯关包 =====
//
// 导出方向永远是「当前正在编辑的那一个闯关」——入口就埋在编辑器工具栏里，
// 不在列表页，所以不存在"把列表里所有闯关一起导出"这种歧义。
//
// mode = 'full'  完整闯关：原样搬运（allowEdit 保留）
// mode = 'play'  仅游玩闯关：内容一模一样，只把元数据 allowEdit 写成 false
//                —— 收到的人能玩、不能进编辑器（编辑按钮变挂锁）
//
// 数据一律"从磁盘读"，不从渲染进程搬 base64：渲染端点导出时会先 saveAllAsync()
// 把内存里的编辑落盘，再由主进程打包。这样导出内容必然与存档一致，也避免了
// 几十 MB 的位图走 IPC。
function readMetaJson(saveId) {
  try {
    // 注意用 savesRoot 直接拼路径：不能用 saveDir()，它会 mkdir，
    // 查一个不存在的闯关就会在存档目录里留下空壳
    const f = path.join(savesRoot(), String(saveId), 'meta.json');
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch (e) { return null; }
}

// 文件名安全化：Windows 不允许 \ / : * ? " < > | ，且结尾不能是空格或点
function safeSaveName(name, fallback) {
  let s = String(name === undefined || name === null ? '' : name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  if (s.length > 80) s = s.slice(0, 80).replace(/[. ]+$/, '');
  return s || fallback;
}

// 把一个闯关打包成 .hgyx（不弹对话框、不落盘，纯函数便于自检）
function buildHgyxBuffer(saveId, mode) {
  const meta = readMetaJson(saveId);
  if (!meta) return { ok: false, error: '找不到这个闯关的元数据（meta.json）' };
  const kind = mode === 'play' ? 'play' : 'full';

  // save.json = 元数据 + 关卡结构 + 图层清单，唯一改动就是「仅游玩」的 allowEdit
  const saveJson = Object.assign({}, meta);
  saveJson.allowEdit = kind === 'play' ? false : (meta.allowEdit !== false);

  const entries = [];
  const levels = meta.levels || [];
  let tileFiles = 0, legacyFiles = 0;
  for (let li = 0; li < levels.length; li++) {
    const lv = levels[li] || {};
    const lyMeta = lv.layers || [];
    const nLy = lyMeta.length || lv.layerCount || 0;
    for (let ci = 0; ci < nLy; ci++) {
      const dir = layerTileDir(saveId, li, ci);
      for (const f of listTileFiles(dir)) {
        entries.push({ name: 'layers/L' + li + '_ly' + ci + '/' + f, data: fs.readFileSync(path.join(dir, f)) });
        tileFiles++;
      }
      // 老存档的整张单图（还没切片）也一并带上，别让笔迹在半路上丢了
      const legacy = path.join(layersDir(saveId), 'L' + li + '_ly' + ci + '.png');
      if (fs.existsSync(legacy)) {
        entries.push({ name: 'layers/L' + li + '_ly' + ci + '.png', data: fs.readFileSync(legacy) });
        legacyFiles++;
      }
    }
  }
  const musicPath = path.join(saveDir(saveId), 'custom.mp3');
  if (fs.existsSync(musicPath)) entries.push({ name: 'music.mp3', data: fs.readFileSync(musicPath) });
  const thumbPath = path.join(saveDir(saveId), 'thumbnail.png');
  if (fs.existsSync(thumbPath)) entries.push({ name: 'thumb.png', data: fs.readFileSync(thumbPath) });

  const saveBuf = Buffer.from(JSON.stringify(saveJson, null, 2), 'utf-8');
  entries.push({ name: 'save.json', data: saveBuf });

  const manifest = {
    format: 'hgyx',
    formatVersion: hgyx.FORMAT_VERSION,
    kind: kind,
    kindLabel: kind === 'play' ? '仅游玩闯关' : '完整闯关',
    app: '画个游戏',
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    name: saveJson.name || '',
    author: saveJson.author || '',
    allowEdit: saveJson.allowEdit,
    levels: levels.length,
    layerTiles: tileFiles,
    layerImages: legacyFiles,
    hasMusic: entries.some((x) => x.name === 'music.mp3'),
    hasThumb: entries.some((x) => x.name === 'thumb.png'),
    files: entries.map((x) => x.name).concat(['manifest.json'])
  };
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
  entries.unshift({ name: 'manifest.json', data: manifestBuf });

  const buf = hgyx.write(entries);
  return { ok: true, buf, manifest, saveJson, tileFiles, legacyFiles, levels: levels.length };
}

ipcMain.handle('game:export-save', async (e, saveId, mode, displayName) => {
  try {
    const built = buildHgyxBuffer(saveId, mode);
    if (!built.ok) return built;
    const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getAllWindows()[0] || null;
    // 默认文件名 = [闯关名称].hgyx，落在「下载」目录
    const base = safeSaveName(displayName || built.saveJson.name, '闯关' + saveId);
    let dir = '';
    try { dir = app.getPath('downloads'); } catch (e2) { dir = ''; }
    if (!dir) { try { dir = app.getPath('documents'); } catch (e3) { dir = ''; } }
    const defaultPath = dir ? path.join(dir, base + '.hgyx') : base + '.hgyx';
    const opts = {
      title: mode === 'play' ? '导出仅游玩闯关' : '导出完整闯关',
      defaultPath: defaultPath,
      filters: [{ name: '画个游戏闯关包 (*.hgyx)', extensions: ['hgyx'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (!res || res.canceled || !res.filePath) return { ok: false, canceled: true };
    const filePath = /\.hgyx$/i.test(res.filePath) ? res.filePath : res.filePath + '.hgyx';
    fs.writeFileSync(filePath, built.buf);
    return {
      ok: true,
      path: filePath,
      bytes: built.buf.length,
      mode: mode === 'play' ? 'play' : 'full',
      levels: built.levels,
      tiles: built.tileFiles,
      allowEdit: built.saveJson.allowEdit
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ───────────────────────────────────────────────────────────────────────────
// .hgyx 导入
//
// 与导出对称。分三层，好处是自检时可以只跑中间那层、完全不碰 index.json：
//   parseHgyx(buf)                 纯解析 + 校验，不落盘
//   materializeImport(p, id, o)    只写 saves/<id>/，不动列表
//   importHgyxBuffer(buf)          完整流程：分配 id → 落盘 → 挂进 index.json
//
// 两条硬规则：
//   1) 导入永远产出「一个新闯关」（重新分配 id），绝不覆盖本机已有的任何闯关；
//   2) 包里的 allowEdit 原样保留 —— 「仅游玩」包进来就该是锁的。
// 外加一条：cleared（通关状态）不跟着包走，导入一律置 false —— 那是本机玩家自己的进度。
// ───────────────────────────────────────────────────────────────────────────
const TILE_ENTRY_RE = /^layers\/L(\d+)_ly(\d+)\/t(-?\d+)_(-?\d+)\.png$/;
const LEGACY_ENTRY_RE = /^layers\/L(\d+)_ly(\d+)\.png$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function isPngBuffer(b) {
  return Buffer.isBuffer(b) && b.length > 8 && b.subarray(0, 4).equals(PNG_MAGIC);
}

function parseHgyx(buf) {
  let pack;
  try { pack = hgyx.read(buf); }
  catch (e) { return { ok: false, error: '不是有效的 .hgyx 文件（' + ((e && e.message) || e) + '）' }; }
  const manBuf = pack['manifest.json'];
  if (!manBuf) return { ok: false, error: '包里没有 manifest.json，不是「画个游戏」的闯关包' };
  let manifest;
  try { manifest = JSON.parse(manBuf.toString('utf-8')); }
  catch (e) { return { ok: false, error: 'manifest.json 无法解析' }; }
  if (!manifest || manifest.format !== 'hgyx') return { ok: false, error: '这不是「画个游戏」的闯关包（缺少 format 标记）' };
  // 比本程序新的格式：明确拒绝。硬着头皮读下去只会写出一份缺字段的坏存档。
  if (Number(manifest.formatVersion) > hgyx.FORMAT_VERSION) {
    return { ok: false, error: '包格式 v' + manifest.formatVersion + ' 比本程序（v' + hgyx.FORMAT_VERSION + '）新，请先升级程序' };
  }
  const sjBuf = pack['save.json'];
  if (!sjBuf) return { ok: false, error: '包里没有 save.json（闯关数据）' };
  let saveJson;
  try { saveJson = JSON.parse(sjBuf.toString('utf-8')); }
  catch (e) { return { ok: false, error: 'save.json 无法解析' }; }
  if (!saveJson || typeof saveJson !== 'object' || Array.isArray(saveJson)) return { ok: false, error: 'save.json 内容不是对象' };
  if (!Array.isArray(saveJson.levels)) return { ok: false, error: 'save.json 里没有关卡列表（levels）' };
  return { ok: true, manifest, saveJson, files: pack };
}

// 包里的 meta 未必和实际瓦片文件对得上（手工改过、或早期版本产出的包）。
// 以「包里真有哪一层」为准补齐关卡/图层描述 —— 否则瓦片躺在磁盘上却永远读不出来，
// 表现就是「导入成功但关卡是空的」。
function reconcileImportedLevels(meta, files) {
  const need = [];        // need[li] = { ci: true }
  for (const name of Object.keys(files)) {
    const m = TILE_ENTRY_RE.exec(name) || LEGACY_ENTRY_RE.exec(name);
    if (!m) continue;
    const li = parseInt(m[1], 10), ci = parseInt(m[2], 10);
    if (!(li >= 0) || !(ci >= 0)) continue;
    while (need.length <= li) need.push({});
    need[li][ci] = true;
  }
  const levels = meta.levels;
  const total = Math.max(levels.length, need.length);
  for (let li = 0; li < total; li++) {
    // 补洞时也保持下标 —— 用 splice 会让后面的关卡整体错位，连带瓦片目录对不上号
    if (!levels[li] || typeof levels[li] !== 'object' || Array.isArray(levels[li])) {
      levels[li] = { name: '第' + (li + 1) + '关', bgColor: '#000000', layers: [],
                     start: { x: 0, y: 0 }, goal: { x: 0, y: -50 }, voidY: 1000 };
    }
    const lv = levels[li];
    if (typeof lv.name !== 'string' || !lv.name) lv.name = '第' + (li + 1) + '关';
    if (!lv.start || typeof lv.start.x !== 'number' || typeof lv.start.y !== 'number') lv.start = { x: 0, y: 0 };
    if (!lv.goal || typeof lv.goal.x !== 'number' || typeof lv.goal.y !== 'number') lv.goal = { x: 0, y: -50 };
    if (typeof lv.voidY !== 'number') lv.voidY = 1000;
    if (!lv.bgColor) lv.bgColor = '#000000';
    if (!Array.isArray(lv.layers)) lv.layers = [];
    const idxs = Object.keys(need[li] || {}).map(Number);
    const maxCi = idxs.length ? Math.max.apply(null, idxs) : -1;
    for (let ci = 0; ci <= maxCi; ci++) {
      if (lv.layers[ci] && typeof lv.layers[ci] === 'object') continue;
      lv.layers[ci] = { id: 'ly' + li + '_' + ci, name: '图层' + (ci + 1), type: 'ground', z: ci, visible: true, locked: false };
    }
  }
  return meta;
}

// 把已解析的包落到 saves/<destId>/。只写文件，不碰 index.json。
function materializeImport(parsed, destId, opts) {
  opts = opts || {};
  const files = parsed.files;
  const dir = path.join(savesRoot(), String(destId));
  fs.rmSync(dir, { recursive: true, force: true });   // 目标 id 是全新的，清一下只为兜底
  const layDir = path.join(dir, 'layers');
  fs.mkdirSync(layDir, { recursive: true });

  const meta = Object.assign({}, parsed.saveJson);
  meta.id = destId;                                        // 必须换号，否则和本机别的闯关撞 id
  meta.allowEdit = parsed.saveJson.allowEdit !== false;    // 「仅游玩」包进来就是锁的
  // 通关状态是本机行为，不跟着包走：别人通过的包导进来必须重新算「未通关」，
  // 否则刚导入就顶着「已通关」，玩家连玩都没玩。
  meta.cleared = false;
  if (typeof opts.name === 'string' && opts.name) meta.name = opts.name;
  if (typeof meta.name !== 'string' || !meta.name) meta.name = '导入的闯关';
  if (!meta.createdAt) meta.createdAt = new Date().toISOString();
  if (!Array.isArray(meta.levels)) meta.levels = [];
  reconcileImportedLevels(meta, files);

  let tiles = 0, legacies = 0;
  const skipped = [];
  for (const name of Object.keys(files)) {
    let m = TILE_ENTRY_RE.exec(name);
    if (m) {
      if (!isPngBuffer(files[name])) { skipped.push(name); continue; }
      const sub = path.join(layDir, 'L' + m[1] + '_ly' + m[2]);
      if (!fs.existsSync(sub)) fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 't' + m[3] + '_' + m[4] + '.png'), files[name]);
      tiles++;
      continue;
    }
    m = LEGACY_ENTRY_RE.exec(name);
    if (m) {
      if (!isPngBuffer(files[name])) { skipped.push(name); continue; }
      fs.writeFileSync(path.join(layDir, 'L' + m[1] + '_ly' + m[2] + '.png'), files[name]);
      legacies++;
    }
  }
  // 音乐以「文件是否真的在包里」为准，meta 里的标记不可信
  const hasMusic = !!files['music.mp3'];
  if (hasMusic) fs.writeFileSync(path.join(dir, 'custom.mp3'), files['music.mp3']);
  meta.customMusic = hasMusic;
  if (files['thumb.png']) fs.writeFileSync(path.join(dir, 'thumbnail.png'), files['thumb.png']);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta), 'utf-8');

  return { ok: true, id: destId, dir, meta, tiles, legacies, skipped,
           levels: meta.levels.length, allowEdit: meta.allowEdit };
}

// 分配新 id：以 index.nextId 为准，同时不撞已有条目、也不撞磁盘上残留的目录
// （saves/ 里可能有已从列表删掉、目录还在的孤儿，撞上就会被整层覆盖）
function allocateSaveId(index) {
  const used = {};
  let maxId = 0;
  for (const s of index.saves) {
    const n = Number(s && s.id) || 0;
    used[String(s.id)] = true;
    if (n > maxId) maxId = n;
  }
  let id = Math.max(Number(index.nextId) || 1, maxId + 1);
  while (used[String(id)] || fs.existsSync(path.join(savesRoot(), String(id)))) id++;
  return id;
}

// 列表里已有同名闯关就加后缀 —— 两张一模一样的卡片没法区分
function uniqueSaveName(name, index) {
  const base = safeSaveName(name, '导入的闯关');
  const used = {};
  for (const s of index.saves) used[String(s && s.name)] = true;
  if (!used[base]) return base;
  let n = 1;
  let cand = base + '（导入）';
  while (used[cand]) { n++; cand = base + '（导入' + n + '）'; }
  return cand;
}

function importHgyxBuffer(buf) {
  const parsed = parseHgyx(buf);
  if (!parsed.ok) return parsed;
  const index = readIndexJson();
  const destId = allocateSaveId(index);
  const destName = uniqueSaveName(parsed.saveJson.name, index);

  let res;
  try { res = materializeImport(parsed, destId, { name: destName }); }
  catch (e) { return { ok: false, error: '写入存档失败：' + ((e && e.message) || e) }; }

  const entry = {
    id: res.id, name: res.meta.name, createdAt: res.meta.createdAt,
    author: res.meta.author || '', epilogue: res.meta.epilogue || '',
    retryFromLevel: !!res.meta.retryFromLevel, customMusic: !!res.meta.customMusic,
    allowEdit: res.meta.allowEdit !== false
  };
  index.saves.push(entry);
  index.nextId = Math.max(Number(index.nextId) || 1, res.id + 1);
  try {
    fs.writeFileSync(path.join(savesRoot(), 'index.json'), JSON.stringify(index), 'utf-8');
  } catch (e) {
    // 挂不上列表就等于没导入：把半成品目录清掉，别留个谁也看不见的孤儿
    try { fs.rmSync(res.dir, { recursive: true, force: true }); } catch (e2) {}
    return { ok: false, error: '写入闯关列表失败：' + ((e && e.message) || e) };
  }
  return { ok: true, id: res.id, name: entry.name, levels: res.levels, tiles: res.tiles,
           legacies: res.legacies, skipped: res.skipped.length, allowEdit: entry.allowEdit };
}

// 从路径导入（对话框之外的全部逻辑，便于自检直接调）
function importHgyxFromPath(filePath) {
  // 对话框的 filter 只是「默认列表里只显示 .hgyx」，用户手打路径仍能选别的 → 这里再兜一道
  if (!/\.hgyx$/i.test(String(filePath || ''))) return { ok: false, error: '只能导入 .hgyx 闯关包' };
  let buf;
  try { buf = fs.readFileSync(filePath); }
  catch (e) { return { ok: false, error: '读取文件失败：' + ((e && e.message) || e) }; }
  const r = importHgyxBuffer(buf);
  if (r && r.ok) r.file = path.basename(filePath);
  return r;
}

ipcMain.handle('game:import-save', async (e) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender) || BrowserWindow.getAllWindows()[0] || null;
    const opts = {
      title: '导入闯关',
      buttonLabel: '导入',
      filters: [{ name: '画个游戏闯关包 (*.hgyx)', extensions: ['hgyx'] }],
      properties: ['openFile']
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return { ok: false, canceled: true };
    return importHgyxFromPath(res.filePaths[0]);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 自检看门狗
//
// 每个自检套件都靠自己调 app.exit() 退出。问题是：只要 finally 块里抛一次异常，
// 后面所有代码（包括 app.exit()）就全被吃掉 —— 那个 Electron 会永远活着，
// PowerShell 卡在 `& $el` 上等它，**整套回归静默挂死**，后面的套件一个都不会跑。
// 2026-09-21 真踩过：一个手误的未声明变量让四套回归挂了 9 分钟才被人发现。
//
// 所以：只要处于自检模式，就压一条上限。超时强制退出并打标记（exit code 3），
// 让排查者一眼看出「是挂死，不是逻辑失败」。正常退出时它不会被触发。
// 可用 TEST_WATCHDOG_MS 覆盖（TILE_TEST 在 GPU 不稳定时可能偏慢）。
// ───────────────────────────────────────────────────────────────────────────
{
  const TEST_MODES = ['UI_TEST', 'TILE_TEST', 'TEXT_TEST', 'EXPORT_TEST', 'IMPORT_TEST',
                      'UNDO_TEST', 'CLOSE_TEST', 'GPU_RECOVER_TEST', 'GPU_STEP_TEST'];
  if (TEST_MODES.some((m) => process.env[m] === '1')) {
    const ms = Number(process.env.TEST_WATCHDOG_MS || 300000);
    const wd = setTimeout(() => {
      console.log('[watchdog] 自检超过 ' + ms + 'ms 仍未退出 —— 强制结束。');
      console.log('          多半是某个套件在 finally/收尾里抛了异常，吃掉了自己的 app.exit()。');
      app.exit(3);
    }, ms);
    if (wd.unref) wd.unref();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 首次启动：把随包附带的「默认关.hgyx」自动导入一次，让新玩家一开就有得玩。
//
// 时机：whenReady 里、**早于 createWindow()** —— 渲染端第一次读 index.json
// 时它就已经在列表里了，渲染端完全不用知道有这回事。
//
// 定位随包文件用 __dirname：打包后它 = 程序自己的 resources/app 目录，所以整个
// 文件夹搬到硬盘任何位置都找得到（不依赖 cwd、不写任何绝对路径）。
//
// 只在「真的第一次」做，三条闸门：
//   ① 自检/截图模式（*_TEST / SHOT_MODE / TILE_SHOT）→ 绝不碰真实存档；
//   ② 已播种过（userData 下的 .seeded-default 标记）→ 跳过；
//   ③ 已经有存档的老用户 → 不硬塞一个重复的「默认关」进人家列表。
// 标记文件故意放在 userData 根、**不放在 saves/ 里** —— 免得被存档逻辑当成一个关卡。
//
// ③ 这条很关键：这个包的 save.json 里名字就叫「◆内置◆」，而老用户的列表里
// 多半已经有一个同名的（手动导入过），不拦就会多出一张「◆内置◆（导入）」。
//
// 想在一台已经有存档的机器上验证「首启播种」这条路，用
//     HuageyouxiGame.exe --user-data-dir=<空目录>   （环境变量 HUAGE_SEED_FORCE=1）
// —— 前者给一个干净存档目录，后者显式跳过 ①② 两道护栏。正常启动完全用不到它们。
// ───────────────────────────────────────────────────────────────────────────
function underTestOrShot() {
  if (process.env.SHOT_MODE === '1' || process.env.TILE_SHOT === '1') return true;
  return Object.keys(process.env).some((k) => /_TEST$/.test(k) && process.env[k] === '1');
}

function seedBundledFirstRunSave() {
  try {
    const forced = process.env.HUAGE_SEED_FORCE === '1';   // 仅测试用
    if (!forced) {
      if (underTestOrShot()) return;
      if (userDataOverridden()) return;   // 探针/脚本改过 userData → 不介入
    }
    const marker = path.join(app.getPath('userData'), '.seeded-default');
    if (fs.existsSync(marker)) return;
    if (readIndexJson().saves.length) return;   // 已经有存档 → 不重复塞
    const src = path.join(__dirname, '默认关.hgyx');
    if (!fs.existsSync(src)) return;            // 包里没带这个文件 → 静默跳过
    const r = importHgyxFromPath(src);
    if (r && r.ok) {
      console.log('[saves] 首次启动：已自动导入默认关「' + r.name + '」(id=' + r.id + ', ' + r.levels + ' 关)');
      try { fs.writeFileSync(marker, new Date().toISOString(), 'utf-8'); } catch (e) {}
    } else {
      // 不落标记：万一是文件损坏，下次启动还可以重试；只写日志、绝不弹窗打断玩家
      console.error('[saves] 首次启动自动导入默认关失败：' + ((r && r.error) || '未知错误'));
    }
  } catch (e) {
    console.error('[saves] 首次启动播种异常（不影响启动）：', e && e.message);
  }
}

app.whenReady().then(() => {
  migrateLegacySavesOnce();   // 早于窗口加载：渲染端第一次读档就能看到老存档
  seedBundledFirstRunSave();  // 早于窗口加载：首启把随包的默认关挂进列表
  createWindow();
});

// GPU 进程崩溃保护：主进程检测到 GPU 子进程退出，通知 renderer 停游戏+锁存档+弹错
app.on('child-process-gone', (event, details) => {
  if (details && details.type === 'GPU') {
    // 关键诊断信息：reason 区分 crashed / oom / clean-exit / killed 等，
    // exitCode 是驱动层返回码。只打「退出了」等于什么都没说，必须记全。
    const info = { reason: details.reason, exitCode: details.exitCode, serviceName: details.serviceName };
    gpuCrashes.push(JSON.stringify(info));
    console.error('[GPU_CRASH] GPU 进程退出 ' + JSON.stringify(info));
    const wins = BrowserWindow.getAllWindows();
    wins.forEach(w => {
      try { w.webContents.executeJavaScript('if (window.__onGpuCrash) window.__onGpuCrash();'); } catch (e) {}
    });
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
