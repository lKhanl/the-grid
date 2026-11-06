package runner

import (
	"testing"

	"github.com/lKhanl/the-grid/internal/config"
)

func TestLogBufferSetMax(t *testing.T) {
	b := NewLogBuffer(10)
	for i := 0; i < 8; i++ {
		b.Add("out", "x")
	}
	b.SetMax(3) // lowering drops the oldest right away
	got := b.Tail(0)
	if len(got) != 3 || got[0].Seq != 6 || got[2].Seq != 8 {
		t.Fatalf("after lowering: %+v", got)
	}
	b.SetMax(100) // raising keeps what is there
	b.Add("out", "y")
	if n := len(b.Tail(0)); n != 4 {
		t.Fatalf("after raising: %d lines", n)
	}
}

func TestSetLogLinesReachesServices(t *testing.T) {
	m := NewManager(cfgWith("a"))
	if m.LogLines() != DefaultLogLines {
		t.Fatalf("default = %d", m.LogLines())
	}
	for i := 0; i < 50; i++ {
		m.Get("a").appendLog("out", "x")
	}
	m.SetLogLines(10)
	if n := len(m.Get("a").Logs(0)); n != 10 {
		t.Fatalf("kept %d lines, want 10", n)
	}
	if m.State().LogLines != 10 {
		t.Fatal("state must report the new size")
	}
}

func TestValidLogLines(t *testing.T) {
	for _, n := range []int{1000, 2500, 5000, 10000} {
		if !ValidLogLines(n) {
			t.Errorf("%d should be valid", n)
		}
	}
	for _, n := range []int{0, -1, 999, 20000} {
		if ValidLogLines(n) {
			t.Errorf("%d should be invalid", n)
		}
	}
}

func cfgWith(name string) *config.Config {
	c := config.Empty()
	c.Services = []config.Service{{Name: name}}
	return c
}
