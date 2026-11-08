package runner

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/lKhanl/the-grid/internal/config"
)

type Status string

const (
	Stopped  Status = "stopped"
	Starting Status = "starting"
	Building Status = "building" // running the build step before the app
	Running  Status = "running"
	Stopping Status = "stopping"
	Exited   Status = "exited"  // finished with code 0
	Crashed  Status = "crashed" // finished with non-zero code or failed to start
)

// Info is the public, JSON-friendly view of a service.
type Info struct {
	Name        string   `json:"name"`
	Group       string   `json:"group"`
	Description string   `json:"description,omitempty"`
	Status      Status   `json:"status"`
	PID         int      `json:"pid,omitempty"`
	ExitCode    *int     `json:"exitCode,omitempty"`
	StartedAt   int64    `json:"startedAt,omitempty"`
	Restarts    int      `json:"restarts"`
	Type        string   `json:"type"`
	Build       string   `json:"build,omitempty"` // build step preview
	Command     string   `json:"command"`         // run command preview
	Cwd         string   `json:"cwd"`
	URL         string   `json:"url,omitempty"`
	DependsOn   []string `json:"dependsOn,omitempty"`
	Ready       string   `json:"ready,omitempty"`
	Runtimes    []string `json:"runtimes,omitempty"`
	NoChanges   bool     `json:"noChanges,omitempty"` // left out of the Changes view
	// CPU is the process tree's CPU use in percent of one core, Mem its
	// resident memory in bytes; both only while a process runs.
	CPU     *float64 `json:"cpu,omitempty"`
	Mem     uint64   `json:"mem,omitempty"`
	LogFile string   `json:"logFile,omitempty"` // where the log is also written
}

type Service struct {
	name string
	mgr  *Manager
	logs *LogBuffer

	mu            sync.Mutex
	cfg           config.Service
	status        Status
	pid           int
	exitCode      *int
	startedAt     time.Time
	restarts      int
	launchSeq     uint64 // log position when the latest start began
	proc          *proc
	done          chan struct{}
	stopRequested bool
	gen           int // bumped for every launch attempt; stale goroutines compare against it
	readyCh       chan struct{}
	readyClosed   bool
	prevBuild     string // previews of the derived commands
	prevRun       string
	wsKey         string // log folder of the workspace (see workspaceKey)
	stats         procStats
}

func newService(m *Manager, cfg config.Service, cfgPath string) *Service {
	s := &Service{name: cfg.Name, mgr: m, status: Stopped, logs: NewLogBuffer(m.LogLines()), wsKey: workspaceKey(cfgPath)}
	s.setConfig(cfg)
	return s
}

func (s *Service) Name() string { return s.name }

func (s *Service) Info() Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	info := Info{
		Name: s.name, Group: s.cfg.Group, Description: s.cfg.Description, Status: s.status,
		PID: s.pid, ExitCode: s.exitCode, Restarts: s.restarts,
		Type: s.cfg.Type, Build: s.prevBuild, Command: s.prevRun, Cwd: s.cfg.Cwd, URL: s.cfg.URL, DependsOn: s.cfg.DependsOn,
		Runtimes: s.cfg.Runtime, NoChanges: !s.cfg.ShowInChanges(),
		LogFile: s.mgr.files.path(s.wsKey, s.name),
	}
	if s.proc != nil && s.stats.proc == s.proc {
		info.Mem = s.stats.mem
		if s.stats.cpuOK {
			cpu := s.stats.cpu
			info.CPU = &cpu
		}
	}
	if !s.startedAt.IsZero() && (s.status == Running || s.status == Starting || s.status == Building || s.status == Stopping) {
		info.StartedAt = s.startedAt.UnixMilli()
	}
	if r := s.cfg.Ready; r != nil {
		if r.Port > 0 {
			info.Ready = "port " + strconv.Itoa(r.Port)
		} else {
			info.Ready = "log /" + r.Log + "/"
		}
	}
	return info
}

func (s *Service) Logs(n int) []Entry { return s.logs.Tail(n) }

// LogsSinceStart returns the last n lines logged since the latest start began
// (the build, the app's output, and Grid's own notes), so an old crash is not mixed in.
func (s *Service) LogsSinceStart(n int) []Entry {
	s.mu.Lock()
	seq := s.launchSeq
	s.mu.Unlock()
	return s.logs.After(seq, n)
}

func (s *Service) ClearLogs() { s.logs.Clear() }

func (s *Service) publish() {
	info := s.Info()
	s.mgr.Hub.Publish(Event{Type: "service", Service: s.name, Info: &info})
}

func (s *Service) appendLog(stream, line string) {
	e := s.logs.Add(stream, line)
	s.mgr.files.write(s.wsKey, s.name, e)
	s.mgr.Hub.Publish(Event{Type: "log", Service: s.name, Entry: &e})
}

func (s *Service) sys(format string, args ...any) { s.appendLog("sys", fmt.Sprintf(format, args...)) }

func (s *Service) active() bool {
	return s.status == Starting || s.status == Building || s.status == Running || s.status == Stopping
}

func (s *Service) closeReadyLocked() {
	if s.readyCh != nil && !s.readyClosed {
		close(s.readyCh)
		s.readyClosed = true
	}
}

// Start builds (if the type has a build step) and launches the service after
// its dependencies are ready. It blocks until the build or the app process
// is spawned (not until it is ready).
func (s *Service) Start() error { return s.start(false) }

// StartNoBuild skips the build step.
func (s *Service) StartNoBuild() error { return s.start(true) }

func (s *Service) start(skipBuild bool) error {
	s.mu.Lock()
	if s.active() {
		s.mu.Unlock()
		return nil
	}
	s.gen++
	gen := s.gen
	s.launchSeq = s.logs.Seq()
	s.stopRequested = false
	s.restarts = 0
	s.exitCode = nil
	s.readyCh, s.readyClosed = make(chan struct{}), false
	s.status = Starting
	cfg := s.cfg
	s.mu.Unlock()
	s.publish()

	for _, dep := range cfg.DependsOn {
		d := s.mgr.Get(dep)
		if d == nil {
			continue
		}
		// Start returns once the dependency is spawned (or already active).
		if err := d.Start(); err != nil {
			s.failStart(gen, fmt.Errorf("dependency %s: %w", dep, err))
			return err
		}
		if !d.isReady() {
			s.sys("waiting for %s ...", dep)
		}
		if err := d.WaitReady(depTimeout(d)); err != nil {
			s.failStart(gen, fmt.Errorf("dependency %s: %w", dep, err))
			return err
		}
	}
	return s.spawn(gen, cfg, skipBuild)
}

func depTimeout(d *Service) time.Duration {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.cfg.Ready != nil {
		return d.cfg.Ready.Timeout + 5*time.Second
	}
	return 30 * time.Second
}

func (s *Service) failStart(gen int, err error) {
	s.mu.Lock()
	if s.gen != gen || (s.status != Starting && s.status != Building) || s.proc != nil {
		s.mu.Unlock()
		return
	}
	s.status = Crashed
	s.closeReadyLocked()
	s.mu.Unlock()
	s.sys("failed to start: %v", err)
	s.publish()
}

func (s *Service) isReady() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status == Running
}

// WaitReady blocks until the service is running (ready) or fails.
func (s *Service) WaitReady(timeout time.Duration) error {
	s.mu.Lock()
	st, ch := s.status, s.readyCh
	s.mu.Unlock()
	switch st {
	case Running:
		return nil
	case Starting, Building:
	default:
		return fmt.Errorf("not running (%s)", st)
	}
	select {
	case <-ch:
	case <-time.After(timeout):
		return fmt.Errorf("not ready after %s", timeout)
	}
	if s.isReady() {
		return nil
	}
	return fmt.Errorf("stopped before becoming ready")
}

func (s *Service) spawn(gen int, cfg config.Service, skipBuild bool) error {
	if _, err := os.Stat(cfg.Cwd); err != nil {
		s.failStart(gen, fmt.Errorf("cwd: %w", err))
		return err
	}
	env, err := s.mgr.environ(cfg)
	if err != nil {
		s.failStart(gen, err)
		return err
	}
	plan := cfg.Plan(skipBuild)
	for _, name := range cfg.Runtime {
		if rt := s.mgr.runtime(name); rt != nil {
			s.sys("runtime %s (%s): %s", name, rt.Type, rt.Home)
		}
	}
	if plan.Build != "" {
		return s.launch(gen, cfg, env, plan, true, plan.Build, plan.BuildCwd)
	}
	if plan.Note != "" {
		s.sys("%s", plan.Note)
	}
	return s.runPhase(gen, cfg, env, plan)
}

func (s *Service) runPhase(gen int, cfg config.Service, env []string, plan *config.Plan) error {
	command, cwd, err := plan.Run()
	if err != nil {
		s.failStart(gen, err)
		return err
	}
	return s.launch(gen, cfg, env, plan, false, command, cwd)
}

// launch starts one process: the build step (build == true) or the app.
func (s *Service) launch(gen int, cfg config.Service, env []string, plan *config.Plan, build bool, command, cwd string) error {
	cmd := buildCmd(cfg.Shell, command)
	cmd.Dir = cwd
	cmd.Env = env
	outR, outW, err := os.Pipe()
	if err != nil {
		s.failStart(gen, err)
		return err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		s.failStart(gen, err)
		return err
	}
	cmd.Stdout, cmd.Stderr = outW, errW

	s.mu.Lock()
	if s.gen != gen || s.stopRequested {
		s.mu.Unlock()
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
		return nil
	}
	p, err := startProc(cmd)
	outW.Close()
	errW.Close()
	if err != nil {
		s.mu.Unlock()
		outR.Close()
		errR.Close()
		s.failStart(gen, err)
		return err
	}
	done := make(chan struct{})
	s.proc, s.done = p, done
	s.pid = cmd.Process.Pid
	s.startedAt = time.Now()
	switch {
	case build:
		s.status = Building
	case cfg.Ready == nil:
		s.status = Running
		s.closeReadyLocked()
	default:
		s.status = Starting
	}
	s.mu.Unlock()

	if build {
		s.sys("building (pid %d): %s", cmd.Process.Pid, command)
	} else {
		s.sys("started pid %d: %s", cmd.Process.Pid, command)
	}
	s.publish()

	var readers sync.WaitGroup
	readers.Add(2)
	go s.read(gen, outR, "out", cfg, !build, &readers)
	go s.read(gen, errR, "err", cfg, !build, &readers)
	if !build && cfg.Ready != nil {
		if cfg.Ready.Port > 0 {
			go s.probePort(gen, cfg.Ready.Port)
		}
		go s.readyTimeout(gen, cfg.Ready.Timeout)
	}
	started := time.Now()
	go func() {
		err := cmd.Wait()
		p.release()
		code := -1
		if cmd.ProcessState != nil {
			code = cmd.ProcessState.ExitCode()
		}
		// Give readers a moment to drain the final output before reporting the exit.
		drained := make(chan struct{})
		go func() { readers.Wait(); close(drained) }()
		select {
		case <-drained:
		case <-time.After(500 * time.Millisecond):
		}
		// Settle the status before releasing Stop(), so Restart sees "stopped".
		if build {
			s.buildDone(gen, code, time.Since(started), cfg, env, plan)
		} else {
			s.exited(gen, code, err)
		}
		close(done)
	}()
	return nil
}

// buildDone continues with the app after a successful build.
func (s *Service) buildDone(gen, code int, took time.Duration, cfg config.Service, env []string, plan *config.Plan) {
	s.mu.Lock()
	if s.gen != gen {
		s.mu.Unlock()
		return
	}
	s.proc, s.pid = nil, 0
	if s.stopRequested {
		s.status = Stopped
		s.closeReadyLocked()
		s.mu.Unlock()
		s.sys("build stopped")
		s.publish()
		return
	}
	if code != 0 {
		s.status = Crashed
		s.exitCode = &code
		s.closeReadyLocked()
		s.mu.Unlock()
		s.sys("build failed (exit %d) after %s; the app was not started", code, took.Round(100*time.Millisecond))
		s.publish()
		return
	}
	s.mu.Unlock()
	if plan.AfterBuild != nil {
		plan.AfterBuild()
	}
	s.sys("build finished in %s", took.Round(100*time.Millisecond))
	s.runPhase(gen, cfg, env, plan)
}

func (s *Service) read(gen int, r io.ReadCloser, stream string, cfg config.Service, app bool, wg *sync.WaitGroup) {
	defer wg.Done()
	defer r.Close()
	br := bufio.NewReaderSize(r, 64*1024)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			line = bytes.TrimRight(line, "\r\n")
			text := decode(line, cfg.Encoding)
			s.appendLog(stream, text)
			if app && cfg.ReadyRegexp != nil && cfg.ReadyRegexp.MatchString(StripANSI(text)) {
				s.markReady(gen, "log matched")
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *Service) markReady(gen int, why string) {
	s.mu.Lock()
	if s.gen != gen || s.status != Starting || s.proc == nil {
		s.mu.Unlock()
		return
	}
	s.status = Running
	s.closeReadyLocked()
	took := time.Since(s.startedAt).Round(100 * time.Millisecond)
	s.mu.Unlock()
	s.sys("ready in %s (%s)", took, why)
	s.publish()
}

func (s *Service) stillStarting(gen int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gen == gen && s.status == Starting
}

func (s *Service) probePort(gen int, port int) {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	for s.stillStarting(gen) {
		if c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond); err == nil {
			c.Close()
			s.markReady(gen, "port "+strconv.Itoa(port)+" open")
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func (s *Service) readyTimeout(gen int, d time.Duration) {
	time.Sleep(d)
	if s.stillStarting(gen) {
		s.sys("still not ready after %s; check the 'ready' setting", d)
	}
}

func (s *Service) exited(gen int, code int, waitErr error) {
	s.mu.Lock()
	if s.gen != gen {
		s.mu.Unlock()
		return
	}
	s.proc, s.pid = nil, 0
	s.exitCode = &code
	s.closeReadyLocked()
	restart := false
	switch {
	case s.stopRequested:
		s.status = Stopped
	case code == 0:
		s.status = Exited
		restart = s.cfg.Restart == "always"
	default:
		s.status = Crashed
		restart = s.cfg.Restart == "always" || s.cfg.Restart == "on-failure"
	}
	if restart && s.restarts >= s.cfg.MaxRestarts {
		restart = false
	}
	if restart {
		s.restarts++
	}
	attempt, max := s.restarts, s.cfg.MaxRestarts
	status := s.status
	s.mu.Unlock()

	if status == Stopped {
		s.sys("stopped")
	} else {
		s.sys("exited with code %d", code)
	}
	s.publish()
	if restart {
		s.sys("restarting in 2s (attempt %d/%d)", attempt, max)
		time.AfterFunc(2*time.Second, func() { s.autoRestart(gen) })
	}
}

func (s *Service) autoRestart(prevGen int) {
	s.mu.Lock()
	if s.gen != prevGen || s.stopRequested || s.active() {
		s.mu.Unlock()
		return
	}
	s.gen++
	gen := s.gen
	s.readyCh, s.readyClosed = make(chan struct{}), false
	s.status = Starting
	cfg := s.cfg
	s.mu.Unlock()
	s.publish()
	s.spawn(gen, cfg, true) // crash restarts reuse the last build
}

// Stop terminates the whole process tree and waits for it to exit.
func (s *Service) Stop() error {
	s.mu.Lock()
	if s.proc == nil {
		// Not spawned yet (waiting for deps) or already finished: cancel pending work.
		s.stopRequested = true
		s.gen++
		wasStarting := s.status == Starting || s.status == Building
		if wasStarting {
			s.status = Stopped
			s.closeReadyLocked()
		}
		s.mu.Unlock()
		if wasStarting {
			s.sys("start cancelled")
			s.publish()
		}
		return nil
	}
	s.stopRequested = true
	s.status = Stopping
	p, done, timeout := s.proc, s.done, s.cfg.StopTimeout
	s.mu.Unlock()
	s.publish()
	s.sys("stopping ...")

	p.terminate()
	select {
	case <-done:
		return nil
	case <-time.After(timeout):
	}
	s.sys("did not stop within %s, killing process tree", timeout)
	p.kill()
	select {
	case <-done:
		return nil
	case <-time.After(5 * time.Second):
		return fmt.Errorf("%s: process did not exit after kill", s.name)
	}
}

func (s *Service) Restart() error {
	if err := s.Stop(); err != nil {
		return err
	}
	return s.Start()
}

func (s *Service) setConfig(cfg config.Service) {
	build, run := cfg.Preview()
	s.mu.Lock()
	s.cfg = cfg
	s.prevBuild, s.prevRun = build, run
	s.mu.Unlock()
}
