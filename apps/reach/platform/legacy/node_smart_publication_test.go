package main

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestCASReviewerLazyBindingPublicationRace(t *testing.T) {
	for i := 0; i < 100; i++ {
		h := &hubSrv{}
		r := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
		r.Header.Set("Authorization", "Bearer fixture")
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); <-start; h.bindings() }()
		go func() { defer wg.Done(); <-start; h.modelGrantOK(r); h.smartRunForRequest(r) }()
		close(start)
		wg.Wait()
	}
}
func TestCASReviewerLegacyRenewFlagStillIssuesLegacyGrant(t *testing.T) {
	skillTestConf(t)
	f := newGatewayFixture(t, []gwTestModel{{ID: "glm-4.6", Protocols: []string{"openai-completions"}}})
	h := testHubWithNode("fp", true)
	h.gw = f.Store
	got := reviewerGrantReply(t, h, &sig{K: "model-grant", ID: "run-refresh", Run: "run", Renew: true})
	if got.Err != "" || got.D == "" || got.ID != "run-refresh" {
		t.Fatalf("legacy refresh failed: error=%q correlation=%q", got.Err, got.ID)
	}
}
