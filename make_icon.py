# -*- coding: utf-8 -*-
"""把两张 PNG 合成一个多尺寸 icon.ico（Windows 图标）。

用法： 在项目根目录执行  python make_icon.py
输出： 与脚本同目录的 icon.ico

尺寸分工：
    >= 48px  用主图标（细节多，缩太小会糊）
    <= 32px  用专用小图标（列表 / 左上角那类小尺寸场景）
"""
import io
import os
import struct
import sys

try:
    from PIL import Image
except ImportError:
    sys.exit("缺少 Pillow，请先执行：  pip install pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
BIG = os.path.join(HERE, "画个游戏图标.png")
SMALL = os.path.join(HERE, "画个游戏图标-小图标-列表和应用左上角图标用.png")
OUT = os.path.join(HERE, "icon.ico")

PLAN = [
    (256, BIG),
    (128, BIG),
    (64, BIG),
    (48, BIG),
    (32, SMALL),
    (24, SMALL),
    (16, SMALL),
]

for path in (BIG, SMALL):
    if not os.path.isfile(path):
        sys.exit("找不到源图：" + path)

# 1) 自己缩好每一档，编码成 PNG 字节
frames = []  # [(边长, png字节), ...]
for size, src in PLAN:
    with Image.open(src) as im:
        im = im.convert("RGBA").resize((size, size), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="PNG", optimize=True)
    frames.append((size, buf.getvalue()))
    print("  %3dx%-3d  %7d 字节   <- %s" % (size, size, len(buf.getvalue()), os.path.basename(src)))

# 2) 手工拼 ICO 容器：6 字节文件头 + 16 字节/条目录项 + 数据区
#    每档直接用 PNG 载荷（Vista 及以上原生支持，比重画 BMP 省事且不会出错）
header = struct.pack("<HHH", 0, 1, len(frames))  # reserved / type=1(ICO) / 档数
entries = b""
offset = 6 + 16 * len(frames)
for size, data in frames:
    dim = 0 if size >= 256 else size  # 256 在目录里用 0 表示
    entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
    offset += len(data)

with open(OUT, "wb") as f:
    f.write(header + entries + b"".join(data for _, data in frames))

# 3) 回读校验：确认 7 档都在、顺序和尺寸都对
with Image.open(OUT) as ico:
    got = sorted(ico.ico.sizes())
expect = sorted((s, s) for s, _ in PLAN)
assert got == expect, "写出来的尺寸对不上：%s != %s" % (got, expect)

print()
print("已生成：%s" % OUT)
print("大小  ：%d 字节" % os.path.getsize(OUT))
print("内含  ：" + "、".join("%dx%d" % wh for wh in got))
