package config

// Typed services: instead of a raw command, a service may say what it is
// (spring-boot, node, script) and the runner derives the build and run
// commands every time it starts, the way an IDE run configuration does.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// Service types.
const (
	TypeCustom = "custom"
	TypeSpring = "spring-boot"
	TypeNode   = "node"
	TypeScript = "script"
)

// SpringOpts configures a Spring Boot (Maven) service.
type SpringOpts struct {
	Module    string     `yaml:"module"`     // sub-module of a multi-module build ("" = root)
	Profiles  StringList `yaml:"profiles"`   // spring.profiles.active
	JvmArgs   string     `yaml:"jvm_args"`   // e.g. -Xmx1g -Dfoo=bar
	Args      string     `yaml:"args"`       // program arguments
	Mode      string     `yaml:"mode"`       // package (build jar, then java -jar) | run (mvn spring-boot:run)
	SkipTests *bool      `yaml:"skip_tests"` // default true
	Offline   bool       `yaml:"offline"`    // mvn -o
}

// NodeOpts configures a Node service.
type NodeOpts struct {
	Script         string `yaml:"script"`          // package.json script, e.g. dev
	Args           string `yaml:"args"`            // extra args for the script
	Install        string `yaml:"install"`         // if-changed (default) | always | never
	PackageManager string `yaml:"package_manager"` // auto (default) | npm | yarn | pnpm
}

// ScriptOpts configures a script service (.bat, .cmd, .ps1, .sh, .py).
type ScriptOpts struct {
	File string `yaml:"file"`
	Args string `yaml:"args"`
}

// Plan is what the runner executes for one start.
type Plan struct {
	Build      string // "" = nothing to build
	BuildLabel string // e.g. "mvn package"
	BuildCwd   string
	// Run resolves the run command after the build (the jar name is only known then).
	Run        func() (cmd, cwd string, err error)
	AfterBuild func() // called after a successful build
	// Previews for the UI, available before building.
	BuildPreview string
	RunPreview   string
}

func normalizeType(s *Service) error {
	s.Type = strings.ToLower(strings.TrimSpace(s.Type))
	if s.Type == "" {
		s.Type = TypeCustom
	}
	switch s.Type {
	case TypeCustom:
		if strings.TrimSpace(s.Command) == "" {
			return fmt.Errorf("'command' is required")
		}
	case TypeSpring:
		if s.Spring == nil {
			s.Spring = &SpringOpts{}
		}
		switch s.Spring.Mode {
		case "":
			s.Spring.Mode = "package"
		case "package", "run":
		default:
			return fmt.Errorf("spring.mode must be package or run")
		}
	case TypeNode:
		if s.Node == nil || strings.TrimSpace(s.Node.Script) == "" {
			return fmt.Errorf("'node.script' is required (a script from package.json, e.g. dev)")
		}
		switch s.Node.Install {
		case "":
			s.Node.Install = "if-changed"
		case "if-changed", "always", "never":
		default:
			return fmt.Errorf("node.install must be if-changed, always or never")
		}
		switch s.Node.PackageManager {
		case "":
			s.Node.PackageManager = "auto"
		case "auto", "npm", "yarn", "pnpm":
		default:
			return fmt.Errorf("node.package_manager must be auto, npm, yarn or pnpm")
		}
	case TypeScript:
		if s.Script == nil || strings.TrimSpace(s.Script.File) == "" {
			return fmt.Errorf("'script.file' is required")
		}
	default:
		return fmt.Errorf("unknown type %q (use spring-boot, node, script or custom)", s.Type)
	}
	return nil
}

// Plan derives the commands for one start. skipBuild runs without building.
func (s *Service) Plan(skipBuild bool) *Plan { return s.plan(skipBuild, true) }

// Preview returns the build and run commands for display, without touching
// anything but cheap file checks.
func (s *Service) Preview() (build, run string) {
	p := s.plan(false, false)
	return p.BuildPreview, p.RunPreview
}

func (s *Service) plan(skipBuild, check bool) *Plan {
	var p *Plan
	switch s.Type {
	case TypeSpring:
		p = s.springPlan()
	case TypeNode:
		p = s.nodePlan(check && !skipBuild)
	case TypeScript:
		p = s.scriptPlan()
	default:
		cmd, cwd := s.Command, s.Cwd
		p = &Plan{RunPreview: cmd, Run: func() (string, string, error) { return cmd, cwd, nil }}
	}
	if skipBuild {
		p.Build, p.AfterBuild = "", nil
	}
	return p
}

func quote(s string) string {
	if s == "" || strings.ContainsAny(s, " \t&()[]{}^=;!'+,`~%$") {
		return `"` + s + `"`
	}
	return s
}

func join(parts ...string) string {
	var out []string
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			out = append(out, strings.TrimSpace(p))
		}
	}
	return strings.Join(out, " ")
}

// ---- spring boot ----

// mavenCmd prefers the project's wrapper, like IntelliJ does.
func mavenCmd(root string) string {
	if runtime.GOOS == "windows" {
		if fileExists(filepath.Join(root, "mvnw.cmd")) {
			return quote(filepath.Join(root, "mvnw.cmd"))
		}
		return "mvn"
	}
	if fileExists(filepath.Join(root, "mvnw")) {
		return "sh " + quote(filepath.Join(root, "mvnw"))
	}
	return "mvn"
}

func (s *Service) springPlan() *Plan {
	o := s.Spring
	root := s.Cwd
	mod := root
	if o.Module != "" {
		mod = filepath.Join(root, filepath.FromSlash(o.Module))
	}
	mvn := mavenCmd(root)
	flags := "-B -ntp -Dstyle.color=always"
	if o.Offline {
		flags += " -o"
	}
	profiles := strings.Join(o.Profiles, ",")

	if o.Mode == "run" {
		var extra []string
		if profiles != "" {
			extra = append(extra, "-Dspring-boot.run.profiles="+profiles)
		}
		if o.JvmArgs != "" {
			extra = append(extra, `"-Dspring-boot.run.jvmArguments=`+o.JvmArgs+`"`)
		}
		if o.Args != "" {
			extra = append(extra, `"-Dspring-boot.run.arguments=`+o.Args+`"`)
		}
		cmd := join(mvn, flags, "spring-boot:run", strings.Join(extra, " "))
		return &Plan{RunPreview: cmd, Run: func() (string, string, error) { return cmd, mod, nil }}
	}

	skip := o.SkipTests == nil || *o.SkipTests
	build := join(mvn, flags, map[bool]string{true: "-DskipTests"}[skip], "package")
	if o.Module != "" {
		build += " -pl " + quote(o.Module) + " -am"
	}
	runFor := func(jar string) string {
		prof := ""
		if profiles != "" {
			prof = "--spring.profiles.active=" + profiles
		}
		return join("java", o.JvmArgs, "-jar", quote(jar), prof, o.Args)
	}
	rel := filepath.Join(o.Module, "target", "*.jar")
	return &Plan{
		Build: build, BuildLabel: "mvn package", BuildCwd: root,
		BuildPreview: build,
		RunPreview:   runFor(rel),
		Run: func() (string, string, error) {
			jar, err := FindBootJar(filepath.Join(mod, "target"))
			if err != nil {
				return "", "", err
			}
			return runFor(jar), mod, nil
		},
	}
}

// FindBootJar returns the newest runnable jar in dir (skips sources, javadoc, tests, plain).
func FindBootJar(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", fmt.Errorf("no build output: %s not found", dir)
	}
	type cand struct {
		path string
		mod  int64
	}
	var list []cand
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !strings.HasSuffix(n, ".jar") {
			continue
		}
		base := strings.TrimSuffix(n, ".jar")
		if strings.HasSuffix(base, "-sources") || strings.HasSuffix(base, "-javadoc") ||
			strings.HasSuffix(base, "-tests") || strings.HasSuffix(base, "-plain") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		list = append(list, cand{filepath.Join(dir, n), info.ModTime().UnixNano()})
	}
	if len(list) == 0 {
		return "", fmt.Errorf("no jar in %s; is <packaging> jar and spring-boot-maven-plugin set up?", dir)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].mod > list[j].mod })
	return list[0].path, nil
}

// ---- node ----

// PackageManager picks npm / yarn / pnpm from the lock file.
func PackageManager(dir, configured string) string {
	if configured != "" && configured != "auto" {
		return configured
	}
	switch {
	case fileExists(filepath.Join(dir, "pnpm-lock.yaml")):
		return "pnpm"
	case fileExists(filepath.Join(dir, "yarn.lock")):
		return "yarn"
	}
	return "npm"
}

const installStamp = ".grid-install"

func depsHash(dir string) string {
	h := sha256.New()
	for _, f := range []string{"package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"} {
		if b, err := os.ReadFile(filepath.Join(dir, f)); err == nil {
			h.Write([]byte(f))
			h.Write(b)
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

func (s *Service) nodePlan(check bool) *Plan {
	o, dir := s.Node, s.Cwd
	pm := PackageManager(dir, o.PackageManager)
	run := join(pm, "run", o.Script)
	if o.Args != "" {
		if pm == "npm" {
			run += " -- " + o.Args
		} else {
			run += " " + o.Args
		}
	}
	p := &Plan{RunPreview: run, Run: func() (string, string, error) { return run, dir, nil }}
	install := pm + " install"
	stamp := filepath.Join(dir, "node_modules", installStamp)
	switch o.Install {
	case "always":
		p.BuildPreview = install
	case "if-changed":
		p.BuildPreview = install + "   (only when package.json or the lock file changed)"
	default:
		return p
	}
	if !check {
		return p
	}
	need := o.Install == "always"
	if !need {
		old, err := os.ReadFile(stamp)
		need = err != nil || strings.TrimSpace(string(old)) != depsHash(dir)
	}
	if need {
		p.Build, p.BuildLabel, p.BuildCwd = install, pm+" install", dir
		p.AfterBuild = func() {
			os.MkdirAll(filepath.Dir(stamp), 0o755) // a project without deps has no node_modules
			os.WriteFile(stamp, []byte(depsHash(dir)), 0o644)
		}
	}
	return p
}

// ---- script ----

func (s *Service) scriptPlan() *Plan {
	o, dir := s.Script, s.Cwd
	file := o.File
	if !filepath.IsAbs(file) {
		file = filepath.Join(dir, filepath.FromSlash(file))
	}
	var cmd string
	switch strings.ToLower(filepath.Ext(file)) {
	case ".bat", ".cmd":
		cmd = join(quote(file), o.Args)
	case ".ps1":
		ps := "powershell"
		if runtime.GOOS != "windows" {
			ps = "pwsh"
		}
		cmd = join(ps, "-NoLogo -NoProfile -ExecutionPolicy Bypass -File", quote(file), o.Args)
	case ".sh":
		cmd = join("bash", quote(file), o.Args)
	case ".py":
		py := "python3"
		if runtime.GOOS == "windows" {
			py = "py"
		}
		cmd = join(py, quote(file), o.Args)
	case ".js", ".mjs", ".cjs":
		cmd = join("node", quote(file), o.Args)
	default:
		cmd = join(quote(file), o.Args)
	}
	return &Plan{RunPreview: cmd, Run: func() (string, string, error) {
		if !fileExists(file) {
			return "", "", fmt.Errorf("script %s not found", file)
		}
		return cmd, dir, nil
	}}
}
