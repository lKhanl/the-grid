package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSpringPackagePlan(t *testing.T) {
	root := t.TempDir()
	s := Service{Name: "a", Type: TypeSpring, Cwd: root, Spring: &SpringOpts{Module: "app", Profiles: []string{"local", "dev"}, JvmArgs: "-Xmx1g", Offline: true}}
	if err := normalizeType(&s); err != nil {
		t.Fatal(err)
	}
	p := s.Plan(false)
	for _, want := range []string{"mvn", "-o", "-Dmaven.test.skip=true", "package", "-pl app -am"} {
		if !strings.Contains(p.Build, want) {
			t.Errorf("build %q lacks %q", p.Build, want)
		}
	}
	if _, _, err := p.Run(); err == nil {
		t.Fatal("expected 'no build output' before building")
	}
	target := filepath.Join(root, "app", "target")
	os.MkdirAll(target, 0o755)
	for _, n := range []string{"app-1.0-sources.jar", "app-1.0-plain.jar", "app-1.0.jar"} {
		os.WriteFile(filepath.Join(target, n), nil, 0o644)
	}
	cmd, cwd, err := p.Run()
	if err != nil {
		t.Fatal(err)
	}
	if cwd != filepath.Join(root, "app") || !strings.Contains(cmd, "app-1.0.jar") || !strings.Contains(cmd, "--spring.profiles.active=local,dev") || !strings.HasPrefix(cmd, "java -Xmx1g -jar") {
		t.Fatalf("run %q in %s", cmd, cwd)
	}
	if p := s.Plan(true); p.Build != "" {
		t.Fatal("skipBuild should drop the build")
	}
}

func TestSpringRunMode(t *testing.T) {
	s := Service{Type: TypeSpring, Cwd: t.TempDir(), Spring: &SpringOpts{Mode: "run", Profiles: []string{"local"}}}
	normalizeType(&s)
	p := s.Plan(false)
	cmd, _, _ := p.Run()
	if p.Build != "" || !strings.Contains(cmd, "spring-boot:run") || !strings.Contains(cmd, "-Dspring-boot.run.profiles=local") {
		t.Fatalf("build %q run %q", p.Build, cmd)
	}
}

func TestNodeInstallIfChanged(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"scripts":{"dev":"x"}}`), 0o644)
	s := Service{Type: TypeNode, Cwd: dir, Node: &NodeOpts{Script: "dev", Args: "--host"}}
	if err := normalizeType(&s); err != nil {
		t.Fatal(err)
	}
	p := s.Plan(false)
	if p.Build != "npm install" {
		t.Fatalf("first start should install, got %q", p.Build)
	}
	p.AfterBuild()
	if p2 := s.Plan(false); p2.Build != "" {
		t.Fatalf("unchanged deps should skip install, got %q", p2.Build)
	}
	os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"scripts":{"dev":"y"}}`), 0o644)
	if p3 := s.Plan(false); p3.Build == "" {
		t.Fatal("changed package.json should install again")
	}
	if cmd, _, _ := p.Run(); cmd != "npm run dev -- --host" {
		t.Fatalf("run %q", cmd)
	}
	os.WriteFile(filepath.Join(dir, "yarn.lock"), nil, 0o644)
	if cmd, _, _ := s.Plan(false).Run(); cmd != "yarn run dev --host" {
		t.Fatalf("yarn run %q", cmd)
	}
}

func TestTypeValidation(t *testing.T) {
	for _, s := range []Service{
		{Type: TypeCustom},
		{Type: TypeNode},
		{Type: TypeScript, Script: &ScriptOpts{}},
		{Type: "gradle", Command: "x"},
		{Type: TypeSpring, Spring: &SpringOpts{Mode: "fast"}},
	} {
		if err := normalizeType(&s); err == nil {
			t.Errorf("expected error for %+v", s)
		}
	}
}

func TestJarPlan(t *testing.T) {
	root := t.TempDir()
	s := Service{Name: "j", Type: TypeJar, Cwd: root, Jar: &JarOpts{File: "target/*.jar", JvmArgs: "-Xmx512m", Args: "--port=1"}}
	if err := normalizeType(&s); err != nil {
		t.Fatal(err)
	}
	p := s.Plan(false)
	if p.Build != "" {
		t.Fatal("jar has no build step")
	}
	if _, _, err := p.Run(); err == nil {
		t.Fatal("expected error when no jar exists")
	}
	os.MkdirAll(filepath.Join(root, "target"), 0o755)
	os.WriteFile(filepath.Join(root, "target", "a.jar"), nil, 0o644)
	cmd, cwd, err := p.Run()
	if err != nil || cwd != root || !strings.HasPrefix(cmd, "java -Xmx512m -jar") || !strings.HasSuffix(cmd, "a.jar --port=1") {
		t.Fatalf("run %q in %s: %v", cmd, cwd, err)
	}
	bad := Service{Name: "j", Type: TypeJar}
	if normalizeType(&bad) == nil {
		t.Fatal("jar.file should be required")
	}
}

// springProject builds root/pom.xml, root/app/{pom.xml,src/Main.java,target/app.jar}, all dated `old`,
// plus a build stamp one hour newer; it returns the service, the root and the stamp path.
func springProject(t *testing.T, opts *SpringOpts, old time.Time) (Service, string, string) { // service, root, stamp
	t.Helper()
	root := t.TempDir()
	for _, f := range []string{"pom.xml", "app/pom.xml", "app/src/Main.java", "app/target/app-1.0.jar"} {
		p := filepath.Join(root, filepath.FromSlash(f))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte("x"), 0o644)
	}
	age := func(p string) { os.Chtimes(p, old, old) }
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error { age(p); return nil })
	opts.Module = "app"
	s := Service{Name: "a", Type: TypeSpring, Cwd: root, Spring: opts}
	if err := normalizeType(&s); err != nil {
		t.Fatal(err)
	}
	// the last build started after everything that went into it was written
	stamp := filepath.Join(root, "app", "target", buildStamp)
	os.WriteFile(stamp, []byte("x"), 0o644)
	now := old.Add(time.Hour)
	os.Chtimes(stamp, now, now)
	return s, root, stamp
}

func TestSpringSkipsBuildWhenNothingChanged(t *testing.T) {
	s, _, _ := springProject(t, &SpringOpts{}, time.Now().Add(-2*time.Hour))
	p := s.Plan(false)
	if p.Build != "" || !strings.Contains(p.Note, "build skipped") {
		t.Fatalf("build %q note %q", p.Build, p.Note)
	}
	if p.BuildPreview == "" {
		t.Fatal("the UI preview must still show the build command")
	}
	if b, _ := s.Preview(); b == "" {
		t.Fatal("Preview must keep the build command")
	}
	if _, _, err := p.Run(); err != nil {
		t.Fatalf("must still run the jar: %v", err)
	}
}

func TestSpringRebuildsWhenInputsChange(t *testing.T) {
	later := time.Now().Add(-30 * time.Minute) // newer than the old inputs, older than... set explicitly below
	for name, touch := range map[string]func(root string){
		"source edited":      func(r string) { os.Chtimes(filepath.Join(r, "app/src/Main.java"), later, later) },
		"module pom edited":  func(r string) { os.Chtimes(filepath.Join(r, "app/pom.xml"), later, later) },
		"parent pom edited":  func(r string) { os.Chtimes(filepath.Join(r, "pom.xml"), later, later) },
		"file added/removed": func(r string) { os.Chtimes(filepath.Join(r, "app/src"), later, later) },
	} {
		t.Run(name, func(t *testing.T) {
			s, root, stamp := springProject(t, &SpringOpts{}, time.Now().Add(-3*time.Hour))
			old := time.Now().Add(-2 * time.Hour)
			os.Chtimes(stamp, old, old) // last build older than `later`
			touch(root)
			if p := s.Plan(false); p.Build == "" {
				t.Fatalf("expected a rebuild (%s), got note %q", name, p.Note)
			}
		})
	}
}

func TestSpringAlwaysBuildAndMissingJar(t *testing.T) {
	s, _, _ := springProject(t, &SpringOpts{AlwaysBuild: true}, time.Now().Add(-2*time.Hour))
	if p := s.Plan(false); p.Build == "" {
		t.Fatal("always_build must build")
	}
	s, root, stamp := springProject(t, &SpringOpts{}, time.Now().Add(-2*time.Hour))
	os.Remove(stamp)
	if p := s.Plan(false); p.Build == "" {
		t.Fatal("never built by Grid (no stamp): must build")
	}
	s, root, _ = springProject(t, &SpringOpts{}, time.Now().Add(-2*time.Hour))
	os.Remove(filepath.Join(root, "app", "target", "app-1.0.jar"))
	if p := s.Plan(false); p.Build == "" {
		t.Fatal("no jar: must build")
	}
}

func TestSpringSkipTestsAlsoSkipsCompilingThem(t *testing.T) {
	s := Service{Type: TypeSpring, Cwd: t.TempDir(), Spring: &SpringOpts{}}
	normalizeType(&s)
	if b := s.Plan(false).Build; !strings.Contains(b, "-Dmaven.test.skip=true") || strings.Contains(b, "-DskipTests") {
		t.Fatalf("build %q", b)
	}
	no := false
	s.Spring.SkipTests = &no
	if b := s.Plan(false).Build; strings.Contains(b, "skip") && strings.Contains(b, "test") {
		t.Fatalf("tests on: %q", b)
	}
}

func TestSpringStampWrittenAfterBuildDatesFromItsStart(t *testing.T) {
	s, root, stamp := springProject(t, &SpringOpts{}, time.Now().Add(-3*time.Hour))
	os.Remove(stamp)
	p := s.Plan(false)
	if p.Build == "" || p.AfterBuild == nil {
		t.Fatal("expected a build with an AfterBuild hook")
	}
	time.Sleep(20 * time.Millisecond)
	edit := time.Now() // edited while the build was running
	os.Chtimes(filepath.Join(root, "app/src/Main.java"), edit, edit)
	p.AfterBuild()
	if p := s.Plan(false); p.Build == "" {
		t.Fatal("an edit made during the build must trigger the next build")
	}
	// and without such an edit the next start skips
	old := time.Now().Add(-time.Hour)
	filepath.WalkDir(filepath.Join(root, "app", "src"), func(p string, d os.DirEntry, err error) error { os.Chtimes(p, old, old); return nil })
	if p := s.Plan(false); p.Build != "" {
		t.Fatalf("should skip, note %q", p.Note)
	}
}

func TestLoadRejectsBadServiceNames(t *testing.T) {
	dir := t.TempDir()
	load := func(name string) error {
		p := filepath.Join(dir, "grid.yaml")
		os.WriteFile(p, []byte("services:\n  \""+name+"\":\n    command: echo hi\n"), 0o644)
		_, err := Load(p)
		return err
	}
	for _, name := range []string{"../x", "a/b", "my service", "-api", ".hidden", ""} {
		if err := load(name); err == nil || !strings.Contains(err.Error(), "invalid service name") {
			t.Errorf("name %q: got %v, want an invalid service name error", name, err)
		}
	}
	for _, name := range []string{"api", "web-ui", "account_service", "v1.2", "9lives"} {
		if err := load(name); err != nil {
			t.Errorf("name %q: %v", name, err)
		}
	}
}
