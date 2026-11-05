//go:build !windows

package term

import (
	"bytes"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestSessionRoundTrip(t *testing.T) {
	var changes atomic.Int32
	m := NewManager(func() { changes.Add(1) })
	s, err := m.Open(Options{Shell: "/bin/sh", Cwd: t.TempDir(), Env: append(os.Environ(), "GRID_T=hello"), Cols: 80, Rows: 24})
	if err != nil {
		t.Fatal(err)
	}
	_, ch := s.Attach()
	s.Write([]byte("echo \"$GRID_T world\"; exit 3\n"))
	var out bytes.Buffer
	timeout := time.After(5 * time.Second)
	for ch != nil {
		select {
		case b, ok := <-ch:
			if !ok {
				ch = nil
				continue
			}
			out.Write(b)
		case <-timeout:
			t.Fatalf("timeout, got %q", out.String())
		}
	}
	if !strings.Contains(out.String(), "hello world") {
		t.Fatalf("output %q", out.String())
	}
	info := s.Info()
	if !info.Exited || info.ExitCode == nil || *info.ExitCode != 3 {
		t.Fatalf("info %+v", info)
	}
	hist, ch2 := s.Attach()
	if ch2 != nil || !bytes.Contains(hist, []byte("exited with code 3")) {
		t.Fatalf("reattach after exit: ch=%v hist=%q", ch2, hist)
	}
	if !m.Close(info.ID) || len(m.List()) != 0 {
		t.Fatal("close")
	}
	if changes.Load() < 3 { // open, exit, close
		t.Fatalf("onChange called %d times", changes.Load())
	}
}

func TestKill(t *testing.T) {
	m := NewManager(nil)
	s, err := m.Open(Options{Shell: "/bin/sh", Cwd: t.TempDir(), Env: os.Environ()})
	if err != nil {
		t.Fatal(err)
	}
	s.Write([]byte("sleep 60\n"))
	time.Sleep(200 * time.Millisecond)
	m.Close(s.Info().ID)
	select {
	case <-s.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("shell not killed")
	}
}
