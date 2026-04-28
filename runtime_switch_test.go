package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

// setSessionStoreForTest installs a fresh in-memory-backed SessionStore for
// the duration of a test. It also clears any pre-existing session/broadcaster
// state so individual handler tests are deterministic.
func setSessionStoreForTest(t *testing.T, active string) *SessionStore {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("SWAT_DASHBOARD_HOME", dir)
	s, err := LoadOrInitStore()
	if err != nil {
		t.Fatalf("LoadOrInitStore: %v", err)
	}
	if active != "" {
		if err := s.SetActive(active); err != nil {
			t.Fatalf("SetActive: %v", err)
		}
	}

	prevStore := sessionStore
	sessionStore = s
	sessionsMu.Lock()
	prevSessions := sessions
	prevBcs := broadcasters
	sessions = make(map[string]*platformPTY)
	broadcasters = make(map[string]*Broadcaster)
	sessionsMu.Unlock()

	t.Cleanup(func() {
		sessionStore = prevStore
		sessionsMu.Lock()
		sessions = prevSessions
		broadcasters = prevBcs
		sessionsMu.Unlock()
	})
	return s
}

func TestHandleRuntimesIncludesActiveAndSessionID(t *testing.T) {
	setSessionStoreForTest(t, "gemini")

	req := httptest.NewRequest(http.MethodGet, "/api/runtimes", nil)
	rec := httptest.NewRecorder()
	handleRuntimes(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{`"name":"copilot"`, `"name":"gemini"`, `"active":true`, `"active":false`, `"session_id"`} {
		if !strings.Contains(body, want) {
			t.Errorf("expected body to contain %q; got %s", want, body)
		}
	}
}

func TestHandleRuntimeSwitchInvalidRuntime(t *testing.T) {
	setSessionStoreForTest(t, "copilot")

	req := httptest.NewRequest(http.MethodPost, "/api/runtime/switch?to=bogus", nil)
	rec := httptest.NewRecorder()
	handleRuntimeSwitch(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unknown runtime, got %d", rec.Code)
	}
}

func TestHandleRuntimeSwitchRejectsWrongMethod(t *testing.T) {
	setSessionStoreForTest(t, "copilot")
	req := httptest.NewRequest(http.MethodGet, "/api/runtime/switch?to=copilot", nil)
	rec := httptest.NewRecorder()
	handleRuntimeSwitch(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405 for GET, got %d", rec.Code)
	}
}

// TestHandleRuntimeSwitchConcurrentRace exercises the switchMu TryLock path
// without depending on a real CLI being installed. We hold switchMu from the
// test body to deterministically force the second request into the 409 branch.
func TestHandleRuntimeSwitchConcurrentRace(t *testing.T) {
	setSessionStoreForTest(t, "copilot")

	// Manually take switchMu so any concurrent handler call must observe
	// TryLock failure → 409. This avoids needing a real CLI on PATH inside
	// the test runner (which has neither copilot nor gemini installed).
	switchMu.Lock()
	defer switchMu.Unlock()

	const n = 4
	var wg sync.WaitGroup
	var got409 int32
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/api/runtime/switch?to=gemini", nil)
			rec := httptest.NewRecorder()
			handleRuntimeSwitch(rec, req)
			if rec.Code == http.StatusConflict {
				atomic.AddInt32(&got409, 1)
			}
		}()
	}
	wg.Wait()
	if int(got409) != n {
		t.Fatalf("expected all %d concurrent calls to receive 409 while switchMu is held, got %d", n, got409)
	}
}

func TestHandleSessionWSRejectsInactive(t *testing.T) {
	setSessionStoreForTest(t, "copilot")

	// Build a request that looks like a WS handshake but to an inactive
	// runtime; the handler should 409 BEFORE attempting websocket.Upgrade.
	req := httptest.NewRequest(http.MethodGet, "/ws/session?runtime=gemini", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	rec := httptest.NewRecorder()
	handleSessionWS(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for inactive runtime, got %d", rec.Code)
	}
}
