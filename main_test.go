package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
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
	t.Run("status=active,queued comma list", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/ops?status=active,queued&limit=50", nil)
		rec := httptest.NewRecorder()

		handleOps(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d", rec.Code)
		}

		var result map[string]interface{}
		if err := json.NewDecoder(rec.Body).Decode(&result); err != nil {
			t.Fatalf("failed to decode JSON: %v", err)
		}

		if ops, ok := result["operations"].([]interface{}); ok {
			for i, rawOp := range ops {
				op := rawOp.(map[string]interface{})
				s := op["status"]
				if s != "active" && s != "queued" {
					t.Errorf("ops[%d]: expected status active|queued, got %q", i, s)
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

func TestStripYAMLFrontmatter(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "strips simple frontmatter block",
			in:   "---\nfoo: bar\n---\n# Hello\n",
			want: "# Hello\n",
		},
		{
			name: "strips CRLF frontmatter block",
			in:   "---\r\nfoo: bar\r\n---\r\n# Hello\r\n",
			want: "# Hello\r\n",
		},
		{
			name: "strips frontmatter with trailing whitespace on delimiters",
			in:   "---  \nfoo: bar\n---\t\nbody",
			want: "body",
		},
		{
			name: "strips frontmatter with no trailing newline after closer",
			in:   "---\nfoo: bar\n---",
			want: "",
		},
		{
			name: "preserves body containing horizontal rule",
			in:   "---\nfoo: bar\n---\nintro\n\n---\n\nmore",
			want: "intro\n\n---\n\nmore",
		},
		{
			name: "no frontmatter is unchanged",
			in:   "# Heading\n\nbody",
			want: "# Heading\n\nbody",
		},
		{
			name: "first line is hr but no closer is unchanged",
			in:   "---\nthis looks like frontmatter but never closes\nstill open",
			want: "---\nthis looks like frontmatter but never closes\nstill open",
		},
		{
			name: "single-line dashes is unchanged",
			in:   "---",
			want: "---",
		},
		{
			name: "first line not a delimiter is unchanged",
			in:   "----\nfoo: bar\n----\nbody",
			want: "----\nfoo: bar\n----\nbody",
		},
		{
			name: "empty input is unchanged",
			in:   "",
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := stripYAMLFrontmatter(tc.in)
			if got != tc.want {
				t.Errorf("stripYAMLFrontmatter(%q)\n  got:  %q\n  want: %q", tc.in, got, tc.want)
			}
		})
	}
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

// TestBuildSessionArgsCopilotColdStart verifies that on cold start (no session
// store), the copilot branch includes -i with the prompt.
func TestBuildSessionArgsCopilotColdStart(t *testing.T) {
	// No session store → cold start.
	prevStore := sessionStore
	sessionStore = nil
	t.Cleanup(func() { sessionStore = prevStore })

	cmd, args, err := buildSessionArgs("copilot", "test prompt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd != "copilot" {
		t.Fatalf("expected cmd=copilot, got %s", cmd)
	}
	if !slices.Contains(args, "-i") {
		t.Fatal("cold start: expected -i in args, got", args)
	}
	iIdx := slices.Index(args, "-i")
	if iIdx+1 >= len(args) || args[iIdx+1] != "test prompt" {
		t.Fatalf("cold start: expected -i followed by prompt, got %v", args)
	}
	if slices.Contains(args, "--resume") {
		t.Fatal("cold start: --resume should not be present without session store")
	}
	if !slices.Contains(args, "--yolo") {
		t.Fatal("expected --yolo in copilot args")
	}
}

// TestBuildSessionArgsCopilotWarmStart verifies that on warm start (session
// store has a GUID for copilot), the copilot branch does NOT include -i but
// DOES include --resume.
func TestBuildSessionArgsCopilotWarmStart(t *testing.T) {
	store := setSessionStoreForTest(t, "copilot")
	// Pre-populate a GUID for copilot so GUIDFor returns an existing one.
	_ = store.GUIDFor("copilot")

	cmd, args, err := buildSessionArgs("copilot", "test prompt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd != "copilot" {
		t.Fatalf("expected cmd=copilot, got %s", cmd)
	}
	if slices.Contains(args, "-i") {
		t.Fatalf("warm start: -i must NOT be present when resuming, got %v", args)
	}
	if !slices.Contains(args, "--resume") {
		t.Fatal("warm start: expected --resume in args, got", args)
	}
	if !slices.Contains(args, "--yolo") {
		t.Fatal("expected --yolo in copilot args")
	}
}

// TestBuildSessionArgsGeminiUnchanged verifies that the gemini branch still
// uses -i only when guid is empty (seed failure path).
func TestBuildSessionArgsGeminiUnchanged(t *testing.T) {
	_ = setSessionStoreForTest(t, "gemini")

	// Stub seedGeminiSessionFn to simulate seed failure (no guid).
	prevSeed := seedGeminiSessionFn
	seedGeminiSessionFn = func(string) (string, error) {
		return "", fmt.Errorf("stub seed failure")
	}
	t.Cleanup(func() { seedGeminiSessionFn = prevSeed })

	// Cold start: no pre-existing GUID, seed fails → -i should be present.
	cmd, args, err := buildSessionArgs("gemini", "test prompt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd != "gemini" {
		t.Fatalf("expected cmd=gemini, got %s", cmd)
	}
	if !slices.Contains(args, "-i") {
		t.Fatal("gemini cold start with seed failure: expected -i in args, got", args)
	}
	if slices.Contains(args, "--resume") {
		t.Fatal("gemini cold start with seed failure: --resume should not be present")
	}

	// Warm start: pre-populate a GUID for gemini.
	if err := sessionStore.SetGUID("gemini", "test-session-id"); err != nil {
		t.Fatalf("SetGUID: %v", err)
	}
	cmd2, args2, err := buildSessionArgs("gemini", "test prompt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cmd2 != "gemini" {
		t.Fatalf("expected cmd=gemini, got %s", cmd2)
	}
	if slices.Contains(args2, "-i") {
		t.Fatalf("gemini warm start: -i must NOT be present when resuming, got %v", args2)
	}
	if !slices.Contains(args2, "--resume") {
		t.Fatal("gemini warm start: expected --resume in args, got", args2)
	}
}

// TestBuildSessionArgsUnknownRuntime verifies unknown runtimes are rejected.
func TestBuildSessionArgsUnknownRuntime(t *testing.T) {
	_, _, err := buildSessionArgs("bogus", "prompt")
	if err == nil {
		t.Fatal("expected error for unknown runtime")
	}
}
