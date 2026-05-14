#!/usr/bin/env python3
"""Crop and rename iPhone photos of GH2e item cards.

First batch (all items at once):
  1. AirDrop all photos to INPUT_DIR in CSV order
  2. uv run prepare-items.py
  3. git add items/ && git commit && git push

Adding new items later (e.g. you unlocked items 98 and 99):
  1. AirDrop the 2 new photos to INPUT_DIR
  2. uv run prepare-items.py --items 98,99
  3. git add items/ && git commit && git push

Other flags:
  --from 88        jump to item NUMBER 88 in the CSV (skips earlier items)
  --overwrite      re-process items that already have an output file

Controls (per image):
  Drag        — draw crop selection (shown in red)
  Enter       — save with current selection (must have drawn one)
  Esc         — clear current selection
  q / Cmd-W   — stop here
"""

import csv
import sys
from pathlib import Path

import pillow_heif
from PIL import Image, ImageOps

pillow_heif.register_heif_opener()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
INPUT_DIR = Path(__file__).parent / "items-raw"
OUTPUT_DIR = Path(__file__).parent / "items"
CSV_FILE   = Path(__file__).parent / "gh2e-items.csv"

JPEG_QUALITY = 85
IMG_EXTS = {".jpg", ".jpeg", ".heic", ".png"}


def load_csv():
    with open(CSV_FILE, newline="") as f:
        return list(csv.DictReader(f))


def get_photos():
    return sorted(p for p in INPUT_DIR.iterdir() if p.suffix.lower() in IMG_EXTS)


def open_rgb(path):
    img = ImageOps.exif_transpose(Image.open(path))
    return img.convert("RGB") if img.mode != "RGB" else img


def run_interactive(items, photos, start_from=0):
    import pygame

    pygame.init()
    pygame.display.set_caption("prepare-items")
    font = pygame.font.SysFont("monospace", 14)

    info = pygame.display.Info()
    max_w = int(info.current_w * 0.9)
    max_h = int(info.current_h * 0.85)
    STATUS_H = 36

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    photo_idx = 0
    for i, item in enumerate(items):
        if i < start_from:
            continue
        if photo_idx >= len(photos):
            print(f"  MISSING photo: {item['name']}")
            continue

        photo = photos[photo_idx]
        photo_idx += 1
        img = open_rgb(photo)

        rotation  = 0          # clockwise 90° steps
        cur_img   = img        # rotated working image
        drag_start = drag_end = box = None
        quit_all  = False

        def apply_rotation():
            nonlocal cur_img, scale, dw, dh, surf, screen, drag_start, drag_end, box
            cur_img = img.rotate(-90 * rotation, expand=True)
            scale = min(max_w / cur_img.width, max_h / cur_img.height, 1.0)
            dw, dh = int(cur_img.width * scale), int(cur_img.height * scale)
            disp = cur_img.resize((dw, dh), Image.LANCZOS)
            surf = pygame.image.fromstring(disp.tobytes(), disp.size, "RGB")
            screen = pygame.display.set_mode((dw, dh + STATUS_H))
            pygame.display.set_caption(f"[{i + 1}/{len(items)}] {item['name']}")
            drag_start = drag_end = box = None

        scale = dw = dh = 1  # initialised by apply_rotation
        surf = screen = None
        apply_rotation()

        def draw(status_text):
            screen.fill((0, 0, 0))
            screen.blit(surf, (0, 0))
            if drag_start and drag_end:
                x1, y1 = drag_start
                x2, y2 = drag_end
                sel = pygame.Rect(min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1))
                pygame.draw.rect(screen, (255, 60, 60), sel, 2)
            if box:
                bl, bt, br, bb = [int(v * scale) for v in box]
                pygame.draw.rect(screen, (255, 60, 60), pygame.Rect(bl, bt, br - bl, bb - bt), 2)
            pygame.draw.rect(screen, (17, 17, 17), pygame.Rect(0, dh, dw, STATUS_H))
            screen.blit(font.render(status_text, True, (220, 220, 220)), (8, dh + 10))
            pygame.display.flip()

        hint = f"[{i+1}/{len(items)}] {item['name']}  |  drag=crop  Enter=save  r=rotate  Esc=clear  q=quit"
        running = True
        while running:
            draw(f"Selected {box}  |  Enter=save  r=rotate  Esc=clear  q=quit" if box else hint)
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    quit_all = running = False
                elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                    drag_start = event.pos
                    drag_end = box = None
                elif event.type == pygame.MOUSEMOTION and drag_start and event.buttons[0]:
                    drag_end = (event.pos[0], min(event.pos[1], dh))
                elif event.type == pygame.MOUSEBUTTONUP and event.button == 1 and drag_start:
                    drag_end = (event.pos[0], min(event.pos[1], dh))
                    x1, y1 = drag_start
                    x2, y2 = drag_end
                    l, t = int(min(x1, x2) / scale), int(min(y1, y2) / scale)
                    r, b = int(max(x1, x2) / scale), int(max(y1, y2) / scale)
                    if r > l and b > t:
                        box = (l, t, r, b)
                elif event.type == pygame.KEYDOWN:
                    if event.key == pygame.K_RETURN:
                        if box:
                            running = False
                    elif event.key == pygame.K_r:
                        rotation = (rotation + 1) % 4
                        apply_rotation()
                    elif event.key == pygame.K_ESCAPE:
                        box = drag_start = drag_end = None
                    elif event.key == pygame.K_q:
                        quit_all = running = False

        if quit_all:
            print(f"Stopped at item {i + 1}.")
            break

        out_path = OUTPUT_DIR / item["filename"]
        cur_img.crop(box).save(out_path, "JPEG", quality=JPEG_QUALITY)
        print(f"[{i + 1:>2}/{len(items)}] {photo.name} → {item['filename']}  {box}  rot={rotation*90}°")

    pygame.quit()


def main():
    all_items = load_csv()
    photos    = get_photos()
    args      = sys.argv[1:]
    overwrite = "--overwrite" in args

    # --items 98,99  → process only those item numbers, photos matched in order
    if "--items" in args:
        numbers = {int(n) for n in args[args.index("--items") + 1].split(",")}
        items = [it for it in all_items if int(it["number"]) in numbers]
        if not items:
            sys.exit(f"No CSV rows found for item numbers: {numbers}")
        if not overwrite:
            before = len(items)
            items = [it for it in items if not (OUTPUT_DIR / it["filename"]).exists()]
            if before - len(items):
                print(f"Skipping {before - len(items)} already-done item(s) (--overwrite to redo).")
        print(f"Processing {len(items)} item(s): {', '.join(it['name'] for it in items)}")
        start_from = 0
    # --from 88  → start from item NUMBER 88 in the CSV (skips earlier items)
    elif "--from" in args:
        target = int(args[args.index("--from") + 1])
        matches = [idx for idx, it in enumerate(all_items) if int(it["number"]) == target]
        if not matches:
            sys.exit(f"Item number {target} not found in CSV")
        start_from = matches[0]
        items = all_items
    else:
        # Default: auto-skip items that already have output files so you can just
        # drop remaining photos in INPUT_DIR and re-run without any flags.
        items = all_items
        if not overwrite:
            before = len(items)
            items = [it for it in items if not (OUTPUT_DIR / it["filename"]).exists()]
            done = before - len(items)
            if done:
                print(f"{done} already done, processing {len(items)} remaining.")
        start_from = 0

    print(f"Found {len(photos)} photo(s) in {INPUT_DIR}")

    if not photos:
        sys.exit("AirDrop your card photos to INPUT_DIR first.")

    if not items:
        print("Nothing to do.")
        return

    if len(photos) != len(items):
        print(f"WARNING: {len(photos)} photos vs {len(items)} items to process")
        if input("Continue anyway? [y/N] ").strip().lower() != "y":
            return

    run_interactive(items, photos, start_from)
    print("Done.")


if __name__ == "__main__":
    main()
