"""不等号小程序头像 — 设计稿脚本。

运行：python3 docs/brand/_drafts.py
输出：docs/brand/avatar-{a,b,c,d,e,f,g}.png  @ 1024x1024 RGBA
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
CX, CY = SIZE // 2, SIZE // 2
CORNER_R = 200  # 预览圆角；微信会自动按圆形裁剪

OUT_DIR = Path(__file__).resolve().parent


# --- 渐变与几何 ---------------------------------------------------------

def gradient_bg(size: int, c1: tuple, c2: tuple, angle_deg: float = 135) -> Image.Image:
    """对角线渐变（c1 -> c2 沿 angle_deg 方向）。"""
    rad = math.radians(angle_deg)
    dx, dy = math.cos(rad), math.sin(rad)
    diag = abs(dx) + abs(dy)
    inv_diag = 1.0 / (size * diag)
    r1, g1, b1 = c1
    r2, g2, b2 = c2
    buf = bytearray(size * size * 3)
    for y in range(size):
        row_off = y * size * 3
        for x in range(size):
            t = (x * dx + y * dy) * inv_diag
            if t < 0.0:
                t = 0.0
            elif t > 1.0:
                t = 1.0
            inv = 1.0 - t
            off = row_off + x * 3
            buf[off]     = int(r1 * inv + r2 * t)
            buf[off + 1] = int(g1 * inv + g2 * t)
            buf[off + 2] = int(b1 * inv + b2 * t)
    return Image.frombytes("RGB", (size, size), bytes(buf))


def rotated_rect(cx: float, cy: float, w: float, h: float, angle_deg: float) -> list[tuple[float, float]]:
    """返回旋转矩形的四个顶点（围绕中心旋转）。"""
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    hw, hh = w / 2, h / 2
    pts = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
    return [(p[0] * ca - p[1] * sa + cx, p[0] * sa + p[1] * ca + cy) for p in pts]


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def apply_rounded(img: Image.Image, radius: int) -> Image.Image:
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img.convert("RGBA"), (0, 0), rounded_mask(img.size[0], radius))
    return out


def draw_not_equal(draw: ImageDraw.ImageDraw, cx: float, cy: float,
                   length: float, thickness: float, color: tuple,
                   gap: float, angle_deg: float) -> None:
    """画 ≠：上斜线 \\ 与下斜线 /，对称倾斜。"""
    upper = rotated_rect(cx, cy - gap, length, thickness, angle_deg)
    lower = rotated_rect(cx, cy + gap, length, thickness, -angle_deg)
    draw.polygon(upper, fill=color)
    draw.polygon(lower, fill=color)


def draw_heart(draw: ImageDraw.ImageDraw, cx: float, cy: float, size: float, color: tuple) -> None:
    """简化实心爱心：两个圆 + 倒三角。"""
    r = size / 2
    draw.ellipse((cx - r, cy - r * 0.7, cx, cy + r * 0.5), fill=color)
    draw.ellipse((cx, cy - r * 0.7, cx + r, cy + r * 0.5), fill=color)
    draw.polygon([
        (cx - r * 0.95, cy + r * 0.15),
        (cx + r * 0.95, cy + r * 0.15),
        (cx, cy + r * 1.15),
    ], fill=color)


# --- 七个设计方向 -----------------------------------------------------------

def design_a_warm() -> Image.Image:
    """A. 温暖拥抱 — 桃粉 → 珊瑚橙 + 奶白 ≠。"""
    bg = gradient_bg(SIZE, (255, 196, 163), (255, 122, 107), 135)
    draw = ImageDraw.Draw(bg)
    draw_not_equal(draw, CX, CY, length=580, thickness=104, color=(255, 255, 255), gap=120, angle_deg=22)
    return apply_rounded(bg, CORNER_R)


def design_b_cool() -> Image.Image:
    """B. 理性绿洲 — 薄荷绿 → 蓝绿 + 深绿 ≠。"""
    bg = gradient_bg(SIZE, (168, 230, 207), (94, 178, 158), 135)
    draw = ImageDraw.Draw(bg)
    draw_not_equal(draw, CX, CY, length=580, thickness=104, color=(26, 67, 56), gap=120, angle_deg=18)
    return apply_rounded(bg, CORNER_R)


def design_c_cute() -> Image.Image:
    """C. 童趣奶昔 — 柔粉 → 桃粉 + 玫红 ≠ + 暖黄小心。"""
    bg = gradient_bg(SIZE, (255, 211, 224), (255, 175, 197), 135)
    draw = ImageDraw.Draw(bg)
    draw_not_equal(draw, CX, CY, length=560, thickness=112, color=(233, 75, 111), gap=130, angle_deg=25)
    draw_heart(draw, cx=750, cy=300, size=110, color=(255, 214, 107))
    return apply_rounded(bg, 220)


def design_d_peach() -> Image.Image:
    """D. 蜜桃气泡 — 蜜桃黄 → 珊瑚橙 + 深玫红 ≠，明亮活泼。"""
    bg = gradient_bg(SIZE, (255, 212, 90), (255, 127, 92), 135)
    draw = ImageDraw.Draw(bg)
    draw_not_equal(draw, CX, CY, length=580, thickness=104, color=(214, 58, 95), gap=120, angle_deg=22)
    return apply_rounded(bg, CORNER_R)


def design_e_forest() -> Image.Image:
    """E. 森系初夏 — 嫩黄绿 → 草绿 + 深森林绿 ≠，清新自然。"""
    bg = gradient_bg(SIZE, (212, 225, 87), (124, 179, 66), 135)
    draw = ImageDraw.Draw(bg)
    draw_not_equal(draw, CX, CY, length=580, thickness=104, color=(45, 74, 43), gap=120, angle_deg=18)
    return apply_rounded(bg, CORNER_R)


def design_f_rose() -> Image.Image:
    """F. 晨曦玫粉 — 玫红 → 浅桃粉 + 暖白 ≠ + 小心，更鲜艳可爱。"""
    bg = gradient_bg(SIZE, (255, 92, 138), (255, 181, 197), 135)
    draw = ImageDraw.Draw(bg)
    draw_not_equal(draw, CX, CY, length=560, thickness=112, color=(255, 248, 241), gap=130, angle_deg=25)
    draw_heart(draw, cx=760, cy=290, size=110, color=(255, 240, 200))
    return apply_rounded(bg, 220)


def design_g_minimal() -> Image.Image:
    """G. 极简奶白 — 纯白底 + 深玫红 ≠，极简专业。"""
    bg = Image.new("RGB", (SIZE, SIZE), (255, 255, 255))
    draw = ImageDraw.Draw(bg)
    draw_not_equal(draw, CX, CY, length=580, thickness=104, color=(214, 58, 95), gap=120, angle_deg=20)
    return apply_rounded(bg, CORNER_R)


def main() -> None:
    designs = {
        "a-warm": design_a_warm,
        "b-cool": design_b_cool,
        "c-cute": design_c_cute,
        "d-peach": design_d_peach,
        "e-forest": design_e_forest,
        "f-rose": design_f_rose,
        "g-minimal": design_g_minimal,
    }
    for name, fn in designs.items():
        out = OUT_DIR / f"avatar-{name}.png"
        img = fn()
        img.save(out, "PNG", optimize=True)
        print(f"saved {out}  {img.size}")


if __name__ == "__main__":
    main()
