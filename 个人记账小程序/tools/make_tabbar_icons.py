# -*- coding: utf-8 -*-
"""
【工具】生成 tabBar 图标（6 张 PNG）

为什么用脚本画而不用 AI 生成：tabBar 图标要的是边缘干净、
三张风格统一的几何图形，脚本画出来的每一条线都可控，且随时能改颜色重跑。

官方规格：81x81 像素，png/jpg，单张建议不超过 40KB。
这里用 4 倍超采样（324px）作画再缩小到 81px，边缘平滑不起毛边。

用法：在项目根目录运行
  python tools/make_tabbar_icons.py
输出到 miniprogram/assets/tabbar/
"""
import os
from PIL import Image, ImageDraw

SIZE = 81            # 最终输出尺寸（官方推荐 81x81）
SCALE = 4            # 超采样倍数，画布实际是 324px
CANVAS = SIZE * SCALE
GRAY = (154, 160, 166, 255)    # 未选中：#9AA0A6，与 app.json 的 tabBar.color 一致
GREEN = (7, 193, 96, 255)      # 选中：#07C160，与 tabBar.selectedColor 一致
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'miniprogram', 'assets', 'tabbar')

STROKE = 28                   # 线宽（按 324px 画布计，缩到 81px 后约 7px，粗细适中）


def new_canvas():
    """建一张透明画布"""
    return Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))


def rounded_line(draw, p1, p2, color):
    """两端圆润的直线：先画线，再在两端各补一个实心圆当圆头"""
    draw.line([p1, p2], fill=color, width=STROKE)
    r = STROKE // 2
    for (x, y) in (p1, p2):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=color)


def dot(draw, cx, cy, radius, color):
    """实心圆点"""
    draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=color)


def icon_list(color):
    """「明细」图标：账单列表 —— 三行记录，每行一个圆点 + 一条横线"""
    img = new_canvas()
    d = ImageDraw.Draw(img)
    for cy in (88, 162, 236):
        dot(d, 74, cy, 14, color)                              # 左侧圆点
        rounded_line(d, (114, cy), (250, cy), color)           # 右侧横线
    return img


def icon_stats(color):
    """「统计」图标：柱状图 —— 三根高低不同的圆角柱子"""
    img = new_canvas()
    d = ImageDraw.Draw(img)
    bar_w = 56
    # (柱子中心x, 顶部y, 底部y)：中间最高、左边次之、右边最矮
    for cx, top, bottom in ((86, 150, 248), (162, 96, 248), (238, 192, 248)):
        left = cx - bar_w // 2
        d.rounded_rectangle([left, top, left + bar_w, bottom], radius=bar_w // 2, fill=color)
    return img


def icon_person(color):
    """「我的」图标：人形 —— 空心圆脑袋 + 半圆肩膀（描边风格，与另两张同粗细）"""
    img = new_canvas()
    d = ImageDraw.Draw(img)
    # 脑袋：空心圆，圆心 (162, 112)，半径 40
    d.ellipse([162 - 40, 72, 162 + 40, 152], outline=color, width=STROKE)
    # 肩膀：上半段圆弧（180°→360°），底边平齐，形似"肩膀"
    d.arc([72, 164, 252, 344], start=180, end=360, fill=color, width=STROKE)
    return img


def save(img, name):
    """4 倍画布缩小到 81px，平滑边缘；确认体积不超官方建议"""
    out = img.resize((SIZE, SIZE), Image.LANCZOS)
    path = os.path.join(OUT_DIR, name)
    out.save(path, 'PNG')
    kb = os.path.getsize(path) / 1024.0
    print('%-22s %5.1f KB' % (name, kb))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, fn in (('list', icon_list), ('stats', icon_stats), ('mine', icon_person)):
        save(fn(GRAY), name + '.png')       # 未选中：灰色
        save(fn(GREEN), name + '-on.png')   # 选中：微信绿
    print('完成，输出目录:', os.path.normpath(OUT_DIR))


if __name__ == '__main__':
    main()
