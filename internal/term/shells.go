package term

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Shell is an installed shell the UI can offer.
type Shell struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func kind(shell string) string {
	base := strings.ToLower(shellName(shell))
	switch base {
	case "cmd", "powershell", "pwsh", "bash", "zsh", "fish":
		return base
	}
	return "sh"
}

// ShellArgs is the command line that starts shell interactively.
func ShellArgs(shell string) []string {
	switch kind(shell) {
	case "powershell", "pwsh":
		return []string{shell, "-NoLogo"}
	case "bash":
		if runtime.GOOS == "windows" {
			return []string{shell, "--login", "-i"} // Git Bash: load its profile (prompt, PATH conversion)
		}
	}
	return []string{shell}
}

// Shells lists the shells found on this machine; the first is the default.
func Shells() []Shell {
	var out []Shell
	seen := map[string]bool{}
	add := func(name, path string) {
		if path == "" {
			return
		}
		key := strings.ToLower(filepath.Clean(path))
		if seen[key] {
			return
		}
		if _, err := os.Stat(path); err != nil {
			return
		}
		seen[key] = true
		out = append(out, Shell{Name: name, Path: path})
	}
	look := func(exe string) string {
		p, _ := exec.LookPath(exe)
		return p
	}
	if runtime.GOOS == "windows" {
		add("PowerShell", look("powershell.exe"))
		add("PowerShell 7", look("pwsh.exe"))
		comspec := os.Getenv("COMSPEC")
		if comspec == "" {
			comspec = look("cmd.exe")
		}
		add("Command Prompt", comspec)
		add("Git Bash", gitBash())
		return out
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		add(shellName(sh), sh)
	}
	for _, sh := range []string{"zsh", "bash", "fish", "sh", "pwsh"} {
		add(sh, look(sh))
	}
	return out
}

// gitBash finds Git for Windows' bash (not WSL's System32\bash.exe).
func gitBash() string {
	var cands []string
	if git := func() string { p, _ := exec.LookPath("git.exe"); return p }(); git != "" {
		root := filepath.Dir(filepath.Dir(git)) // ...\Git\cmd\git.exe or ...\Git\bin\git.exe
		cands = append(cands, filepath.Join(root, "bin", "bash.exe"))
	}
	for _, env := range []string{"ProgramFiles", "ProgramW6432", "LOCALAPPDATA"} {
		if v := os.Getenv(env); v != "" {
			sub := "Git"
			if env == "LOCALAPPDATA" {
				sub = filepath.Join("Programs", "Git")
			}
			cands = append(cands, filepath.Join(v, sub, "bin", "bash.exe"))
		}
	}
	for _, c := range cands {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// DefaultShell is the first shell found (PowerShell on Windows, $SHELL elsewhere).
func DefaultShell() string {
	if list := Shells(); len(list) > 0 {
		return list[0].Path
	}
	if runtime.GOOS == "windows" {
		return "cmd.exe"
	}
	return "/bin/sh"
}
