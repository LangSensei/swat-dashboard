//go:build windows

package main

import (
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"

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
	// Resolve the actual executable path
	resolved, err := exec.LookPath(cmd.Args[0])
	if err != nil {
		resolved = cmd.Args[0]
	}

	var parts []string
	lower := strings.ToLower(resolved)
	isBatch := strings.HasSuffix(lower, ".cmd") || strings.HasSuffix(lower, ".bat")

	if isBatch {
		// .cmd/.bat: run via cmd.exe, but keep stdin alive
		// Build: cmd.exe /c "full\path\copilot.cmd" -i "prompt" --yolo
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
