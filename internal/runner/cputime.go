package runner

import (
	"strconv"
	"strings"
	"time"
)

// parseCPUTime reads ps's TIME column: [dd-][hh:]mm:ss[.cc].
func parseCPUTime(s string) (time.Duration, bool) {
	var days int
	if i := strings.IndexByte(s, '-'); i >= 0 {
		d, err := strconv.Atoi(s[:i])
		if err != nil {
			return 0, false
		}
		days, s = d, s[i+1:]
	}
	parts := strings.Split(s, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, false
	}
	sec, err := strconv.ParseFloat(parts[len(parts)-1], 64)
	if err != nil {
		return 0, false
	}
	total := sec
	mult := 60.0
	for i := len(parts) - 2; i >= 0; i-- {
		n, err := strconv.Atoi(parts[i])
		if err != nil {
			return 0, false
		}
		total += float64(n) * mult
		mult *= 60
	}
	total += float64(days) * 86400
	return time.Duration(total * float64(time.Second)), true
}
