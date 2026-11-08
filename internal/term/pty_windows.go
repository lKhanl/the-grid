//go:build windows

package term

import (
	"os"
	"strings"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ConPTY (Windows 10 1809+, no admin needed). The shell runs in a Job Object
// with KILL_ON_JOB_CLOSE so closing a terminal ends everything started in it.
type winPTY struct {
	hpc     windows.Handle
	in      *os.File // we write keystrokes here
	out     *os.File // the console's output
	process windows.Handle
	pid     int
	job     windows.Handle
}

func startPTY(argv []string, cwd string, env []string, cols, rows int) (ptyProc, error) {
	var ptyIn, inW, outR, ptyOut windows.Handle
	if err := windows.CreatePipe(&ptyIn, &inW, nil, 0); err != nil {
		return nil, err
	}
	if err := windows.CreatePipe(&outR, &ptyOut, nil, 0); err != nil {
		windows.CloseHandle(ptyIn)
		windows.CloseHandle(inW)
		return nil, err
	}
	var hpc windows.Handle
	if err := windows.CreatePseudoConsole(coord(cols, rows), ptyIn, ptyOut, 0, &hpc); err != nil {
		for _, h := range []windows.Handle{ptyIn, inW, outR, ptyOut} {
			windows.CloseHandle(h)
		}
		return nil, err
	}
	// The console holds its own copies of these ends.
	windows.CloseHandle(ptyIn)
	windows.CloseHandle(ptyOut)
	p := &winPTY{hpc: hpc, in: os.NewFile(uintptr(inW), "conpty-in"), out: os.NewFile(uintptr(outR), "conpty-out")}
	if err := p.spawn(argv, cwd, env); err != nil {
		p.Close()
		return nil, err
	}
	return p, nil
}

func (p *winPTY) spawn(argv []string, cwd string, env []string) error {
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return err
	}
	defer attrs.Delete()
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, *(*unsafe.Pointer)(unsafe.Pointer(&p.hpc)), unsafe.Sizeof(p.hpc)); err != nil {
		return err
	}
	si := &windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(*si))
	si.Flags = windows.STARTF_USESTDHANDLES // with no handles: the child talks only to the pseudo console

	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(argv))
	if err != nil {
		return err
	}
	var dir *uint16
	if cwd != "" {
		if dir, err = windows.UTF16PtrFromString(cwd); err != nil {
			return err
		}
	}
	block := envBlock(env)
	var pi windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_SUSPENDED)
	if err := windows.CreateProcess(nil, cmdLine, nil, nil, false, flags, &block[0], dir, &si.StartupInfo, &pi); err != nil {
		return err
	}
	defer windows.CloseHandle(pi.Thread)
	p.process = pi.Process
	p.pid = int(pi.ProcessId)
	if job, err := killOnCloseJob(); err == nil {
		if windows.AssignProcessToJobObject(job, pi.Process) == nil {
			p.job = job
		} else {
			windows.CloseHandle(job)
		}
	}
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		windows.TerminateProcess(pi.Process, 1)
		return err
	}
	return nil
}

func killOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

// envBlock builds a sorted-as-given, double-NUL-terminated UTF-16 block.
func envBlock(env []string) []uint16 {
	var b []uint16
	for _, kv := range env {
		if strings.IndexByte(kv, 0) >= 0 {
			continue
		}
		b = append(b, utf16.Encode([]rune(kv))...)
		b = append(b, 0)
	}
	if len(b) == 0 {
		b = append(b, 0)
	}
	return append(b, 0)
}

func coord(cols, rows int) windows.Coord {
	return windows.Coord{X: int16(cols), Y: int16(rows)}
}

func (p *winPTY) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p *winPTY) Write(b []byte) (int, error) { return p.in.Write(b) }
func (p *winPTY) Pid() int                    { return p.pid }

func (p *winPTY) Resize(cols, rows int) error {
	return windows.ResizePseudoConsole(p.hpc, coord(cols, rows))
}

func (p *winPTY) Wait() int {
	windows.WaitForSingleObject(p.process, windows.INFINITE)
	var code uint32
	if windows.GetExitCodeProcess(p.process, &code) != nil {
		return -1
	}
	return int(code)
}

func (p *winPTY) Kill() {
	if p.job != 0 {
		windows.TerminateJobObject(p.job, 1)
	} else if p.process != 0 {
		windows.TerminateProcess(p.process, 1)
	}
}

// Hangup tears the console down; the output pipe then reports EOF.
func (p *winPTY) Hangup() {
	if p.hpc != 0 {
		windows.ClosePseudoConsole(p.hpc)
		p.hpc = 0
	}
}

func (p *winPTY) Close() {
	p.Hangup()
	p.in.Close()
	p.out.Close()
	if p.job != 0 {
		windows.CloseHandle(p.job) // KILL_ON_JOB_CLOSE: nothing outlives the terminal
		p.job = 0
	}
	if p.process != 0 {
		windows.CloseHandle(p.process)
		p.process = 0
	}
}
