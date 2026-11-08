//go:build linux || darwin || windows

package runner

import (
	"os"
	"runtime"
	"testing"
	"time"

	"github.com/lKhanl/the-grid/internal/config"
)

// A real busy process: after two samples it shows memory and CPU.
func TestStatsOfRunningService(t *testing.T) {
	cmd := "while :; do :; done"
	if runtime.GOOS == "windows" {
		cmd = `powershell -NoProfile -Command "while ($true) {}"`
	}
	m := NewManager(config.Empty())
	m.SetLogDir(t.TempDir())
	defer m.Shutdown()
	s := newService(m, config.Service{Name: "busy", Command: cmd, Cwd: os.TempDir(), StopTimeout: time.Second}, "/tmp/ws/grid.yaml")
	m.services = append(m.services, s)
	m.byName["busy"] = s
	if err := s.Start(); err != nil {
		t.Fatal(err)
	}
	defer s.Stop()

	time.Sleep(300 * time.Millisecond)
	m.sampleStats()
	time.Sleep(time.Second)
	m.sampleStats()
	info := s.Info()
	if info.Mem == 0 || info.CPU == nil {
		t.Fatalf("no stats: mem %d cpu %v", info.Mem, info.CPU)
	}
	if *info.CPU < 20 {
		t.Fatalf("busy loop shows only %.1f%% cpu", *info.CPU)
	}
	if info.LogFile == "" {
		t.Fatal("no log file")
	}

	s.Stop()
	if i := s.Info(); i.Mem != 0 || i.CPU != nil {
		t.Fatalf("stats after stop: %+v", i)
	}
}
