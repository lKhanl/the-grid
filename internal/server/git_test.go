package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/lKhanl/the-grid/internal/config"
	"github.com/lKhanl/the-grid/internal/runner"
	"github.com/lKhanl/the-grid/internal/term"
)

func gitReq(t *testing.T, srv *httptest.Server, method, path, body string) (int, string) {
	req, _ := http.NewRequest(method, srv.URL+path, strings.NewReader(body))
	req.Header.Set(CSRFHeader, "test")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// shown and hidden paths (relative to the repo) of the one project
func changesOf(t *testing.T, srv *httptest.Server) (shown, hidden []string) {
	_, body := gitReq(t, srv, "GET", "/api/git/changes", "")
	var r struct {
		Projects []struct {
			Files   []struct{ Path string }
			Ignored []struct{ Path, Pattern string }
		}
		Error string
	}
	if err := json.Unmarshal([]byte(body), &r); err != nil || len(r.Projects) != 1 {
		t.Fatalf("%v %s", err, body)
	}
	for _, f := range r.Projects[0].Files {
		shown = append(shown, f.Path)
	}
	for _, f := range r.Projects[0].Ignored {
		hidden = append(hidden, f.Path)
	}
	sort.Strings(shown)
	sort.Strings(hidden)
	return
}

func TestChangesIgnoreHidesTrackedAndUntrackedFiles(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo, _ := filepath.EvalSymlinks(t.TempDir()) // macOS: /var is /private/var, and git reports the real path
	run := func(args ...string) {
		c := exec.Command("git", append([]string{"-c", "user.email=t@t", "-c", "user.name=t"}, args...)...)
		c.Dir = repo
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	write := func(rel, text string) {
		p := filepath.Join(repo, rel)
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(text), 0o644)
	}
	run("init", "-q")
	write("app/local.yml", "a\n")
	write("app/Main.java", "a\n")
	run("add", ".")
	run("commit", "-q", "-m", "init")
	write("app/local.yml", "changed\n") // tracked and modified
	write("app/Main.java", "changed\n")
	write("app/api.iml", "x\n") // untracked
	write("app/tmp/a.log", "x\n")

	cfgPath := filepath.Join(t.TempDir(), "grid.yaml")
	os.WriteFile(cfgPath, []byte("services:\n  api:\n    cwd: "+filepath.Join(repo, "app")+"\n    command: echo hi\n    changes_ignore: ['*.iml', tmp/]\n"), 0o644)
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(runner.NewManager(cfg), term.NewManager(func() {}), nil, fstest.MapFS{"index.html": {Data: []byte("x")}}))
	defer srv.Close()

	shown, hidden := changesOf(t, srv)
	if strings.Join(shown, ",") != "app/Main.java,app/local.yml" || strings.Join(hidden, ",") != "app/api.iml,app/tmp/a.log" {
		t.Fatalf("shown %v hidden %v", shown, hidden)
	}

	// right-click "Hide from Changes" on a tracked file: written to grid.yaml, applied at once
	if code, body := gitReq(t, srv, "POST", "/api/config/services/api/changes-ignore", `{"pattern":"local.yml"}`); code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	if b, _ := os.ReadFile(cfgPath); !strings.Contains(string(b), "local.yml") {
		t.Fatalf("not saved:\n%s", b)
	}
	if shown, _ = changesOf(t, srv); strings.Join(shown, ",") != "app/Main.java" {
		t.Fatalf("still shown: %v", shown)
	}

	// and back
	if code, body := gitReq(t, srv, "DELETE", "/api/config/services/api/changes-ignore", `{"pattern":"local.yml"}`); code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	if shown, _ = changesOf(t, srv); strings.Join(shown, ",") != "app/Main.java,app/local.yml" {
		t.Fatalf("not shown again: %v", shown)
	}
	if code, _ := gitReq(t, srv, "DELETE", "/api/config/services/api/changes-ignore", `{"pattern":"nope"}`); code != 404 {
		t.Fatalf("unknown pattern: %d", code)
	}
}

// A VDI keeps C:\dev on an App Volumes disk: the service folder is reached through a
// link and git reports the real path behind it as the repository. The files must still
// belong to the service, not to "<repo> (other files)".
func TestChangesThroughALinkedFolder(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	real, _ := filepath.EvalSymlinks(t.TempDir())
	repo := filepath.Join(real, "volume", "be")
	os.MkdirAll(filepath.Join(repo, "src"), 0o755)
	c := exec.Command("git", "init", "-q")
	c.Dir = repo
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("git init: %s", out)
	}
	os.WriteFile(filepath.Join(repo, "src", "app.yml"), []byte("x\n"), 0o644)
	linked := filepath.Join(real, "dev")
	if err := os.Symlink(filepath.Join(real, "volume"), linked); err != nil {
		t.Skip("no symlinks:", err)
	}

	cfgPath := filepath.Join(t.TempDir(), "grid.yaml")
	os.WriteFile(cfgPath, []byte("services:\n  be:\n    cwd: "+filepath.Join(linked, "be")+"\n    command: echo hi\n"), 0o644)
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(New(runner.NewManager(cfg), term.NewManager(func() {}), nil, fstest.MapFS{"index.html": {Data: []byte("x")}}))
	defer srv.Close()

	_, body := gitReq(t, srv, "GET", "/api/git/changes", "")
	var r struct{ Projects []struct{ Name string } }
	json.Unmarshal([]byte(body), &r)
	if len(r.Projects) != 1 || r.Projects[0].Name != "be" {
		t.Fatalf("want the service's own project, got %s", body)
	}
}

// A folder that git could not place (a timeout, or simply no repository yet) must not stay
// out of Changes until the Grid restarts: it is asked again after repoRetry, and at once
// after a reload.
func TestChangesSeesARepositoryThatAppearsLater(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x\n"), 0o644)
	cfgPath := filepath.Join(t.TempDir(), "grid.yaml")
	os.WriteFile(cfgPath, []byte("services:\n  api:\n    cwd: "+dir+"\n    command: echo hi\n"), 0o644)
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	m := runner.NewManager(cfg)
	now := time.Now()
	cache := newRepoCache()
	cache.now = func() time.Time { return now }
	count := func() int { p, _ := gitProjects(m, cache); return len(p) }

	if n := count(); n != 0 {
		t.Fatalf("no repository yet: got %d projects", n)
	}
	c := exec.Command("git", "init", "-q")
	c.Dir = dir
	if out, err := c.CombinedOutput(); err != nil {
		t.Fatalf("git init: %s", out)
	}
	if n := count(); n != 0 {
		t.Fatalf("within repoRetry the answer is remembered: got %d projects", n)
	}
	if err := m.Reload(); err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 1 {
		t.Fatalf("after a reload: got %d projects, want 1", n)
	}

	// and without a reload, once repoRetry has passed
	cache = newRepoCache()
	cache.now = func() time.Time { return now }
	cache.sync(m.Generation())
	cache.put(dir, repoLoc{})
	if n := count(); n != 0 {
		t.Fatalf("remembered as no repository: got %d projects", n)
	}
	now = now.Add(repoRetry)
	if n := count(); n != 1 {
		t.Fatalf("after repoRetry: got %d projects, want 1", n)
	}
}

// A folder missing from .gitignore brings thousands of untracked files: only the first
// maxUntracked are listed (with every tracked change), the rest is a number.
func TestChangesCapsUntrackedFiles(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	run := func(args ...string) {
		c := exec.Command("git", args...)
		c.Dir = dir
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	run("init", "-q")
	os.WriteFile(filepath.Join(dir, "zz-tracked.txt"), []byte("a\n"), 0o644)
	run("add", ".")
	run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
	os.WriteFile(filepath.Join(dir, "zz-tracked.txt"), []byte("a\nb\n"), 0o644)
	os.MkdirAll(filepath.Join(dir, "deps"), 0o755)
	const extra = 25
	for i := 0; i < maxUntracked+extra; i++ {
		os.WriteFile(filepath.Join(dir, "deps", fmt.Sprintf("f%05d.js", i)), []byte("x\n"), 0o644)
	}
	cfgPath := filepath.Join(t.TempDir(), "grid.yaml")
	os.WriteFile(cfgPath, []byte("services:\n  api:\n    cwd: "+dir+"\n    command: echo hi\n"), 0o644)
	cfg, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	projects, msg := gitProjects(runner.NewManager(cfg), newRepoCache())
	if len(projects) != 1 {
		t.Fatalf("got %d projects (%s)", len(projects), msg)
	}
	p := projects[0]
	if len(p.Files) != maxUntracked+1 || p.More != extra {
		t.Fatalf("listed %d files, %d more; want %d and %d", len(p.Files), p.More, maxUntracked+1, extra)
	}
	last := p.Files[len(p.Files)-1]
	if last.Path != "zz-tracked.txt" || last.Status != "M" {
		t.Fatalf("the tracked change must stay listed, last file is %+v", last)
	}
	if p.Files[0].Additions != 1 {
		t.Fatalf("listed untracked files are line-counted, got %+v", p.Files[0])
	}
}
