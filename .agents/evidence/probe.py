
import subprocess
from PIL import Image
import io, os

def shot(path):
    data = subprocess.run(["adb","exec-out","screencap","-p"], capture_output=True).stdout
    open(path,"wb").write(data)
    return Image.open(io.BytesIO(data)).convert("RGB")

def tabrow_y(im):
    """The selected tab is a filled pill: find the horizontal band with the most mid-grey fill."""
    w,h=im.size; px=im.load()
    best=(0,None)
    for y in range(int(h*0.35), int(h*0.62)):
        grey=0
        for x in range(0,w,4):
            r,g,b=px[x,y]
            if 215<r<245 and 215<g<245 and 215<b<245: grey+=1
        if grey>best[0]: best=(grey,y)
    return best[1], best[0]

im = shot(r"C:\np-prove\evidence\android-probe.png")
y,d = tabrow_y(im)
print("tab row y =", y, "pill density =", d)
