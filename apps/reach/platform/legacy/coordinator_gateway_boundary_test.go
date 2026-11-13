package main

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestCoordinatorHubProxyCredentialAndPathBoundary(t *testing.T) {
	skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m1"}})
	f.Chat = func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("X-Fixture-Query", r.URL.RawQuery)
		w.Header().Set("X-Fixture-Path", r.URL.EscapedPath())
		w.Header().Add("Set-Cookie", "hwses=from-gateway; Path=/")
		_, _ = io.WriteString(w, "ok")
		return true
	}
	front := gatewayProxyHub(t, f)
	t.Run("query-credentials", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodPost, front.URL+"/v1/chat/completions?token=tk&key=client-secret&alt=sse", strings.NewReader(`{"model":"m1"}`))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("authorized fixture rejected: %d", res.StatusCode)
		}
		if got := res.Header.Get("X-Fixture-Query"); got != "alt=sse" {
			t.Fatalf("host credentials crossed gateway boundary: %q", got)
		}
	})
	t.Run("response-cookie", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodPost, front.URL+"/v1/chat/completions", nil)
		req.Header.Set("Authorization", "Bearer tk")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("authorized fixture rejected: %d", res.StatusCode)
		}
		if got := res.Header.Get("Set-Cookie"); got != "" {
			t.Fatalf("gateway cookie crossed host boundary: %q", got)
		}
	})
	t.Run("escaped-model-segment", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodPost, front.URL+"/v1/gemini/models/vendor%2Fmodel:streamGenerateContent", nil)
		req.Header.Set("Authorization", "Bearer tk")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatalf("authorized fixture rejected: %d", res.StatusCode)
		}
		if got := res.Header.Get("X-Fixture-Path"); got != "/v1beta/models/vendor%2Fmodel:streamGenerateContent" {
			t.Fatalf("model segment escape changed: %q", got)
		}
	})
}
