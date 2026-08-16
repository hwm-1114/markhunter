# 生成应用图标 assets/icon.png（256x256，蓝青渐变 + 白色 M 字形）
# 仅用 Python 标准库手写 PNG 编码，无第三方依赖
import zlib
import struct
import os

W = H = 256

# M 字形位图（7 列 x 9 行，'#' = 实心）
M_BITMAP = [
    "M.....M",
    "MM...MM",
    "M.M.M.M",
    "M..M..M",
    "M.....M",
    "M.....M",
    "M.....M",
    "M.....M",
    "M.....M",
]

def lerp(a, b, t):
    return int(a + (b - a) * t)

def make_pixels():
    # 每行: filter byte(0) + RGB
    rows = []
    scale = 22
    mw, mh = len(M_BITMAP[0]) * scale, len(M_BITMAP) * scale
    ox, oy = (W - mw) // 2, (H - mh) // 2
    for y in range(H):
        t = y / (H - 1)
        bg = (lerp(59, 20, t), lerp(130, 184, t), lerp(246, 166, t))
        row = bytearray([0])
        for x in range(W):
            # 底部白色横线（markdown 感）
            if 226 <= y <= 234 and 70 <= x <= 186:
                row += b"\xff\xff\xff"
                continue
            # M 字形
            mx, my = x - ox, y - oy
            if 0 <= mx < mw and 0 <= my < mh:
                c = M_BITMAP[my // scale][mx // scale]
                if c == "M":
                    row += b"\xff\xff\xff"
                    continue
            row += bytes(bg)
        rows.append(bytes(row))
    return rows

def chunk(ctype, data):
    c = struct.pack(">I", len(data)) + ctype + data
    return c + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)

def write_png(path, rows):
    ihdr = struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0)
    raw = b"".join(rows)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)
    print("icon written:", path, len(png), "bytes")

if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "icon.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_png(out, make_pixels())
