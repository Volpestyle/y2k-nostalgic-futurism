from __future__ import annotations

from img2mesh3d.pipeline import to_data_uri_png


def test_data_uri_prefix():
    s = to_data_uri_png(b"abc")
    assert s.startswith("data:image/png;base64,")
