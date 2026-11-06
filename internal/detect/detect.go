// Package detect looks at a project folder and suggests how to run it:
// a Spring Boot (Maven) app, a Node app, or scripts.
package detect

import (
	"bufio"
	"encoding/json"
	"encoding/xml"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type Result struct {
	Dir       string   `json:"dir"`
	Exists    bool     `json:"exists"`
	Suggested string   `json:"suggested"` // spring-boot | node | script | jar | custom
	Spring    *Spring  `json:"spring,omitempty"`
	Node      *Node    `json:"node,omitempty"`
	Scripts   []string `json:"scripts,omitempty"`
	Jars      []string `json:"jars,omitempty"` // *.jar in the folder and its target/ or build/libs
}

type Spring struct {
	ArtifactID  string   `json:"artifactId"`
	JavaVersion string   `json:"javaVersion,omitempty"`
	Wrapper     bool     `json:"wrapper"`
	Modules     []Module `json:"modules"` // runnable apps; Path "" = the root itself
}

type Module struct {
	Path       string   `json:"path"`
	ArtifactID string   `json:"artifactId"`
	MainClass  string   `json:"mainClass,omitempty"`
	Port       int      `json:"port,omitempty"`
	Profiles   []string `json:"profiles,omitempty"`
}

type Node struct {
	Name           string            `json:"name"`
	Scripts        []string          `json:"scripts"` // preferred first (dev, start, serve)
	Commands       map[string]string `json:"commands"`
	PackageManager string            `json:"packageManager"`
	NodeVersion    string            `json:"nodeVersion,omitempty"` // engines.node or .nvmrc
	Ports          map[string]int    `json:"ports,omitempty"`       // guessed per script
	Installed      bool              `json:"installed"`             // node_modules exists
}

// Dir inspects dir.
func Dir(dir string) Result {
	r := Result{Dir: dir, Suggested: "custom"}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return r
	}
	r.Exists = true
	r.Spring = spring(dir)
	r.Node = node(dir)
	r.Scripts = scripts(dir)
	r.Jars = jars(dir)
	switch {
	case r.Spring != nil && len(r.Spring.Modules) > 0:
		r.Suggested = "spring-boot"
	case r.Node != nil && len(r.Node.Scripts) > 0:
		r.Suggested = "node"
	case len(r.Scripts) > 0:
		r.Suggested = "script"
	case len(r.Jars) > 0:
		r.Suggested = "jar"
	}
	return r
}

// ---- maven / spring boot ----

type pom struct {
	ArtifactID string `xml:"artifactId"`
	Packaging  string `xml:"packaging"`
	Parent     struct {
		ArtifactID string `xml:"artifactId"`
	} `xml:"parent"`
	Modules    []string `xml:"modules>module"`
	Properties struct {
		Java    string `xml:"java.version"`
		Release string `xml:"maven.compiler.release"`
		Source  string `xml:"maven.compiler.source"`
	} `xml:"properties"`
	Plugins []struct {
		ArtifactID string `xml:"artifactId"`
	} `xml:"build>plugins>plugin"`
	Deps []struct {
		ArtifactID string `xml:"artifactId"`
	} `xml:"dependencies>dependency"`
}

func readPom(dir string) *pom {
	b, err := os.ReadFile(filepath.Join(dir, "pom.xml"))
	if err != nil {
		return nil
	}
	var p pom
	if xml.Unmarshal(b, &p) != nil {
		return nil
	}
	return &p
}

func (p *pom) javaVersion() string {
	for _, v := range []string{p.Properties.Java, p.Properties.Release, p.Properties.Source} {
		if v = strings.TrimPrefix(strings.TrimSpace(v), "1."); v != "" && !strings.Contains(v, "${") {
			return v
		}
	}
	return ""
}

func (p *pom) usesBoot() bool {
	if p.Parent.ArtifactID == "spring-boot-starter-parent" {
		return true
	}
	for _, pl := range p.Plugins {
		if pl.ArtifactID == "spring-boot-maven-plugin" {
			return true
		}
	}
	for _, d := range p.Deps {
		if strings.HasPrefix(d.ArtifactID, "spring-boot-starter") {
			return true
		}
	}
	return false
}

func spring(root string) *Spring {
	rp := readPom(root)
	if rp == nil {
		return nil
	}
	s := &Spring{ArtifactID: rp.ArtifactID, JavaVersion: rp.javaVersion(),
		Wrapper: exists(filepath.Join(root, "mvnw")) || exists(filepath.Join(root, "mvnw.cmd"))}
	var walk func(dir, rel string, p *pom, depth int)
	walk = func(dir, rel string, p *pom, depth int) {
		if p.Packaging != "pom" {
			main := mainClass(dir)
			if main != "" || p.usesBoot() && hasPlugin(p) {
				m := Module{Path: rel, ArtifactID: p.ArtifactID, MainClass: main}
				m.Port, m.Profiles = springResources(dir)
				s.Modules = append(s.Modules, m)
			}
		}
		if depth >= 3 {
			return
		}
		for _, mod := range p.Modules {
			cd := filepath.Join(dir, filepath.FromSlash(mod))
			if cp := readPom(cd); cp != nil {
				if s.JavaVersion == "" {
					s.JavaVersion = cp.javaVersion()
				}
				walk(cd, filepath.ToSlash(filepath.Join(rel, mod)), cp, depth+1)
			}
		}
	}
	walk(root, "", rp, 0)
	return s
}

func hasPlugin(p *pom) bool {
	for _, pl := range p.Plugins {
		if pl.ArtifactID == "spring-boot-maven-plugin" {
			return true
		}
	}
	return false
}

var pkgRe = regexp.MustCompile(`(?m)^\s*package\s+([\w.]+)`)

// mainClass finds the @SpringBootApplication class under src/main/{java,kotlin}.
func mainClass(dir string) string {
	found, seen := "", 0
	for _, src := range []string{"src/main/java", "src/main/kotlin"} {
		filepath.WalkDir(filepath.Join(dir, src), func(p string, d fs.DirEntry, err error) error {
			if err != nil || found != "" || seen > 5000 {
				return filepath.SkipDir
			}
			if d.IsDir() {
				return nil
			}
			ext := filepath.Ext(p)
			if ext != ".java" && ext != ".kt" {
				return nil
			}
			seen++
			b, err := os.ReadFile(p)
			if err != nil || !strings.Contains(string(b), "@SpringBootApplication") {
				return nil
			}
			cls := strings.TrimSuffix(filepath.Base(p), ext)
			if m := pkgRe.FindSubmatch(b); m != nil {
				cls = string(m[1]) + "." + cls
			}
			found = cls
			return filepath.SkipAll
		})
	}
	return found
}

var (
	propPortRe = regexp.MustCompile(`(?m)^\s*server\.port\s*[=:]\s*(?:\$\{[^:}]*:)?(\d+)`)
	ymlPortRe  = regexp.MustCompile(`^\s+port:\s*["']?(?:\$\{[^:}]*:)?(\d+)`)
	profileRe  = regexp.MustCompile(`^application-([\w.-]+)\.(properties|ya?ml)$`)
)

// springResources reads server.port and lists profile files.
func springResources(dir string) (int, []string) {
	res := filepath.Join(dir, "src", "main", "resources")
	port := 0
	if b, err := os.ReadFile(filepath.Join(res, "application.properties")); err == nil {
		if m := propPortRe.FindSubmatch(b); m != nil {
			port, _ = strconv.Atoi(string(m[1]))
		}
	}
	for _, name := range []string{"application.yml", "application.yaml"} {
		if port != 0 {
			break
		}
		f, err := os.Open(filepath.Join(res, name))
		if err != nil {
			continue
		}
		inServer := false
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := sc.Text()
			if strings.TrimSpace(line) == "" || strings.HasPrefix(strings.TrimSpace(line), "#") {
				continue
			}
			if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
				inServer = strings.HasPrefix(line, "server:")
				continue
			}
			if inServer {
				if m := ymlPortRe.FindStringSubmatch(line); m != nil {
					port, _ = strconv.Atoi(m[1])
					break
				}
			}
		}
		f.Close()
	}
	if port == 0 {
		port = 8080
	}
	var profiles []string
	entries, _ := os.ReadDir(res)
	for _, e := range entries {
		if m := profileRe.FindStringSubmatch(e.Name()); m != nil && !contains(profiles, m[1]) {
			profiles = append(profiles, m[1])
		}
	}
	return port, profiles
}

// ---- node ----

var portArgRe = regexp.MustCompile(`(?:--port[= ]|-p\s+)(\d{2,5})`)

func node(dir string) *Node {
	b, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return nil
	}
	var pj struct {
		Name    string            `json:"name"`
		Scripts map[string]string `json:"scripts"`
		Engines struct {
			Node string `json:"node"`
		} `json:"engines"`
	}
	if json.Unmarshal(b, &pj) != nil {
		return nil
	}
	n := &Node{Name: pj.Name, Commands: pj.Scripts, Ports: map[string]int{}, NodeVersion: pj.Engines.Node,
		Installed: exists(filepath.Join(dir, "node_modules"))}
	if v, err := os.ReadFile(filepath.Join(dir, ".nvmrc")); err == nil {
		n.NodeVersion = strings.TrimSpace(string(v))
	}
	switch {
	case exists(filepath.Join(dir, "pnpm-lock.yaml")):
		n.PackageManager = "pnpm"
	case exists(filepath.Join(dir, "yarn.lock")):
		n.PackageManager = "yarn"
	default:
		n.PackageManager = "npm"
	}
	rank := func(s string) int {
		switch s {
		case "dev":
			return 0
		case "start":
			return 1
		case "serve":
			return 2
		case "start:dev", "dev:local", "start:local":
			return 3
		}
		return 10
	}
	for name, cmd := range pj.Scripts {
		n.Scripts = append(n.Scripts, name)
		if p := guessPort(cmd); p > 0 {
			n.Ports[name] = p
		}
	}
	sort.Slice(n.Scripts, func(i, j int) bool {
		ri, rj := rank(n.Scripts[i]), rank(n.Scripts[j])
		if ri != rj {
			return ri < rj
		}
		return n.Scripts[i] < n.Scripts[j]
	})
	return n
}

func guessPort(cmd string) int {
	if m := portArgRe.FindStringSubmatch(cmd); m != nil {
		p, _ := strconv.Atoi(m[1])
		return p
	}
	switch {
	case strings.Contains(cmd, "vite"):
		return 5173
	case strings.Contains(cmd, "ng serve"):
		return 4200
	case strings.Contains(cmd, "next dev"), strings.Contains(cmd, "react-scripts start"):
		return 3000
	}
	return 0
}

// ---- scripts ----

var scriptExt = map[string]bool{".bat": true, ".cmd": true, ".ps1": true, ".sh": true, ".py": true}

func scripts(dir string) []string {
	entries, _ := os.ReadDir(dir)
	var out []string
	for _, e := range entries {
		n := e.Name()
		if e.IsDir() || !scriptExt[strings.ToLower(filepath.Ext(n))] || strings.HasPrefix(n, "mvnw") || strings.HasPrefix(n, "gradlew") {
			continue
		}
		out = append(out, n)
	}
	return out
}

// jars lists runnable-looking jars (slash-separated, relative to dir), newest first within a folder.
func jars(dir string) []string {
	var out []string
	for _, sub := range []string{"", "target", "build/libs"} {
		entries, _ := os.ReadDir(filepath.Join(dir, filepath.FromSlash(sub)))
		for _, e := range entries {
			n := e.Name()
			base := strings.TrimSuffix(n, ".jar")
			if e.IsDir() || base == n || strings.HasPrefix(n, "original-") {
				continue
			}
			if strings.HasSuffix(base, "-sources") || strings.HasSuffix(base, "-javadoc") ||
				strings.HasSuffix(base, "-tests") || strings.HasSuffix(base, "-plain") {
				continue
			}
			out = append(out, path.Join(sub, n))
		}
	}
	return out
}

// ---- folder browsing ----

type Entry struct {
	Name string `json:"name"`
	Kind string `json:"kind,omitempty"` // maven | node | ""
}

type Listing struct {
	Path   string   `json:"path"`
	Parent string   `json:"parent,omitempty"`
	Dirs   []Entry  `json:"dirs"`
	Files  []string `json:"files"`           // *.yml / *.yaml in dir, for picking a config file
	Roots  []string `json:"roots,omitempty"` // drive letters on Windows
	Error  string   `json:"error,omitempty"`
}

var skipDirs = map[string]bool{"node_modules": true, "target": true, "build": true, "dist": true, "out": true, "bin": true, "obj": true}

// List returns the sub-folders of dir, marking Maven and Node projects.
func List(dir string) Listing {
	l := Listing{Path: dir, Dirs: []Entry{}, Files: []string{}, Roots: roots()}
	if parent := filepath.Dir(dir); parent != dir {
		l.Parent = parent
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		l.Error = err.Error()
		return l
	}
	for _, e := range entries {
		n := e.Name()
		if ext := strings.ToLower(filepath.Ext(n)); !e.IsDir() && (ext == ".yml" || ext == ".yaml") && !strings.HasPrefix(n, ".") {
			if e.Type().IsRegular() || e.Type()&os.ModeSymlink != 0 {
				l.Files = append(l.Files, n)
			}
			continue
		}
		if !e.IsDir() || strings.HasPrefix(n, ".") || strings.HasPrefix(n, "$") || skipDirs[n] {
			continue
		}
		en := Entry{Name: n}
		p := filepath.Join(dir, n)
		switch {
		case exists(filepath.Join(p, "pom.xml")):
			en.Kind = "maven"
		case exists(filepath.Join(p, "package.json")):
			en.Kind = "node"
		}
		l.Dirs = append(l.Dirs, en)
	}
	sort.Slice(l.Files, func(i, j int) bool { return strings.ToLower(l.Files[i]) < strings.ToLower(l.Files[j]) })
	sort.Slice(l.Dirs, func(i, j int) bool { return strings.ToLower(l.Dirs[i].Name) < strings.ToLower(l.Dirs[j].Name) })
	return l
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
