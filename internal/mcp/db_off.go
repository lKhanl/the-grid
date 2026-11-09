//go:build !db && !oracle && !postgres

package mcp

// Built without the database module (no -tags db): no db_* tools.

const dbInstructions = ""

var dbTools []map[string]any

func (s *Server) dbReload() string { return "" }

func (s *Server) callDB(string, map[string]any) (string, bool, error) { return "", false, nil }
