//go:build !windows

package main

import "os"

func restrictFileAccess(path string) error {
	return os.Chmod(path, 0o600)
}
