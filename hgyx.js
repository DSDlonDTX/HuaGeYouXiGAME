// ───────────────────────────────────────────────────────────────────────────
// .hgyx 闯关包格式
//
// 「画个游戏」的导出产物。本质上是一个标准 ZIP 容器（因此可以直接把后缀改成
// .zip 用任何解压软件打开检查），里面装着：
//
//   manifest.json                  包清单：格式版本、导出类型(full/play)、导出时间、
//                                  体积统计、文件列表
//   save.json                      闯关元数据 + 关卡结构（名称/背景色/起点/终点/
//                                  死亡界限/图层清单）+ allowEdit
//   layers/L{关}_ly{层}/t{tx}_{ty}.png   笔迹瓦片（与存档目录同构）
//   layers/L{关}_ly{层}.png              旧版单张图层（老存档才有）
//   music.mp3                      自定义音乐（若有）
//   thumb.png                      缩略图（若有）
//
// 为什么自己手写 ZIP 而不用第三方库：
//   1) 只依赖 Node 内置 zlib，零新增依赖，不会因为 npm i 失败而导不出；
//   2) 产物是通用格式，用户/未来的导入功能都能自己解析，不搞私有二进制；
//   3) PNG 本身已压缩，这里对小幅数据用 deflate 兜底、对已压缩数据直接 store，
//      都不会把包撑大。
//
// 注意：这里只实现"打包/解包"这一层，不认识游戏语义。哪些文件该进包、allowEdit
// 怎么改，都属于业务，放在 main.js 里。
// ───────────────────────────────────────────────────────────────────────────
const zlib = require('zlib');

// 包格式版本。导入端靠它拒绝「比本程序新」的包，避免拿半个包写出一份坏存档。
// 单一来源：main.js 打包时也写这个值。
const FORMAT_VERSION = 1;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
// ZIP 通用位标记 bit 11：文件名是 UTF-8（否则中文文件名在解压端会乱码）
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
// 小于这个字节数就不值得压（deflate 头尾开销会把小文件压大）
const COMPRESS_MIN = 128;

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// DOS 时间戳（ZIP 用的是 1980 纪元的 MS-DOS 格式，秒只有 2 秒精度）
function dosDateTime(d) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  };
}

// entries: [{ name: string, data: Buffer|string }] -> Buffer
function write(entries) {
  const list = entries || [];
  const localParts = [];
  const centralParts = [];
  const { time, date } = dosDateTime(new Date());
  let offset = 0;

  for (const en of list) {
    const nameBuf = Buffer.from(String(en.name).replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(en.data) ? en.data : Buffer.from(String(en.data), 'utf8');
    const crc = crc32(raw);

    let method = METHOD_STORE;
    let body = raw;
    if (raw.length >= COMPRESS_MIN) {
      const packed = zlib.deflateRawSync(raw, { level: 9 });
      if (packed.length < raw.length) { method = METHOD_DEFLATE; body = packed; }
    }

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(LOCAL_SIG, 0);
    lh.writeUInt16LE(20, 4);              // 解压所需版本 2.0
    lh.writeUInt16LE(FLAG_UTF8, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);    // 压缩后大小
    lh.writeUInt32LE(raw.length, 22);     // 原始大小
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);              // 扩展字段长度
    localParts.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(CENTRAL_SIG, 0);
    ch.writeUInt16LE(20, 4);              // 生成程序版本
    ch.writeUInt16LE(20, 6);              // 解压所需版本
    ch.writeUInt16LE(FLAG_UTF8, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);              // 扩展字段
    ch.writeUInt16LE(0, 32);              // 注释
    ch.writeUInt16LE(0, 34);              // 起始磁盘号
    ch.writeUInt16LE(0, 36);              // 内部属性
    ch.writeUInt32LE(0, 38);              // 外部属性
    ch.writeUInt32LE(offset, 42);         // 本地头偏移
    centralParts.push(ch, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);               // 本磁盘号
  eocd.writeUInt16LE(0, 6);               // 中央目录起始磁盘号
  eocd.writeUInt16LE(list.length, 8);     // 本磁盘条目数
  eocd.writeUInt16LE(list.length, 10);    // 总条目数
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);         // 中央目录偏移
  eocd.writeUInt16LE(0, 20);              // 注释长度

  return Buffer.concat([Buffer.concat(localParts), central, eocd]);
}

// 便于自检与（未来的）导入：把包读回 { 文件名: Buffer }
function read(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('文件太小，不是有效的 .hgyx');
  // 从尾部往前找 EOCD（注释最长 65535 字节）
  const min = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('未找到 ZIP 结尾记录，不是有效的 .hgyx');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // 数据要从本地头自己的扩展字段长度算起（中央目录的 extraLen 未必相同）
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    out[name] = method === METHOD_DEFLATE ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

module.exports = { write, read, crc32, FORMAT_VERSION };
