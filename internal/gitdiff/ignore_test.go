package gitdiff

import "testing"

func TestIgnore(t *testing.T) {
	ig := NewIgnore([]string{"*.iml", "tmp/", "src/main/resources/application-local.yml", "**/gen/*.java", "/build", "# comment", ""})
	cases := map[string]string{
		"api.iml":          "*.iml",
		"sub/x.iml":        "*.iml",
		"tmp/a.log":        "tmp/",
		"x/tmp/deep/a.log": "tmp/",
		"tmp":              "", // a file called tmp: the pattern is for folders
		"src/main/resources/application-local.yml":       "src/main/resources/application-local.yml",
		"other/src/main/resources/application-local.yml": "", // anchored
		"a/b/gen/X.java":  "**/gen/*.java",
		"gen/X.java":      "**/gen/*.java",
		"gen/sub/X.java":  "",
		"build/out.jar":   "/build",
		"x/build/out.jar": "",
		"src/Main.java":   "",
	}
	for p, want := range cases {
		if got := ig.Match(p); got != want {
			t.Errorf("%s: got %q, want %q", p, got, want)
		}
	}
	if (*Ignore)(nil).Match("a") != "" {
		t.Error("nil matcher matched")
	}
}
