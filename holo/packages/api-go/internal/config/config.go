package config

import (
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Addr         string
	DataDir      string
	CutoutModels []string
	DepthModels  []string
}

func Load() Config {
	addr := getenv("HOLO_API_ADDR", ":8080")
	dataDir := getenv("HOLO_DATA_DIR", filepath.Join("..", "..", "local-data"))
	cutoutModels := getenvCSV("HOLO_CUTOUT_MODELS", []string{"rmbg-1.4"})
	depthModels := getenvCSV("HOLO_DEPTH_MODELS", []string{"depth-anything-v2-small"})
	return Config{
		Addr:         addr,
		DataDir:      dataDir,
		CutoutModels: cutoutModels,
		DepthModels:  depthModels,
	}
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getenvCSV(key string, fallback []string) []string {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	values := splitCSV(raw)
	if len(values) == 0 {
		return fallback
	}
	return values
}

func splitCSV(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed == "" {
			continue
		}
		out = append(out, trimmed)
	}
	return out
}
