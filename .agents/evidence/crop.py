
from PIL import Image
im = Image.open(r"C:\np-prove\evidence\android-tabs.png").convert("RGB")
# crop the tab row and the area just below it, scale up, and save for reading
crop = im.crop((0, 1100, 1080, 1420)).resize((1080*2, 320*2), Image.LANCZOS)
crop.save(r"C:\np-prove\evidence\android-tabrow.png")
print("saved", crop.size)
