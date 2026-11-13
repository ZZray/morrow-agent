package websafe

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestAdaptAppIdempotenceAndDrift(t *testing.T) {
	var edits []struct{ Old, New string }
	if err := json.Unmarshal(patch, &edits); err != nil {
		t.Fatal(err)
	}
	var source []byte
	for _, edit := range edits {
		source = append(source, []byte(edit.Old+"\n")...)
	}
	fixed, err := AdaptApp(source)
	if err != nil {
		t.Fatal(err)
	}
	twice, err := AdaptApp(fixed)
	if err != nil || !bytes.Equal(fixed, twice) {
		t.Fatal("already repaired source changed or rejected")
	}
	for _, input := range [][]byte{nil, append(append([]byte(nil), source...), source...), bytes.Replace(fixed, []byte("text.textContent = message;"), []byte("text.innerHTML = message;"), 1), append(append([]byte(nil), fixed...), []byte(edits[0].Old)...)} {
		if _, err = AdaptApp(input); err == nil {
			t.Fatal("missing, duplicate, altered or mixed call site accepted")
		}
	}
}
