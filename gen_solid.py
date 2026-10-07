# -*- coding: utf-8 -*-
"""把 testlevel.png 的固体像素(alpha>64)预生成为 RLE 段数据 JS 文件。
script 标签加载不受 file:// CORS 限制，网页端无需 canvas getImageData。
用法: python gen_solid.py   (在项目根生成 testlevel.solid.js)
"""
from PIL import Image
import json
import os

BASE = r'E:\Shinelon-DTX\Documents\PycharmProjects\Agentshixian\Gamehalfcoustom'
SRC = os.path.join(BASE, 'testlevel.png')
OUT = os.path.join(BASE, 'testlevel.solid.js')
TH = 64

img = Image.open(SRC).convert('RGBA')
w, h = img.size
px = img.load()

rows = []
for y in range(h):
    segs = []
    start = None
    for x in range(w):
        a = px[x, y][3]
        if a > TH:
            if start is None:
                start = x
        else:
            if start is not None:
                segs.append([start, x - 1])
                start = None
    if start is not None:
        segs.append([start, w - 1])
    rows.append(segs)

data = {'w': w, 'h': h, 'ox': -600, 'oy': 100, 'rle': rows}
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('window.SOLID_DATA = ')
    json.dump(data, f, separators=(',', ':'))
    f.write(';')
print('rows_with_solid:', sum(1 for r in rows if r), 'size:', os.path.getsize(OUT), 'bytes')
