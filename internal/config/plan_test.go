package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSpringPackagePlan(t *testing.T) {
	root := t.TempDir()
	s := Service{Name: "a", Type: TypeSpring, Cwd: root, Spring: &SpringOpts{Module: "app", Profiles: []string{"local", "dev"}, JvmArgs: "-Xmx1g", Offline: true}}
	if err := normalizeType(&s); err != nil {
		t.Fatal(err)
	}
	p := s.Plan(false)
	for _, want := range []string{"mvn", "-o", "-DskipTests", "package", "-pl app -am"} {
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
