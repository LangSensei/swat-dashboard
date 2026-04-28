package main

import (
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
	ID          string `json:"id"`
	Squad       string `json:"squad"`
	Status      string `json:"status"`
	Brief       string `json:"brief"`
	Summary     string `json:"summary"`
	CreatedAt   string `json:"created_at"`
	CompletedAt string `json:"completed_at,omitempty"`
	Elapsed     string `json:"elapsed,omitempty"`
}

func opToView(op *operation.Operation) OpView {
	v := OpView{
		ID:      op.OperationID,
		Squad:   op.Squad,
		Status:  op.Status,
		Brief:   op.Brief,
		Summary: op.Summary,
	}
	// The upstream operation package returns Brief/Summary as raw YAML
	// strings; if the YAML used a block-scalar (`|` / `>`) the marker can
	// leak into the UI. Re-parse OPERATION.md with a real YAML parser only
	// when one of the fields actually shows that pattern — this avoids an
	// N+1 file read on every list call for the common (already-clean) case.
	if needsFrontmatterReparse(v.Brief) || needsFrontmatterReparse(v.Summary) {
		if dir, err := opDirForSquad(op.Squad, op.OperationID); err == nil {
			if data, err := os.ReadFile(filepath.Join(dir, "OPERATION.md")); err == nil {
				if meta, _, ok := parseFrontmatter(data); ok {
					if s := frontmatterString(meta, "summary"); s != "" {
						v.Summary = s
					}
					if s := frontmatterString(meta, "brief"); s != "" {
						v.Brief = s
					}
				}
			}
		}
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

	var ops []OpView
	for _, op := range all {
		if squad != "" && op.Squad != squad {
			continue
		}
		if status != "" && op.Status != status {
			continue
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

func containsCI(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

// --- PTY session ---

// --- Default session prompt ---

const defaultPrompt = `You are a SWAT dashboard operator. Wait for user instructions. Do not take any action autonomously. Your role: discuss requirements, review operations, and help dispatch tasks when asked. Workspace: ~/.swat/`

// --- PTY session manager ---

var (
	sessions      = make(map[string]*platformPTY)
	broadcasters  = make(map[string]*Broadcaster)
	sessionsMu    sync.Mutex
)

func getOrCreateSession(runtimeName, prompt string) (*platformPTY, *Broadcaster, error) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()

	if sess, ok := sessions[runtimeName]; ok {
		return sess, broadcasters[runtimeName], nil
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

func autoStartSessions() {
	for _, rt := range []string{"copilot", "gemini"} {
		if _, err := exec.LookPath(rt); err == nil {
			_, _, err := getOrCreateSession(rt, defaultPrompt)
			if err != nil {
				log.Printf("Failed to auto-start %s: %v", rt, err)
			} else {
				log.Printf("Auto-started %s session", rt)
			}
		}
	}
}

func createPTYSession(runtimeName, prompt string) (*platformPTY, error) {
	var cmdName string
	var args []string
	switch runtimeName {
	case "copilot":
		cmdName = "copilot"
	case "gemini":
		cmdName = "gemini"
	default:
		return nil, fmt.Errorf("unknown runtime: %s", runtimeName)
	}

	// Check if CLI exists
	if _, err := exec.LookPath(cmdName); err != nil {
		return nil, fmt.Errorf("%s CLI not found. Please install it first", cmdName)
	}

	if prompt != "" {
		args = append(args, "-i", prompt)
	}
	if cmdName == "gemini" {
		args = append(args, "--skip-trust", "--approval-mode", "yolo")
	} else {
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

// handleStats returns operation counts by status.
func handleStats(w http.ResponseWriter, r *http.Request) {
	all, _ := operation.List()
	counts := map[string]int{"active": 0, "queued": 0, "completed": 0, "failed": 0}
	for _, op := range all {
		counts[op.Status]++
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

// opDirForSquad returns the on-disk directory for an operation given its
// squad. This is the single source of truth for the
// `~/.swat/squads/<squad>/operations/<id>` convention; both opDir and
// opToView share it so any future `swat home` refactor only needs to
// touch one place.
func opDirForSquad(squad, opID string) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".swat", "squads", squad, "operations", opID), nil
}

// opDir returns the filesystem path for a given operation ID.
func opDir(opID string) (string, error) {
	op, err := operation.Find(opID)
	if err != nil {
		return "", err
	}
	return opDirForSquad(op.Squad, opID)
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
	// For OPERATION.md, strip the leading YAML frontmatter so the renderer
	// (marked.js on the frontend) does not display the raw metadata block.
	if file == "OPERATION.md" {
		if _, body, ok := parseFrontmatter([]byte(content)); ok {
			content = body
		}
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(content))
}

func handleRuntimes(w http.ResponseWriter, r *http.Request) {
	runtimes := []map[string]interface{}{}
	for _, rt := range []struct{ name, cmd string }{
		{"copilot", "copilot"},
		{"gemini", "gemini"},
	} {
		_, err := exec.LookPath(rt.cmd)
		runtimes = append(runtimes, map[string]interface{}{
			"name":      rt.name,
			"available": err == nil,
		})
	}
	json.NewEncoder(w).Encode(runtimes)
}

func handleSessionWS(w http.ResponseWriter, r *http.Request) {
	rt := r.URL.Query().Get("runtime")
	if rt == "" {
		rt = "copilot"
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
	http.HandleFunc("/ws/session", handleSessionWS)

	// Static files
	staticFS, _ := fs.Sub(staticFiles, "static")
	http.Handle("/", http.FileServer(http.FS(staticFS)))

	// Start
	listener, err := net.Listen("tcp", ":"+port)
	if err != nil {
		log.Fatalf("Failed to listen on port %s: %v", port, err)
	}

	url := fmt.Sprintf("http://localhost:%s", port)
	fmt.Printf("SWAT Dashboard %s running at %s\n", version, url)

	// Auto-start available CLI sessions
	autoStartSessions()

	openBrowser(url)

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		fmt.Println("\nShutting down...")
		listener.Close()
		os.Exit(0)
	}()

	log.Fatal(http.Serve(listener, nil))
}
