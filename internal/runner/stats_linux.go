package runner

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Linux: every process in /proc whose process group is the service's.
// utime/stime are in clock ticks (USER_HZ, 100 on every common kernel).
const clockTicks = 100

func sampleProcs(procs []*proc) map[*proc]usage {
	byGroup := map[int]*proc{}
	for _, p := range procs {
		byGroup[p.pid] = p
	}
	out := map[*proc]usage{}
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return out
	}
	page := uint64(os.Getpagesize())
	for _, e := range ents {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		b, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue
		}
		pgrp, cpu, rss, ok := parseProcStat(string(b))
		if !ok {
			continue
		}
		if p := byGroup[pgrp]; p != nil {
			u := out[p]
			u.cpu += time.Duration(cpu) * time.Second / clockTicks
			u.mem += rss * page
			out[p] = u
		}
	}
	return out
}

// parseProcStat reads the process group, utime+stime (ticks) and rss (pages)
// of /proc/<pid>/stat. The command name may hold spaces and parentheses, so
// fields are counted after the last ')'.
func parseProcStat(s string) (pgrp int, ticks, rss uint64, ok bool) {
	i := strings.LastIndexByte(s, ')')
	if i < 0 {
		return 0, 0, 0, false
	}
	f := strings.Fields(s[i+1:]) // f[0] is field 3 (state)
	if len(f) < 22 {
		return 0, 0, 0, false
	}
	pgrp, err1 := strconv.Atoi(f[2])
	ut, err2 := strconv.ParseUint(f[11], 10, 64)
	st, err3 := strconv.ParseUint(f[12], 10, 64)
	r, err4 := strconv.ParseInt(f[21], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
		return 0, 0, 0, false
	}
	if r < 0 {
		r = 0
	}
	return pgrp, ut + st, uint64(r), true
}
