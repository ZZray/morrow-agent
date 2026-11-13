package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSkillUIAssets(t *testing.T) {
	skillTestConf(t)
	h := &hubSrv{token: "test-root", nodeTok: "test-node"}
	mux := http.NewServeMux()
	h.routes(mux)
	for _, asset := range []struct{ path, marker string }{
		{"/skills-ui.js", "function openAttachMenu()"},
		{"/skills-ui.css", ".skill-manager"},
	} {
		t.Run(asset.path, func(t *testing.T) {
			for _, token := range []string{"", "test-node", "test-root"} {
				r := httptest.NewRequest(http.MethodGet, asset.path, nil)
				if token != "" {
					r.Header.Set("Authorization", "Bearer "+token)
				}
				w := httptest.NewRecorder()
				mux.ServeHTTP(w, r)
				if token == "test-root" {
					if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), asset.marker) {
						t.Fatalf("asset not served: %d %s", w.Code, w.Body.String())
					}
				} else if w.Code == http.StatusOK {
					t.Fatal("asset served without controller authentication")
				}
			}
		})
	}
}
