package model

import (
	"errors"
	"time"
)

type JobStatus string

const (
	JobQueued  JobStatus = "queued"
	JobRunning JobStatus = "running"
	JobDone    JobStatus = "done"
	JobError   JobStatus = "error"
)

var ErrNotFound = errors.New("not found")

// Job represents a bake job record in the job store.
//
// - InputKey/OutputKey are relative keys in the blob store.
// - SpecJSON holds the BakeSpec JSON string (shared contract from packages/shared-spec).
type Job struct {
	ID        string    `json:"id"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Status    JobStatus `json:"status"`
	Progress  float64   `json:"progress"`
	InputKey  string    `json:"inputKey"`
	SpecJSON  string    `json:"specJson"`
	OutputKey string    `json:"outputKey,omitempty"`
	Error     string    `json:"error,omitempty"`
}

// JobPatch is used for partial updates.
type JobPatch struct {
	Status   *string
	Progress *float64
	OutputKey *string
	Error    *string
}
