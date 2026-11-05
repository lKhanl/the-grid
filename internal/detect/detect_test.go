package detect

import (
	"path/filepath"
	"runtime"
	"testing"
)

func demo(t *testing.T, name string) string {
	_, f, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(f), "..", "..", "demo", name)
}

func TestSingleModuleSpring(t *testing.T) {
	r := Dir(demo(t, "spring-api"))
	if r.Suggested != "spring-boot" || r.Spring == nil || len(r.Spring.Modules) != 1 {
		t.Fatalf("got %+v", r)
	}
	m := r.Spring.Modules[0]
	if m.Path != "" || m.MainClass != "demo.bank.SpringApiApplication" || m.Port != 8090 || r.Spring.JavaVersion != "17" {
		t.Fatalf("module %+v java %q", m, r.Spring.JavaVersion)
	}
}

func TestMultiModuleSpring(t *testing.T) {
	r := Dir(demo(t, "bank-suite"))
	if r.Suggested != "spring-boot" || len(r.Spring.Modules) != 1 {
		t.Fatalf("got %+v", r.Spring)
	}
	m := r.Spring.Modules[0] // "common" is a library: no main class, no boot plugin
	if m.Path != "account-service" || m.MainClass != "demo.account.AccountServiceApplication" || m.Port != 8092 {
		t.Fatalf("module %+v", m)
	}
	if len(m.Profiles) != 2 || m.Profiles[0] != "local" || m.Profiles[1] != "test" {
		t.Fatalf("profiles %v", m.Profiles)
	}
}

func TestNode(t *testing.T) {
	r := Dir(demo(t, "web-ui"))
	if r.Suggested != "node" || r.Node.Scripts[0] != "dev" || r.Node.Scripts[1] != "start" || r.Node.Ports["dev"] != 5180 || r.Node.PackageManager != "npm" {
		t.Fatalf("got %+v", r.Node)
	}
}

func TestMissing(t *testing.T) {
	if r := Dir(filepath.Join(t.TempDir(), "nope")); r.Exists || r.Suggested != "custom" {
		t.Fatalf("got %+v", r)
	}
}
