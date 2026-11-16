from PIL import Image, ImageDraw

S = 5
W = H = 36 * S
img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

def rect(x, y, w, h, color):
    d.rectangle([x * S, y * S, (x + w) * S - 1, (y + h) * S - 1], fill=color)

# dirt body
rect(7.5, 13.5, 21, 15, '#8f6a4a')
# grass top
rect(7.5, 7.5, 21, 6, '#5f9e4f')
# grass drips + dirt specks
rect(7.5, 13.5, 3, 3, '#5f9e4f')
rect(19.5, 13.5, 3, 3, '#5f9e4f')
rect(25.5, 13.5, 3, 3, '#6e5038')
rect(7.5, 19.5, 3, 3, '#6e5038')
rect(13.5, 25.5, 3, 3, '#6e5038')
rect(25.5, 22.5, 3, 3, '#6e5038')
rect(10.5, 19.5, 3, 3, '#a9815b')
rect(19.5, 25.5, 3, 3, '#a9815b')

# play triangle: slightly larger than the SVG so the orange reads at 180px
d.polygon([(14.2 * S, 17.2 * S), (23.2 * S, 21.5 * S), (14.2 * S, 25.8 * S)], fill='#f0a24a', outline='#4a3524', width=int(1.3 * S))

# export 180px master and a 512px copy
img.save('assets/icon-180.png', optimize=True)
img.resize((512, 512), Image.Resampling.NEAREST).save('assets/icon-512.png', optimize=True)
print('wrote assets/icon-180.png and assets/icon-512.png')
