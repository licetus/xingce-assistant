#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成微信小程序 tabBar 图标。

产出 4 个 tab × 2 态（未选中 / 选中）= 8 张 81×81 透明 PNG，
写入 miniprogram/assets/tabbar/。

为什么是 81×81：微信官方建议 tabBar 图标 81×81，尺寸上限 40KB。
本脚本用 8 倍超采样绘制再 LANCZOS 缩回，得到平滑抗锯齿的描边。

依赖（仅开发期需要，不进小程序包）：
    pip install Pillow

用法：
    python3 scripts/gen-tabbar-icons.py
"""

import os

from PIL import Image, ImageDraw

# ---------------------------------------------------------------- 配置

SIZE = 81          # 输出尺寸
SCALE = 8          # 超采样倍率
STROKE = 5.0       # 描边宽度（以 81×81 坐标系为准）

COLOR_NORMAL = (0x9A, 0x9E, 0xA6, 255)   # 与 app.json tabBar.color 一致
COLOR_ACTIVE = (0x2B, 0x6C, 0xF6, 255)   # 与 tabBar.selectedColor 一致

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "miniprogram", "assets", "tabbar")


def px(v):
    """81 坐标系 -> 超采样画布坐标"""
    return v * SCALE


def stroke_path(d, pts, color, width=STROKE, close=False, caps=True):
    """折线描边，拐角圆角连接；端点用圆点补出圆头效果。"""
    w = int(round(width * SCALE))
    scaled = [(px(x), px(y)) for x, y in pts]
    if close:
        scaled.append(scaled[0])
        d.line(scaled, fill=color, width=w, joint="curve")
        return
    d.line(scaled, fill=color, width=w, joint="curve")
    if caps:
        r = w / 2.0
        for (x, y) in (scaled[0], scaled[-1]):
            d.ellipse([x - r, y - r, x + r, y + r], fill=color)


def draw_home(d, c):
    """首页：房子"""
    stroke_path(d, [(40.5, 16), (61, 33), (61, 65), (20, 65), (20, 33)], c, close=True)
    stroke_path(d, [(34, 65), (34, 53), (47, 53), (47, 65)], c)


def draw_practice(d, c):
    """练习：答题卡 / 剪贴板"""
    d.rounded_rectangle(
        [px(22), px(22), px(59), px(65)], radius=px(6), outline=c, width=int(STROKE * SCALE)
    )
    # 顶部夹子：先填白盖住板子上沿，再描边
    d.rounded_rectangle(
        [px(33), px(15), px(48), px(27)],
        radius=px(3),
        fill=(255, 255, 255, 255),
        outline=c,
        width=int(4.5 * SCALE),
    )
    stroke_path(d, [(30, 42), (51, 42)], c, width=4.5)
    stroke_path(d, [(30, 54), (44, 54)], c, width=4.5)


def draw_wrong(d, c):
    """错题本：摊开的书"""
    stroke_path(d, [(40.5, 23), (20, 27), (20, 61), (40.5, 65)], c, close=True)
    stroke_path(d, [(40.5, 23), (61, 27), (61, 61), (40.5, 65)], c, close=True)
    stroke_path(d, [(40.5, 23), (40.5, 65)], c, width=4.5)


def draw_mine(d, c):
    """我的：头像剪影"""
    r = 9.5
    d.ellipse(
        [px(40.5 - r), px(27 - r), px(40.5 + r), px(27 + r)],
        outline=c,
        width=int(STROKE * SCALE),
    )
    # 肩部：椭圆上半弧
    d.arc(
        [px(17), px(41), px(64), px(79)],
        start=180,
        end=360,
        fill=c,
        width=int(STROKE * SCALE),
    )


GLYPHS = {
    "home": draw_home,
    "practice": draw_practice,
    "wrong": draw_wrong,
    "mine": draw_mine,
}


def render(draw_fn, color):
    canvas = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    draw_fn(d, color)
    return canvas.resize((SIZE, SIZE), Image.LANCZOS)


def main():
    out = os.path.abspath(OUT_DIR)
    os.makedirs(out, exist_ok=True)

    for name, fn in GLYPHS.items():
        for suffix, color in (("", COLOR_NORMAL), ("_on", COLOR_ACTIVE)):
            img = render(fn, color)
            path = os.path.join(out, f"{name}{suffix}.png")
            img.save(path, "PNG", optimize=True)
            print(f"  {os.path.relpath(path, os.path.dirname(out)):34s} {os.path.getsize(path):>5d} B")

    print(f"\n完成，输出目录：{out}")


if __name__ == "__main__":
    main()
