package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// helper: isolate a SessionStore inside a per-test temp dir.
func newStoreInTemp(t *testing.T) (*SessionStore, string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("SWAT_DASHBOARD_HOME", dir)
	s, err := LoadOrInitStore()
	if err != nil {
		t.Fatalf("LoadOrInitStore: %v", err)
	}
	return s, filepath.Join(dir, "sessions.json")
}

func TestSessionStoreRoundTrip(t *testing.T) {
	s, path := newStoreInTemp(t)

	if s.ActiveRuntime() != "copilot" {
		t.Fatalf("expected default active=copilot, got %q", s.ActiveRuntime())
	}

	g1 := s.GUIDFor("copilot")
	g2 := s.GUIDFor("gemini")
	if g1 == "" || g2 == "" || g1 == g2 {
		t.Fatalf("expected two distinct guids, got %q %q", g1, g2)
	}
	if !isValidUUIDv4(g1) || !isValidUUIDv4(g2) {
		t.Fatalf("guids must be UUIDv4: %q %q", g1, g2)
	}
	if err := s.SetActive("gemini"); err != nil {
		t.Fatalf("SetActive: %v", err)
	}

	// Reload from disk and verify state survives.
	s2, err := LoadOrInitStore()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if s2.ActiveRuntime() != "gemini" {
		t.Fatalf("expected reloaded active=gemini, got %q", s2.ActiveRuntime())
	}
	if got := s2.GUIDFor("copilot"); got != g1 {
		t.Fatalf("expected reloaded copilot guid %q, got %q", g1, got)
	}
	if got := s2.GUIDFor("gemini"); got != g2 {
		t.Fatalf("expected reloaded gemini guid %q, got %q", g2, got)
	}

	// Sanity: file actually exists and is valid JSON.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var raw struct {
		Active   string            `json:"active"`
		Sessions map[string]string `json:"sessions"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("on-disk JSON invalid: %v", err)
	}
}

func TestSessionStoreCorruptionRecovery(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SWAT_DASHBOARD_HOME", dir)
	path := filepath.Join(dir, "sessions.json")
	if err := os.WriteFile(path, []byte("{not valid json"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s, err := LoadOrInitStore()
	if err != nil {
		t.Fatalf("LoadOrInitStore: %v", err)
	}
	if s.ActiveRuntime() != "copilot" {
		t.Fatalf("expected default active after recovery, got %q", s.ActiveRuntime())
	}
	// Backup file should exist.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	bakFound := false
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "sessions.json.bak.") {
			bakFound = true
		}
	}
	if !bakFound {
		t.Fatalf("expected sessions.json.bak.<ts>, got entries: %v", entries)
	}
	// Rebuilt file is valid.
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read rebuilt: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("rebuilt file is not valid JSON: %v", err)
	}
}

func TestSessionStoreInvalidUUID(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SWAT_DASHBOARD_HOME", dir)
	path := filepath.Join(dir, "sessions.json")

	good := "550e8400-e29b-41d4-a716-446655440000"
	seed := map[string]any{
		"active": "copilot",
		"sessions": map[string]string{
			"copilot": "not-a-uuid",
			"gemini":  good,
		},
	}
	data, _ := json.MarshalIndent(seed, "", "  ")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	s, err := LoadOrInitStore()
	if err != nil {
		t.Fatalf("LoadOrInitStore: %v", err)
	}
	g := s.GUIDFor("copilot")
	if g == "not-a-uuid" {
		t.Fatalf("expected regenerated UUID for invalid copilot entry, still got %q", g)
	}
	if !isValidUUIDv4(g) {
		t.Fatalf("regenerated id %q is not a valid UUIDv4", g)
	}
	// Gemini's valid id must be preserved.
	if got := s.GUIDFor("gemini"); got != good {
		t.Fatalf("expected gemini guid preserved, got %q", got)
	}
}

func TestSessionStoreAtomicWrite(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SWAT_DASHBOARD_HOME", dir)
	s, err := LoadOrInitStore()
	if err != nil {
		t.Fatalf("LoadOrInitStore: %v", err)
	}
	for i := 0; i < 20; i++ {
		_ = s.GUIDFor("copilot")
		if err := s.SetActive("gemini"); err != nil {
			t.Fatalf("SetActive: %v", err)
		}
		if err := s.SetActive("copilot"); err != nil {
			t.Fatalf("SetActive: %v", err)
		}
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp.") {
			t.Fatalf("found leftover temp file %q — atomic write must clean up", e.Name())
		}
	}
}

func TestSessionStoreConcurrentGUIDFor(t *testing.T) {
	// Concurrent GUIDFor calls for the same runtime must agree on a single
	// stable id (no race-induced second regeneration).
	s, _ := newStoreInTemp(t)
	const n = 32
	results := make([]string, n)
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			results[i] = s.GUIDFor("copilot")
		}(i)
	}
	wg.Wait()
	for i := 1; i < n; i++ {
		if results[i] != results[0] {
			t.Fatalf("concurrent GUIDFor returned divergent ids: %q vs %q", results[0], results[i])
		}
	}
}
