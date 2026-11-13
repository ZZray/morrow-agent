package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCoordinatorMigrationMustNotReplaceRacingConfig(t *testing.T) {
	dir := skillTestConf(t)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m", Protocols: []string{"openai-completions"}}})
	m, _ := newMigratorForTest(dir)
	path := filepath.Join(dir, gatewayConfigFile)
	concurrent := []byte(`{"gateway_root":"https://concurrent.example","default_model":"keep-me"}`)
	m.now = func() time.Time {
		if err := os.WriteFile(path, concurrent, 0600); err != nil {
			t.Fatal(err)
		}
		return time.Now()
	}
	_, err := m.run(context.Background(), migrateCandidate(f.Server.URL, "m"), true)
	got, readErr := os.ReadFile(path)
	if err == nil || readErr != nil || !bytes.Equal(got, concurrent) {
		t.Fatalf("concurrent config was not preserved: err=%v read=%v unchanged=%v", err, readErr, bytes.Equal(got, concurrent))
	}
}

func TestCoordinatorMigrationDryrunMustNotCreateConfDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not-created")
	t.Setenv("HW_CONF", dir)
	t.Setenv("HW_GATEWAY_TOKEN", gwTestSecret)
	f := newGatewayFixture(t, []gwTestModel{{ID: "m", Protocols: []string{"openai-completions"}}})
	if err := runMigrateGateway([]string{"-gateway", f.Server.URL, "-model", "m", "-allow_loopback"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("dryrun created configuration directory: %v", err)
	}
}
