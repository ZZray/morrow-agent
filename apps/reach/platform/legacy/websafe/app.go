// Package websafe applies narrow, version-checked security repairs to the
// maintained legacy HandWave UI without changing its source-evidence archive.
package websafe

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
)

//go:embed patch.json
var patch []byte

// AdaptApp accepts each exact original or repaired call site once. This allows
// Ray to safely receive an already repaired Hub script, while drift, duplicates
// and partially altered repairs fail closed instead of serving unsafe markup.
func AdaptApp(body []byte) ([]byte, error) {
	// Git checkouts on Windows may embed CRLF while the pinned release uses LF.
	// JavaScript normalizes either line ending; compare the same reviewed source.
	body = bytes.ReplaceAll(body, []byte("\r\n"), []byte("\n"))
	var edits []struct {
		Old   string `json:"old"`
		New   string `json:"new"`
		Count int    `json:"count"`
	}
	if err := json.Unmarshal(patch, &edits); err != nil {
		return nil, errors.New("invalid HandWave security patch")
	}
	for _, edit := range edits {
		if edit.Old == "" || edit.New == "" || edit.Old == edit.New || edit.Count != 1 {
			return nil, errors.New("invalid HandWave security call site")
		}
		originals, repaired := bytes.Count(body, []byte(edit.Old)), bytes.Count(body, []byte(edit.New))
		if repaired == 1 && originals == bytes.Count([]byte(edit.New), []byte(edit.Old)) {
			continue
		}
		if repaired != 0 || originals != 1 {
			return nil, errors.New("HandWave security call site requires review")
		}
		body = bytes.Replace(body, []byte(edit.Old), []byte(edit.New), 1)
	}
	return body, nil
}
