// +build windows

package main

import (
	"fmt"
	"io"
	"os/exec"
	"sync"

	conpty "github.com/UserExistsError/conpty"
)

type platformPTY struct {
	cpty *conpty.ConPty
	cmd  *exec.Cmd
	mu   sync.Mutex
}

func startPTY(cmd *exec.Cmd) (*platformPTY, error) {
	args := append([]string{cmd.Path}, cmd.Args[1:]...)
	cmdLine := ""
	for i, a := range args {
		if i > 0 {
			cmdLine += " "
		}
		cmdLine += a
	}
	cpty, err := conpty.Start(cmdLine, conpty.ConPtyDimensions(120, 30))
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
