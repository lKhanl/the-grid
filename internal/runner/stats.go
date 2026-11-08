package runner

import (
	"math"
	"time"
)

// CPU and memory of each running service's process tree, sampled every few
// seconds: one system call batch for all services (Windows: the service's
// Job Object; macOS: one `ps`; Linux: /proc).

const statsEvery = 2 * time.Second

// usage is one sample of a process tree.
type usage struct {
	cpu time.Duration // CPU time used so far (user + system)
	mem uint64        // resident memory in bytes
}

// procStats is what a Service keeps between samples.
type procStats struct {
	proc  *proc // the process the numbers belong to
	at    time.Time
	used  time.Duration
	cpu   float64 // percent of one core since the previous sample
	cpuOK bool    // false until there are two samples
	mem   uint64
}

// StartStats samples CPU and memory in the background (once per manager).
func (m *Manager) StartStats() {
	m.statsOn.Do(func() {
		go func() {
			t := time.NewTicker(statsEvery)
			defer t.Stop()
			for range t.C {
				m.sampleStats()
			}
		}()
	})
}

func (m *Manager) sampleStats() {
	var procs []*proc
	owners := map[*proc]*Service{}
	for _, s := range m.Services() {
		s.mu.Lock()
		if p := s.proc; p != nil {
			procs = append(procs, p)
			owners[p] = s
		}
		s.mu.Unlock()
	}
	if len(procs) == 0 {
		return
	}
	got := sampleProcs(procs)
	now := time.Now()
	for p, u := range got {
		s := owners[p]
		s.mu.Lock()
		if s.proc != p { // stopped or moved on from the build meanwhile
			s.mu.Unlock()
			continue
		}
		st := &s.stats
		before := *st
		if st.proc == p && now.After(st.at) {
			d := u.cpu - st.used
			if d < 0 {
				d = 0 // a child exited: its CPU time left the sum (Unix)
			}
			st.cpu = math.Round(float64(d)/float64(now.Sub(st.at))*1000) / 10
			st.cpuOK = true
		} else {
			st.cpuOK = false
		}
		st.proc, st.at, st.used, st.mem = p, now, u.cpu, u.mem
		changed := st.cpuOK != before.cpuOK || math.Abs(st.cpu-before.cpu) >= 1 ||
			memDiff(st.mem, before.mem) > max(before.mem/50, 1<<20) || before.proc != p
		s.mu.Unlock()
		if changed {
			s.publish()
		}
	}
}

func memDiff(a, b uint64) uint64 {
	if a > b {
		return a - b
	}
	return b - a
}
