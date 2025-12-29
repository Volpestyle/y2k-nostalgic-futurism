package blob

import (
	"io"
	"os"
	"path/filepath"
)

type LocalFS struct {
	Root string
}

func (l LocalFS) Put(relPath string, r io.Reader) (string, error) {
	clean := filepath.Clean(relPath)
	abs := filepath.Join(l.Root, clean)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return "", err
	}
	f, err := os.Create(abs)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := io.Copy(f, r); err != nil {
		return "", err
	}
	return clean, nil
}

func (l LocalFS) Open(relPath string) (*os.File, error) {
	clean := filepath.Clean(relPath)
	abs := filepath.Join(l.Root, clean)
	return os.Open(abs)
}

func (l LocalFS) Exists(relPath string) bool {
	clean := filepath.Clean(relPath)
	abs := filepath.Join(l.Root, clean)
	_, err := os.Stat(abs)
	return err == nil
}
