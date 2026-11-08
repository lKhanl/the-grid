package runner

import "testing"

func TestParseProcStat(t *testing.T) {
	// comm with spaces and a ')' inside
	s := "4242 (my (odd) app) S 1 4200 4200 0 -1 4194560 100 0 0 0 150 50 0 0 20 0 1 0 100 1000000 321 18446744073709551615"
	pgrp, ticks, rss, ok := parseProcStat(s)
	if !ok || pgrp != 4200 || ticks != 200 || rss != 321 {
		t.Fatalf("got %d %d %d %v", pgrp, ticks, rss, ok)
	}
}
