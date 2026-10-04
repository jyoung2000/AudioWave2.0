
from PIL import Image
im = Image.open(r"C:\np-prove\evidence\android-tabs.png").convert("RGB")
w,h=im.size; px=im.load()
# scan the tab-row band for text glyph columns (dark pixels), group into words
y0,y1 = 1120,1190
cols=[]
for x in range(0,w,2):
    d=0
    for y in range(y0,y1):
        r,g,b=px[x,y]
        if not (r>200 and g>200 and b>200): d+=1
    cols.append((x,d))
# group contiguous runs of ink
groups=[];cur=None;gap=0
for x,d in cols:
    if d>0:
        if cur is None: cur=[x,x]
        else: cur[1]=x
        gap=0
    else:
        if cur is not None:
            gap+=1
            if gap>14: groups.append(cur); cur=None
if cur: groups.append(cur)
merged=[]
for g in groups:
    if merged and g[0]-merged[-1][1] < 30: merged[-1][1]=g[1]
    else: merged.append(list(g))
for i,g in enumerate(merged):
    print(i, "x=%d..%d centre=%d width=%d" % (g[0],g[1],(g[0]+g[1])//2,g[1]-g[0]))
