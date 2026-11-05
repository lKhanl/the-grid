//go:build !windows

package runner

import (
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

// Each service gets its own process group so the whole tree
// (sh -> npm -> node ...) can be signalled at once.

type proc struct{ pid int }

func buildCmd(shell, command string) *exec.Cmd {
	if shell == "" {
		shell = "/bin/sh"
	}
	var c *exec.Cmd
	switch strings.ToLower(filepath.Base(shell)) {
	case "powershell", "pwsh":
		c = exec.Command(shell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command)
	default:
		c = exec.Command(shell, "-c", command)
	}
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return c
}

func startProc(c *exec.Cmd) (*proc, error) {
	if err := c.Start(); err != nil {
		return nil, err
	}
	return &proc{pid: c.Process.Pid}, nil
}

func (p *proc) terminate() { syscall.Kill(-p.pid, syscall.SIGTERM) }

func (p *proc) kill() { syscall.Kill(-p.pid, syscall.SIGKILL) }

// release kills anything left in the group after the main process exited.
func (p *proc) release() { syscall.Kill(-p.pid, syscall.SIGKILL) }
