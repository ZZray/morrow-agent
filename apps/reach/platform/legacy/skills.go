package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

const (
	maxSkillName            = 128
	maxSkillDescription     = 1024
	maxSkillContent         = 64 << 10
	maxSelectedSkills       = 8
	maxSelectedSkillContent = 128 << 10
	maxSkillJSON            = 512 << 10
)

type skillMeta struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type skillSnapshot struct {
	skillMeta
	Content string `json:"content"`
}

var (
	skillsMu         sync.RWMutex
	errSkillInvalid  = errors.New("invalid skill")
	errSkillTooLarge = errors.New("skill limit exceeded")
	errSkillNotFound = errors.New("skill not found")
)

func skillsDir() string {
	return filepath.Join(dataRoot(), "skills")
}

func validSkillID(id string) bool {
	if len(id) != 32 {
		return false
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func validateSkill(name, description, content string) error {
	if len(name) > maxSkillName || len(description) > maxSkillDescription || len(content) > maxSkillContent {
		return errSkillTooLarge
	}
	if strings.TrimSpace(name) == "" || strings.TrimSpace(content) == "" ||
		!utf8.ValidString(name) || !utf8.ValidString(description) || !utf8.ValidString(content) {
		return errSkillInvalid
	}
	return nil
}

func createSkill(name, description, content string) (*skillSnapshot, error) {
	if err := validateSkill(name, description, content); err != nil {
		return nil, err
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil, err
	}
	s := &skillSnapshot{
		skillMeta: skillMeta{ID: hex.EncodeToString(id[:]), Name: strings.TrimSpace(name), Description: strings.TrimSpace(description)},
		Content:   content,
	}
	b, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	skillsMu.Lock()
	defer skillsMu.Unlock()
	if err := ensureDir(skillsDir()); err != nil {
		return nil, err
	}
	path := filepath.Join(skillsDir(), s.ID+".json")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	_, writeErr := f.Write(b)
	closeErr := f.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		_ = os.Remove(path)
		return nil, err
	}
	return s, nil
}

func loadSkillLocked(id string) (*skillSnapshot, error) {
	if !validSkillID(id) {
		return nil, errSkillInvalid
	}
	path := filepath.Join(skillsDir(), id+".json")
	st, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil, errSkillNotFound
	}
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > maxSkillJSON {
		return nil, fmt.Errorf("invalid stored skill")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxSkillJSON+1))
	if err != nil {
		return nil, err
	}
	var s skillSnapshot
	if len(b) > maxSkillJSON || json.Unmarshal(b, &s) != nil || s.ID != id || validateSkill(s.Name, s.Description, s.Content) != nil {
		return nil, fmt.Errorf("invalid stored skill")
	}
	return &s, nil
}

func getSkill(id string) (*skillSnapshot, error) {
	skillsMu.RLock()
	defer skillsMu.RUnlock()
	return loadSkillLocked(id)
}

func updateSkill(id, name, description, content string) (*skillSnapshot, error) {
	if !validSkillID(id) {
		return nil, errSkillInvalid
	}
	if err := validateSkill(name, description, content); err != nil {
		return nil, err
	}
	skillsMu.Lock()
	defer skillsMu.Unlock()
	// Require an existing, valid regular file; never follow a stored symlink or upsert.
	if _, err := loadSkillLocked(id); err != nil {
		return nil, err
	}
	s := &skillSnapshot{
		skillMeta: skillMeta{ID: id, Name: strings.TrimSpace(name), Description: strings.TrimSpace(description)},
		Content:   content,
	}
	b, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	// Keep the old file intact until the complete replacement has been synced and closed.
	f, err := os.CreateTemp(skillsDir(), ".skill-*.tmp")
	if err != nil {
		return nil, err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(b)
	syncErr := f.Sync()
	closeErr := f.Close()
	if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
		return nil, err
	}
	if err := os.Rename(f.Name(), filepath.Join(skillsDir(), id+".json")); err != nil {
		return nil, err
	}
	return s, nil
}

func listSkills() ([]skillMeta, error) {
	skillsMu.RLock()
	defer skillsMu.RUnlock()
	out := []skillMeta{}
	root := skillsDir()
	st, err := os.Stat(root)
	if os.IsNotExist(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("invalid skill storage directory")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		if !validSkillID(id) {
			continue
		}
		s, err := loadSkillLocked(id)
		if err != nil {
			return nil, err
		}
		out = append(out, s.skillMeta)
	}
	return out, nil
}

func deleteSkill(id string) error {
	if !validSkillID(id) {
		return errSkillInvalid
	}
	skillsMu.Lock()
	defer skillsMu.Unlock()
	path := filepath.Join(skillsDir(), id+".json")
	st, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return errSkillNotFound
	}
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("invalid stored skill")
	}
	return os.Remove(path)
}

func resolveSkills(ids []string) ([]skillSnapshot, error) {
	if len(ids) > maxSelectedSkills {
		return nil, errSkillTooLarge
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if !validSkillID(id) || seen[id] {
			return nil, errSkillInvalid
		}
		seen[id] = true
	}
	skillsMu.RLock()
	defer skillsMu.RUnlock()
	var out []skillSnapshot
	total := 0
	for _, id := range ids {
		s, err := loadSkillLocked(id)
		if err != nil {
			return nil, err
		}
		total += len(s.Content)
		if total > maxSelectedSkillContent {
			return nil, errSkillTooLarge
		}
		out = append(out, *s)
	}
	return out, nil
}

func skillPrompt(skills []skillSnapshot) string {
	if len(skills) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n## 用户为本条消息明确选择的技能\n以下是用户选择的 Markdown 指令，仅用于当前请求及其工具续接，不代表自动执行脚本或额外工具授权。\n")
	for _, s := range skills {
		fmt.Fprintf(&b, "\n### 技能 %s（%s）\n%s\n\n%s\n", s.Name, s.ID, s.Description, s.Content)
	}
	return b.String()
}

func writeSkillError(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	message := "skill storage error"
	switch {
	case errors.Is(err, errSkillInvalid):
		code, message = http.StatusBadRequest, errSkillInvalid.Error()
	case errors.Is(err, errSkillTooLarge):
		code, message = http.StatusRequestEntityTooLarge, errSkillTooLarge.Error()
	case errors.Is(err, errSkillNotFound):
		code, message = http.StatusNotFound, errSkillNotFound.Error()
	}
	writeJSON(w, code, map[string]string{"error": message})
}

func readSkillBody(w http.ResponseWriter, r *http.Request) (*skillSnapshot, error) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSkillJSON))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, errSkillTooLarge
		}
		return nil, errSkillInvalid
	}
	var body struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Content     string `json:"content"`
	}
	if !utf8.Valid(b) || json.Unmarshal(b, &body) != nil {
		return nil, errSkillInvalid
	}
	return &skillSnapshot{
		skillMeta: skillMeta{Name: body.Name, Description: body.Description},
		Content:   body.Content,
	}, nil
}

func (h *hubSrv) apiSkills(w http.ResponseWriter, r *http.Request, path string) {
	if path != "/skills" {
		id := strings.TrimPrefix(path, "/skills/")
		if !validSkillID(id) {
			writeSkillError(w, errSkillInvalid)
			return
		}
		switch r.Method {
		case http.MethodGet:
			s, err := getSkill(id)
			if err != nil {
				writeSkillError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, s)
		case http.MethodPut:
			body, err := readSkillBody(w, r)
			if err != nil {
				writeSkillError(w, err)
				return
			}
			s, err := updateSkill(id, body.Name, body.Description, body.Content)
			if err != nil {
				writeSkillError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, s)
		case http.MethodDelete:
			if err := deleteSkill(id); err != nil {
				writeSkillError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		default:
			w.Header().Set("Allow", "GET, PUT, DELETE")
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
		return
	}
	switch r.Method {
	case http.MethodGet:
		list, err := listSkills()
		if err != nil {
			writeSkillError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	case http.MethodPost:
		body, err := readSkillBody(w, r)
		if err != nil {
			writeSkillError(w, err)
			return
		}
		s, err := createSkill(body.Name, body.Description, body.Content)
		if err != nil {
			writeSkillError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, s.skillMeta)
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
	}
}
