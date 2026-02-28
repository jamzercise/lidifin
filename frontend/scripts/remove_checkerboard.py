#!/usr/bin/env python3
"""
Remove checkerboard background from icon and make it transparent.
Checkerboard is typically white + light gray - we replace those with alpha.
"""

import os
import sys
from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCE_ICON = os.path.join(SCRIPT_DIR, "..", "assets", "icon-only.png")


def is_checkerboard_color(r, g, b, tolerance=15):
    """Check if pixel is checkerboard (white or light gray)."""
    # White: rgb(255, 255, 255)
    is_white = (
        abs(r - 255) <= tolerance and abs(g - 255) <= tolerance and abs(b - 255) <= tolerance
    )
    # Light gray checkerboard: rgb(192,192,192) or similar
    is_gray = r == g == b and 170 <= r <= 240
    return is_white or is_gray


def main():
    if not os.path.exists(SOURCE_ICON):
        print(f"Error: Source icon not found: {SOURCE_ICON}", file=sys.stderr)
        sys.exit(1)

    img = Image.open(SOURCE_ICON).convert("RGBA")
    pixels = img.load()
    width, height = img.size

    replaced = 0
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if is_checkerboard_color(r, g, b):
                pixels[x, y] = (r, g, b, 0)
                replaced += 1

    img.save(SOURCE_ICON)
    print(f"✓ Removed checkerboard ({replaced} pixels made transparent)")
    print(f"✓ Saved: {SOURCE_ICON}")


if __name__ == "__main__":
    main()
