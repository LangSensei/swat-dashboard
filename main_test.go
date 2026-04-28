package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleStats(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	rec := httptest.NewRecorder()

	handleStats(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var result map[string]int
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("failed to decode JSON: %v", err)
	}

	for _, key := range []string{"active", "queued", "completed", "failed"} {
		if _, ok := result[key]; !ok {
			t.Errorf("missing key %q in stats response", key)
		}
	}
}

func TestHandleOps(t *testing.T) {
	t.Run("default", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ops", nil)
		rec := httptest.NewRecorder()

		handleOps(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", rec.Code)
		}

		var result map[string]interface{}
		if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
			t.Fatalf("failed to decode JSON: %v", err)
		}

		if _, ok := result["operations"]; !ok {
			t.Error("missing 'operations' key")
		}
		if _, ok := result["total"]; !ok {
			t.Error("missing 'total' key")
		}

		// operations must be an array (or null)
		switch ops := result["operations"].(type) {
		case []interface{}:
			// ok
			_ = ops
		case nil:
			// ok — no operations found
		default:
			t.Errorf("expected 'operations' to be array or null, got %T", result["operations"])
		}

		// total must be a number
		if _, ok := result["total"].(float64); !ok {
			t.Errorf("expected 'total' to be a number, got %T", result["total"])
		}
	})

	t.Run("with query params", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ops?limit=5&offset=0&squad=test-squad&status=completed&q=search", nil)
		rec := httptest.NewRecorder()

		handleOps(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", rec.Code)
		}

		var result map[string]interface{}
		if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
			t.Fatalf("failed to decode JSON: %v", err)
		}

		if _, ok := result["operations"]; !ok {
			t.Error("missing 'operations' key")
		}
		if _, ok := result["total"]; !ok {
			t.Error("missing 'total' key")
		}
	})

	t.Run("status=active filter", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ops?status=active&limit=50", nil)
		rec := httptest.NewRecorder()

		handleOps(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", rec.Code)
		}

		var result map[string]interface{}
		if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
			t.Fatalf("failed to decode JSON: %v", err)
		}

		if _, ok := result["operations"]; !ok {
			t.Error("missing 'operations' key")
		}
		if _, ok := result["total"]; !ok {
			t.Error("missing 'total' key")
		}

		// All returned ops must be active
		if ops, ok := result["operations"].([]interface{}); ok {
			for i, rawOp := range ops {
				op := rawOp.(map[string]interface{})
				if op["status"] != "active" {
					t.Errorf("ops[%d]: expected status 'active', got %q", i, op["status"])
				}
			}
		}
	})

	t.Run("status=queued filter", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ops?status=queued&limit=50", nil)
		rec := httptest.NewRecorder()

		handleOps(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", rec.Code)
		}

		var result map[string]interface{}
		if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
			t.Fatalf("failed to decode JSON: %v", err)
		}

		if _, ok := result["operations"]; !ok {
			t.Error("missing 'operations' key")
		}
		if _, ok := result["total"]; !ok {
			t.Error("missing 'total' key")
		}

		// All returned ops must be queued
		if ops, ok := result["operations"].([]interface{}); ok {
			for i, rawOp := range ops {
				op := rawOp.(map[string]interface{})
				if op["status"] != "queued" {
					t.Errorf("ops[%d]: expected status 'queued', got %q", i, op["status"])
				}
			}
		}
	})
}

func TestHandleSquads(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/squads", nil)
	rec := httptest.NewRecorder()

	handleSquads(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	// Decode into RawMessage first, then check if it's null or an array
	body := rec.Body.Bytes()
	var raw json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatalf("failed to decode JSON: %v", err)
	}
	if string(raw) != "null" {
		var result []interface{}
		if err := json.Unmarshal(body, &result); err != nil {
			t.Fatalf("expected JSON array or null, got: %s", string(raw))
		}
	}
}

func TestHandleRuntimes(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/runtimes", nil)
	rec := httptest.NewRecorder()

	handleRuntimes(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	var result []map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
		t.Fatalf("failed to decode JSON: %v", err)
	}

	if len(result) != 2 {
		t.Fatalf("expected exactly 2 runtime entries (copilot, gemini), got %d", len(result))
	}

	for i, rt := range result {
		if _, ok := rt["name"]; !ok {
			t.Errorf("runtime[%d]: missing 'name' field", i)
		}
		if _, ok := rt["available"]; !ok {
			t.Errorf("runtime[%d]: missing 'available' field", i)
		}
	}
}

func TestHandleOpFile(t *testing.T) {
	t.Run("missing params returns 400", func(t *testing.T) {
		// No params at all
		req := httptest.NewRequest(http.MethodGet, "/api/file", nil)
		rec := httptest.NewRecorder()
		handleOpFile(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for missing params, got %d", rec.Code)
		}

		// Only op param
		req = httptest.NewRequest(http.MethodGet, "/api/file?op=some-id", nil)
		rec = httptest.NewRecorder()
		handleOpFile(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for missing file param, got %d", rec.Code)
		}

		// Only file param
		req = httptest.NewRequest(http.MethodGet, "/api/file?file=OPERATION.md", nil)
		rec = httptest.NewRecorder()
		handleOpFile(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for missing op param, got %d", rec.Code)
		}
	})

	t.Run("nonexistent op returns 404", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/file?op=nonexistent-op-id&file=OPERATION.md", nil)
		rec := httptest.NewRecorder()
		handleOpFile(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("expected 404 for nonexistent op, got %d", rec.Code)
		}
	})
}

func TestHandleOpFiles(t *testing.T) {
	t.Run("missing op returns 400", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/files", nil)
		rec := httptest.NewRecorder()
		handleOpFiles(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400 for missing op param, got %d", rec.Code)
		}
	})

	t.Run("nonexistent op returns 404", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/files?op=nonexistent-op-id", nil)
		rec := httptest.NewRecorder()
		handleOpFiles(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("expected 404 for nonexistent op, got %d", rec.Code)
		}
	})
}

func TestContainsCI(t *testing.T) {
	tests := []struct {
		s, sub string
		want   bool
	}{
		{"Hello World", "hello", true},
		{"Hello World", "WORLD", true},
		{"Hello World", "world", true},
		{"Hello World", "Hello World", true},
		{"Hello World", "xyz", false},
		{"", "", true},
		{"abc", "", true},
		{"", "a", false},
		{"FooBarBaz", "obar", true},
		{"FooBarBaz", "OBARBAZ", true},
	}

	for _, tc := range tests {
		got := containsCI(tc.s, tc.sub)
		if got != tc.want {
			t.Errorf("containsCI(%q, %q) = %v, want %v", tc.s, tc.sub, got, tc.want)
		}
	}
}
