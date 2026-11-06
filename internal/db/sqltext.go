package db

import (
	"errors"
	"strings"
)

// maskLiterals blanks out string literals, quoted identifiers and comments, so checks
// can look at the real SQL words only. The result has the same length as sql.
func maskLiterals(sql string) string {
	b := []byte(sql)
	n := len(b)
	blank := func(from, to int) {
		for i := from; i < to && i < n; i++ {
			if b[i] != '\n' {
				b[i] = ' '
			}
		}
	}
	for i := 0; i < n; {
		switch {
		case b[i] == '-' && i+1 < n && b[i+1] == '-': // line comment
			j := i
			for j < n && b[j] != '\n' {
				j++
			}
			blank(i, j)
			i = j
		case b[i] == '/' && i+1 < n && b[i+1] == '*': // block comment
			j := i + 2
			for j+1 < n && !(b[j] == '*' && b[j+1] == '/') {
				j++
			}
			j = min(j+2, n)
			blank(i, j)
			i = j
		case b[i] == '\'' || b[i] == '"':
			q := b[i]
			j := i + 1
			for j < n {
				if b[j] == q {
					if j+1 < n && b[j+1] == q { // doubled quote
						j += 2
						continue
					}
					break
				}
				j++
			}
			blank(i+1, j)
			i = min(j+1, n)
		default:
			i++
		}
	}
	return string(b)
}

// firstWord is the first SQL keyword, upper case ("" if none).
func firstWord(masked string) string {
	s := strings.TrimLeft(masked, " \t\r\n(")
	end := 0
	for end < len(s) && (s[end] >= 'A' && s[end] <= 'Z' || s[end] >= 'a' && s[end] <= 'z' || s[end] == '_') {
		end++
	}
	return strings.ToUpper(s[:end])
}

// isQuery reports whether sql returns rows (SELECT / WITH).
func isQuery(sql string) bool {
	w := firstWord(maskLiterals(sql))
	return w == "SELECT" || w == "WITH"
}

// txControl recognizes a typed COMMIT / ROLLBACK (not ROLLBACK TO SAVEPOINT): the UI session
// must end its transaction itself, or it would still show "uncommitted changes".
func txControl(sql string) string {
	f := strings.Fields(strings.ToUpper(strings.TrimRight(strings.TrimSpace(maskLiterals(sql)), "; \t\r\n")))
	if len(f) == 2 && f[1] == "WORK" {
		f = f[:1]
	}
	if len(f) == 1 && (f[0] == "COMMIT" || f[0] == "ROLLBACK") {
		return f[0]
	}
	return ""
}

// isDDL reports statements that Oracle commits implicitly.
func isDDL(sql string) bool {
	switch firstWord(maskLiterals(sql)) {
	case "CREATE", "ALTER", "DROP", "TRUNCATE", "GRANT", "REVOKE", "COMMENT", "RENAME", "ANALYZE", "AUDIT", "NOAUDIT", "FLASHBACK", "PURGE":
		return true
	}
	return false
}

// prepare trims the statement for the driver: Oracle rejects a trailing ";" on plain SQL,
// but a PL/SQL block or CREATE PROCEDURE ... END; needs it.
func prepare(sql string) string {
	t := strings.TrimSpace(sql)
	for strings.HasSuffix(t, ";") {
		body := strings.TrimSpace(strings.TrimSuffix(t, ";"))
		up := strings.ToUpper(maskLiterals(body))
		if strings.HasSuffix(up, "END") || strings.HasSuffix(up, "END "+lastWord(up)) && strings.HasPrefix(firstWord(up), "CREATE") {
			return t // keep "END;"
		}
		t = body
	}
	return t
}

func lastWord(s string) string {
	f := strings.Fields(s)
	if len(f) == 0 {
		return ""
	}
	return f[len(f)-1]
}

// checkReadOnly accepts exactly one SELECT / WITH statement without FOR UPDATE.
func checkReadOnly(sql string) error {
	masked := strings.TrimSpace(maskLiterals(sql))
	masked = strings.TrimRight(masked, "; \t\r\n")
	if masked == "" {
		return errors.New("empty statement")
	}
	if strings.Contains(masked, ";") {
		return errors.New("one statement at a time (no ; in the middle)")
	}
	if w := firstWord(masked); w != "SELECT" && w != "WITH" {
		return errors.New("this connection is read-only for AI: only SELECT / WITH statements are allowed")
	}
	up := " " + strings.Join(strings.Fields(strings.ToUpper(masked)), " ") + " "
	if strings.Contains(up, " FOR UPDATE ") || strings.Contains(up, " FOR UPDATE;") {
		return errors.New("SELECT ... FOR UPDATE is not allowed on a read-only connection")
	}
	return nil
}

// checkSingle rejects several statements in one go (used for AI writes).
func checkSingle(sql string) error {
	masked := strings.TrimSpace(maskLiterals(sql))
	if strings.TrimRight(masked, "; \t\r\n") == "" {
		return errors.New("empty statement")
	}
	w := firstWord(masked)
	if w == "BEGIN" || w == "DECLARE" || w == "CREATE" {
		return nil // PL/SQL blocks contain ; by nature
	}
	if strings.Contains(strings.TrimRight(masked, "; \t\r\n"), ";") {
		return errors.New("one statement at a time (no ; in the middle)")
	}
	return nil
}
