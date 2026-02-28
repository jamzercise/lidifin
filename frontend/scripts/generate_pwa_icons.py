#!/usr/bin/env python3
"""
Generate PWA icons and Lidify branding images from icon-only.png.
"""

import os
from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SOURCE_ICON = os.path.join(SCRIPT_DIR, "..", "assets", "icon-only.png")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "..", "public", "assets", "icons")
IMAGES_DIR = os.path.join(SCRIPT_DIR, "..", "public", "assets", "images")

SIZES = [48, 72, 96, 128, 192, 256, 512]


def main():
    if not os.path.exists(SOURCE_ICON):
        print(f"Error: Source icon not found: {SOURCE_ICON}")
        return 1

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(IMAGES_DIR, exist_ok=True)

    img = Image.open(SOURCE_ICON).convert("RGBA")

    # PWA icons
    for size in SIZES:
        resized = img.resize((size, size), Image.Resampling.LANCZOS)
        output_path = os.path.join(OUTPUT_DIR, f"icon-{size}.png")
        resized.save(output_path, "PNG")
        print(f"✓ Generated icon-{size}.png")

    # Favicon
    favicon_path = os.path.join(IMAGES_DIR, "favicon-192.png")
    img.resize((192, 192), Image.Resampling.LANCZOS).save(favicon_path, "PNG")
    print(f"✓ Generated favicon-192.png")

    # Lidify branding images (used in Sidebar, login, etc.)
    lidify_96 = img.resize((96, 96), Image.Resampling.LANCZOS)
    lidify_96.save(os.path.join(IMAGES_DIR, "LIDIFY.webp"), "WEBP", quality=90)
    print("✓ Generated LIDIFY.webp (96x96)")

    lidify_256 = img.resize((256, 256), Image.Resampling.LANCZOS)
    lidify_256.save(os.path.join(IMAGES_DIR, "LIDIFY-2.webp"), "WEBP", quality=90)
    print("✓ Generated LIDIFY-2.webp (256x256)")

    lidify_256.save(os.path.join(IMAGES_DIR, "lidify_circular.webp"), "WEBP", quality=90)
    print("✓ Generated lidify_circular.webp (256x256)")

    # LIDIFY-black: same icon (already has black circle) - for dark backgrounds
    lidify_96.save(os.path.join(IMAGES_DIR, "LIDIFY-black.webp"), "WEBP", quality=90)
    print("✓ Generated LIDIFY-black.webp (96x96)")

    print("\n[SUCCESS] All icons and branding images generated!")
    return 0


if __name__ == "__main__":
    exit(main())
