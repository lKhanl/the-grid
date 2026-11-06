package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sample = `# Workspace config
name: Test

runtimes:
  java-17: { home: /tmp }

services:
  # the main API
  api:
    group: backend
    command: java -jar api.jar   # keep this comment
    color: false
    env: { PORT: "8081" }
  ui:
    command: npm run dev
    depends_on: [api]

# trailing notes
`

func setup(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "grid.yaml")
	if err := os.WriteFile(p, []byte(sample), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func read(t *testing.T, p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestCreateService(t *testing.T) {
	p := setup(t)
	err := SaveService(p, "", ServiceSpec{
		Name: "worker", Group: "jobs", Command: "node worker.js", Runtime: []string{"java-17"},
		Env: []EnvVar{{"A", "1"}, {"B", "two words"}}, ReadyPort: 9000, Restart: "on-failure", MaxRestarts: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	w := cfg.Services[len(cfg.Services)-1]
	if w.Name != "worker" || w.Group != "jobs" || w.Ready.Port != 9000 || w.Env["B"] != "two words" || w.Runtime[0] != "java-17" {
		t.Fatalf("unexpected: %+v", w)
	}
	out := read(t, p)
	for _, keep := range []string{"# Workspace config", "# the main API", "# keep this comment", "# trailing notes", "color: false"} {
		if !strings.Contains(out, keep) {
			t.Errorf("lost %q:\n%s", keep, out)
		}
	}
	if _, err := os.Stat(p + ".bak"); err != nil {
		t.Error("no backup written")
	}
	if testing.Verbose() {
		t.Log("\n" + out)
	}
}

func TestUpdateKeepsUnknownKeysAndComments(t *testing.T) {
	p := setup(t)
	spec, err := ReadSpec(p, "api")
	if err != nil {
		t.Fatal(err)
	}
	if spec.Command != "java -jar api.jar" || len(spec.Env) != 1 || spec.Env[0].Value != "8081" {
		t.Fatalf("read spec: %+v", spec)
	}
	spec.Command = "java -jar api-2.jar"
	spec.Group = ""
	if err := SaveService(p, "api", spec); err != nil {
		t.Fatal(err)
	}
	out := read(t, p)
	if !strings.Contains(out, "api-2.jar") || !strings.Contains(out, "# keep this comment") || !strings.Contains(out, "color: false") {
		t.Fatalf("bad update:\n%s", out)
	}
	if strings.Contains(out, "group: backend") {
		t.Fatal("cleared field still present")
	}
}

func TestRenameUpdatesDependsOn(t *testing.T) {
	p := setup(t)
	spec, _ := ReadSpec(p, "api")
	spec.Name = "core-api"
	if err := SaveService(p, "api", spec); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Services[0].Name != "core-api" || cfg.Services[1].DependsOn[0] != "core-api" {
		t.Fatalf("rename failed: %+v", cfg.Services)
	}
}

func TestInvalidChangeLeavesFileUntouched(t *testing.T) {
	p := setup(t)
	before := read(t, p)
	cases := []ServiceSpec{
		{Name: "x", Command: ""},                                // command required
		{Name: "x", Command: "a", Runtime: []string{"java-99"}}, // unknown runtime
		{Name: "x", Command: "a", DependsOn: []string{"nope"}},  // unknown dependency
		{Name: "bad name", Command: "a"},                        // invalid name
		{Name: "api", Command: "a"},                             // duplicate
		{Name: "x", Command: "a", ReadyLog: "(unclosed"},        // bad regex
	}
	for _, c := range cases {
		if err := SaveService(p, "", c); err == nil {
			t.Errorf("expected error for %+v", c)
		}
	}
	if read(t, p) != before {
		t.Fatal("file changed after rejected edits")
	}
	if _, err := os.Stat(p + ".tmp"); err == nil {
		t.Fatal("temp file left behind")
	}
}

func TestDelete(t *testing.T) {
	p := setup(t)
	if err := DeleteService(p, "api"); err == nil || !strings.Contains(err.Error(), "depends on") {
		t.Fatalf("expected dependency error, got %v", err)
	}
	if err := DeleteService(p, "ui"); err != nil {
		t.Fatal(err)
	}
	if err := DeleteService(p, "api"); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Services) != 0 {
		t.Fatalf("services left: %d", len(cfg.Services))
	}
}

func TestRuntimeCRUD(t *testing.T) {
	p := setup(t)
	// create: name implies the type, so no `type:` key is written
	if err := SaveRuntime(p, "", RuntimeSpec{Name: "node-20", Type: "node", Home: "/tmp"}); err != nil {
		t.Fatal(err)
	}
	// a script runtime with a name that doesn't imply it
	if err := SaveRuntime(p, "", RuntimeSpec{Name: "maven-3.9", Type: "script", Home: "/tmp",
		Env: []EnvVar{{"MAVEN_OPTS", "-Xmx1g"}}}); err != nil {
		t.Fatal(err)
	}
	// a name that doesn't imply the type gets an explicit `type:`
	if err := SaveRuntime(p, "", RuntimeSpec{Name: "corretto", Type: "java", Home: "/tmp"}); err != nil {
		t.Fatal(err)
	}
	out := read(t, p)
	if strings.Contains(out, "type: node") || strings.Contains(out, "type: script") || !strings.Contains(out, "type: java") || !strings.Contains(out, "# the main API") {
		t.Fatalf("unexpected file:\n%s", out)
	}
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Runtimes["node-20"].Type != "node" || cfg.Runtimes["maven-3.9"].Env["MAVEN_OPTS"] != "-Xmx1g" {
		t.Fatalf("bad runtimes: %+v", cfg.Runtimes)
	}

	// rename updates services
	spec, _ := ReadSpec(p, "api")
	spec.Runtime = []string{"java-17", "maven-3.9"}
	if err := SaveService(p, "api", spec); err != nil {
		t.Fatal(err)
	}
	rs, err := ReadRuntime(p, "java-17")
	if err != nil || rs.Type != "java" || rs.Home != "/tmp" {
		t.Fatalf("read: %+v %v", rs, err)
	}
	rs.Name = "jdk-17"
	if err := SaveRuntime(p, "java-17", rs); err != nil {
		t.Fatal(err)
	}
	cfg, _ = Load(p)
	if cfg.Services[0].Runtime[0] != "jdk-17" {
		t.Fatalf("service ref not renamed: %v", cfg.Services[0].Runtime)
	}

	// delete is refused while used
	if err := DeleteRuntime(p, "jdk-17", false); err == nil || !strings.Contains(err.Error(), "api") {
		t.Fatalf("expected in-use error, got %v", err)
	}
	if err := DeleteRuntime(p, "node-20", false); err != nil {
		t.Fatal(err)
	}
	// detach: removed from api's [jdk-17, maven-3.9] list, which becomes a scalar
	if err := DeleteRuntime(p, "jdk-17", true); err != nil {
		t.Fatal(err)
	}
	cfg, _ = Load(p)
	if _, ok := cfg.Runtimes["jdk-17"]; ok || len(cfg.Services[0].Runtime) != 1 || cfg.Services[0].Runtime[0] != "maven-3.9" {
		t.Fatalf("detach failed: %v", cfg.Services[0].Runtime)
	}
	if !strings.Contains(read(t, p), "runtime: maven-3.9") {
		t.Fatalf("expected scalar runtime:\n%s", read(t, p))
	}
	if err := DeleteRuntime(p, "maven-3.9", true); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(read(t, p), "runtime:") {
		t.Fatalf("runtime key should be gone:\n%s", read(t, p))
	}
	// invalid input
	for _, bad := range []RuntimeSpec{
		{Name: "x", Type: "python", Home: "/tmp"},
		{Name: "x", Type: "java", Home: ""},
		{Name: "corretto", Type: "java", Home: "/tmp"},
		{Name: "bad name", Type: "java", Home: "/tmp"},
	} {
		if err := SaveRuntime(p, "", bad); err == nil {
			t.Errorf("expected error for %+v", bad)
		}
	}
}

func TestRuntimeTypesAndNewSection(t *testing.T) {
	p := filepath.Join(t.TempDir(), "grid.yaml")
	os.WriteFile(p, []byte("services:\n  a:\n    command: echo hi\n"), 0o644)
	if err := SaveRuntime(p, "", RuntimeSpec{Name: "java-11", Type: "java", Home: "/tmp"}); err != nil {
		t.Fatal(err)
	}
	out := read(t, p)
	if strings.Index(out, "runtimes:") > strings.Index(out, "services:") {
		t.Fatalf("runtimes should come before services:\n%s", out)
	}
	// only java, node and script exist; a maven-3.9 name is inferred as script
	os.WriteFile(p, []byte("runtimes:\n  maven-3.9: {home: /tmp}\nservices: {}\n"), 0o644)
	cfg, err := Load(p)
	if err != nil || cfg.Runtimes["maven-3.9"].Type != "script" {
		t.Fatalf("inferred type: %v", err)
	}
	os.WriteFile(p, []byte("runtimes:\n  m: {home: /tmp, type: maven}\nservices: {}\n"), 0o644)
	if _, err := Load(p); err == nil {
		t.Fatal("type: maven should be rejected")
	}
}

func TestTypedServiceRoundTrip(t *testing.T) {
	p := setup(t)
	spec := ServiceSpec{Name: "acc", Type: TypeSpring, Cwd: ".",
		Spring: &SpringSpec{Module: "account-service", Profiles: []string{"local"}, SkipTests: true}}
	if err := SaveService(p, "", spec); err != nil {
		t.Fatal(err)
	}
	out := read(t, p)
	if !strings.Contains(out, "type: spring-boot") || !strings.Contains(out, "module: account-service") || strings.Contains(out, "skip_tests") {
		t.Fatalf("unexpected:\n%s", out)
	}
	got, err := ReadSpec(p, "acc")
	if err != nil || got.Spring == nil || got.Spring.Module != "account-service" || !got.Spring.SkipTests || got.Spring.Profiles[0] != "local" {
		t.Fatalf("read back %+v %v", got.Spring, err)
	}
	// switching to custom drops the spring block and needs a command
	got.Type, got.Command = TypeCustom, "java -jar x.jar"
	if err := SaveService(p, "acc", got); err != nil {
		t.Fatal(err)
	}
	if out := read(t, p); strings.Contains(out, "spring:") || strings.Contains(out, "type: spring-boot") {
		t.Fatalf("spring block left:\n%s", out)
	}
	// node needs a script
	if err := SaveService(p, "", ServiceSpec{Name: "n", Type: TypeNode, Node: &NodeSpec{}}); err == nil {
		t.Fatal("expected node.script error")
	}
}

func TestReorderServices(t *testing.T) {
	p := setup(t)
	if err := ReorderServices(p, []string{"ui", "api"}); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Services[0].Name != "ui" || cfg.Services[1].Name != "api" {
		t.Fatalf("order %s, %s", cfg.Services[0].Name, cfg.Services[1].Name)
	}
	out := read(t, p)
	// the comment above api moves with it
	if strings.Index(out, "# the main API") < strings.Index(out, "ui:") || !strings.Contains(out, "# keep this comment") {
		t.Fatalf("comments lost or misplaced:\n%s", out)
	}
	for _, bad := range [][]string{{"ui"}, {"ui", "ui"}, {"ui", "nope"}} {
		if err := ReorderServices(p, bad); err == nil {
			t.Errorf("expected error for %v", bad)
		}
	}
}

func TestChangesVisibilityRoundTrip(t *testing.T) {
	p := setup(t)
	spec, err := ReadSpec(p, "api")
	if err != nil || spec.NoChanges {
		t.Fatalf("shown by default: %v %+v", err, spec)
	}
	spec.NoChanges = true
	if err := SaveService(p, "api", spec); err != nil {
		t.Fatal(err)
	}
	if out := read(t, p); !strings.Contains(out, "changes: false") {
		t.Fatalf("not written:\n%s", out)
	}
	if spec, _ = ReadSpec(p, "api"); !spec.NoChanges {
		t.Fatal("not read back")
	}
	cfg, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range cfg.Services {
		if (s.Name == "api") == s.ShowInChanges() {
			t.Fatalf("%s: ShowInChanges = %v", s.Name, s.ShowInChanges())
		}
	}
	spec.NoChanges = false // shown again: the key goes away instead of staying as `changes: true`
	if err := SaveService(p, "api", spec); err != nil {
		t.Fatal(err)
	}
	if out := read(t, p); strings.Contains(out, "changes:") {
		t.Fatalf("key left behind:\n%s", out)
	}
}
