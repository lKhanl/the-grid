package runner

import (
	"os/exec"
	"strconv"
	"strings"
)

// macOS has no /proc: one `ps` lists every process with its group,
// resident size (KiB) and CPU time.
func sampleProcs(procs []*proc) map[*proc]usage {
	byGroup := map[int]*proc{}
	for _, p := range procs {
		byGroup[p.pid] = p
	}
	out := map[*proc]usage{}
	b, err := exec.Command("ps", "-A", "-o", "pgid=", "-o", "rss=", "-o", "time=").Output()
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) != 3 {
			continue
		}
		pgid, err := strconv.Atoi(f[0])
		if err != nil || byGroup[pgid] == nil {
			continue
		}
		rss, err1 := strconv.ParseUint(f[1], 10, 64)
		cpu, ok := parseCPUTime(f[2])
		if err1 != nil || !ok {
			continue
		}
		p := byGroup[pgid]
		u := out[p]
		u.cpu += cpu
		u.mem += rss * 1024
		out[p] = u
	}
	return out
}
