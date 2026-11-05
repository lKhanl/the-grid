//go:build !windows

package term

import (
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/creack/pty"
)

type unixPTY struct {
	f   *os.File
	cmd *exec.Cmd
}

func startPTY(argv []string, cwd string, env []string, cols, rows int) (ptyProc, error) {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = env
	// pty.Start puts the shell in its own session, so the shell's pid is
	// also its process group id: kill(-pid) reaches everything it started.
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	return &unixPTY{f: f, cmd: cmd}, nil
}

func (p *unixPTY) Read(b []byte) (int, error)  { return p.f.Read(b) }
func (p *unixPTY) Write(b []byte) (int, error) { return p.f.Write(b) }
func (p *unixPTY) Pid() int                    { return p.cmd.Process.Pid }

func (p *unixPTY) Resize(cols, rows int) error {
	return pty.Setsize(p.f, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

func (p *unixPTY) Wait() int {
	err := p.cmd.Wait()
	if p.cmd.ProcessState != nil {
		if ws, ok := p.cmd.ProcessState.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return p.cmd.ProcessState.ExitCode()
	}
	if err != nil {
		return -1
	}
	return 0
}

// Kill hangs up the shell (it passes SIGHUP on to its jobs, which live in
// their own process groups) and then kills its group for good measure.
func (p *unixPTY) Kill() {
	pid := p.cmd.Process.Pid
	syscall.Kill(pid, syscall.SIGHUP)
	syscall.Kill(-pid, syscall.SIGHUP)
	time.AfterFunc(2*time.Second, func() { syscall.Kill(-pid, syscall.SIGKILL) })
}

// Hangup: on Unix the master reports EOF by itself once the shell and its
// children have closed the terminal.
func (p *unixPTY) Hangup() {}

func (p *unixPTY) Close() { p.f.Close() }
