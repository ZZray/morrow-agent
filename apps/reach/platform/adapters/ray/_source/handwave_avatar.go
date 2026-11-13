package main

import (
	"bytes"
	_ "embed"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"
)

//go:embed assets/brand/handwave-ai-20261017.png
var handWaveAssistantAvatar []byte

//go:embed handwave_avatar.js
var handWaveAvatarJS []byte

//go:embed handwave_avatar.css
var handWaveAvatarCSS []byte

const handWaveAvatarSHA = "d2f42225668bbb7d4105864ea8adcf53a4e8706163b5be2c049d41bef73251b8"
const handWaveAvatarPath = "/ray/assets/handwave-ai-d2f42225668b.png"

// Called only after platform browser authentication, never from public installer
// dispatch. An exact immutable asset is not a generic file-serving interface.
func serveHandWaveAvatar(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != handWaveAvatarPath {
		return false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return true
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+handWaveAvatarSHA+`"`)
	http.ServeContent(w, r, "assistant-avatar.png", time.Time{}, bytes.NewReader(handWaveAssistantAvatar))
	return true
}

func adaptHandWaveAvatarScript(body []byte) ([]byte, error) {
	if !bytes.Contains(body, []byte("function addBubble(role, content, extra) {")) {
		return body, nil
	}
	edits := [][2]string{
		{"row.appendChild(el('span', 'msg-ava', 'hw'));", "row.appendChild(makeHandWaveAssistantAvatar('msg-ava'));"},
		{"const ava = el('span', 'msg-ava loading');\n  ava.textContent = 'hw';", "const ava = makeHandWaveAssistantAvatar('msg-ava loading');"},
		{"const avatar = el('span', 'agent-avatar', (a.name || 'A').slice(0, 1).toUpperCase());", "const avatar = a.id === 'local' ? makeHandWaveAssistantAvatar('agent-avatar') : el('span', 'agent-avatar', (a.name || 'A').slice(0, 1).toUpperCase());"},
	}
	for _, edit := range edits {
		if bytes.Count(body, []byte(edit[0])) != 1 {
			return nil, errors.New("HandWave avatar creation site requires review")
		}
		body = bytes.Replace(body, []byte(edit[0]), []byte(edit[1]), 1)
	}
	helper := bytes.ReplaceAll(handWaveAvatarJS, []byte("@AVATAR_PATH@"), []byte(handWaveAvatarPath))
	return append(append(body, []byte("\n;\n")...), helper...), nil
}

// The established adapter still owns every security/module transformation.
func adaptHandWaveAvatar(response *http.Response) error {
	if err := adaptHandWaveUI(response); err != nil {
		return err
	}
	if response.Request == nil || response.Request.Method != http.MethodGet || response.StatusCode != http.StatusOK {
		return nil
	}
	path := response.Request.URL.Path
	style := path == "/handwave/style.css" || path == "/style.css"
	script := path == "/handwave/app.js" || path == "/app.js"
	if !style && !script {
		return nil
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if style && media != "text/css" || script && media != "text/javascript" && media != "application/javascript" {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (4<<20)+1))
	if err != nil || len(body) > 4<<20 {
		return errors.New("HandWave avatar response unavailable")
	}
	if err = response.Body.Close(); err != nil {
		return err
	}
	if style {
		body = append(append(body, '\n'), handWaveAvatarCSS...)
	} else if body, err = adaptHandWaveAvatarScript(body); err != nil {
		return err
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Set("Content-Length", strconv.Itoa(len(body)))
	response.Header.Set("Cache-Control", "no-store")
	for _, name := range []string{"ETag", "Content-Encoding", "Last-Modified", "Content-MD5", "Digest"} {
		response.Header.Del(name)
	}
	return nil
}
