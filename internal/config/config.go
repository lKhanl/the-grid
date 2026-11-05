// Package config loads and validates grid.yaml.
package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// Config is the whole grid.yaml file.
type Config struct {
	Name         string
	Env          map[string]string
	EnvFile      string
	Runtimes     map[string]*Runtime
	RuntimeOrder []string
	Services     []Service
	Path         string // absolute path of the loaded file
	Dir          string // directory of the loaded file
}

// Runtime is a named tool installation (a JDK, Maven, Node, ...) that
// services can opt into instead of whatever is on the system PATH.
type Runtime struct {
	Name string            `yaml:"-"`
	Type string            `yaml:"type"` // java | maven | node | gradle | generic (inferred from the name)
	Home string            `yaml:"home"`
	Bin  string            `yaml:"bin"` // optional, defaults per type
	Env  map[string]string `yaml:"env"`
}

// StringList accepts either `key: value` or `key: [a, b]`.
type StringList []string

func (l *StringList) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		if n.Value != "" {
			*l = StringList{n.Value}
		}
		return nil
	}
	var list []string
	if err := n.Decode(&list); err != nil {
		return err
	}
	*l = list
	return nil
}

// Service is a single runnable entry.
type Service struct {
	Name        string            `yaml:"-"`
	Group       string            `yaml:"group"`
	Description string            `yaml:"description"`
	Type        string            `yaml:"type"` // spring-boot | node | script | custom (default)
	Command     string            `yaml:"command"`
	Spring      *SpringOpts       `yaml:"spring"`
	Node        *NodeOpts         `yaml:"node"`
	Script      *ScriptOpts       `yaml:"script"`
	Cwd         string            `yaml:"cwd"`
	Shell       string            `yaml:"shell"`
	Env         map[string]string `yaml:"env"`
	EnvFile     string            `yaml:"env_file"`
	Encoding    string            `yaml:"encoding"` // auto | utf-8 | cp1254
	DependsOn   []string          `yaml:"depends_on"`
	Ready       *Ready            `yaml:"ready"`
	Restart     string            `yaml:"restart"` // no | on-failure | always
	MaxRestarts int               `yaml:"max_restarts"`
	Autostart   bool              `yaml:"autostart"`
	StopTimeout time.Duration     `yaml:"stop_timeout"`
	URL         string            `yaml:"url"`
	Color       *bool             `yaml:"color"`
	Runtime     StringList        `yaml:"runtime"` // names from the top-level `runtimes`

	ReadyRegexp *regexp.Regexp `yaml:"-"`
}

// Ready describes how to detect that a service finished starting.
type Ready struct {
	Port    int           `yaml:"port"`
	Log     string        `yaml:"log"`
	Timeout time.Duration `yaml:"timeout"`
}

type rawConfig struct {
	Name     string            `yaml:"name"`
	Env      map[string]string `yaml:"env"`
	EnvFile  string            `yaml:"env_file"`
	Runtimes yaml.Node         `yaml:"runtimes"`
	Services yaml.Node         `yaml:"services"`
}

// Load reads, normalizes and validates the config file at path.
func Load(path string) (*Config, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	var raw rawConfig
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("%s: %w", abs, err)
	}

	cfg := &Config{
		Name: raw.Name,
		Env:  raw.Env,
		Path: abs,
		Dir:  filepath.Dir(abs),
	}
	if cfg.Name == "" {
		cfg.Name = filepath.Base(cfg.Dir)
	}
	if raw.EnvFile != "" {
		cfg.EnvFile = resolvePath(cfg.Dir, raw.EnvFile)
	}

	cfg.Runtimes = map[string]*Runtime{}
	if raw.Runtimes.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(raw.Runtimes.Content); i += 2 {
			key, val := raw.Runtimes.Content[i], raw.Runtimes.Content[i+1]
			rt := &Runtime{}
			if err := val.Decode(rt); err != nil {
				return nil, fmt.Errorf("runtime %q: %w", key.Value, err)
			}
			rt.Name = key.Value
			if err := normalizeRuntime(cfg.Dir, rt); err != nil {
				return nil, fmt.Errorf("runtime %q: %w", rt.Name, err)
			}
			cfg.Runtimes[rt.Name] = rt
			cfg.RuntimeOrder = append(cfg.RuntimeOrder, rt.Name)
		}
	} else if raw.Runtimes.Kind != 0 {
		return nil, fmt.Errorf("%s: 'runtimes' must be a mapping of name -> runtime", abs)
	}

	if raw.Services.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s: 'services' must be a mapping of name -> service", abs)
	}
	seen := map[string]bool{}
	for i := 0; i+1 < len(raw.Services.Content); i += 2 {
		key, val := raw.Services.Content[i], raw.Services.Content[i+1]
		var s Service
		if err := val.Decode(&s); err != nil {
			return nil, fmt.Errorf("service %q: %w", key.Value, err)
		}
		s.Name = key.Value
		if seen[s.Name] {
			return nil, fmt.Errorf("service %q defined twice", s.Name)
		}
		seen[s.Name] = true
		if err := normalize(cfg.Dir, &s); err != nil {
			return nil, fmt.Errorf("service %q: %w", s.Name, err)
		}
		if err := checkServiceRuntimes(cfg, &s); err != nil {
			return nil, fmt.Errorf("service %q: %w", s.Name, err)
		}
		cfg.Services = append(cfg.Services, s)
	}
	if err := validateDeps(cfg.Services); err != nil {
		return nil, err
	}
	return cfg, nil
}

func normalize(dir string, s *Service) error {
	if s.Cwd == "" {
		s.Cwd = dir
	} else {
		s.Cwd = resolvePath(dir, s.Cwd)
	}
	if err := normalizeType(s); err != nil {
		return err
	}
	if s.EnvFile != "" {
		s.EnvFile = resolvePath(dir, s.EnvFile)
	}
	switch strings.ToLower(s.Encoding) {
	case "", "auto":
		s.Encoding = "auto"
	case "utf-8", "utf8":
		s.Encoding = "utf-8"
	case "cp1254", "windows-1254":
		s.Encoding = "cp1254"
	default:
		return fmt.Errorf("unknown encoding %q (use auto, utf-8 or cp1254)", s.Encoding)
	}
	switch s.Restart {
	case "", "no", "never":
		s.Restart = "no"
	case "on-failure", "always":
	default:
		return fmt.Errorf("unknown restart policy %q (use no, on-failure or always)", s.Restart)
	}
	if s.MaxRestarts <= 0 {
		s.MaxRestarts = 5
	}
	if s.StopTimeout <= 0 {
		s.StopTimeout = 10 * time.Second
	}
	if s.Ready != nil {
		if s.Ready.Port == 0 && s.Ready.Log == "" {
			return fmt.Errorf("'ready' needs 'port' or 'log'")
		}
		if s.Ready.Log != "" {
			re, err := regexp.Compile(s.Ready.Log)
			if err != nil {
				return fmt.Errorf("ready.log: %w", err)
			}
			s.ReadyRegexp = re
		}
		if s.Ready.Timeout <= 0 {
			s.Ready.Timeout = 3 * time.Minute
		}
	}
	return nil
}

func validateDeps(services []Service) error {
	byName := map[string]*Service{}
	for i := range services {
		byName[services[i].Name] = &services[i]
	}
	for _, s := range services {
		for _, d := range s.DependsOn {
			if _, ok := byName[d]; !ok {
				return fmt.Errorf("service %q depends on unknown service %q", s.Name, d)
			}
		}
	}
	const (
		white = iota
		grey
		black
	)
	color := map[string]int{}
	var visit func(name string, path []string) error
	visit = func(name string, path []string) error {
		switch color[name] {
		case grey:
			return fmt.Errorf("dependency cycle: %s -> %s", strings.Join(path, " -> "), name)
		case black:
			return nil
		}
		color[name] = grey
		for _, d := range byName[name].DependsOn {
			if err := visit(d, append(path, name)); err != nil {
				return err
			}
		}
		color[name] = black
		return nil
	}
	for _, s := range services {
		if err := visit(s.Name, nil); err != nil {
			return err
		}
	}
	return nil
}

func resolvePath(base, p string) string {
	p = os.ExpandEnv(p)
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, p[1:])
		}
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(base, p)
	}
	return filepath.Clean(p)
}

// ReadEnvFile parses KEY=VALUE lines (with optional "export " and quotes).
func ReadEnvFile(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		out[k] = v
	}
	return out, sc.Err()
}
