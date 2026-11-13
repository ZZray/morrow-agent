package main

// 云端消息执行端到端：POST /api/chat → SSE 流 → 上游模型 → 助手消息落库。

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCloudChatSSEExecutesAndStores(t *testing.T) {
	skillTestConf(t)
	ws, sid := skillTestSession(t)

	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.ChatText = "cloud-answer"
	h := &hubSrv{token: "tk", dev: true, gw: f.Store}
	mux := http.NewServeMux()
	h.routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/chat", "application/json", strings.NewReader(
		`{"workspace_id":"`+ws+`","session_id":"`+sid+`","content":"hello cloud","model":"default"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	text := string(body)
	if !strings.Contains(text, "event: done") || !strings.Contains(text, "cloud-answer") {
		t.Fatalf("sse missing done/answer: %s", text)
	}

	msgs, err := readMessages(ws, sid)
	if err != nil {
		t.Fatal(err)
	}
	var lastAsst string
	for _, m := range msgs {
		if m.Role == "assistant" {
			lastAsst = m.Content
		}
	}
	if lastAsst != "cloud-answer" {
		t.Fatalf("stored assistant=%q", lastAsst)
	}
}

func TestPublicHomeAndUnauthRedirect(t *testing.T) {
	h := &hubSrv{token: "tk"}
	mux := http.NewServeMux()
	h.routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/home")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("home status=%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	for _, want := range []string{"/login", "/omp/", "/download", "Ray 的工具箱"} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("home page missing %q", want)
		}
	}
	if strings.Contains(string(body), "登录后") {
		t.Fatal("home page still says download requires login")
	}

	req, _ := http.NewRequest("GET", srv.URL+"/", nil)
	req.Header.Set("Accept", "text/html")
	c := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r2, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer r2.Body.Close()
	if r2.StatusCode != http.StatusFound || r2.Header.Get("Location") != "/home" {
		t.Fatalf("unauth / = %d location=%q", r2.StatusCode, r2.Header.Get("Location"))
	}
}

func TestPublicDownloadNoAuth(t *testing.T) {
	dir := t.TempDir()
	h := &hubSrv{token: "tk", dl: &dlRegistry{dir: dir}}
	mux := http.NewServeMux()
	h.routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/download")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("download status=%d", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "被控端") {
		t.Fatalf("download page missing 被控端: %s", body)
	}
}
