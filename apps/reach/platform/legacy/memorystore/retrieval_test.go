package memorystore

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestChineseAssociationScopeAndStandingContext(t *testing.T) {
	s := fresh(t)
	matched := save(t, s, "device", "A", "lesson", "数据库锁定时先检查占用进程和日志", 1)
	unrelated := save(t, s, "device", "A", "knowledge", "如何种植玫瑰", 2)
	private := save(t, s, "device", "B", "knowledge", "数据库锁定专用秘密", 3)
	project := save(t, s, "project", "P", "knowledge", "数据库锁定项目经验", 4)
	for i := 5; i < 12; i++ {
		save(t, s, "workspace", "ray", "preference", "固定偏好", i)
	}
	snap, err := s.Snapshot("A", "W", "请解决数据库被锁定的问题并分析日志")
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Records) != 5 || snap.Records[0].ID != matched.ID {
		t.Fatalf("association/standing cap: %#v", snap)
	}
	for _, r := range snap.Records {
		if r.ID == unrelated.ID || r.ID == private.ID || r.ID == project.ID {
			t.Fatal("scope or relevance leak", r)
		}
	}
	before := snap.Epoch
	if _, err = s.Revoke("device", "A", oid(20), matched.ID, 1); err != nil {
		t.Fatal(err)
	}
	snap, err = s.Snapshot("A", "W", "数据库")
	if err != nil || snap.Epoch == before {
		t.Fatal(snap, err)
	}
	for _, r := range snap.Records {
		if r.ID == matched.ID {
			t.Fatal("revoked result")
		}
	}
}

func TestRetrievalTitlePhraseTermsAndDeterminism(t *testing.T) {
	rs := []Record{
		{ID: "body", Kind: "knowledge", Text: "python traceback", Status: "active"},
		{ID: "title", Kind: "knowledge", Title: "Python Traceback", Status: "active"},
		{ID: "zero", Kind: "lesson", Text: "flowers", Status: "active"},
	}
	a := rankRecords(rs, "PYTHON traceback")
	if len(a) != 2 || a[0].ID != "title" {
		t.Fatal(a)
	}
	if !reflect.DeepEqual(a, rankRecords(rs, "PYTHON traceback")) {
		t.Fatal("unstable ranking")
	}
	if len(retrievalTerms(strings.Repeat("汉字关联查询abcdef ", 1000))) > 64 {
		t.Fatal("term budget")
	}
	if !reflect.DeepEqual(retrievalTerms("日志日志 Python python"), []string{"日志", "志日", "python"}) {
		t.Fatal(retrievalTerms("日志日志 Python python"))
	}
	if len(rankRecords(rs, "")) != 0 {
		t.Fatal("unrelated knowledge injected")
	}
}

func TestAssociationRecordAndEscapedWireCaps(t *testing.T) {
	s := fresh(t)
	for i := 1; i <= 40; i++ {
		save(t, s, "device", "A", "knowledge", "关联"+strings.Repeat("\"\\\n", 2000), i)
	}
	snap, err := s.Snapshot("A", "W", "关联")
	if err != nil || len(snap.Records) == 0 || len(snap.Records) > 32 {
		t.Fatal(snap, err)
	}
	b, _ := json.Marshal(snap)
	if len(b) > 32768 {
		t.Fatal(len(b))
	}
	small := fresh(t)
	for i := 1; i <= 40; i++ {
		save(t, small, "device", "A", "knowledge", "匹配", i)
	}
	snap, err = small.Snapshot("A", "W", "匹配")
	if err != nil || len(snap.Records) != 32 {
		t.Fatal(len(snap.Records), err)
	}
}
