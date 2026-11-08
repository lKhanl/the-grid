package config

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// copyExample puts the repository's grid.example.yaml (every option, hand
// formatted) in a temp dir, so saves can be compared byte for byte.
func copyExample(t *testing.T) (path, orig string) {
	t.Helper()
	b, err := os.ReadFile("../../grid.example.yaml")
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "grid.yaml")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, string(b)
}

func serviceNames(t *testing.T, p string) []string {
	t.Helper()
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, s := range cfg.Services {
		names = append(names, s.Name)
	}
	return names
}

func TestSaveWithoutChangesKeepsFileExactly(t *testing.T) {
	for _, tc := range []struct {
		name string
		make func(*testing.T) (string, string)
	}{
		{"example", copyExample},
		{"sample", func(t *testing.T) (string, string) { return setup(t), sample }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, orig := tc.make(t)
			for _, n := range serviceNames(t, p) {
				spec, err := ReadSpec(p, n)
				if err != nil {
					t.Fatal(err)
				}
				if err := SaveService(p, n, spec); err != nil {
					t.Fatal(err)
				}
				if got := read(t, p); got != orig {
					t.Fatalf("saving %s unchanged rewrote the file:\n%s", n, got)
				}
			}
			if err := ReorderServices(p, serviceNames(t, p)); err != nil {
				t.Fatal(err)
			}
			if got := read(t, p); got != orig {
				t.Fatalf("same order rewrote the file:\n%s", got)
			}
		})
	}
}

func TestToggleChangesTouchesOneLine(t *testing.T) {
	p, orig := copyExample(t)
	spec, err := ReadSpec(p, "api")
	if err != nil {
		t.Fatal(err)
	}
	spec.NoChanges = true
	if err := SaveService(p, "api", spec); err != nil {
		t.Fatal(err)
	}
	got := read(t, p)
	added := strings.Split(got, "\n")
	for _, l := range strings.Split(orig, "\n") {
		i := slices.Index(added, l)
		if i < 0 {
			t.Fatalf("line %q lost:\n%s", l, got)
		}
		added = slices.Delete(added, i, i+1)
	}
	if len(added) != 1 || strings.TrimSpace(added[0]) != "changes: false" {
		t.Fatalf("want only `changes: false` added, got %q", added)
	}

	spec.NoChanges = false
	if err := SaveService(p, "api", spec); err != nil {
		t.Fatal(err)
	}
	if got := read(t, p); got != orig {
		t.Fatalf("toggling back did not restore the file:\n%s", got)
	}
}

func TestEditRewritesOnlyChangedLine(t *testing.T) {
	p := setup(t)
	spec, err := ReadSpec(p, "api")
	if err != nil {
		t.Fatal(err)
	}
	spec.Env = []EnvVar{{"PORT", "9090"}}
	if err := SaveService(p, "api", spec); err != nil {
		t.Fatal(err)
	}
	want := strings.Replace(sample, `    env: { PORT: "8081" }`, `    env: {PORT: "9090"}`, 1)
	if got := read(t, p); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestReorderKeepsLayout(t *testing.T) {
	p, orig := copyExample(t)
	names := serviceNames(t, p)
	slices.Reverse(names)
	if err := ReorderServices(p, names); err != nil {
		t.Fatal(err)
	}
	got := read(t, p)
	if !slices.Equal(serviceNames(t, p), names) {
		t.Fatalf("order not applied:\n%s", got)
	}
	// same lines, other order: nothing reformatted, no blank lines lost
	a, b := strings.Split(orig, "\n"), strings.Split(got, "\n")
	slices.Sort(a)
	slices.Sort(b)
	if !slices.Equal(a, b) {
		t.Fatalf("reorder changed the text of the entries:\n%s", got)
	}
	if strings.Contains(got, "\n\n\n") {
		t.Fatalf("double blank line:\n%s", got)
	}
}

func TestAddAndDeleteKeepLayout(t *testing.T) {
	p, orig := copyExample(t)
	if err := SaveService(p, "", ServiceSpec{Name: "extra", Group: "jobs", Command: "node x.js"}); err != nil {
		t.Fatal(err)
	}
	got := read(t, p)
	want := orig + "\n  extra:\n    group: jobs\n    command: node x.js\n"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	if err := DeleteService(p, "extra"); err != nil {
		t.Fatal(err)
	}
	if got := read(t, p); got != orig {
		t.Fatalf("delete did not restore the file:\n%s", got)
	}
}
