package main

import (
	"ara/apps/reach/platform/legacy/websafe"
	"bytes"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDirectHubAppScriptSecurity(t *testing.T) {
	h := &hubSrv{dev: true}
	mux := http.NewServeMux()
	h.routes(mux)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/app.js", nil))
	if w.Code != 200 {
		t.Fatalf("direct app response: %d %s", w.Code, w.Body.String())
	}
	source, err := fs.ReadFile(webFS, "web/app.js")
	if err != nil {
		t.Fatal(err)
	}
	expected, err := websafe.AdaptApp(source)
	if err != nil || !bytes.Equal(w.Body.Bytes(), expected) {
		t.Fatal("direct Hub did not use shared repaired app source")
	}
	if w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("ETag") != "" {
		t.Fatal("unsafe script cache validator")
	}
}
