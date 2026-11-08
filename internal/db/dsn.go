//go:build db || oracle

package db

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	go_ora "github.com/sijms/go-ora/v2"
)

// dsn builds the go-ora connection URL of c.
func dsn(c Conn) (string, error) {
	switch c.Mode {
	case ModeService:
		return go_ora.BuildUrl(c.Host, c.Port, c.Service, c.User, c.Password, nil), nil
	case ModeSID:
		return go_ora.BuildUrl(c.Host, c.Port, "", c.User, c.Password, map[string]string{"SID": c.SID}), nil
	case ModeTNS:
		desc := c.TNS
		if !strings.HasPrefix(strings.TrimSpace(desc), "(") { // an alias
			var err error
			if desc, err = lookupTNS(c.TNS, c.TNSAdmin); err != nil {
				return "", err
			}
		}
		return go_ora.BuildJDBC(c.User, c.Password, desc, nil), nil
	}
	return "", fmt.Errorf("mode %q", c.Mode)
}

// lookupTNS finds alias in tnsnames.ora (admin folder, $TNS_ADMIN, or $ORACLE_HOME/network/admin).
func lookupTNS(alias, admin string) (string, error) {
	var dirs []string
	if admin != "" {
		dirs = append(dirs, admin)
	}
	if d := os.Getenv("TNS_ADMIN"); d != "" {
		dirs = append(dirs, d)
	}
	if h := os.Getenv("ORACLE_HOME"); h != "" {
		dirs = append(dirs, filepath.Join(h, "network", "admin"))
	}
	if len(dirs) == 0 {
		return "", fmt.Errorf("TNS alias %q: set the TNS folder on the connection or the TNS_ADMIN environment variable", alias)
	}
	for _, d := range dirs {
		b, err := os.ReadFile(filepath.Join(d, "tnsnames.ora"))
		if err != nil {
			continue
		}
		if desc, ok := parseTNSNames(string(b))[strings.ToUpper(alias)]; ok {
			return desc, nil
		}
	}
	return "", fmt.Errorf("TNS alias %q not found in tnsnames.ora (looked in %s)", alias, strings.Join(dirs, ", "))
}

// parseTNSNames returns alias (upper case) -> "(DESCRIPTION=...)" for every entry.
// It understands comments (#), several aliases for one entry ("A, B = (...)") and nested parentheses.
func parseTNSNames(text string) map[string]string {
	var lines []string
	for _, l := range strings.Split(text, "\n") {
		if i := strings.Index(l, "#"); i >= 0 {
			l = l[:i]
		}
		lines = append(lines, l)
	}
	s := strings.Join(lines, "\n")
	out := map[string]string{}
	i := 0
	for i < len(s) {
		eq := strings.Index(s[i:], "=")
		if eq < 0 {
			break
		}
		names := strings.TrimSpace(s[i : i+eq])
		j := i + eq + 1
		for j < len(s) && (s[j] == ' ' || s[j] == '\t' || s[j] == '\n' || s[j] == '\r') {
			j++
		}
		if j >= len(s) || s[j] != '(' {
			i = j
			continue
		}
		depth, k := 0, j
		for ; k < len(s); k++ {
			if s[k] == '(' {
				depth++
			} else if s[k] == ')' {
				depth--
				if depth == 0 {
					k++
					break
				}
			}
		}
		desc := strings.Join(strings.Fields(s[j:k]), "")
		for _, n := range strings.Split(names, ",") {
			if n = strings.ToUpper(strings.TrimSpace(n)); n != "" {
				out[n] = desc
			}
		}
		i = k
	}
	return out
}
