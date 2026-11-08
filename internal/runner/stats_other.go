//go:build !linux && !darwin && !windows

package runner

// No sampler on this platform: services show no CPU / memory.
func sampleProcs(procs []*proc) map[*proc]usage { return nil }
