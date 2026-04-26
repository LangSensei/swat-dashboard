package main

import (
	"embed"
	"encoding/json"
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

	"github.com/gorilla/websocket"
)

//go:embed static/*
var staticFiles embed.FS

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// --- Operation model ---

type Operation struct {
	ID          string `json:"id"`
	Squad       string `json:"squad"`
	Status      string `json:"status"`
	Brief       string `json:"brief"`
	Summary     string `json:"summary"`
	CreatedAt   string `json:"created_at"`
	CompletedAt string `json:"completed_at,omitempty"`
	Elapsed     string `json:"elapsed,omitempty"`
}

// --- File-system scanner for history ---

func swatHome() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".swat")
}

func scanOperations(squad, status, keyword string, limit, offset int) ([]Operation, int) {
	squadsDir := filepath.Join(swatHome(), "squads")
	var ops []Operation

	squadDirs, _ := os.ReadDir(squadsDir)
	for _, sd := range squadDirs {
		if !sd.IsDir() {
			continue
		}
		if squad != "" && sd.Name() != squad {
			continue
		}
		opsDir := filepath.Join(squadsDir, sd.Name(), "operations")
		opDirs, _ := os.ReadDir(opsDir)
		for _, od := range opDirs {
			if !od.IsDir() {
				continue
			}
			op := parseOperation(filepath.Join(opsDir, od.Name()), sd.Name())
			if op == nil {
				continue
			}
			if status != "" && op.Status != status {
				continue
			}
			if keyword != "" && !containsCI(op.Brief, keyword) && !containsCI(op.Summary, keyword) {
				continue
			}
			ops = append(ops, *op)
		}
	}

	// Sort by ID descending (newest first)
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

func parseOperation(dir, squad string) *Operation {
	opFile := filepath.Join(dir, "OPERATION.md")
	data, err := os.ReadFile(opFile)
	if err != nil {
		return nil
	}
	content := string(data)
	op := &Operation{
		ID:    filepath.Base(dir),
		Squad: squad,
	}

	// Parse frontmatter-style fields
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "status:") {
			op.Status = strings.TrimSpace(strings.TrimPrefix(line, "status:"))
		}
		if strings.HasPrefix(line, "brief:") {
			op.Brief = strings.TrimSpace(strings.TrimPrefix(line, "brief:"))
		}
		if strings.HasPrefix(line, "summary:") {
			op.Summary = strings.TrimSpace(strings.TrimPrefix(line, "summary:"))
		}
		if strings.HasPrefix(line, "created_at:") {
			op.CreatedAt = strings.TrimSpace(strings.TrimPrefix(line, "created_at:"))
		}
		if strings.HasPrefix(line, "completed_at:") {
			op.CompletedAt = strings.TrimSpace(strings.TrimPrefix(line, "completed_at:"))
		}
	}

	// Calculate elapsed
	if op.CreatedAt != "" {
		if start, err := time.Parse(time.RFC3339, op.CreatedAt); err == nil {
			end := time.Now()
			if op.CompletedAt != "" {
				if t, err := time.Parse(time.RFC3339, op.CompletedAt); err == nil {
					end = t
				}
			}
			d := end.Sub(start)
			if d < time.Hour {
				op.Elapsed = fmt.Sprintf("%dm", int(d.Minutes()))
			} else {
				op.Elapsed = fmt.Sprintf("%dh%dm", int(d.Hours()), int(d.Minutes())%60)
			}
		}
	}

	return op
}

func listSquads() []string {
	squadsDir := filepath.Join(swatHome(), "squads")
	entries, _ := os.ReadDir(squadsDir)
	var squads []string
	for _, e := range entries {
		if e.IsDir() {
			squads = append(squads, e.Name())
		}
	}
	return squads
}

func readOpFile(opId, filename string) (string, error) {
	squadsDir := filepath.Join(swatHome(), "squads")
	squadDirs, _ := os.ReadDir(squadsDir)
	for _, sd := range squadDirs {
		if !sd.IsDir() {
			continue
		}
		path := filepath.Join(squadsDir, sd.Name(), "operations", opId, filename)
		data, err := os.ReadFile(path)
		if err == nil {
			return string(data), nil
		}
	}
	return "", fmt.Errorf("not found")
}

func containsCI(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

// --- PTY session ---

// --- PTY session manager ---

var (
	sessions   = make(map[string]*platformPTY) // runtime -> PTY
	sessionsMu sync.Mutex
)

func getOrCreateSession(runtimeName, prompt string) (*platformPTY, error) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()

	if sess, ok := sessions[runtimeName]; ok {
		return sess, nil
	}

	sess, err := createPTYSession(runtimeName, prompt)
	if err != nil {
		return nil, err
	}
	sessions[runtimeName] = sess
	return sess, nil
}

func removeSession(runtimeName string) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	if sess, ok := sessions[runtimeName]; ok {
		sess.Close()
		delete(sessions, runtimeName)
	}
}

func createPTYSession(runtimeName, prompt string) (*platformPTY, error) {
	var cmd *exec.Cmd
	switch runtimeName {
	case "copilot":
		args := []string{}
		if prompt != "" {
			args = append(args, "-i", prompt)
		}
		args = append(args, "--yolo")
		cmd = exec.Command("copilot", args...)
	case "gemini":
		args := []string{}
		if prompt != "" {
			args = append(args, "-i", prompt)
		}
		args = append(args, "--yolo")
		cmd = exec.Command("gemini", args...)
	default:
		return nil, fmt.Errorf("unknown runtime: %s", runtimeName)
	}
	return startPTY(cmd)
}

// --- HTTP Handlers ---

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
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(content))
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

	sess, err := getOrCreateSession(rt, prompt)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("Error: %v", err)))
		return
	}
	// Note: don't defer sess.Close() — session persists across reconnects

	// PTY → WebSocket
	done := make(chan struct{})
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := sess.Read(buf)
			if n > 0 {
				if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					return
				}
			}
			if err != nil {
				conn.WriteMessage(websocket.TextMessage, []byte("\r\n[Session ended]"))
				removeSession(rt)
				close(done)
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
	port := "8370"
	if p := os.Getenv("PORT"); p != "" {
		port = p
	}

	// API routes
	http.HandleFunc("/api/ops", handleOps)
	http.HandleFunc("/api/squads", handleSquads)
	http.HandleFunc("/api/file", handleOpFile)
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
	fmt.Printf("SWAT Dashboard running at %s\n", url)
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
