from pathlib import Path

from PIL import Image

from img2mesh3d.utils.images import GridSpec, pad_to_square, resize_max, split_grid


def test_pad_to_square():
    im = Image.new("RGBA", (100, 50), (255, 0, 0, 255))
    sq = pad_to_square(im)
    assert sq.size == (100, 100)


def test_resize_max():
    im = Image.new("RGBA", (200, 200), (0, 255, 0, 255))
    out = resize_max(im, 128)
    assert out.size == (128, 128)


def test_split_grid():
    im = Image.new("RGBA", (300, 200), (0, 0, 0, 0))
    tiles = split_grid(im, spec=GridSpec(rows=2, cols=3))
    assert len(tiles) == 6
    assert all(t.size == (100, 100) for t in tiles)
