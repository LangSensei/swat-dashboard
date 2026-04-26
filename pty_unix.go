// +build !windows

package main

import (
	"os"
	"os/exec"

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
	p.cmd.Process.Kill()
}
