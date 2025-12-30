package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	_ "modernc.org/sqlite"

	"github.com/example/holo-2d3d/api-go/internal/model"
)

type SQLite struct {
	db *sql.DB
}

func Open(path string) (*SQLite, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL DEFAULT 0,
  input_key TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  output_key TEXT,
  error_message TEXT
);
`); err != nil {
		return nil, err
	}
	return &SQLite{db: db}, nil
}

func (s *SQLite) Close() error { return s.db.Close() }

func (s *SQLite) CreateJob(ctx context.Context, job model.Job) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO jobs (id, created_at, updated_at, status, progress, input_key, spec_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
		job.ID,
		job.CreatedAt.UnixMilli(),
		job.UpdatedAt.UnixMilli(),
		string(job.Status),
		job.Progress,
		job.InputKey,
		job.SpecJSON,
	)
	return err
}

func (s *SQLite) GetJob(ctx context.Context, id string) (model.Job, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, created_at, updated_at, status, progress, input_key, spec_json, output_key, error_message
       FROM jobs WHERE id = ?`, id,
	)
	var (
		jid, statusStr, inputKey, specJSON string
		createdMs, updatedMs                 int64
		progress                            float64
		outputKey                           sql.NullString
		errorMsg                            sql.NullString
	)
	if err := row.Scan(&jid, &createdMs, &updatedMs, &statusStr, &progress, &inputKey, &specJSON, &outputKey, &errorMsg); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return model.Job{}, model.ErrNotFound
		}
		return model.Job{}, err
	}
	job := model.Job{
		ID:        jid,
		CreatedAt: time.UnixMilli(createdMs),
		UpdatedAt: time.UnixMilli(updatedMs),
		Status:    model.JobStatus(statusStr),
		Progress:  progress,
		InputKey:  inputKey,
		SpecJSON:  specJSON,
	}
	if outputKey.Valid {
		job.OutputKey = outputKey.String
	}
	if errorMsg.Valid {
		job.Error = errorMsg.String
	}
	return job, nil
}

func (s *SQLite) ListJobs(ctx context.Context, status *model.JobStatus, limit int) ([]model.Job, error) {
	if limit <= 0 {
		limit = 25
	}

	query := `SELECT id, created_at, updated_at, status, progress, input_key, spec_json, output_key, error_message
       FROM jobs`
	args := []any{}
	if status != nil {
		query += " WHERE status = ?"
		args = append(args, string(*status))
	}
	query += " ORDER BY updated_at DESC LIMIT ?"
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []model.Job
	for rows.Next() {
		var (
			jid, statusStr, inputKey, specJSON string
			createdMs, updatedMs                 int64
			progress                            float64
			outputKey                           sql.NullString
			errorMsg                            sql.NullString
		)
		if err := rows.Scan(&jid, &createdMs, &updatedMs, &statusStr, &progress, &inputKey, &specJSON, &outputKey, &errorMsg); err != nil {
			return nil, err
		}
		job := model.Job{
			ID:        jid,
			CreatedAt: time.UnixMilli(createdMs),
			UpdatedAt: time.UnixMilli(updatedMs),
			Status:    model.JobStatus(statusStr),
			Progress:  progress,
			InputKey:  inputKey,
			SpecJSON:  specJSON,
		}
		if outputKey.Valid {
			job.OutputKey = outputKey.String
		}
		if errorMsg.Valid {
			job.Error = errorMsg.String
		}
		out = append(out, job)
	}
	return out, rows.Err()
}

func (s *SQLite) ListQueued(ctx context.Context, limit int) ([]model.Job, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, created_at, updated_at, status, progress, input_key, spec_json, output_key, error_message
       FROM jobs WHERE status = ? ORDER BY created_at ASC LIMIT ?`,
		string(model.JobQueued), limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []model.Job
	for rows.Next() {
		var (
			jid, statusStr, inputKey, specJSON string
			createdMs, updatedMs                 int64
			progress                            float64
			outputKey                           sql.NullString
			errorMsg                            sql.NullString
		)
		if err := rows.Scan(&jid, &createdMs, &updatedMs, &statusStr, &progress, &inputKey, &specJSON, &outputKey, &errorMsg); err != nil {
			return nil, err
		}
		job := model.Job{
			ID:        jid,
			CreatedAt: time.UnixMilli(createdMs),
			UpdatedAt: time.UnixMilli(updatedMs),
			Status:    model.JobStatus(statusStr),
			Progress:  progress,
			InputKey:  inputKey,
			SpecJSON:  specJSON,
		}
		if outputKey.Valid {
			job.OutputKey = outputKey.String
		}
		if errorMsg.Valid {
			job.Error = errorMsg.String
		}
		out = append(out, job)
	}
	return out, rows.Err()
}

func (s *SQLite) UpdateJob(ctx context.Context, id string, patch model.JobPatch) error {
	now := time.Now().UnixMilli()
	_, err := s.db.ExecContext(ctx,
		`UPDATE jobs
         SET updated_at = ?,
             status = COALESCE(?, status),
             progress = COALESCE(?, progress),
             output_key = COALESCE(?, output_key),
             error_message = COALESCE(?, error_message)
         WHERE id = ?`,
		now,
		nullableString(patch.Status),
		nullableFloat64(patch.Progress),
		nullableString(patch.OutputKey),
		nullableString(patch.Error),
		id,
	)
	return err
}

func nullableString(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}

func nullableFloat64(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}
