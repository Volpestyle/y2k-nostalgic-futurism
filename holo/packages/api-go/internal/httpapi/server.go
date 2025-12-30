package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	aikit "github.com/Volpestyle/ai-kit/packages/go"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"

	"github.com/example/holo-2d3d/api-go/internal/blob"
	"github.com/example/holo-2d3d/api-go/internal/model"
	"github.com/example/holo-2d3d/api-go/internal/store"
)

type Server struct {
	Blobs   blob.LocalFS
	Jobs    *store.SQLite
	BaseURL string // optional, for generating absolute result URLs
	AIKit   *aikit.Kit
}

func (s Server) Router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(cors)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	r.Route("/v1", func(r chi.Router) {
		r.Post("/jobs", s.handleCreateJob)
		r.Get("/jobs", s.handleListJobs)
		r.Get("/jobs/{id}", s.handleGetJob)
		r.Get("/jobs/{id}/result", s.handleGetResult)
		r.Get("/jobs/{id}/result/*", s.handleGetResultFile)
		r.Get("/jobs/{id}/artifacts/*", s.handleGetArtifact)
		r.Route("/ai", func(r chi.Router) {
			r.Get("/provider-models", s.handleProviderModels)
			r.Post("/generate", s.handleGenerate)
			r.Post("/generate/stream", s.handleGenerateStream)
			r.Post("/image", s.handleImage)
			r.Post("/mesh", s.handleMesh)
		})
	})

	return r
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s Server) handleCreateJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := r.ParseMultipartForm(50 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("parse multipart: %w", err))
		return
	}
	file, header, err := r.FormFile("image")
	if err != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("missing 'image' file: %w", err))
		return
	}
	defer file.Close()

	id := uuid.NewString()
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext == "" {
		ext = ".png"
	}
	inputKey := filepath.Join("jobs", id, "input"+ext)
	if _, err := s.Blobs.Put(inputKey, file); err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("store input: %w", err))
		return
	}

	specJSON := `{"version":"0.1.0","views":{"count":12,"seed":42},"mesh":{"targetTris":2000}}`
	if raw := r.FormValue("bakeSpec"); raw != "" {
		var tmp any
		if err := json.Unmarshal([]byte(raw), &tmp); err != nil {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid bakeSpec JSON: %w", err))
			return
		}
		canon, _ := json.Marshal(tmp)
		specJSON = string(canon)
	}

	now := time.Now().UTC()
	job := model.Job{
		ID:        id,
		CreatedAt: now,
		UpdatedAt: now,
		Status:    model.JobQueued,
		Progress:  0,
		InputKey:  inputKey,
		SpecJSON:  specJSON,
	}
	if err := s.Jobs.CreateJob(ctx, job); err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("create job: %w", err))
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{"jobId": id})
}

func (s Server) handleGetJob(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	job, err := s.Jobs.GetJob(ctx, id)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}

	writeJSON(w, http.StatusOK, jobResponse(job, s.BaseURL))
}

func (s Server) handleListJobs(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var status *model.JobStatus
	if raw := strings.TrimSpace(r.URL.Query().Get("status")); raw != "" {
		parsed := model.JobStatus(raw)
		switch parsed {
		case model.JobQueued, model.JobRunning, model.JobDone, model.JobError:
			status = &parsed
		default:
			writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid status: %s", raw))
			return
		}
	}

	limit := 25
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value <= 0 {
			writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid limit: %s", raw))
			return
		}
		if value > 100 {
			value = 100
		}
		limit = value
	}

	jobs, err := s.Jobs.ListJobs(ctx, status, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}

	resp := make([]map[string]any, 0, len(jobs))
	for _, job := range jobs {
		resp = append(resp, jobResponse(job, s.BaseURL))
	}

	writeJSON(w, http.StatusOK, resp)
}

func (s Server) handleGetResult(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	job, err := s.Jobs.GetJob(ctx, id)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	if job.OutputKey == "" || !s.Blobs.Exists(job.OutputKey) {
		writeErr(w, http.StatusNotFound, fmt.Errorf("result not ready"))
		return
	}
	f, err := s.Blobs.Open(job.OutputKey)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	defer f.Close()

	ext := strings.ToLower(filepath.Ext(job.OutputKey))
	contentType := "application/octet-stream"
	switch ext {
	case ".glb":
		contentType = "model/gltf-binary"
	case ".gltf":
		contentType = "model/gltf+json"
	}
	w.Header().Set("Content-Type", contentType)
	_, _ = io.Copy(w, f)
}

func (s Server) handleGetResultFile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	id := chi.URLParam(r, "id")
	raw := strings.TrimPrefix(chi.URLParam(r, "*"), "/")

	job, err := s.Jobs.GetJob(ctx, id)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	if job.OutputKey == "" || !s.Blobs.Exists(job.OutputKey) {
		writeErr(w, http.StatusNotFound, fmt.Errorf("result not ready"))
		return
	}

	if raw == "" || raw == "." {
		base := filepath.Base(job.OutputKey)
		http.Redirect(w, r, fmt.Sprintf("/v1/jobs/%s/result/%s", id, base), http.StatusFound)
		return
	}

	clean := filepath.Clean(raw)
	if clean == "." || strings.HasPrefix(clean, "..") || strings.Contains(clean, string(filepath.Separator)+"..") {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid result path"))
		return
	}
	if inputBase := filepath.Base(job.InputKey); inputBase != "" && clean == inputBase {
		writeErr(w, http.StatusNotFound, fmt.Errorf("result not found"))
		return
	}

	resultDir := filepath.Dir(job.OutputKey)
	relPath := filepath.Join(resultDir, clean)
	if !s.Blobs.Exists(relPath) {
		writeErr(w, http.StatusNotFound, fmt.Errorf("result not found"))
		return
	}
	f, err := s.Blobs.Open(relPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	defer f.Close()

	buf := make([]byte, 512)
	n, _ := f.Read(buf)
	contentType := http.DetectContentType(buf[:n])
	if ext := filepath.Ext(clean); ext != "" {
		if mimeType := mime.TypeByExtension(ext); mimeType != "" {
			if contentType == "application/octet-stream" || strings.HasPrefix(contentType, "text/plain") {
				contentType = mimeType
			}
		}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.Copy(w, f)
}

func (s Server) handleGetArtifact(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	raw := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if raw == "" || raw == "." {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("missing artifact path"))
		return
	}
	clean := filepath.Clean(raw)
	if clean == "." || strings.HasPrefix(clean, "..") || strings.Contains(clean, string(filepath.Separator)+"..") {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("invalid artifact path"))
		return
	}

	relPath := filepath.Join("jobs", id, "work", clean)
	if !s.Blobs.Exists(relPath) {
		writeErr(w, http.StatusNotFound, fmt.Errorf("artifact not found"))
		return
	}
	f, err := s.Blobs.Open(relPath)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	defer f.Close()

	buf := make([]byte, 512)
	n, _ := f.Read(buf)
	contentType := http.DetectContentType(buf[:n])
	if ext := filepath.Ext(clean); ext != "" {
		if mimeType := mime.TypeByExtension(ext); mimeType != "" {
			if contentType == "application/octet-stream" || strings.HasPrefix(contentType, "text/plain") {
				contentType = mimeType
			}
		}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.Copy(w, f)
}

func (s Server) handleProviderModels(w http.ResponseWriter, r *http.Request) {
	if s.AIKit == nil {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("ai-kit is not configured"))
		return
	}
	aikit.ModelsHandler(s.AIKit, nil)(w, r)
}

func (s Server) handleGenerate(w http.ResponseWriter, r *http.Request) {
	if s.AIKit == nil {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("ai-kit is not configured"))
		return
	}
	aikit.GenerateHandler(s.AIKit)(w, r)
}

func (s Server) handleGenerateStream(w http.ResponseWriter, r *http.Request) {
	if s.AIKit == nil {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("ai-kit is not configured"))
		return
	}
	aikit.GenerateSSEHandler(s.AIKit)(w, r)
}

func (s Server) handleImage(w http.ResponseWriter, r *http.Request) {
	if s.AIKit == nil {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("ai-kit is not configured"))
		return
	}
	aikit.ImageHandler(s.AIKit)(w, r)
}

func (s Server) handleMesh(w http.ResponseWriter, r *http.Request) {
	if s.AIKit == nil {
		writeErr(w, http.StatusServiceUnavailable, fmt.Errorf("ai-kit is not configured"))
		return
	}
	aikit.MeshHandler(s.AIKit)(w, r)
}

func jobResponse(job model.Job, baseURL string) map[string]any {
	resp := map[string]any{
		"id":        job.ID,
		"createdAt": job.CreatedAt,
		"updatedAt": job.UpdatedAt,
		"status":    job.Status,
		"progress":  job.Progress,
		"inputKey":  job.InputKey,
		"outputKey": job.OutputKey,
		"error":     job.Error,
		"specJson":  job.SpecJSON,
	}
	if job.OutputKey != "" {
		base := strings.TrimRight(baseURL, "/")
		filename := filepath.Base(job.OutputKey)
		resp["resultUrl"] = fmt.Sprintf("%s/v1/jobs/%s/result/%s", base, job.ID, filename)
	}
	return resp
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]any{"error": err.Error()})
}
