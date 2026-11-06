package db

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// formatCell turns a driver value into display text (nil = NULL).
func formatCell(v any, dbType string) *string {
	var s string
	switch x := v.(type) {
	case nil:
		return nil
	case string:
		s = x
	case []byte:
		s = formatBinary(x)
	case int64:
		s = strconv.FormatInt(x, 10)
	case int:
		s = strconv.Itoa(x)
	case float64:
		s = strconv.FormatFloat(x, 'f', -1, 64)
	case float32:
		s = strconv.FormatFloat(float64(x), 'f', -1, 32)
	case bool:
		s = strconv.FormatBool(x)
	case time.Time:
		s = formatTime(x, dbType)
	case fmt.Stringer:
		s = x.String()
	default:
		s = fmt.Sprint(x)
	}
	return &s
}

func formatTime(t time.Time, dbType string) string {
	layout := "2006-01-02 15:04:05"
	if t.Nanosecond() != 0 {
		layout += ".999999999"
	}
	if strings.Contains(strings.ToUpper(dbType), "TZ") || strings.Contains(strings.ToUpper(dbType), "TIME ZONE") {
		layout += " -07:00"
	}
	return t.Format(layout)
}

func formatBinary(b []byte) string {
	const show = 16
	if len(b) <= show {
		return fmt.Sprintf("0x%X", b)
	}
	return fmt.Sprintf("0x%X... (%d bytes)", b[:show], len(b))
}
