package server

import (
	"net/http"
	"path/filepath"
	"runtime"
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
	Files    []gitdiff.File `json:"files"`   // paths relative to Root
	Ignored  []ignoredFile  `json:"ignored"` // changed, but hidden by a changes_ignore pattern of the project's services
	hidden   bool           // a service of the project is set to stay out of Changes (services in one folder share a project)
	patterns []string       // changes_ignore of its services (relative to the project folder)
	ignore   *gitdiff.Ignore
}

// repoLoc is where a service folder sits: its repository and its folder in it
// (as git reports them, see gitdiff.Locate).
type repoLoc struct{ root, prefix string }

type ignoredFile struct {
	gitdiff.File
	Pattern string `json:"pattern"` // the pattern that hides it
}

// add puts a changed file in the project, or in its ignored list when a pattern hides it.
func (p *gitProject) add(f gitdiff.File) {
	rel := f.Path
	if p.Prefix != "" && len(f.Path) > len(p.Prefix) {
		rel = f.Path[len(p.Prefix)+1:] // cut by length: the case may differ on Windows (see under)
	}
	if pat := p.ignore.Match(rel); pat != "" {
		p.Ignored = append(p.Ignored, ignoredFile{File: f, Pattern: pat})
		return
	}
	p.Files = append(p.Files, f)
}

// under tells whether a repository path lies in the project folder prefix.
// Windows folders ignore case, and a cwd typed in grid.yaml may not match
// the case git keeps, so there the comparison ignores it too.
func under(path, prefix string) bool {
	if prefix == "" {
		return true
	}
	if runtime.GOOS == "windows" {
		path, prefix = strings.ToLower(path), strings.ToLower(prefix)
	}
	return path == prefix || strings.HasPrefix(path, prefix+"/")
}

// gitProjects groups the changed files by project. A file belongs to the
// deepest project folder containing it; files outside every project land in
// "<repo> (other files)". Projects without changes are left out.
func gitProjects(m *runner.Manager, cache *sync.Map) ([]gitProject, string) {
	type key struct{ root, prefix string }
	projects := map[key]*gitProject{}
	visible := map[string]bool{} // repository -> at least one of its services is shown in Changes
	var firstErr string
	for _, s := range m.State().Services {
		var loc repoLoc
		if v, ok := cache.Load(s.Cwd); ok {
			loc = v.(repoLoc)
		} else {
			r, prefix, err := gitdiff.Locate(s.Cwd)
			if err != nil {
				if strings.Contains(err.Error(), "not found on PATH") {
					return nil, err.Error()
				}
				if firstErr == "" {
					firstErr = err.Error()
				}
			} else {
				loc = repoLoc{r, prefix}
			}
			cache.Store(s.Cwd, loc) // root "" = not a repository
		}
		root, prefix := loc.root, loc.prefix
		if root == "" {
			continue
		}
		if !s.NoChanges {
			visible[root] = true
		}
		k := key{root, prefix}
		p := projects[k]
		if p == nil {
			p = &gitProject{Key: root + "|" + prefix, Name: s.Name, Root: root, Prefix: prefix, Files: []gitdiff.File{}, Ignored: []ignoredFile{}}
			projects[k] = p
		}
		if s.NoChanges {
			p.hidden = true
		}
		p.Services = append(p.Services, s.Name)
		p.Types = append(p.Types, string(s.Type))
		p.patterns = append(p.patterns, s.ChangesIgnore...)
	}
	for _, p := range projects {
		p.ignore = gitdiff.NewIgnore(p.patterns)
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
		if !visible[root] { // every service of this repository is hidden: nothing of it is listed, not even its other files
			continue
		}
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
					p.add(f)
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
				root0.add(f)
			} else {
				other = append(other, f)
			}
		}
		for _, p := range list {
			if len(p.Files)+len(p.Ignored) == 0 || p.hidden { // a hidden project still claims its files, so they do not show up as "other files"
				continue
			}
			p.Branch = st.Branch
			out = append(out, *p)
		}
		if len(other) > 0 {
			out = append(out, gitProject{Key: root + "|*", Name: filepath.Base(root) + " (other files)", Root: root, Branch: st.Branch, Files: other,
				Ignored: []ignoredFile{}, Services: []string{}, Types: []string{}})
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
			if v, found := cache.Load(s.Cwd); found && v.(repoLoc).root == root && root != "" {
				ok = true
				break
			}
		}
		if !ok {
			writeError(w, http.StatusNotFound, "unknown repository")
			return
		}
		d, err := gitdiff.FileDiff(r.Context(), root, r.URL.Query().Get("path"))
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, d)
	})
}
