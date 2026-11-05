package config

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Known runtime types. The type decides which *_HOME variable is set and
// which executable must exist; every type puts its bin dir first on PATH.
var runtimeTypes = map[string]struct {
	homeVars []string
	exe      string // checked inside the bin dir ("" = no check)
}{
	"java": {[]string{"JAVA_HOME"}, "java"},
	"node": {nil, "node"},
	// script: any tool folder (Maven, Gradle, Python, own scripts). Only
	// its bin dir (or the folder itself) goes first on PATH.
	"script": {nil, ""},
}

// RuntimeTypes lists the types in display order.
var RuntimeTypes = []string{"java", "node", "script"}

// inferType guesses the type from names like java-17, jdk11, node20.
func inferType(name string) string {
	n := strings.ToLower(name)
	for _, p := range []struct{ prefix, typ string }{
		{"java", "java"}, {"jdk", "java"}, {"jre", "java"}, {"node", "node"},
	} {
		if strings.HasPrefix(n, p.prefix) {
			return p.typ
		}
	}
	return "script"
}

func normalizeRuntime(dir string, rt *Runtime) error {
	if strings.TrimSpace(rt.Home) == "" {
		return fmt.Errorf("'home' is required")
	}
	rt.Home = resolvePath(dir, rt.Home)
	rt.Type = strings.ToLower(strings.TrimSpace(rt.Type))
	if rt.Type == "" {
		rt.Type = inferType(rt.Name)
	}
	if _, ok := runtimeTypes[rt.Type]; !ok {
		return fmt.Errorf("unknown type %q (use java, node or script)", rt.Type)
	}
	if rt.Bin != "" {
		rt.Bin = resolvePath(rt.Home, rt.Bin)
	}
	return nil
}

func checkServiceRuntimes(cfg *Config, s *Service) error {
	seen := map[string]string{}
	for _, name := range s.Runtime {
		rt, ok := cfg.Runtimes[name]
		if !ok {
			return fmt.Errorf("unknown runtime %q (define it under 'runtimes')", name)
		}
		if rt.Type != "script" {
			if other, dup := seen[rt.Type]; dup {
				return fmt.Errorf("runtimes %q and %q are both %s; pick one", other, name, rt.Type)
			}
			seen[rt.Type] = name
		}
	}
	return nil
}

// BinDir is the directory that goes first on PATH.
func (rt *Runtime) BinDir() string {
	if rt.Bin != "" {
		return rt.Bin
	}
	bin := filepath.Join(rt.Home, "bin")
	if rt.Type == "node" || rt.Type == "script" {
		// The Windows node zip has node.exe directly in the home folder.
		if _, err := os.Stat(bin); err != nil {
			return rt.Home
		}
	}
	return bin
}

// Executable returns the main tool path, or "" for script runtimes.
func (rt *Runtime) Executable() string {
	exe := runtimeTypes[rt.Type].exe
	if exe == "" {
		return ""
	}
	dir := rt.BinDir()
	if runtime.GOOS == "windows" {
		for _, ext := range []string{".exe", ".cmd", ".bat"} {
			if p := filepath.Join(dir, exe+ext); fileExists(p) {
				return p
			}
		}
		return filepath.Join(dir, exe+".exe")
	}
	return filepath.Join(dir, exe)
}

// Check verifies that the installation exists.
func (rt *Runtime) Check() error {
	if _, err := os.Stat(rt.Home); err != nil {
		return fmt.Errorf("home %s not found", rt.Home)
	}
	if exe := rt.Executable(); exe != "" && !fileExists(exe) {
		return fmt.Errorf("%s not found", exe)
	}
	return nil
}

// Vars returns the *_HOME variables plus the runtime's own env.
func (rt *Runtime) Vars() map[string]string {
	vars := map[string]string{}
	for _, k := range runtimeTypes[rt.Type].homeVars {
		vars[k] = rt.Home
	}
	for k, v := range rt.Env {
		vars[k] = v
	}
	return vars
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

var versionRe = regexp.MustCompile(`\d+(\.\d+)+`)

// Version runs `java -version` / `node --version` and returns the first
// meaningful output line ("" for script runtimes or when it fails).
func (rt *Runtime) Version() string {
	var arg string
	switch rt.Type {
	case "java":
		arg = "-version"
	case "node":
		arg = "--version"
	default:
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	c := exec.CommandContext(ctx, rt.Executable(), arg)
	env := os.Environ()
	for k, v := range rt.Vars() {
		env = append(env, k+"="+v)
	}
	c.Env = env
	out, _ := c.CombinedOutput()
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "Picked up") && versionRe.MatchString(line) {
			return line
		}
	}
	return ""
}

// ProbeResult describes a runtime folder as the form sees it.
type ProbeResult struct {
	Home    string   `json:"home"`
	BinDir  string   `json:"binDir"`
	Exe     string   `json:"exe,omitempty"`
	Exists  bool     `json:"exists"`
	Error   string   `json:"error,omitempty"`
	Version string   `json:"version,omitempty"`
	Tools   []string `json:"tools,omitempty"` // script: executables found in the bin dir
}

// ProbeRuntime resolves home/bin relative to dir and checks the folder.
func ProbeRuntime(dir, typ, home, bin string) ProbeResult {
	rt := &Runtime{Name: "probe", Type: typ, Home: home, Bin: bin}
	if err := normalizeRuntime(dir, rt); err != nil {
		return ProbeResult{Error: err.Error()}
	}
	res := ProbeResult{Home: rt.Home, BinDir: rt.BinDir(), Exe: rt.Executable()}
	if st, err := os.Stat(rt.Home); err == nil && st.IsDir() {
		res.Exists = true
	}
	if err := rt.Check(); err != nil {
		res.Error = err.Error()
		return res
	}
	if rt.Type == "script" {
		res.Tools = listTools(res.BinDir)
		return res
	}
	res.Version = rt.Version()
	return res
}

func listTools(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if runtime.GOOS == "windows" {
			ext := strings.ToLower(filepath.Ext(name))
			if ext != ".exe" && ext != ".cmd" && ext != ".bat" && ext != ".ps1" {
				continue
			}
			name = strings.TrimSuffix(name, filepath.Ext(name))
		} else if info, err := e.Info(); err != nil || info.Mode()&0o111 == 0 {
			continue
		}
		if indexOf(out, name) < 0 {
			out = append(out, name)
		}
		if len(out) == 12 {
			break
		}
	}
	return out
}
