package main

import (
	"bufio"
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/LangSensei/swat/commander/operation"
	"github.com/gorilla/websocket"
)

// version is set at build time via ldflags: -X main.version=v1.2.3
var version = "dev"

//go:embed static/*
var staticFiles embed.FS

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// --- Operation model ---

// OpView is a lightweight UI view of an operation
type OpView struct {
	ID            string `json:"id"`
	Squad         string `json:"squad"`
	Status        string `json:"status"`
	Brief         string `json:"brief"`
	Summary       string `json:"summary"`
	FailureReason string `json:"failure_reason,omitempty"`
	CreatedAt     string `json:"created_at"`
	CompletedAt   string `json:"completed_at,omitempty"`
	Elapsed       string `json:"elapsed,omitempty"`
}

func opToView(op *operation.Operation) OpView {
	v := OpView{
		ID:      op.OperationID,
		Squad:   op.Squad,
		Status:  op.Status,
		Brief:   op.Brief,
		Summary: op.Summary,
	}
	if op.FailureReason != nil {
		v.FailureReason = *op.FailureReason
	}
	if !op.CreatedAt.IsZero() {
		v.CreatedAt = op.CreatedAt.Format(time.RFC3339)
	}
	if op.CompletedAt != nil && !op.CompletedAt.IsZero() {
		v.CompletedAt = op.CompletedAt.Format(time.RFC3339)
	}
	// Elapsed
	if !op.CreatedAt.IsZero() {
		end := time.Now()
		if op.CompletedAt != nil && !op.CompletedAt.IsZero() {
			end = *op.CompletedAt
		}
		d := end.Sub(op.CreatedAt)
		if d < time.Hour {
			v.Elapsed = fmt.Sprintf("%dm", int(d.Minutes()))
		} else {
			v.Elapsed = fmt.Sprintf("%dh%dm", int(d.Hours()), int(d.Minutes())%60)
		}
	}
	return v
}

func scanOperations(squad, status, keyword string, limit, offset int) ([]OpView, int) {
	all, err := operation.List()
	if err != nil {
		return nil, 0
	}

	// status accepts a comma-separated list so the active and history lists can
	// query disjoint buckets (e.g. "active,queued" vs "completed,failed") with a
	// single endpoint while remaining independent.
	var statusSet map[string]struct{}
	if status != "" {
		statusSet = make(map[string]struct{})
		for _, s := range strings.Split(status, ",") {
			if s = strings.TrimSpace(s); s != "" {
				statusSet[s] = struct{}{}
			}
		}
	}

	var ops []OpView
	for _, op := range all {
		if squad != "" && op.Squad != squad {
			continue
		}
		if statusSet != nil {
			if _, ok := statusSet[op.Status]; !ok {
				continue
			}
		}
		if keyword != "" && !containsCI(op.Brief, keyword) && !containsCI(op.Summary, keyword) {
			continue
		}
		ops = append(ops, opToView(op))
	}

	sort.Slice(ops, func(i, j int) bool { return ops[i].ID > ops[j].ID })

	total := len(ops)
	if offset > len(ops) {
		offset = len(ops)
	}
	ops = ops[offset:]
	if limit > 0 && limit < len(ops) {
		ops = ops[:limit]
	}
	return ops, total
}

func listSquads() []string {
	all, _ := operation.List()
	seen := map[string]bool{}
	for _, op := range all {
		if op.Squad != "" {
			seen[op.Squad] = true
		}
	}
	var squads []string
	for s := range seen {
		squads = append(squads, s)
	}
	sort.Strings(squads)
	return squads
}

func readOpFile(opId, filename string) (string, error) {
	dir, err := opDir(opId)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, filename)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// stripYAMLFrontmatter removes a leading `---\n…\n---\n` YAML frontmatter block
// from a markdown document. It mirrors the semantics of the deleted
// static/frontmatter.js helper:
//
//   - The input must start with a line that is exactly `---` (optional trailing
//     spaces/tabs, CRLF tolerant). Otherwise the input is returned unchanged.
//   - Stripping ends at the next standalone `---` line.
//   - If no closing `---` line is found, the input is returned unchanged so we
//     never silently swallow a document that just happens to start with `---`.
//   - Horizontal-rule `---` lines anywhere other than line 1 are never stripped.
func stripYAMLFrontmatter(text string) string {
	if !strings.HasPrefix(text, "---") {
		return text
	}
	nl := strings.IndexByte(text, '\n')
	if nl == -1 {
		return text
	}
	firstLine := strings.TrimRight(text[:nl], "\r")
	if !isFrontmatterDelimiter(firstLine) {
		return text
	}
	rest := text[nl+1:]
	// Walk `rest` looking for the next standalone `---` line.
	search := 0
	for search <= len(rest) {
		idx := strings.Index(rest[search:], "---")
		if idx == -1 {
			return text
		}
		abs := search + idx
		// Must be at the start of a line.
		if abs != 0 && rest[abs-1] != '\n' {
			search = abs + 1
			continue
		}
		lineEnd := strings.IndexByte(rest[abs:], '\n')
		var line string
		var consumed int
		if lineEnd == -1 {
			line = rest[abs:]
			consumed = len(rest) - abs
		} else {
			line = strings.TrimRight(rest[abs:abs+lineEnd], "\r")
			consumed = lineEnd + 1
		}
		if isFrontmatterDelimiter(line) {
			return rest[abs+consumed:]
		}
		search = abs + 1
	}
	return text
}

// isFrontmatterDelimiter reports whether line is `---` followed only by spaces
// or tabs. Caller is responsible for trimming any trailing CR.
func isFrontmatterDelimiter(line string) bool {
	if !strings.HasPrefix(line, "---") {
		return false
	}
	for i := 3; i < len(line); i++ {
		if line[i] != ' ' && line[i] != '\t' {
			return false
		}
	}
	return true
}

func containsCI(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

// --- PTY session ---

// --- Default session prompt ---

const defaultPrompt = `You are a SWAT dashboard operator. Wait for user instructions. Do not take any action autonomously. Your role: discuss requirements, review operations, and help dispatch tasks when asked. Workspace: ~/.swat/`

// --- PTY session manager ---

var (
	sessions     = make(map[string]*platformPTY)
	broadcasters = make(map[string]*Broadcaster)
	sessionsMu   sync.Mutex

	// switchMu serialises POST /api/runtime/switch. It is intentionally
	// distinct from sessionsMu — switch runs the full tear-down + spawn dance
	// (which acquires sessionsMu inside getOrCreateSession), so reusing
	// sessionsMu here would deadlock. switchMu is used with TryLock so
	// concurrent UI clicks return 409 instead of queueing.
	switchMu sync.Mutex

	// sessionStore holds the persistent runtime-id state. It is loaded once
	// at startup.
	sessionStore *SessionStore
)

// runtimeOrder defines the canonical ordering used by autoStartActiveSession's
// fallback (and by /api/runtimes for stable client rendering).
var runtimeOrder = []string{"copilot", "gemini"}

// Test-only hooks. These are package vars so individual tests can override
// them to exercise concurrency-sensitive paths without depending on a real
// CLI being installed. Production callers are unaffected.
var (
	lookPathFn     = exec.LookPath
	terminatePTYFn = func(p *platformPTY, d time.Duration) { p.Terminate(d) }
	spawnSessionFn = func(rt string) error {
		_, _, err := getOrCreateSession(rt, defaultPrompt)
		return err
	}
)

func getOrCreateSession(runtimeName, prompt string) (*platformPTY, *Broadcaster, error) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()

	if sess, ok := sessions[runtimeName]; ok {
		return sess, broadcasters[runtimeName], nil
	}

	// Re-check active runtime under sessionsMu to seal the residual race
	// window in handleSessionWS between its pre-upgrade `rt != active`
	// check and this call: an in-flight WS upgrader that already passed
	// the pre-check can be context-switched out long enough for
	// handleRuntimeSwitch to flip SetActive(to); without this gate it
	// would resume here and spawn a fresh PTY for the now-outgoing
	// runtime, violating the single-active-runtime invariant. Safe for
	// all three call sites: the WS upgrade rejects late races,
	// handleRuntimeSwitch's spawnSessionFn proceeds because SetActive(to)
	// already ran, and autoStartActiveSession proceeds for the active
	// runtime it just selected.
	if sessionStore != nil {
		if active := sessionStore.ActiveRuntime(); active != "" && active != runtimeName {
			return nil, nil, fmt.Errorf("runtime %q is not active (active=%q)", runtimeName, active)
		}
	}

	if prompt == "" {
		prompt = defaultPrompt
	}
	sess, err := createPTYSession(runtimeName, prompt)
	if err != nil {
		return nil, nil, err
	}
	sessions[runtimeName] = sess

	bc := NewBroadcaster()
	broadcasters[runtimeName] = bc
	bc.Start(sess, func() {
		sessionsMu.Lock()
		delete(sessions, runtimeName)
		delete(broadcasters, runtimeName)
		sessionsMu.Unlock()
	})

	return sess, bc, nil
}

// autoStartActiveSession spawns exactly one PTY at boot, picking the persisted
// active runtime if its CLI is on PATH, else the first available runtime in
// runtimeOrder. If no CLI is installed it logs a warning and skips — the UI
// will surface this through /api/runtimes.
func autoStartActiveSession() {
	if sessionStore == nil {
		log.Printf("autoStartActiveSession: session store not initialised")
		return
	}
	preferred := sessionStore.ActiveRuntime()
	pick := ""
	if preferred != "" {
		if _, err := exec.LookPath(preferred); err == nil {
			pick = preferred
		}
	}
	if pick == "" {
		for _, rt := range runtimeOrder {
			if _, err := exec.LookPath(rt); err == nil {
				pick = rt
				break
			}
		}
	}
	if pick == "" {
		log.Printf("autoStartActiveSession: no CLI runtime available on PATH; skipping auto-start")
		return
	}
	if pick != preferred {
		if err := sessionStore.SetActive(pick); err != nil {
			log.Printf("autoStartActiveSession: persist active=%s: %v", pick, err)
		}
	}
	if _, _, err := getOrCreateSession(pick, defaultPrompt); err != nil {
		log.Printf("autoStartActiveSession: spawn %s: %v", pick, err)
		return
	}
	log.Printf("autoStartActiveSession: started %s session", pick)
}

// seedGeminiSessionTimeout is the maximum time to wait for the gemini CLI
// to emit an init event during session seeding.
const seedGeminiSessionTimeout = 30 * time.Second

// seedGeminiSession runs gemini non-interactively with stream-json output to
// create a new session and extract the session_id from the init event.
func seedGeminiSession(prompt string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), seedGeminiSessionTimeout)
	defer cancel()

	args := []string{"-p", prompt, "--output-format", "stream-json", "--skip-trust"}
	cmd := exec.CommandContext(ctx, "gemini", args...)
	cmd.Dir = filepath.Join(homeDir(), ".swat")

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start gemini seed: %w", err)
	}

	// Read stdout line by line looking for the init event.
	scanner := bufio.NewScanner(stdout)
	var sessionID string
	for scanner.Scan() {
		line := scanner.Text()
		var evt struct {
			Type      string `json:"type"`
			SessionID string `json:"session_id"`
		}
		if json.Unmarshal([]byte(line), &evt) == nil && evt.Type == "init" && evt.SessionID != "" {
			sessionID = evt.SessionID
			break
		}
	}

	// We have the session ID (or not). Wait for the process to finish.
	// Ignore exit errors — the seed process may be killed by context cancellation.
	_ = cmd.Wait()

	if sessionID == "" {
		return "", fmt.Errorf("no init event with session_id received from gemini")
	}
	return sessionID, nil
}

// seedGeminiSessionFn is a test hook for seedGeminiSession.
var seedGeminiSessionFn = seedGeminiSession

func createPTYSession(runtimeName, prompt string) (*platformPTY, error) {
	var cmdName string
	switch runtimeName {
	case "copilot":
		cmdName = "copilot"
	case "gemini":
		cmdName = "gemini"
	default:
		return nil, fmt.Errorf("unknown runtime: %s", runtimeName)
	}

	if _, err := exec.LookPath(cmdName); err != nil {
		return nil, fmt.Errorf("%s CLI not found. Please install it first", cmdName)
	}

	// `--resume <guid>` MUST come first so neither CLI's flag parser confuses
	// it with the operator prompt that follows. Both copilot and gemini accept
	// `--resume` together with `-i prompt` (resume restores conversation
	// history; `-i` injects the operator-level system prompt). Issue #29
	// confirms this orthogonality.
	var args []string
	if cmdName == "gemini" {
		// Gemini does not support create-on-miss: --resume only works with
		// existing sessions. Use GetGUID (no auto-generation) and seed a new
		// session via stream-json if needed (Option D, issue #32).
		guid := ""
		if sessionStore != nil {
			guid = sessionStore.GetGUID("gemini")
		}
		if guid == "" {
			// Cold start: seed a new session via gemini CLI structured output.
			if prompt == "" {
				prompt = defaultPrompt
			}
			seedID, err := seedGeminiSessionFn(prompt)
			if err != nil {
				log.Printf("gemini seed failed: %v; launching without --resume (no persistence)", err)
			} else {
				guid = seedID
				if sessionStore != nil {
					if err := sessionStore.SetGUID("gemini", seedID); err != nil {
						log.Printf("gemini seed: failed to persist session ID: %v", err)
					}
				}
			}
		}
		if guid != "" {
			args = append(args, "--resume", guid)
		}
		// On warm start (or after successful seed), skip -i: the session
		// already has the prompt from the seed call or previous run.
		// On fallback (no guid), inject the prompt so gemini starts fresh.
		if guid == "" && prompt != "" {
			args = append(args, "-i", prompt)
		}
		args = append(args, "--skip-trust", "--approval-mode", "yolo")
	} else {
		// Copilot: existing behavior — GUIDFor auto-generates on first use.
		if sessionStore != nil {
			guid := sessionStore.GUIDFor(runtimeName)
			if guid != "" {
				args = append(args, "--resume", guid)
			}
		}
		if prompt != "" {
			args = append(args, "-i", prompt)
		}
		args = append(args, "--yolo")
	}
	cmd := exec.Command(cmdName, args...)
	cmd.Dir = filepath.Join(homeDir(), ".swat")
	return startPTY(cmd)
}

func homeDir() string {
	h, _ := os.UserHomeDir()
	return h
}

// --- HTTP Handlers ---

// handleStats returns operation counts by status and failure_reason buckets.
func handleStats(w http.ResponseWriter, r *http.Request) {
	all, _ := operation.List()
	counts := map[string]int{
		"active": 0, "queued": 0, "completed": 0, "failed": 0,
		"cancelled": 0, "crashed": 0, "setup": 0, "config": 0,
	}
	for _, op := range all {
		counts[op.Status]++
		if op.Status == "failed" && op.FailureReason != nil {
			switch *op.FailureReason {
			case "cancelled_by_user":
				counts["cancelled"]++
			case "process_exited_without_completion":
				counts["crashed"]++
			case "classify_spawn_failed", "classify_move_failed", "provision_failed", "launch_failed":
				counts["setup"]++
			case "classify_no_squad", "classify_squad_not_installed":
				counts["config"]++
			}
		}
	}
	json.NewEncoder(w).Encode(counts)
}

func handleOps(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	squad := q.Get("squad")
	status := q.Get("status")
	keyword := q.Get("q")
	limit := 20
	offset := 0
	if l := q.Get("limit"); l != "" {
		fmt.Sscanf(l, "%d", &limit)
	}
	if o := q.Get("offset"); o != "" {
		fmt.Sscanf(o, "%d", &offset)
	}

	ops, total := scanOperations(squad, status, keyword, limit, offset)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"operations": ops,
		"total":      total,
	})
}

func handleSquads(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(listSquads())
}

// opDir returns the filesystem path for a given operation ID.
func opDir(opID string) (string, error) {
	op, err := operation.Find(opID)
	if err != nil {
		return "", err
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".swat", "squads", op.Squad, "operations", opID), nil
}

// handleOpFiles returns a JSON array of non-hidden file names in the operation directory.
func handleOpFiles(w http.ResponseWriter, r *http.Request) {
	opID := r.URL.Query().Get("op")
	if opID == "" {
		http.Error(w, "missing op", 400)
		return
	}
	dir, err := opDir(opID)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "not found", 404)
		} else {
			http.Error(w, "internal error", 500)
		}
		return
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		files = append(files, e.Name())
	}
	if files == nil {
		files = []string{}
	}
	json.NewEncoder(w).Encode(files)
}

func handleOpFile(w http.ResponseWriter, r *http.Request) {
	opId := r.URL.Query().Get("op")
	file := r.URL.Query().Get("file")
	if opId == "" || file == "" {
		http.Error(w, "missing op or file", 400)
		return
	}
	// Sanitize filename
	file = filepath.Base(file)
	content, err := readOpFile(opId, file)
	if err != nil {
		http.Error(w, "not found", 404)
		return
	}
	if strings.EqualFold(filepath.Ext(file), ".md") {
		content = stripYAMLFrontmatter(content)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(content))
}

func handleRuntimes(w http.ResponseWriter, r *http.Request) {
	active := ""
	if sessionStore != nil {
		active = sessionStore.ActiveRuntime()
	}
	runtimes := []map[string]interface{}{}
	for _, rt := range []struct{ name, cmd string }{
		{"copilot", "copilot"},
		{"gemini", "gemini"},
	} {
		_, err := exec.LookPath(rt.cmd)
		entry := map[string]interface{}{
			"name":      rt.name,
			"available": err == nil,
			"active":    rt.name == active,
		}
		entry["session_id"] = sessionIDFor(rt.name)
		runtimes = append(runtimes, entry)
	}
	json.NewEncoder(w).Encode(runtimes)
}

// handleRuntimeSwitch atomically tears down the current active PTY and brings
// up a new one for ?to=<runtime>. Concurrent calls return 409 instead of
// queueing so the UI can surface the contention as a toast.
func handleRuntimeSwitch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	to := r.URL.Query().Get("to")
	if to != "copilot" && to != "gemini" {
		http.Error(w, "unknown runtime", http.StatusBadRequest)
		return
	}
	if sessionStore == nil {
		http.Error(w, "session store not initialised", http.StatusInternalServerError)
		return
	}

	if !switchMu.TryLock() {
		http.Error(w, "switch already in progress", http.StatusConflict)
		return
	}
	defer switchMu.Unlock()

	current := sessionStore.ActiveRuntime()
	if to == current {
		// No-op: report current state. We still validate that the active PTY
		// actually exists; if it doesn't, fall through to spawn.
		sessionsMu.Lock()
		_, exists := sessions[to]
		sessionsMu.Unlock()
		if exists {
			writeSwitchResponse(w, to, sessionIDFor(to))
			return
		}
	}

	if _, err := lookPathFn(to); err != nil {
		http.Error(w, fmt.Sprintf("%s CLI not available on PATH", to), http.StatusBadRequest)
		return
	}

	// IMPORTANT: SetActive(to) MUST happen before the outgoing PTY teardown.
	// handleSessionWS rejects upgrades whose runtime != active BEFORE
	// upgrading, and getOrCreateSession re-checks under sessionsMu, so
	// flipping the active marker first guarantees that any WS connection
	// arriving for `current` during the multi-second teardown window
	// cannot race ahead and respawn an orphan PTY for the outgoing
	// runtime (preserving the single-active-runtime invariant — both the
	// pre-upgrade gate and the post-lock gate must agree). If
	// SetActive fails we abort cleanly with the old PTY still intact.
	if err := sessionStore.SetActive(to); err != nil {
		log.Printf("handleRuntimeSwitch: persist active=%s: %v", to, err)
		http.Error(w, "failed to persist new active runtime", http.StatusInternalServerError)
		return
	}

	// Tear down the previously-active PTY (if any). We snapshot under
	// sessionsMu but call Terminate / CloseAll outside the lock — Terminate
	// can block for several seconds and we don't want to block other
	// session-map readers (e.g. /api/runtimes).
	sessionsMu.Lock()
	curSess := sessions[current]
	curBc := broadcasters[current]
	delete(sessions, current)
	delete(broadcasters, current)
	sessionsMu.Unlock()

	if curSess != nil {
		terminatePTYFn(curSess, 3*time.Second)
	}
	if curBc != nil {
		curBc.CloseAll()
	}

	if err := spawnSessionFn(to); err != nil {
		log.Printf("handleRuntimeSwitch: spawn %s: %v", to, err)
		http.Error(w, fmt.Sprintf("failed to spawn %s: %v", to, err), http.StatusInternalServerError)
		return
	}
	writeSwitchResponse(w, to, sessionIDFor(to))
}

// sessionIDFor returns the stored session ID for runtime. For gemini it uses
// GetGUID (no auto-generation); for copilot it uses GUIDFor (create-on-miss).
func sessionIDFor(runtime string) string {
	if sessionStore == nil {
		return ""
	}
	if runtime == "gemini" {
		return sessionStore.GetGUID(runtime)
	}
	return sessionStore.GUIDFor(runtime)
}

func writeSwitchResponse(w http.ResponseWriter, runtime, sessionID string) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"active":     runtime,
		"session_id": sessionID,
	})
}

func handleSessionWS(w http.ResponseWriter, r *http.Request) {
	rt := r.URL.Query().Get("runtime")
	if rt == "" {
		rt = "copilot"
	}

	// Reject WS for non-active runtimes BEFORE upgrading. The frontend must
	// call POST /api/runtime/switch first; WS never implicitly switches the
	// active runtime (issue #29 contract).
	if sessionStore != nil {
		if active := sessionStore.ActiveRuntime(); active != "" && rt != active {
			http.Error(w, fmt.Sprintf("runtime %q is not active (active=%q)", rt, active), http.StatusConflict)
			return
		}
	}

	prompt := r.URL.Query().Get("prompt")

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	sess, bc, err := getOrCreateSession(rt, prompt)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("Error: %v", err)))
		return
	}

	// Subscribe to broadcaster
	subID, ch := bc.Subscribe()
	defer bc.Unsubscribe(subID)

	// Broadcaster → WebSocket
	done := make(chan struct{})
	go func() {
		defer close(done)
		for data := range ch {
			if err := conn.WriteMessage(websocket.BinaryMessage, data); err != nil {
				return
			}
		}
	}()

	// WebSocket → PTY
	for {
		select {
		case <-done:
			return
		default:
		}

		_, msg, err := conn.ReadMessage()
		if err != nil {
			return // Client disconnected, but PTY stays alive
		}

		var resize struct {
			Type string `json:"type"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
		}
		if json.Unmarshal(msg, &resize) == nil && resize.Type == "resize" {
			sess.Resize(resize.Cols, resize.Rows)
			continue
		}

		sess.Write(msg)
	}
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	cmd.Start()
}

func main() {
	showVersion := flag.Bool("version", false, "Print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("swat-dashboard %s\n", version)
		os.Exit(0)
	}

	port := "8370"
	if p := os.Getenv("PORT"); p != "" {
		port = p
	}

	// API routes
	http.HandleFunc("/api/stats", handleStats)
	http.HandleFunc("/api/ops", handleOps)
	http.HandleFunc("/api/squads", handleSquads)
	http.HandleFunc("/api/files", handleOpFiles)
	http.HandleFunc("/api/file", handleOpFile)
	http.HandleFunc("/api/runtimes", handleRuntimes)
	http.HandleFunc("/api/runtime/switch", handleRuntimeSwitch)
	http.HandleFunc("/ws/session", handleSessionWS)

	// Static files
	staticFS, _ := fs.Sub(staticFiles, "static")
	http.Handle("/", http.FileServer(http.FS(staticFS)))

	// Load persistent session-id store before spawning anything that depends
	// on --resume <guid>.
	store, err := LoadOrInitStore()
	if err != nil {
		log.Fatalf("Failed to load session store: %v", err)
	}
	sessionStore = store

	// Start
	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Fatalf("Failed to listen on port %s: %v", port, err)
	}

	url := fmt.Sprintf("http://localhost:%s", port)
	fmt.Printf("SWAT Dashboard %s running at %s\n", version, url)

	// Auto-start the single active CLI session (one runtime at a time).
	autoStartActiveSession()

	openBrowser(url)

	// Graceful shutdown: cleanly terminate the active PTY (and any others
	// that may have been spawned) before exiting so we don't leave orphaned
	// CLI processes around.
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		fmt.Println("\nShutting down...")
		shutdownSessions()
		listener.Close()
		os.Exit(0)
	}()

	log.Fatal(http.Serve(listener, nil))
}

// shutdownSessions terminates every live PTY with a short bounded timeout so
// we don't leave orphaned CLI processes when the dashboard exits. Safe to
// call multiple times.
func shutdownSessions() {
	sessionsMu.Lock()
	snapshot := make([]*platformPTY, 0, len(sessions))
	bcs := make([]*Broadcaster, 0, len(broadcasters))
	for k, s := range sessions {
		snapshot = append(snapshot, s)
		if bc, ok := broadcasters[k]; ok {
			bcs = append(bcs, bc)
		}
		delete(sessions, k)
		delete(broadcasters, k)
	}
	sessionsMu.Unlock()
	for _, s := range snapshot {
		s.Terminate(2 * time.Second)
	}
	for _, bc := range bcs {
		bc.CloseAll()
	}
}
