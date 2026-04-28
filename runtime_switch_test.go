package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

// TestHandleRuntimeSwitchSetActiveBeforeTeardown is the regression test for
// the orphan-PTY race: SetActive(to) MUST be persisted BEFORE the outgoing
// PTY teardown so that any WS upgrade for the OLD runtime arriving during
// the multi-second teardown window is rejected by handleSessionWS's
// pre-upgrade `rt != active` check (issue from PR #30 review).
//
// The test stubs lookPathFn / spawnSessionFn (so we don't need a real CLI on
// PATH) and stubs terminatePTYFn with a slow function. While teardown is
// blocked inside terminatePTYFn, we fire a WS upgrade for the OUTGOING
// runtime and assert it gets 409. With the pre-fix code (SetActive AFTER
// teardown), ActiveRuntime() would still report `copilot` during teardown
// and the WS upgrade would proceed → orphan PTY.
func TestHandleRuntimeSwitchSetActiveBeforeTeardown(t *testing.T) {
	setSessionStoreForTest(t, "copilot")

	// Stub LookPath / spawn so the handler doesn't need real CLIs on PATH.
	prevLookPath := lookPathFn
	prevSpawn := spawnSessionFn
	prevTerminate := terminatePTYFn
	t.Cleanup(func() {
		lookPathFn = prevLookPath
		spawnSessionFn = prevSpawn
		terminatePTYFn = prevTerminate
	})
	lookPathFn = func(string) (string, error) { return "/stub/path", nil }
	spawnSessionFn = func(string) error { return nil }

	// Inject a fake current PTY so the teardown branch is exercised. We
	// never call a real method on it because terminatePTYFn is stubbed.
	sessionsMu.Lock()
	sessions["copilot"] = &platformPTY{}
	sessionsMu.Unlock()

	// Coordination: terminatePTYFn blocks until we close `release`. We
	// observe ActiveRuntime() inside terminatePTYFn AND fire a concurrent
	// WS request for the outgoing runtime to assert pre-upgrade rejection.
	teardownEntered := make(chan struct{})
	release := make(chan struct{})
	var observedActive string
	terminatePTYFn = func(p *platformPTY, d time.Duration) {
		observedActive = sessionStore.ActiveRuntime()
		close(teardownEntered)
		<-release
	}

	switchDone := make(chan int, 1)
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/api/runtime/switch?to=gemini", nil)
		rec := httptest.NewRecorder()
		handleRuntimeSwitch(rec, req)
		switchDone <- rec.Code
	}()

	// Wait for the switch handler to enter teardown.
	select {
	case <-teardownEntered:
	case <-time.After(2 * time.Second):
		close(release)
		<-switchDone
		t.Fatal("switch handler did not reach teardown within 2s")
	}

	// At this point SetActive must have already flipped to "gemini".
	if observedActive != "gemini" {
		close(release)
		<-switchDone
		t.Fatalf("expected ActiveRuntime()==\"gemini\" at teardown entry; got %q (SetActive ran AFTER teardown — race fix regressed)", observedActive)
	}

	// While teardown is still in flight, a WS upgrade for the OUTGOING
	// runtime ("copilot") must be rejected by handleSessionWS's pre-upgrade
	// gate, proving no orphan PTY can be respawned for the old runtime.
	wsReq := httptest.NewRequest(http.MethodGet, "/ws/session?runtime=copilot", nil)
	wsReq.Header.Set("Connection", "Upgrade")
	wsReq.Header.Set("Upgrade", "websocket")
	wsReq.Header.Set("Sec-WebSocket-Version", "13")
	wsReq.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	wsRec := httptest.NewRecorder()
	handleSessionWS(wsRec, wsReq)
	if wsRec.Code != http.StatusConflict {
		close(release)
		<-switchDone
		t.Fatalf("expected 409 for WS upgrade against outgoing runtime mid-switch, got %d (orphan-PTY race window still open)", wsRec.Code)
	}

	// Allow teardown to finish and switch handler to complete.
	close(release)
	if code := <-switchDone; code != http.StatusOK {
		t.Fatalf("expected switch handler to return 200, got %d", code)
	}
}
