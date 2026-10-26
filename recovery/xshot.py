import sys
from Xlib import X, display
from PIL import Image

d = display.Display()
root = d.screen().root
g = root.get_geometry()
raw = root.get_image(0, 0, g.width, g.height, X.ZPixmap, 0xFFFFFFFF)
img = Image.frombytes("RGB", (g.width, g.height), raw.data, "raw", "BGRX")
img.save(sys.argv[1])
print("saved", sys.argv[1], img.size)
