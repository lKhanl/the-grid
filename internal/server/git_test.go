package server

import (
	"encoding/json"
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
