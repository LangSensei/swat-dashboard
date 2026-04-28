// +build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/creack/pty"
)

type platformPTY struct {
	cmd  *exec.Cmd
	ptmx *os.File
}

func startPTY(cmd *exec.Cmd) (*platformPTY, error) {
	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}
	return &platformPTY{cmd: cmd, ptmx: ptmx}, nil
}

func (p *platformPTY) Read(buf []byte) (int, error)  { return p.ptmx.Read(buf) }
func (p *platformPTY) Write(data []byte) (int, error) { return p.ptmx.Write(data) }
func (p *platformPTY) Resize(cols, rows int) {
	pty.Setsize(p.ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}
func (p *platformPTY) Close() {
	p.ptmx.Close()
	if p.cmd != nil && p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
}

// Terminate gracefully signals the PTY-attached process and waits up to
// timeout for it to exit before resorting to SIGKILL. The PTY master is
// closed last so the broadcaster's Read loop unblocks once the process is
// gone.
func (p *platformPTY) Terminate(timeout time.Duration) {
	proc := p.cmd.Process
	if proc != nil {
		_ = proc.Signal(syscall.SIGTERM)
	}
	done := make(chan struct{})
	go func() {
		if proc != nil {
			_, _ = proc.Wait()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		if proc != nil {
			_ = proc.Kill()
		}
		<-done
	}
	_ = p.ptmx.Close()
}
