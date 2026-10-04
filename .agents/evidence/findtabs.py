
from PIL import Image
im = Image.open(r"C:\np-prove\evidence\android-tabs.png").convert("RGB")
w,h = im.size
px = im.load()
# The selected tab is drawn as a filled pill. Find rows with a run of non-white, non-background pixels
# in the mid-lower part of the screen, grouped into contiguous bands.
rows=[]
for y in range(int(h*0.30), int(h*0.75)):
    dark=0
    for x in range(0,w,6):
        r,g,b = px[x,y]
        if not (r>235 and g>235 and b>235):
            dark+=1
    rows.append((y,dark))
# report bands where dark count jumps
band=[]
prev=0
for y,d in rows:
    if d>12 and prev<=12: band.append([y,y,d])
    elif d>12: band[-1][1]=y; band[-1][2]=max(band[-1][2],d)
    prev=d
for b in band[:25]:
    print("band y=%d..%d (centre %d) density=%d" % (b[0],b[1],(b[0]+b[1])//2,b[2]))
