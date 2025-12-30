from img2mesh3d.artifacts import to_data_uri


def test_to_data_uri_png():
    b = b"\x89PNG\r\n\x1a\n"
    uri = to_data_uri(b, "image/png")
    assert uri.startswith("data:image/png;base64,")
