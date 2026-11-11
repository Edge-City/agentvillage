# Agent Village explainer film

A 47 second vertical (1080x1920, 30 fps) animated explainer, drawn entirely in code.

- `film.js`: the animation. `film.draw(frame)` paints one deterministic frame on a canvas.
- `index.html`: live preview. Open it in a browser; add `?t=12.5` to hold one moment.
- `render.mjs`: writes JPEG frames with headless Chromium (needs Playwright).
- `score.py`: synthesizes the ambient score (needs numpy).

## Render

```bash
node render.mjs frames
python3 score.py score.wav
ffmpeg -framerate 30 -i frames/f%05d.jpg -i score.wav -c:v libx264 -preset slow -crf 21 -maxrate 7M -bufsize 14M -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart -shortest agent-village-explainer.mp4
```

The rendered mp4 is kept out of the repo because every resident's agent clones it.
