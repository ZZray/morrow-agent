package main

// 下载中心：hub 托管安装包。列表与文件下载公开（登录前后均可）；工作台仍需令牌。
//
//	GET  /login        登录页（公开静态）
//	POST /login        {"token":...} 校验 hub 令牌 -> Set-Cookie hwdl（HttpOnly，7 天）【旧下载会话，可选】
//	GET  /download     安装包列表（公开）
//	GET  /dl/file?f=   下载指定 zip（公开；白名单文件名；?sha=1 返回校验值）
//	GET  /logout       清 cookie 回登录页
//
// 包目录：hub.conf 的 dist= 键 > <配置目录>/dist；文件限 handwave-<os>-<arch>.zip。

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed web/login.html web/download.html web/home.html
var dlFS embed.FS

const dlCookie = "hwdl"
const dlSessionTTL = 7 * 24 * time.Hour

var dlNameRe = regexp.MustCompile(`^handwave-[a-z0-9]+-[a-z0-9]+\.zip$`)

type dlPkg struct {
	Name    string
	Size    int64
	ModTime time.Time
	SHA     string
}

type dlRegistry struct {
	dir  string
	mu   sync.Mutex
	pkgs map[string]*dlPkg // name -> 缓存（size+mtime 变了才重算 sha）
}

func (d *dlRegistry) list() ([]dlPkg, error) {
	ents, err := os.ReadDir(d.dir)
	if err != nil {
		return nil, err
	}
	var out []dlPkg
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || !dlNameRe.MatchString(name) {
			continue
		}
		st, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, d.entry(name, st))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// entry 返回（必要时惰性计算 sha256 的）包元数据
func (d *dlRegistry) entry(name string, st os.FileInfo) dlPkg {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.pkgs == nil {
		d.pkgs = map[string]*dlPkg{}
	}
	p, ok := d.pkgs[name]
	if !ok || p.Size != st.Size() || !p.ModTime.Equal(st.ModTime()) {
		sum := ""
		if f, err := os.Open(filepath.Join(d.dir, name)); err == nil {
			h := sha256.New()
			_, _ = io.Copy(h, f)
			f.Close()
			sum = hex.EncodeToString(h.Sum(nil))
		}
		p = &dlPkg{Name: name, Size: st.Size(), ModTime: st.ModTime(), SHA: sum}
		d.pkgs[name] = p
	}
	return *p
}

// dlPlatformTitle 把发行包名显示成下载页上的系统名。
// linux-arm64 是 Ubuntu 等 ARM64 Linux 被控端，不是第二套程序。
func dlPlatformTitle(name string) string {
	key := strings.TrimSuffix(strings.TrimPrefix(name, "handwave-"), ".zip")
	switch key {
	case "windows-amd64":
		return "Windows"
	case "linux-amd64":
		return "Linux（x86_64）"
	case "linux-arm64":
		return "ARM Linux（Ubuntu）"
	case "darwin-arm64":
		return "macOS（Apple 芯片）"
	default:
		return key
	}
}

func humanSize(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/float64(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.0f KB", float64(n)/float64(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

// ---- 会话 ----

func (h *hubSrv) newSession() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return ""
	}
	sid := hex.EncodeToString(b)
	h.mu.Lock()
	if h.dlses == nil {
		h.dlses = map[string]time.Time{}
	}
	now := time.Now()
	for k, exp := range h.dlses { // 顺带回收
		if exp.Before(now) {
			delete(h.dlses, k)
		}
	}
	h.dlses[sid] = now.Add(dlSessionTTL)
	h.mu.Unlock()
	return sid
}

func (h *hubSrv) dlAuthed(r *http.Request) bool {
	c, err := r.Cookie(dlCookie)
	if err != nil || c.Value == "" {
		return false
	}
	h.mu.Lock()
	exp, ok := h.dlses[c.Value]
	if ok && exp.Before(time.Now()) {
		delete(h.dlses, c.Value)
		ok = false
	}
	h.mu.Unlock()
	return ok
}

// dlOK：下载中心会话、工作台会话、或 -dev / 根令牌均可。
func (h *hubSrv) dlOK(r *http.Request) bool {
	return h.dlAuthed(r) || h.authOK(r)
}

// ---- 页 ----

func (h *hubSrv) renderStatic(w http.ResponseWriter, name string) {
	b, err := dlFS.ReadFile("web/" + name)
	if err != nil {
		http.Error(w, "页面缺失", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(b)
}

func (h *hubSrv) loginH(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.renderStatic(w, "login.html")
	case http.MethodPost:
		var body struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
			http.Error(w, `{"error":"请求格式错误"}`, http.StatusBadRequest)
			return
		}
		if subtle.ConstantTimeCompare([]byte(body.Token), []byte(h.token)) != 1 {
			time.Sleep(500 * time.Millisecond) // 拖慢爆破
			http.Error(w, `{"error":"令牌无效"}`, http.StatusUnauthorized)
			return
		}
		sid := h.newSession()
		if sid == "" {
			http.Error(w, `{"error":"服务器随机源异常"}`, http.StatusInternalServerError)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name: dlCookie, Value: sid, Path: "/", HttpOnly: true,
			SameSite: http.SameSiteStrictMode, MaxAge: int(dlSessionTTL.Seconds()),
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *hubSrv) logoutH(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(dlCookie); err == nil {
		h.mu.Lock()
		delete(h.dlses, c.Value)
		h.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: dlCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func (h *hubSrv) downloadH(w http.ResponseWriter, r *http.Request) {
	tpl, err := fs.ReadFile(dlFS, "web/download.html")
	if err != nil {
		http.Error(w, "页面缺失", 500)
		return
	}
	list := `<div class="pkg"><div class="pkg-ico" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></div><div class="pkg-body"><div class="os">安装包目录为空</div><div class="meta">把 dist/handwave-*.zip 放到 hub 配置目录的 dist/ 下（或 hub.conf 的 dist= 指定）。</div></div></div>`
	if pkgs, err := h.dl.list(); err == nil && len(pkgs) > 0 {
		var b strings.Builder
		for _, p := range pkgs {
			sha := p.SHA
			if len(sha) > 16 {
				sha = sha[:16] + "…"
			}
			fmt.Fprintf(&b,
				`<div class="pkg"><div class="pkg-ico" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></div><div class="pkg-body"><div class="os">%s</div><div class="meta">%s · %s · sha256 %s · %s</div></div><a class="pkg-dl" href="/dl/file?f=%s">下载</a></div>`+"\n",
				template.HTMLEscapeString(dlPlatformTitle(p.Name)), template.HTMLEscapeString(p.Name),
				humanSize(p.Size), sha, p.ModTime.Format("2006-01-02 15:04"), url.QueryEscape(p.Name))
		}
		list = b.String()
	}
	href := "/login"
	page := strings.ReplaceAll(string(tpl), "<!--LIST-->", list)
	page = strings.ReplaceAll(page, "<!--HREF-->", href)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = io.WriteString(w, page)
}

func (h *hubSrv) dlFileH(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.URL.Query().Get("f"))
	if !dlNameRe.MatchString(name) {
		http.Error(w, `{"error":"bad file name"}`, http.StatusBadRequest)
		return
	}
	path := filepath.Join(h.dl.dir, name)
	st, err := os.Stat(path)
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	if r.URL.Query().Get("sha") == "1" {
		p := h.dl.entry(name, st)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = io.WriteString(w, p.SHA+"\n")
		return
	}
	h.dl.entry(name, st)
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	http.ServeFile(w, r, path)
}
