package main

// 知识库：分块 + 倒排关键词索引（零新依赖）。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

type kbDoc struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MIME     string `json:"mime"`
	Size     int64  `json:"size"`
	Created  string `json:"created"`
	ChunkN   int    `json:"chunk_n"`
}

type kbChunk struct {
	DocID string `json:"doc_id"`
	Name  string `json:"name"`
	Idx   int    `json:"idx"`
	Text  string `json:"text"`
}

type kbIndex struct {
	Docs   []kbDoc            `json:"docs"`
	Chunks []kbChunk          `json:"chunks"`
	Inv    map[string][]int   `json:"inv"` // token -> chunk indices
}

var tokRe = regexp.MustCompile(`[\p{L}\p{N}_]+`)

func kbPath(scope, wsID string) string {
	if scope == "global" {
		return globalKBDir()
	}
	return filepath.Join(wsDir(wsID), "kb")
}

func loadKBIndex(scope, wsID string) *kbIndex {
	dir := kbPath(scope, wsID)
	b, err := os.ReadFile(filepath.Join(dir, "index.json"))
	if err != nil {
		return &kbIndex{Inv: map[string][]int{}}
	}
	var idx kbIndex
	if json.Unmarshal(b, &idx) != nil {
		return &kbIndex{Inv: map[string][]int{}}
	}
	if idx.Inv == nil {
		idx.Inv = map[string][]int{}
	}
	return &idx
}

func saveKBIndex(scope, wsID string, idx *kbIndex) error {
	dir := kbPath(scope, wsID)
	if err := ensureDir(dir); err != nil {
		return err
	}
	b, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "index.json"), b, 0o600)
}

func tokenize(s string) []string {
	s = strings.ToLower(s)
	raw := tokRe.FindAllString(s, -1)
	var out []string
	seen := map[string]bool{}
	for _, t := range raw {
		if len([]rune(t)) < 2 {
			continue
		}
		if seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	// CJK bigrams for short Chinese queries
	runes := []rune(strings.ToLower(s))
	for i := 0; i+1 < len(runes); i++ {
		if unicode.Is(unicode.Han, runes[i]) && unicode.Is(unicode.Han, runes[i+1]) {
			bg := string(runes[i : i+2])
			if !seen[bg] {
				seen[bg] = true
				out = append(out, bg)
			}
		}
	}
	return out
}

func chunkText(text string, size int) []string {
	runes := []rune(text)
	if size <= 0 {
		size = 700
	}
	var chunks []string
	for i := 0; i < len(runes); i += size {
		j := i + size
		if j > len(runes) {
			j = len(runes)
		}
		chunks = append(chunks, string(runes[i:j]))
	}
	if len(chunks) == 0 {
		chunks = []string{""}
	}
	return chunks
}

func addKBDoc(scope, wsID, name, mime string, data []byte) (*kbDoc, error) {
	text := string(data)
	if !strings.HasPrefix(mime, "text/") && mime != "application/json" &&
		!strings.HasSuffix(strings.ToLower(name), ".md") {
		// 非文本：只存元数据说明
		text = "（二进制文件 " + name + "，未提取文本。请上传 txt/md/代码等文本以供检索。）"
	}
	if len([]rune(text)) > 500000 {
		text = string([]rune(text)[:500000])
	}
	dir := kbPath(scope, wsID)
	if err := ensureDir(dir); err != nil {
		return nil, err
	}
	id := hexID()
	safe := filepath.Base(name)
	_ = os.WriteFile(filepath.Join(dir, id+"_"+safe), data, 0o600)

	idx := loadKBIndex(scope, wsID)
	parts := chunkText(text, 700)
	doc := kbDoc{ID: id, Name: safe, MIME: mime, Size: int64(len(data)), Created: time.Now().UTC().Format(time.RFC3339), ChunkN: len(parts)}
	base := len(idx.Chunks)
	for i, p := range parts {
		ci := base + i
		idx.Chunks = append(idx.Chunks, kbChunk{DocID: id, Name: safe, Idx: i, Text: p})
		for _, tok := range tokenize(p) {
			idx.Inv[tok] = append(idx.Inv[tok], ci)
		}
	}
	idx.Docs = append(idx.Docs, doc)
	if err := saveKBIndex(scope, wsID, idx); err != nil {
		return nil, err
	}
	return &doc, nil
}

func listKBDocs(scope, wsID string) []kbDoc {
	return loadKBIndex(scope, wsID).Docs
}

func deleteKBDoc(scope, wsID, docID string) error {
	idx := loadKBIndex(scope, wsID)
	var docs []kbDoc
	for _, d := range idx.Docs {
		if d.ID != docID {
			docs = append(docs, d)
		}
	}
	// 重建索引
	var chunks []kbChunk
	inv := map[string][]int{}
	for _, c := range idx.Chunks {
		if c.DocID == docID {
			continue
		}
		ci := len(chunks)
		chunks = append(chunks, c)
		for _, tok := range tokenize(c.Text) {
			inv[tok] = append(inv[tok], ci)
		}
	}
	idx.Docs = docs
	idx.Chunks = chunks
	idx.Inv = inv
	dir := kbPath(scope, wsID)
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), docID+"_") {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
	return saveKBIndex(scope, wsID, idx)
}

type kbHit struct {
	DocID string `json:"doc_id"`
	Name  string `json:"name"`
	Text  string `json:"text"`
	Score int    `json:"score"`
}

func searchKB(scope, wsID, query string, topK int) []kbHit {
	if topK <= 0 {
		topK = 6
	}
	idx := loadKBIndex(scope, wsID)
	toks := tokenize(query)
	if len(toks) == 0 || len(idx.Chunks) == 0 {
		return nil
	}
	scores := map[int]int{}
	for _, t := range toks {
		for _, ci := range idx.Inv[t] {
			scores[ci]++
		}
	}
	type pair struct{ i, s int }
	var ps []pair
	for i, s := range scores {
		ps = append(ps, pair{i, s})
	}
	sort.Slice(ps, func(a, b int) bool { return ps[a].s > ps[b].s })
	var hits []kbHit
	for _, p := range ps {
		if len(hits) >= topK {
			break
		}
		c := idx.Chunks[p.i]
		hits = append(hits, kbHit{DocID: c.DocID, Name: c.Name, Text: c.Text, Score: p.s})
	}
	return hits
}

func searchKBScoped(wsID, query string, useGlobal, useProject bool, topK int) []kbHit {
	var all []kbHit
	if useGlobal {
		all = append(all, searchKB("global", "", query, topK)...)
	}
	if useProject && wsID != "" {
		all = append(all, searchKB("project", wsID, query, topK)...)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].Score > all[j].Score })
	if len(all) > topK {
		all = all[:topK]
	}
	return all
}
