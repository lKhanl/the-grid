//go:build windows

package runner

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

// Every service runs inside its own Windows Job Object with
// KILL_ON_JOB_CLOSE: stopping the service (or the runner dying for any
// reason) kills the complete process tree, so no orphan java/node keeps
// holding a port.

var (
	modKernel32                  = syscall.NewLazyDLL("kernel32.dll")
	modNtdll                     = syscall.NewLazyDLL("ntdll.dll")
	procCreateJobObjectW         = modKernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = modKernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = modKernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject       = modKernel32.NewProc("TerminateJobObject")
	procNtResumeProcess          = modNtdll.NewProc("NtResumeProcess")
)

const (
	createSuspended                   = 0x00000004
	createNewProcessGroup             = 0x00000200
	jobObjectExtendedLimitInformation = 9
	jobObjectLimitKillOnJobClose      = 0x00002000
	processTerminate                  = 0x0001
	processSetQuota                   = 0x0100
	processSuspendResume              = 0x0800
)

type jobBasicLimit struct {
	PerProcessUserTimeLimit int64
	PerJobUserTimeLimit     int64
	LimitFlags              uint32
	MinimumWorkingSetSize   uintptr
	MaximumWorkingSetSize   uintptr
	ActiveProcessLimit      uint32
	Affinity                uintptr
	PriorityClass           uint32
	SchedulingClass         uint32
}

type ioCounters struct {
	ReadOperationCount, WriteOperationCount, OtherOperationCount uint64
	ReadTransferCount, WriteTransferCount, OtherTransferCount    uint64
}

type jobExtendedLimit struct {
	BasicLimitInformation jobBasicLimit
	IoInfo                ioCounters
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

type proc struct {
	pid int
	mu  sync.Mutex // guards job against release() while stats read it
	job syscall.Handle
}

func shellKind(shell string) string {
	if strings.TrimSpace(shell) == "" {
		return "cmd" // default shell; don't rely on filepath.Base("")
	}
	base := strings.ToLower(strings.TrimSuffix(filepath.Base(shell), filepath.Ext(shell)))
	switch base {
	case "", "cmd":
		return "cmd"
	case "powershell", "pwsh":
		return "powershell"
	}
	return "posix"
}

// newCmd builds the Cmd with an explicit Path, so a locked-down machine
// (no COMSPEC, odd PATH) can't leave Path empty ("exec: no command").
func newCmd(exe string, args ...string) *exec.Cmd {
	path := exe
	if !strings.ContainsAny(exe, `\/`) {
		if lp, err := exec.LookPath(exe); err == nil && lp != "" {
			path = lp
		} else if root := os.Getenv("SystemRoot"); root != "" && strings.EqualFold(exe, "cmd.exe") {
			path = filepath.Join(root, "System32", "cmd.exe")
		} else if strings.EqualFold(exe, "cmd.exe") {
			path = `C:\Windows\System32\cmd.exe`
		}
	}
	return &exec.Cmd{Path: path, Args: append([]string{exe}, args...)}
}

func buildCmd(shell, command string) *exec.Cmd {
	var c *exec.Cmd
	switch shellKind(shell) {
	case "cmd":
		exe := shell
		if exe == "" || strings.EqualFold(exe, "cmd") {
			if exe = os.Getenv("COMSPEC"); exe == "" {
				exe = "cmd.exe"
			}
		}
		c = newCmd(exe)
		// Raw command line: cmd.exe has its own quoting rules, Go's escaping would break them.
		c.SysProcAttr = &syscall.SysProcAttr{CmdLine: `"` + exe + `" /d /s /c "` + command + `"`}
	case "powershell":
		exe := shell
		if strings.EqualFold(exe, "powershell") || strings.EqualFold(exe, "pwsh") {
			exe += ".exe"
		}
		c = newCmd(exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command)
		c.SysProcAttr = &syscall.SysProcAttr{}
	default: // bash / sh (e.g. Git Bash)
		c = newCmd(shell, "-c", command)
		c.SysProcAttr = &syscall.SysProcAttr{}
	}
	// Suspended so the process can be put into the job before it spawns children.
	c.SysProcAttr.CreationFlags |= createSuspended | createNewProcessGroup
	return c
}

func newKillOnCloseJob() (syscall.Handle, error) {
	r, _, err := procCreateJobObjectW.Call(0, 0)
	if r == 0 {
		return 0, err
	}
	job := syscall.Handle(r)
	var info jobExtendedLimit
	info.BasicLimitInformation.LimitFlags = jobObjectLimitKillOnJobClose
	r, _, err = procSetInformationJobObject.Call(uintptr(job), jobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if r == 0 {
		syscall.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func startProc(c *exec.Cmd) (*proc, error) {
	if err := c.Start(); err != nil {
		return nil, fmt.Errorf("%w [path=%q args=%q dir=%q]", err, c.Path, c.Args, c.Dir)
	}
	p := &proc{pid: c.Process.Pid}
	h, err := syscall.OpenProcess(processTerminate|processSetQuota|processSuspendResume, false, uint32(p.pid))
	if err != nil {
		c.Process.Kill()
		return nil, fmt.Errorf("open process: %w", err)
	}
	defer syscall.CloseHandle(h)
	if job, err := newKillOnCloseJob(); err == nil {
		if r, _, _ := procAssignProcessToJobObject.Call(uintptr(job), uintptr(h)); r != 0 {
			p.job = job
		} else {
			syscall.CloseHandle(job)
		}
	}
	if r, _, err := procNtResumeProcess.Call(uintptr(h)); r != 0 {
		c.Process.Kill()
		return nil, fmt.Errorf("resume process: %v", err)
	}
	return p, nil
}

// terminate: console programs on Windows have no reliable graceful signal
// from a non-console parent, so stopping is a tree kill.
func (p *proc) terminate() { p.kill() }

func (p *proc) kill() {
	p.mu.Lock()
	job := p.job
	p.mu.Unlock()
	if job != 0 {
		procTerminateJobObject.Call(uintptr(job), 1)
		return
	}
	exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(p.pid)).Run()
}

func (p *proc) release() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.job != 0 {
		syscall.CloseHandle(p.job) // kills leftovers thanks to KILL_ON_JOB_CLOSE
		p.job = 0
	}
}
