package memorystore

import (
	"sort"
	"strings"
	"unicode"
)

// retrievalTerms is deterministic and bounded. Han bigrams let ordinary Chinese
// sentences match relevant notes without an auxiliary model or a vector index.
func retrievalTerms(query string) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(s string) {
		if s != "" && len(out) < 64 && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	var latin, han []rune
	flushLatin := func() { add(string(latin)); latin = nil }
	flushHan := func() {
		if len(han) == 1 {
			add(string(han))
		}
		for i := 1; i < len(han); i++ {
			add(string(han[i-1 : i+1]))
		}
		han = nil
	}
	for _, r := range strings.ToLower(query) {
		if unicode.Is(unicode.Han, r) {
			flushLatin()
			han = append(han, r)
		} else if unicode.IsLetter(r) || unicode.IsNumber(r) || strings.ContainsRune("_./:-", r) {
			flushHan()
			latin = append(latin, r)
		} else {
			flushLatin()
			flushHan()
		}
	}
	flushLatin()
	flushHan()
	return out
}

func rankRecords(records []Record, query string) []Record {
	type scored struct {
		record Record
		score  int
	}
	terms := retrievalTerms(query)
	phrase := strings.ToLower(strings.TrimSpace(query))
	// A very long query must not cause repeated large substring searches.
	if len(phrase) > 256 {
		phrase = ""
	}
	ranked := []scored{}
	fallback := []Record{}
	for _, r := range records {
		if r.Status != "active" {
			continue
		}
		title, text := strings.ToLower(r.Title), strings.ToLower(r.Text)
		score := 0
		if phrase != "" {
			if strings.Contains(title, phrase) {
				score += 80
			}
			if strings.Contains(text, phrase) {
				score += 40
			}
		}
		for _, term := range terms {
			if strings.Contains(title, term) {
				score += 8
			}
			if strings.Contains(text, term) {
				score += 3
			}
		}
		if score > 0 {
			ranked = append(ranked, scored{r, score})
		} else if r.Kind == "fact" || r.Kind == "preference" {
			fallback = append(fallback, r)
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].score > ranked[j].score })
	out := make([]Record, 0, len(ranked)+4)
	for _, r := range ranked {
		out = append(out, r.record)
	}
	// At most four unrelated facts/preferences form the small standing context.
	// Knowledge, decisions and lessons always need a lexical association.
	if len(fallback) > 4 {
		fallback = fallback[:4]
	}
	return append(out, fallback...)
}
