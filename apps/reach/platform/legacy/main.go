package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Copyright (c) Ray Zhang. The migrated platform no longer starts a device node.
var deskStateDir string

func configureDeskState(state string) error {
	if state == "" || !filepath.IsAbs(state) {
		return fmt.Errorf("REACH_DESK_STATE_DIR must be an explicit absolute directory")
	}
	state = filepath.Clean(state)
	if err := os.MkdirAll(state, 0o700); err != nil {
		return fmt.Errorf("create Reach Desk state directory: %w", err)
	}
	probe, err := os.CreateTemp(state, ".reach-desk-write-")
	if err != nil {
		return fmt.Errorf("write Reach Desk state directory: %w", err)
	}
	closeErr := probe.Close()
	removeErr := os.Remove(probe.Name())
	if closeErr != nil {
		return closeErr
	}
	if removeErr != nil {
		return removeErr
	}
	if err := os.Setenv("HW_CONF", state); err != nil {
		return err
	}
	deskStateDir = state
	return nil
}

func usage() {
	fmt.Fprintln(os.Stderr, "Reach Desk\nUsage: reach-desk serve [hub options] | version\nSet REACH_DESK_STATE_DIR to an explicit absolute state directory.\nThis compatibility build is optional; Reach identity and device integration are pending.")
}

func main() {
	if len(os.Args) < 2 {
		usage()
		return
	}
	switch os.Args[1] {
	case "version", "--version", "-v":
		fmt.Println("Reach Desk compatibility", versionStr)
		return
	case "help", "--help", "-h":
		usage()
		return
	case "serve", "hub":
		if err := configureDeskState(os.Getenv("REACH_DESK_STATE_DIR")); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		if err := runHub(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, "Reach Desk failed:", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "Unsupported Reach Desk command; device operations use Reach Node")
		usage()
		os.Exit(2)
	}
}

func runHub(args []string) error {
	fs := flag.NewFlagSet("hub", flag.ExitOnError)
	listenF := fs.String("listen", "", "监听地址（默认取 hub.conf 或 :8443）")
	tokenF := fs.String("token", "", "兼容服务访问令牌（必填）")
	nodeTokF := fs.String("node_token", "", "入网令牌（可空；仅 node 角色可用来上线，可随 exe 公开分发）")
	gatewayF := fs.String("gateway", "", "共享网关 root（如 https://gw.example；可空则读 gateway.json）")
	tokenEnvF := fs.String("gateway_token_env", "", "网关服务令牌所在环境变量名（默认 HW_GATEWAY_TOKEN）")
	modelF := fs.String("model", "", "显式默认模型 id")
	protocolF := fs.String("protocol", "", "显式默认协议（多协议模型必须显式选择）")
	loopbackF := fs.Bool("allow_loopback", false, "允许网关 root 指向本机回环地址（默认拒绝）")
	// 旧直连上游参数：仅为给出明确迁移提示而保留，绝不当作网关使用。
	upF := fs.String("upstream", "", "(已弃用) 旧直连上游 base URL")
	upKeyF := fs.String("upkey", "", "(已弃用) 旧直连上游 key")
	certF := fs.String("cert", "", "TLS 证书（可空；HTTPS 建议交给 nginx/caddy 反代）")
	keyF := fs.String("key", "", "TLS 私钥")
	devF := fs.Bool("dev", false, "调试模式：跳过工作台登录（勿用于公网）")
	_ = fs.Parse(args)

	conf := readConf("hub.conf")
	listen := firstNonEmpty(*listenF, conf["listen"], ":8443")
	token := firstNonEmpty(*tokenF, conf["token"])
	nodeTok := firstNonEmpty(*nodeTokF, conf["node_token"])
	devMode := *devF || conf["dev"] == "1" || conf["dev"] == "true" || os.Getenv("HW_DEV") == "1"
	if token == "" {
		return fmt.Errorf("必须设置 -token 或在独立状态目录的 hub.conf 配置 token")
	}
	for _, legacy := range []string{*upF, *upKeyF, conf["upstream"], conf["upkey"], conf["upstreams"]} {
		if strings.TrimSpace(legacy) != "" {
			fmt.Fprintln(os.Stderr, "迁移提示：检测到旧的直连上游配置（-upstream/-upkey/upstream/upkey/upstreams）。Hub 不再直连供应商，也不会把它当作网关；请把供应商注册到共享网关，再用 -gateway 指向网关 root。")
			break
		}
	}
	overrides := gatewayConfig{
		Root:            firstNonEmpty(*gatewayF, conf["gateway"]),
		TokenEnv:        firstNonEmpty(*tokenEnvF, conf["gateway_token_env"]),
		DefaultModel:    firstNonEmpty(*modelF, conf["model"]),
		DefaultProtocol: firstNonEmpty(*protocolF, conf["protocol"]),
		AllowLoopback:   *loopbackF || conf["allow_loopback"] == "1" || conf["allow_loopback"] == "true",
	}
	distDir := conf["dist"]
	if distDir == "" {
		distDir = filepath.Join(confDir(), "dist")
	}
	// 下载中心公开：目录不存在则创建，保证 /download 始终可用（无需登录）
	if err := os.MkdirAll(distDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "warn: cannot create dist dir %s: %v（下载中心未启用）\n", distDir, err)
		distDir = ""
	}
	h, err := newHubSrv(token, nodeTok, overrides, distDir)
	if err != nil {
		return err
	}
	h.dev = devMode
	mux := http.NewServeMux()
	h.routes(mux)
	go h.expireSweep()
	go h.scheduleSweep()
	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: mux}
	gwCfg := h.gw.snapshot()
	if gwCfg.Root != "" {
		fmt.Printf("Reach Desk %s 监听 %s（网关 %s，默认模型 %s%s）\n", versionStr,
			ln.Addr(), mustURLHost(gwCfg.Root), gwCfg.DefaultModel, protocolSuffix(gwCfg.DefaultProtocol))
	} else {
		fmt.Printf("Reach Desk %s 监听 %s（未配置网关，模型能力不可用）\n", versionStr, ln.Addr())
	}
	for _, note := range h.gw.legacy {
		fmt.Fprintln(os.Stderr, "迁移提示："+note)
	}
	if h.dev {
		fmt.Println("⚠ 调试模式：工作台免登录（-dev / HW_DEV=1），勿暴露到公网")
	}
	if h.dl != nil {
		fmt.Printf("下载中心 http://<hub>/download（包目录 %s）\n", distDir)
	}
	if nodeTok != "" {
		fmt.Println("入网令牌已启用：被控端可用 node_token 上线（不能开控制台）")
	}
	if *certF != "" && *keyF != "" {
		return srv.ServeTLS(ln, filepath.Clean(*certF), filepath.Clean(*keyF))
	}
	return srv.Serve(ln)
}

func protocolSuffix(protocol string) string {
	if protocol == "" {
		return ""
	}
	return "，协议 " + protocol
}

func maskKey(k string) string {
	if k == "" {
		return "未配置"
	}
	if len(k) <= 8 {
		return "已配置"
	}
	return k[:4] + "…" + k[len(k)-4:]
}

func runToken() error {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	fmt.Println(hex.EncodeToString(b))
	return nil
}
