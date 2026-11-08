package runner

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFileLogWritesAndRotates(t *testing.T) {
	root := t.TempDir()
	l := newFileLogs()
	l.setRoot(root)
	defer l.close()

	long := strings.Repeat("x", 1000)
	e := Entry{Time: time.Now().UnixMilli(), Stream: "out", Line: "\x1b[32m" + long + "\x1b[0m"}
	n := MaxLogFileBytes / 1000 * 2 // twice the limit
	for i := 0; i < n; i++ {
		l.write("ws-1", "api", e)
	}
	l.close()

	p := filepath.Join(root, "ws-1", "api.log")
	cur, err1 := os.Stat(p)
	prev, err2 := os.Stat(p + ".1")
	if err1 != nil || err2 != nil {
		t.Fatalf("want api.log and api.log.1: %v %v", err1, err2)
	}
	if total := cur.Size() + prev.Size(); total > MaxLogFileBytes {
		t.Fatalf("log files take %d bytes, limit %d", total, MaxLogFileBytes)
	}
	if prev.Size() < MaxLogFileBytes/2-2000 {
		t.Fatalf("previous file only %d bytes: rotated too early", prev.Size())
	}
	b, _ := os.ReadFile(p)
	first := strings.SplitN(string(b), "\n", 2)[0]
	if strings.Contains(first, "\x1b") || !strings.HasSuffix(first, " out "+long) {
		t.Fatalf("line not plain: %q", first[:60])
	}
}

func TestFileLogReopensFullFile(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "ws", "api.log")
	os.MkdirAll(filepath.Dir(p), 0o755)
	os.WriteFile(p, make([]byte, MaxLogFileBytes/2), 0o644) // left full by an earlier run
	l := newFileLogs()
	l.setRoot(root)
	l.write("ws", "api", Entry{Stream: "sys", Line: "hello"})
	l.close()
	if st, _ := os.Stat(p); st.Size() > 100 {
		t.Fatalf("full file not rotated on open: %d bytes", st.Size())
	}
}

func TestFileLogOff(t *testing.T) {
	l := newFileLogs()
	l.write("ws", "api", Entry{Line: "x"}) // must not panic or write anywhere
	if l.path("ws", "api") != "" {
		t.Fatal("path while off")
	}
}

func TestWorkspaceKey(t *testing.T) {
	a := workspaceKey("/work/shop/grid.yaml")
	b := workspaceKey("/other/shop/grid.yaml")
	if a == b || !strings.HasPrefix(a, "shop-") || len(a) != len("shop-")+8 {
		t.Fatalf("keys %q %q", a, b)
	}
	if workspaceKey("/x/my project!/grid.yaml")[:11] != "my_project_" {
		t.Fatalf("unsafe chars kept: %q", workspaceKey("/x/my project!/grid.yaml"))
	}
	if workspaceKey("") != "" {
		t.Fatal("empty path")
	}
}

func TestParseCPUTime(t *testing.T) {
	for in, want := range map[string]time.Duration{
		"0:00.03":    30 * time.Millisecond,
		"12:34.50":   12*time.Minute + 34500*time.Millisecond,
		"01:02:03":   time.Hour + 2*time.Minute + 3*time.Second,
		"2-01:00:00": 49 * time.Hour,
		"123:45.67":  123*time.Minute + 45670*time.Millisecond,
	} {
		got, ok := parseCPUTime(in)
		if !ok || (got-want).Abs() > time.Millisecond {
			t.Errorf("%s: got %v %v, want %v", in, got, ok, want)
		}
	}
	if _, ok := parseCPUTime("bad"); ok {
		t.Error("bad accepted")
	}
}

func TestFileLogTurnedOff(t *testing.T) {
	root := t.TempDir()
	l := newFileLogs()
	l.setRoot(root)
	defer l.close()
	l.setEnabled(false)
	l.write("ws", "api", Entry{Stream: "out", Line: "while off"})
	if l.path("ws", "api") != "" || l.enabled() {
		t.Fatal("still on")
	}
	l.setEnabled(true)
	l.write("ws", "api", Entry{Stream: "out", Line: "back on"})
	l.close()
	b, _ := os.ReadFile(filepath.Join(root, "ws", "api.log"))
	if strings.Contains(string(b), "while off") || !strings.Contains(string(b), "back on") {
		t.Fatalf("file: %q", b)
	}
}
