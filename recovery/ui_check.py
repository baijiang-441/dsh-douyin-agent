import sys
from Xlib import X, display
from PIL import Image

# 检测 Edge「Restore pages」气泡：其标题带区域（屏幕右上白面板顶部）在有气泡时近纯白。
d = display.Display()
root = d.screen().root
g = root.get_geometry()
raw = root.get_image(0, 0, g.width, g.height, X.ZPixmap, 0xFFFFFFFF)
img = Image.frombytes("RGB", (g.width, g.height), raw.data, "raw", "BGRX")
band = img.crop((665, 100, 990, 145)).convert("L")
px = list(band.getdata())
mean = sum(px) / len(px)
print(f"ui_check: title band mean={mean:.1f}")
sys.exit(0 if mean > 215 else 1)
