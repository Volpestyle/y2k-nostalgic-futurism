from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import List, Sequence, Tuple, Union

from PIL import Image


def open_image(path: Union[str, Path]) -> Image.Image:
    return Image.open(str(path))


def ensure_rgba(im: Image.Image) -> Image.Image:
    if im.mode != "RGBA":
        return im.convert("RGBA")
    return im


def pad_to_square(im: Image.Image, *, background=(0, 0, 0, 0)) -> Image.Image:
    """Pad an image to square, centered."""
    im = ensure_rgba(im)
    w, h = im.size
    if w == h:
        return im
    size = max(w, h)
    canvas = Image.new("RGBA", (size, size), background)
    x = (size - w) // 2
    y = (size - h) // 2
    canvas.paste(im, (x, y))
    return canvas


def resize_max(im: Image.Image, size: int) -> Image.Image:
    """Resize so the image becomes exactly (size, size)."""
    if im.size == (size, size):
        return im
    return im.resize((size, size), Image.Resampling.LANCZOS)


def flatten_alpha(im: Image.Image, *, background=(255, 255, 255)) -> Image.Image:
    """Flatten RGBA onto a solid background, returning RGB."""
    im = ensure_rgba(im)
    bg = Image.new("RGB", im.size, background)
    bg.paste(im, mask=im.split()[-1])
    return bg


@dataclass(frozen=True)
class GridSpec:
    rows: int
    cols: int


def split_grid(im: Image.Image, *, spec: GridSpec) -> List[Image.Image]:
    """Split a single grid image into multiple tiles."""
    w, h = im.size
    tile_w = w // spec.cols
    tile_h = h // spec.rows
    out: List[Image.Image] = []
    for r in range(spec.rows):
        for c in range(spec.cols):
            left = c * tile_w
            upper = r * tile_h
            right = left + tile_w
            lower = upper + tile_h
            out.append(im.crop((left, upper, right, lower)))
    return out


def select_indices(items: Sequence, indices: Sequence[int]):
    out = []
    for i in indices:
        if i < 0 or i >= len(items):
            raise IndexError(f"Index {i} out of range for list of length {len(items)}")
        out.append(items[i])
    return out
