package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTouchRecentLastRemove(t *testing.T) {
	dir := t.TempDir()
	s := OpenAt(filepath.Join(dir, "home"))
	a, b := filepath.Join(dir, "a.yaml"), filepath.Join(dir, "b.yaml")
	os.WriteFile(a, nil, 0o644)
	os.WriteFile(b, nil, 0o644)

	if _, ok := s.Last(); ok {
		t.Fatal("empty store has no last")
	}
	s.Touch(a, "A")
	s.Touch(b, "B")
	s.Touch(a, "A2") // moves a to front, no duplicate
	r := s.Recent()
	if len(r) != 2 || r[0].Path != a || r[0].Name != "A2" || r[1].Path != b {
		t.Fatalf("recent = %+v", r)
	}
	if p, ok := s.Last(); !ok || p != a {
		t.Fatalf("last = %q %v", p, ok)
	}
	os.Remove(b)
	if r := s.Recent(); len(r) != 1 {
		t.Fatalf("missing files must be skipped: %+v", r)
	}
	s.Remove(a)
	if _, ok := s.Last(); ok || len(s.Recent()) != 0 {
		t.Fatal("remove should forget a")
	}
}

func TestCorruptFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "state.json"), []byte("{nope"), 0o644)
	s := OpenAt(dir)
	if len(s.Recent()) != 0 {
		t.Fatal("corrupt state should read as empty")
	}
	if err := s.Touch(filepath.Join(dir, "x.yaml"), "x"); err != nil {
		t.Fatal(err)
	}
}

func TestLogLinesPersist(t *testing.T) {
	dir := t.TempDir()
	s := OpenAt(dir)
	if s.LogLines() != 0 {
		t.Fatal("unset must read as 0")
	}
	if err := s.SetLogLines(2500); err != nil {
		t.Fatal(err)
	}
	s.Touch(filepath.Join(dir, "a.yaml"), "A") // other writes must not lose it
	if got := OpenAt(dir).LogLines(); got != 2500 {
		t.Fatalf("log lines = %d", got)
	}
}

func TestLogFilesDefaultOnAndPersist(t *testing.T) {
	dir := t.TempDir()
	s := OpenAt(dir)
	if !s.LogFiles() {
		t.Fatal("log files must be on by default")
	}
	if err := s.SetLogFiles(false); err != nil {
		t.Fatal(err)
	}
	if OpenAt(dir).LogFiles() {
		t.Fatal("off not saved")
	}
}
