package main

// 本机文件工具的实现细节（list_dir / search_text / patch_file）。
// 它们只被宿主注册的工具调用，本身不含任何模型循环。

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func (a *nodeAgent) listDir(path string) (string, error) {
	path, err := expandPath(path)
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return "", err
	}
	const maxEntries = 200
	var b strings.Builder
	fmt.Fprintf(&b, "%s\n", path)
	n := 0
	for _, e := range entries {
		if n >= maxEntries {
			fmt.Fprintf(&b, "… truncated after %d entries\n", maxEntries)
			break
		}
		name := e.Name()
		if e.IsDir() {
			name += "/"
		}
		fmt.Fprintf(&b, "%s\n", name)
		n++
	}
	log.Printf("local agent list_dir: path=%s entries=%d", path, n)
	return b.String(), nil
}

var searchSkipDirs = map[string]bool{".git": true, "node_modules": true, "dist": true, "data": true}

const (
	searchMaxFileBytes = 1 << 20
	searchMaxFiles     = 2000
	searchMaxMatches   = 200
)

// searchText 在 path（目录或单文件）内按正则检索，返回 path:line: 文本。
func (a *nodeAgent) searchText(ctx context.Context, path, pattern string) (string, error) {
	path, err := expandPath(path)
	if err != nil {
		return "", err
	}
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return "", fmt.Errorf("pattern required")
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return "", fmt.Errorf("bad pattern: %v", err)
	}
	var b strings.Builder
	matches, files := 0, 0
	stop := fmt.Errorf("stop")
	err = filepath.WalkDir(path, func(p string, d os.DirEntry, werr error) error {
		if werr != nil {
			return nil
		}
		if ctx.Err() != nil {
			return stop
		}
		if d.IsDir() {
			if searchSkipDirs[d.Name()] && p != path {
				return filepath.SkipDir
			}
			return nil
		}
		if files >= searchMaxFiles || matches >= searchMaxMatches {
			return stop
		}
		info, err := d.Info()
		if err != nil || info.Size() > searchMaxFileBytes {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return nil
		}
		defer f.Close()
		files++
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		line := 0
		for sc.Scan() {
			line++
			if matches >= searchMaxMatches {
				return stop
			}
			text := sc.Text()
			if re.MatchString(text) {
				matches++
				fmt.Fprintf(&b, "%s:%d: %s\n", p, line, clipLine(text, 200))
			}
		}
		return nil
	})
	if err != nil && err != stop {
		return "", err
	}
	if matches == 0 {
		return "no matches", nil
	}
	if matches >= searchMaxMatches {
		fmt.Fprintf(&b, "… truncated at %d matches\n", searchMaxMatches)
	}
	log.Printf("local agent search_text: path=%s pattern=%q matches=%d files=%d", path, pattern, matches, files)
	return b.String(), nil
}

func clipLine(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// patchFile 精确串替换；0 处或多处（未 all）时报错，避免盲改。
func (a *nodeAgent) patchFile(path, old, new string, all bool) (string, error) {
	path, err := expandPath(path)
	if err != nil {
		return "", err
	}
	if old == "" {
		return "", fmt.Errorf("old required")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	content := string(raw)
	n := strings.Count(content, old)
	switch {
	case n == 0:
		return "", fmt.Errorf("old text not found in %s", path)
	case n > 1 && !all:
		return "", fmt.Errorf("old text occurs %d times; provide more context or set all=true", n)
	}
	replaced := content
	if all {
		replaced = strings.ReplaceAll(content, old, new)
	} else {
		replaced = strings.Replace(content, old, new, 1)
	}
	if err := os.WriteFile(path, []byte(replaced), 0o600); err != nil {
		return "", err
	}
	log.Printf("local agent patch_file: path=%s replaced=%d", path, n)
	return fmt.Sprintf("patched %s (%d replacement(s))", path, n), nil
}
