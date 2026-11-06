package runner

import (
	"errors"
	"fmt"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/lKhanl/the-grid/internal/config"
)

// Version is the app version shown in the UI (set by main).
var Version = "dev"

// State is a snapshot of everything the UI needs.
type State struct {
	Version    string        `json:"version"`
	Name       string        `json:"name"`
	ConfigPath string        `json:"configPath"`
	Runtimes   []RuntimeInfo `json:"runtimes"`
	Services   []Info        `json:"services"`
}

type RuntimeInfo struct {
	Name  string `json:"name"`
	Type  string `json:"type"`
	Home  string `json:"home"`
	Error string `json:"error,omitempty"`
}

// ConfigPath is the absolute path of the loaded grid.yaml.
func (m *Manager) ConfigPath() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cfg.Path
}

// ConfigDir is the directory relative paths are resolved against.
// With no workspace open it is the user's home folder.
func (m *Manager) ConfigDir() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.cfg.Dir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
	}
	return m.cfg.Dir
}

// runtime looks up a configured runtime by name.
func (m *Manager) runtime(name string) *config.Runtime {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.cfg.Runtimes[name]
}

type Manager struct {
	Hub *Hub

	mu       sync.RWMutex
	cfg      *config.Config
	services []*Service
	byName   map[string]*Service
}

func NewManager(cfg *config.Config) *Manager {
	m := &Manager{Hub: NewHub(), cfg: cfg, byName: map[string]*Service{}}
	for _, sc := range cfg.Services {
		s := newService(m, sc)
		m.services = append(m.services, s)
		m.byName[s.name] = s
	}
	return m
}

func (m *Manager) Services() []*Service {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]*Service(nil), m.services...)
}

func (m *Manager) Get(name string) *Service {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.byName[name]
}

func (m *Manager) State() State {
	m.mu.RLock()
	cfg := m.cfg
	m.mu.RUnlock()
	st := State{Version: Version, Name: cfg.Name, ConfigPath: cfg.Path, Services: []Info{}, Runtimes: []RuntimeInfo{}}
	for _, name := range cfg.RuntimeOrder {
		rt := cfg.Runtimes[name]
		ri := RuntimeInfo{Name: name, Type: rt.Type, Home: rt.Home}
		if err := rt.Check(); err != nil {
			ri.Error = err.Error()
		}
		st.Runtimes = append(st.Runtimes, ri)
	}
	for _, s := range m.Services() {
		st.Services = append(st.Services, s.Info())
	}
	return st
}

// Resolve maps a target to services: "all", a service name or a group name.
func (m *Manager) Resolve(target string) ([]*Service, error) {
	if target == "all" {
		return m.Services(), nil
	}
	if s := m.Get(target); s != nil {
		return []*Service{s}, nil
	}
	var out []*Service
	for _, s := range m.Services() {
		if s.Info().Group == target {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no service or group named %q", target)
	}
	return out, nil
}

// Do runs an action on a target. start/restart run in the background
// (they may wait for dependencies); stop waits for the processes to exit.
func (m *Manager) Do(target, action string) error {
	svcs, err := m.Resolve(target)
	if err != nil {
		return err
	}
	switch action {
	case "start":
		for _, s := range svcs {
			go s.Start()
		}
	case "restart":
		for _, s := range svcs {
			go s.Restart()
		}
	case "start-nobuild":
		for _, s := range svcs {
			go s.StartNoBuild()
		}
	case "stop":
		return stopAll(svcs)
	case "clear":
		for _, s := range svcs {
			s.ClearLogs()
		}
	default:
		return fmt.Errorf("unknown action %q", action)
	}
	return nil
}

func stopAll(svcs []*Service) error {
	var wg sync.WaitGroup
	errs := make([]error, len(svcs))
	for i, s := range svcs {
		wg.Add(1)
		go func() { defer wg.Done(); errs[i] = s.Stop() }()
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

func (m *Manager) Autostart() {
	for _, s := range m.Services() {
		s.mu.Lock()
		auto := s.cfg.Autostart
		s.mu.Unlock()
		if auto {
			go s.Start()
		}
	}
}

func (m *Manager) Shutdown() { stopAll(m.Services()) }

// Reload re-reads the config file. Running services keep running with the
// old settings; the new settings apply on their next start. Services that
// were removed from the file are stopped and dropped.
func (m *Manager) Reload() error {
	m.mu.RLock()
	path := m.cfg.Path
	m.mu.RUnlock()
	if path == "" {
		return errors.New("no workspace open")
	}
	cfg, err := config.Load(path)
	if err != nil {
		return err
	}
	m.mu.Lock()
	old := m.byName
	var removed []*Service
	m.services, m.byName = nil, map[string]*Service{}
	for _, sc := range cfg.Services {
		s, ok := old[sc.Name]
		if ok {
			s.setConfig(sc)
			delete(old, sc.Name)
		} else {
			s = newService(m, sc)
		}
		m.services = append(m.services, s)
		m.byName[sc.Name] = s
	}
	for _, s := range old {
		removed = append(removed, s)
	}
	m.cfg = cfg
	m.mu.Unlock()
	stopAll(removed)
	st := m.State()
	m.Hub.Publish(Event{Type: "snapshot", State: &st})
	return nil
}

// Switch replaces the whole workspace: every running service of the current
// one is stopped, then the config at path is loaded in its place. If the new
// config fails to load nothing changes.
func (m *Manager) Switch(path string) error {
	cfg, err := config.Load(path)
	if err != nil {
		return err
	}
	m.mu.Lock()
	old := m.services
	m.services, m.byName = nil, map[string]*Service{}
	for _, sc := range cfg.Services {
		s := newService(m, sc)
		m.services = append(m.services, s)
		m.byName[sc.Name] = s
	}
	m.cfg = cfg
	m.mu.Unlock()
	stopAll(old)
	st := m.State()
	m.Hub.Publish(Event{Type: "snapshot", State: &st})
	return nil
}

// environ builds the child environment: OS env < global env < env files < service env.
func (m *Manager) environ(sc config.Service) ([]string, error) {
	m.mu.RLock()
	cfg := m.cfg
	m.mu.RUnlock()

	env := newEnvMap(os.Environ())
	if sc.Color == nil || *sc.Color {
		// Most tools disable colors when stdout is a pipe; ask them not to.
		for k, v := range map[string]string{
			"FORCE_COLOR": "1", "CLICOLOR_FORCE": "1",
			"SPRING_OUTPUT_ANSI_ENABLED": "ALWAYS", "PY_COLORS": "1",
		} {
			if _, ok := env.get(k); !ok {
				env.set(k, v)
			}
		}
	}
	if cfg.EnvFile != "" {
		vars, err := config.ReadEnvFile(cfg.EnvFile)
		if err != nil {
			return nil, fmt.Errorf("env_file: %w", err)
		}
		env.merge(vars)
	}
	env.merge(cfg.Env)
	// Runtimes: set JAVA_HOME & co. and put their bin dirs first on PATH,
	// in the order listed, so `java`, `mvn`, `node` resolve to them.
	var bins []string
	for _, name := range sc.Runtime {
		rt := cfg.Runtimes[name]
		if rt == nil {
			return nil, fmt.Errorf("unknown runtime %q", name)
		}
		if err := rt.Check(); err != nil {
			return nil, fmt.Errorf("runtime %s: %w", name, err)
		}
		env.merge(rt.Vars())
		bins = append(bins, rt.BinDir())
	}
	if len(bins) > 0 {
		path, _ := env.get("PATH")
		env.set("PATH", strings.Join(append(bins, path), string(os.PathListSeparator)))
	}
	if sc.EnvFile != "" {
		vars, err := config.ReadEnvFile(sc.EnvFile)
		if err != nil {
			return nil, fmt.Errorf("env_file: %w", err)
		}
		env.merge(vars)
	}
	env.merge(sc.Env)
	return env.list(), nil
}

type envMap struct {
	keys map[string]string // folded key -> original key
	vals map[string]string // folded key -> value
}

func fold(k string) string {
	if runtime.GOOS == "windows" {
		return strings.ToUpper(k)
	}
	return k
}

func newEnvMap(list []string) *envMap {
	e := &envMap{keys: map[string]string{}, vals: map[string]string{}}
	for _, kv := range list {
		if k, v, ok := strings.Cut(kv, "="); ok && k != "" {
			e.set(k, v)
		}
	}
	return e
}

func (e *envMap) get(k string) (string, bool) { v, ok := e.vals[fold(k)]; return v, ok }

func (e *envMap) set(k, v string) {
	f := fold(k)
	if _, ok := e.keys[f]; !ok {
		e.keys[f] = k
	}
	e.vals[f] = v
}

// Only the ${NAME} form is expanded so values such as passwords may contain '$'.
var envRefRe = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// merge sets vars in a stable order; values may reference ${OTHER} vars.
func (e *envMap) merge(vars map[string]string) {
	names := make([]string, 0, len(vars))
	for k := range vars {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		e.set(k, envRefRe.ReplaceAllStringFunc(vars[k], func(ref string) string {
			v, _ := e.get(ref[2 : len(ref)-1])
			return v
		}))
	}
}

func (e *envMap) list() []string {
	out := make([]string, 0, len(e.vals))
	for f, v := range e.vals {
		out = append(out, e.keys[f]+"="+v)
	}
	sort.Strings(out)
	return out
}

// TermEnv is the environment and folder for an interactive terminal: the
// global env plus the given runtimes, or, for a service, exactly what the
// service gets (its env, env files and runtimes) in its folder.
func (m *Manager) TermEnv(service string, runtimes []string) (env []string, cwd string, err error) {
	off := false
	sc := config.Service{Runtime: runtimes, Color: &off}
	cwd = m.ConfigDir()
	if service != "" {
		s := m.Get(service)
		if s == nil {
			return nil, "", fmt.Errorf("unknown service %q", service)
		}
		s.mu.Lock()
		sc = s.cfg
		s.mu.Unlock()
		sc.Color = &off
		cwd = sc.Cwd
	}
	env, err = m.environ(sc)
	return env, cwd, err
}
