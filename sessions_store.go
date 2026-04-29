package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

// SessionStore tracks the persistent per-runtime resume session ids and the
// currently-active runtime. It is persisted to ~/.swat-dashboard/sessions.json
// (or $SWAT_DASHBOARD_HOME/sessions.json in tests) using an atomic
// write-tmp + rename so a crash mid-write cannot brick the dashboard.
type SessionStore struct {
	mu       sync.RWMutex
	path     string
	Active   string            `json:"active"`
	Sessions map[string]string `json:"sessions"`
	Version  int               `json:"version"`
}

// sessionStoreDir returns the directory holding sessions.json. SWAT_DASHBOARD_HOME
// overrides the default for tests.
func sessionStoreDir() (string, error) {
	if v := os.Getenv("SWAT_DASHBOARD_HOME"); v != "" {
		return v, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("user home dir: %w", err)
	}
	return filepath.Join(home, ".swat-dashboard"), nil
}

// LoadOrInitStore reads sessions.json from the standard location, creating it
// if missing and recovering from JSON corruption by backing up the broken file
// and rebuilding a fresh one.
func LoadOrInitStore() (*SessionStore, error) {
	dir, err := sessionStoreDir()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", dir, err)
	}
	return loadOrInitStoreAt(filepath.Join(dir, "sessions.json"))
}

// storeVersion is the current schema version. Bump when adding migrations.
const storeVersion = 2

// loadOrInitStoreAt is the testable core of LoadOrInitStore.
func loadOrInitStoreAt(path string) (*SessionStore, error) {
	s := &SessionStore{
		path:     path,
		Active:   "copilot",
		Sessions: map[string]string{},
		Version:  storeVersion,
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		if err := s.persistLocked(); err != nil {
			return nil, err
		}
		return s, nil
	}
	var raw struct {
		Active   string            `json:"active"`
		Sessions map[string]string `json:"sessions"`
		Version  int               `json:"version"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		// Corrupt → back up and rebuild.
		bak := fmt.Sprintf("%s.bak.%d", path, time.Now().Unix())
		if rerr := os.Rename(path, bak); rerr != nil {
			_ = os.WriteFile(bak, data, 0o600)
		}
		if perr := s.persistLocked(); perr != nil {
			return nil, perr
		}
		return s, nil
	}
	if raw.Active != "" {
		s.Active = raw.Active
	}
	if raw.Sessions != nil {
		s.Sessions = raw.Sessions
	}
	s.Version = raw.Version

	// Migration: v0/v1 → v2. Clear auto-generated gemini session IDs that
	// were created by GUIDFor before Option D seeding was implemented.
	// These IDs are always UUID v4 and never worked with gemini's --resume.
	if s.Version < 2 {
		delete(s.Sessions, "gemini")
		s.Version = storeVersion
		_ = s.persistLocked()
	}

	return s, nil
}

// GUIDFor returns a stable UUID v4 for runtime, generating and persisting a
// new one if the existing entry is missing or not a valid UUID v4.
// This is only appropriate for runtimes that support create-on-miss (copilot).
// For runtimes that require externally-seeded IDs (gemini), use GetGUID.
func (s *SessionStore) GUIDFor(runtime string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur, ok := s.Sessions[runtime]; ok && isValidUUIDv4(cur) {
		return cur
	}
	id := uuid.NewString()
	if s.Sessions == nil {
		s.Sessions = map[string]string{}
	}
	s.Sessions[runtime] = id
	_ = s.persistLocked()
	return id
}

// GetGUID returns the stored session ID for runtime without generating one.
// Returns empty string if no session ID is stored. Use this for runtimes
// where session IDs must come from an external source (e.g. gemini seed).
func (s *SessionStore) GetGUID(runtime string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Sessions[runtime]
}

// SetGUID stores an externally-provided session ID for runtime.
func (s *SessionStore) SetGUID(runtime, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Sessions == nil {
		s.Sessions = map[string]string{}
	}
	s.Sessions[runtime] = id
	return s.persistLocked()
}

// ClearGUID removes the stored session ID for runtime.
func (s *SessionStore) ClearGUID(runtime string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.Sessions, runtime)
	return s.persistLocked()
}

// SetActive persists active runtime atomically.
func (s *SessionStore) SetActive(runtime string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Active = runtime
	return s.persistLocked()
}

// ActiveRuntime returns the currently-active runtime name (snapshot).
func (s *SessionStore) ActiveRuntime() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Active
}

// Snapshot returns a copy of the (active, sessions) state.
func (s *SessionStore) Snapshot() (string, map[string]string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cp := make(map[string]string, len(s.Sessions))
	for k, v := range s.Sessions {
		cp[k] = v
	}
	return s.Active, cp
}

// persistLocked writes the store atomically. Caller must hold s.mu.
func (s *SessionStore) persistLocked() error {
	if s.path == "" {
		return fmt.Errorf("session store has no backing path")
	}
	payload := struct {
		Active   string            `json:"active"`
		Sessions map[string]string `json:"sessions"`
		Version  int               `json:"version"`
	}{Active: s.Active, Sessions: s.Sessions, Version: s.Version}
	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal session store: %w", err)
	}
	dir := filepath.Dir(s.path)
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return fmt.Errorf("rand suffix: %w", err)
	}
	tmp := filepath.Join(dir, fmt.Sprintf("sessions.json.tmp.%s", hex.EncodeToString(suffix)))
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return fmt.Errorf("write tmp: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename tmp -> %s: %w", s.path, err)
	}
	return nil
}

// isValidUUIDv4 reports whether s parses as a UUID and is variant RFC 4122
// version 4. Other versions and the nil UUID are rejected so callers
// regenerate a fresh v4 — matching the issue #29 contract.
func isValidUUIDv4(s string) bool {
	id, err := uuid.Parse(s)
	if err != nil {
		return false
	}
	if id.Version() != 4 {
		return false
	}
	if id.Variant() != uuid.RFC4122 {
		return false
	}
	return true
}
