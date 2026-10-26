import math, random, sys, time
from Xlib import X, display
from Xlib.ext import xtest

tx, ty = int(sys.argv[1]), int(sys.argv[2])
hover = float(sys.argv[3]) if len(sys.argv) > 3 else 0.4
d = display.Display()
root = d.screen().root

def move(x, y):
    xtest.fake_input(d, X.MotionNotify, x=int(x), y=int(y))
    d.sync()

sx, sy = 300, 400
steps = 42
cx, cy = (sx + tx) / 2 + random.randint(-60, 60), (sy + ty) / 2 + random.randint(-40, 40)
for i in range(1, steps + 1):
    t = i / steps
    ease = 1 - (1 - t) ** 3
    x = (1 - ease) ** 2 * sx + 2 * (1 - ease) * ease * cx + ease ** 2 * tx
    y = (1 - ease) ** 2 * sy + 2 * (1 - ease) * ease * cy + ease ** 2 * ty
    move(x, y)
    time.sleep(0.012 + random.random() * 0.012)
move(tx, ty)
time.sleep(hover)
xtest.fake_input(d, X.ButtonPress, 1); d.sync()
time.sleep(0.09 + random.random() * 0.05)
xtest.fake_input(d, X.ButtonRelease, 1); d.sync()
print("clicked", tx, ty)
time.sleep(1.0)
