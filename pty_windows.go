//go:build windows

package main

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	conpty "github.com/UserExistsError/conpty"
)

type platformPTY struct {
	cpty *conpty.ConPty
	cmd  *exec.Cmd
	mu   sync.Mutex
}

func quoteArg(a string) string {
	if strings.ContainsAny(a, " \t\"") {
		return `"` + strings.ReplaceAll(a, `"`, `\"`) + `"`
	}
	return a
}

func startPTY(cmd *exec.Cmd) (*platformPTY, error) {
	resolved, err := exec.LookPath(cmd.Args[0])
	if err != nil {
		resolved = cmd.Args[0]
	}

	var parts []string
	lower := strings.ToLower(resolved)
	isBatch := strings.HasSuffix(lower, ".cmd") || strings.HasSuffix(lower, ".bat")

	if isBatch {
		parts = append(parts, "cmd.exe", "/c")
		parts = append(parts, quoteArg(resolved))
		for _, a := range cmd.Args[1:] {
			parts = append(parts, quoteArg(a))
		}
	} else {
		for _, a := range cmd.Args {
			parts = append(parts, quoteArg(a))
		}
	}

	cmdLine := strings.Join(parts, " ")
	cpty, err := conpty.Start(cmdLine, conpty.ConPtyDimensions(120, 30), conpty.ConPtyWorkDir(cmd.Dir))
	if err != nil {
		return nil, fmt.Errorf("conpty start: %w", err)
	}
	return &platformPTY{cpty: cpty, cmd: cmd}, nil
}

func (p *platformPTY) Read(buf []byte) (int, error) {
	return p.cpty.Read(buf)
}

func (p *platformPTY) Write(data []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	n, err := io.WriteString(p.cpty, string(data))
	return n, err
}

func (p *platformPTY) Resize(cols, rows int) {
	p.cpty.Resize(cols, rows)
}

func (p *platformPTY) Close() {
	p.cpty.Close()
}

// Terminate gracefully signals the conpty-attached process tree (taskkill /T,
// without /F, sends a WM_CLOSE-style request to console processes), waits up
// to timeout for it to exit, and only then escalates to taskkill /T /F. This
// mirrors the Unix SIGTERM → wait → SIGKILL pattern so callers get the same
// "graceful first, then force" contract on both platforms. The pty handle is
// closed last so the broadcaster's Read loop unblocks once the process is
// gone.
func (p *platformPTY) Terminate(timeout time.Duration) {
	pid := p.cpty.Pid()
	if pid != 0 {
		// Step 1: graceful tree termination. Errors are intentionally
		// swallowed because the process may already have exited.
		_ = exec.Command("taskkill", "/T", "/PID", strconv.Itoa(pid)).Run()
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	exited := make(chan struct{})
	go func() {
		_, _ = p.cpty.Wait(ctx)
		close(exited)
	}()

	select {
	case <-exited:
		// Graceful exit (or already dead) within timeout.
	case <-ctx.Done():
		// Timed out — escalate to forceful tree kill.
		if pid != 0 {
			_ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run()
		}
		<-exited
	}
	_ = p.cpty.Close()
}
