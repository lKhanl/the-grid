package server

import (
	"net/http"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/lKhanl/the-grid/internal/gitdiff"
	"github.com/lKhanl/the-grid/internal/runner"
)

// gitProject is one working directory of the workspace (shared by every
// service that runs there) with the changed files that live under it.
type gitProject struct {
	Key      string         `json:"key"`
	Name     string         `json:"name"`
	Services []string       `json:"services"`
	Types    []string       `json:"types"`
	Root     string         `json:"root"`   // repository top-level folder
	Prefix   string         `json:"prefix"` // project folder inside the repository ("" = the root), slash separated
	Branch   string         `json:"branch"`
	Files    []gitdiff.File `json:"files"` // paths relative to Root
}

func under(path, prefix string) bool {
	return prefix == "" || path == prefix || strings.HasPrefix(path, prefix+"/")
}

// gitProjects groups the changed files by project. A file belongs to the
// deepest project folder containing it; files outside every project land in
// "<repo> (other files)". Projects without changes are left out.
func gitProjects(m *runner.Manager, cache *sync.Map) ([]gitProject, string) {
	type key struct{ root, prefix string }
	projects := map[key]*gitProject{}
	var firstErr string
	for _, s := range m.State().Services {
		var root string
		if v, ok := cache.Load(s.Cwd); ok {
			root = v.(string)
		} else {
			r, err := gitdiff.Root(s.Cwd)
			if err != nil {
				if strings.Contains(err.Error(), "not found on PATH") {
					return nil, err.Error()
				}
				if firstErr == "" {
					firstErr = err.Error()
				}
			} else {
				root = r
			}
			cache.Store(s.Cwd, root) // "" = not a repository
		}
		if root == "" {
			continue
		}
		prefix := ""
		if rel, err := filepath.Rel(root, s.Cwd); err == nil && rel != "." {
			prefix = filepath.ToSlash(rel)
		}
		k := key{root, prefix}
		p := projects[k]
		if p == nil {
			p = &gitProject{Key: root + "|" + prefix, Name: s.Name, Root: root, Prefix: prefix, Files: []gitdiff.File{}}
			projects[k] = p
		}
		p.Services = append(p.Services, s.Name)
		p.Types = append(p.Types, string(s.Type))
	}
	if len(projects) == 0 {
		return []gitProject{}, firstErr
	}

	byRoot := map[string][]*gitProject{}
	for k, p := range projects {
		byRoot[k.root] = append(byRoot[k.root], p)
	}
	var out []gitProject
	for root, list := range byRoot {
		st, err := gitdiff.Status(root)
		if err != nil {
			return nil, err.Error()
		}
		// deepest folder first
		sort.Slice(list, func(i, j int) bool { return len(list[i].Prefix) > len(list[j].Prefix) })
		var other []gitdiff.File
		for _, f := range st.Files {
			placed := false
			for _, p := range list {
				if p.Prefix != "" && under(f.Path, p.Prefix) {
					p.Files = append(p.Files, f)
					placed = true
					break
				}
			}
			if placed {
				continue
			}
			// the project at the repo root (prefix "") takes everything not claimed by a deeper one
			if root0 := func() *gitProject {
				for _, p := range list {
					if p.Prefix == "" {
						return p
					}
				}
				return nil
			}(); root0 != nil {
				root0.Files = append(root0.Files, f)
			} else {
				other = append(other, f)
			}
		}
		for _, p := range list {
			if len(p.Files) == 0 {
				continue
			}
			p.Branch = st.Branch
			out = append(out, *p)
		}
		if len(other) > 0 {
			out = append(out, gitProject{Key: root + "|*", Name: filepath.Base(root) + " (other files)", Root: root, Branch: st.Branch, Files: other,
				Services: []string{}, Types: []string{}})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if out == nil {
		out = []gitProject{}
	}
	return out, ""
}

func gitRoutes(mux *http.ServeMux, m *runner.Manager) {
	cache := &sync.Map{}
	mux.HandleFunc("GET /api/git/changes", func(w http.ResponseWriter, r *http.Request) {
		projects, errMsg := gitProjects(m, cache)
		writeJSON(w, http.StatusOK, map[string]any{"projects": projects, "error": errMsg})
	})
	mux.HandleFunc("GET /api/git/diff", func(w http.ResponseWriter, r *http.Request) {
		// only repositories that contain a service can be read
		root := r.URL.Query().Get("repo")
		ok := false
		for _, s := range m.State().Services {
			if v, found := cache.Load(s.Cwd); found && v.(string) == root && root != "" {
				ok = true
				break
			}
		}
		if !ok {
			writeError(w, http.StatusNotFound, "unknown repository")
			return
		}
		d, err := gitdiff.FileDiff(root, r.URL.Query().Get("path"))
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, d)
	})
}
