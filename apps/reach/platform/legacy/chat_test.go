package main

import "testing"

func TestExtractClarify(t *testing.T) {
	cases := []struct {
		name   string
		input  string
		want   []clarifyOption
		wantC  string // expected content after extraction
	}{
		{
			name:  "no marker",
			input: "Just a regular response.",
			want:  nil,
			wantC: "Just a regular response.",
		},
		{
			name:  "marker at end",
			input: "Which environment?\n[?OPT:开发环境:dev|生产环境:prod]",
			want: []clarifyOption{
				{Label: "开发环境", Value: "dev"},
				{Label: "生产环境", Value: "prod"},
			},
			wantC: "Which environment?",
		},
		{
			name:  "marker in middle",
			input: "Pick one.\n[?OPT:Yes:yes|No:no]\nThanks!",
			want: []clarifyOption{
				{Label: "Yes", Value: "yes"},
				{Label: "No", Value: "no"},
			},
			wantC: "Pick one.\n\nThanks!",
		},
		{
			name:  "marker with spaces",
			input: "Select target.\n[?OPT:Local : local | Server : server]",
			want: []clarifyOption{
				{Label: "Local", Value: "local"},
				{Label: "Server", Value: "server"},
			},
			wantC: "Select target.",
		},
		{
			name:  "only one option — rejected",
			input: "Only one?\n[?OPT:Foo:bar]",
			want:  nil,
			wantC: "Only one?\n[?OPT:Foo:bar]",
		},
		{
			name:  "unclosed marker",
			input: "Missing close.\n[?OPT:A:a|B:b",
			want:  nil,
			wantC: "Missing close.\n[?OPT:A:a|B:b",
		},
		{
			name:  "empty value — skipped",
			input: "Which?\n[?OPT:Option A:option_a|Empty:|Valid:valid]",
			want: []clarifyOption{
				{Label: "Option A", Value: "option_a"},
				{Label: "Valid", Value: "valid"},
			},
			wantC: "Which?",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			content := c.input
			got := extractClarify(&content)
			if c.want == nil {
				if got != nil {
					t.Errorf("expected nil, got %v", got)
				}
				return
			}
			if len(got) != len(c.want) {
				t.Errorf("got %d options, want %d", len(got), len(c.want))
				return
			}
			for i, w := range c.want {
				if got[i].Label != w.Label || got[i].Value != w.Value {
					t.Errorf("option[%d] = %+v, want %+v", i, got[i], w)
				}
			}
			if content != c.wantC {
				t.Errorf("content = %q, want %q", content, c.wantC)
			}
		})
	}
}
