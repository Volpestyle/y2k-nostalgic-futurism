package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/example/holo-2d3d/api-go/internal/ai"
	"github.com/example/holo-2d3d/api-go/internal/blob"
	"github.com/example/holo-2d3d/api-go/internal/config"
	"github.com/example/holo-2d3d/api-go/internal/httpapi"
	"github.com/example/holo-2d3d/api-go/internal/store"
)

func main() {
	cfg := config.Load()
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		log.Fatalf("mkdir data dir: %v", err)
	}

	dbPath := filepath.Join(cfg.DataDir, "jobs.db")
	jobStore, err := store.Open(dbPath)
	if err != nil {
		log.Fatalf("open job store: %v", err)
	}

	blobStore := blob.LocalFS{Root: cfg.DataDir}

	baseURL := os.Getenv("HOLO_BASE_URL")
	if baseURL == "" {
		addr := cfg.Addr
		if strings.HasPrefix(addr, ":") {
			addr = "localhost" + addr
		}
		baseURL = fmt.Sprintf("http://%s", addr)
	}

	kit, err := ai.NewKitFromEnv()
	if err != nil {
		log.Fatalf("ai-kit config error: %v", err)
	}
	if kit == nil {
		log.Printf("ai-kit disabled (no provider keys configured)")
	}

	server := httpapi.Server{
		Blobs:   blobStore,
		Jobs:    jobStore,
		BaseURL: baseURL,
		AIKit:   kit,
		PipelineModels: httpapi.PipelineModels{
			Cutout: cfg.CutoutModels,
			Depth:  cfg.DepthModels,
		},
	}

	log.Printf("API listening on %s (baseURL=%s)", cfg.Addr, baseURL)
	if err := http.ListenAndServe(cfg.Addr, server.Router()); err != nil {
		log.Fatalf("listen: %v", err)
	}
}
