package config

import (
	"os"
	"path/filepath"
)

type Config struct {
	Addr    string
	DataDir string
}

func Load() Config {
	addr := getenv("HOLO_API_ADDR", ":8080")
	dataDir := getenv("HOLO_DATA_DIR", filepath.Join("..", "..", "local-data"))
	return Config{
		Addr:    addr,
		DataDir: dataDir,
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
