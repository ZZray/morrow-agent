package main

import (
	"ara/apps/handwave/websafe"
	"bytes"
	"compress/gzip"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

const oldAgentStatus = "if (evt.status) agent.status = evt.status;"
const rayAgentStatus = "if (evt.status && !(id === 'local' && /^(tool_start|tool_end|retry|steer)$/.test(evt.type))) agent.status = evt.status;"

// The surrounding composer already indicates focus; avoid a second rectangle
// inside it while retaining focus outlines for every other control.
const composerFocusCSS = "\n.ws-app .composer-bar.composer-box:focus-within{background:var(--composer-bg)}\n@media(forced-colors:none){.ws-app .composer-box textarea#input:focus-visible{outline:none}}\n"

// A node greeting starts an asynchronous workspace PATCH. The receipt must
// never update whichever workspace/session is selected when it arrives later.
func adaptHandWaveNodeBinding(body []byte) ([]byte, error) {
	if !bytes.Contains(body, []byte("if (f.k === 'node-hello') {")) {
		return body, nil
	}
	edits := [][2]string{
		{"if (curWS && f.fp) {\n      const dname = i.hostname || '';", "if (curWS && f.fp) {\n      const boundWorkspace = curWS, boundSession = curSess;\n      const dname = i.hostname || '';"},
		{"      }).then(() => {\n        curWS.device_fp = f.fp;", "      }).then(() => {\n        if (curWS !== boundWorkspace || curSess !== boundSession) return;\n        curWS.device_fp = f.fp;"},
	}
	for _, edit := range edits {
		if bytes.Count(body, []byte(edit[0])) != 1 {
			return nil, errors.New("HandWave node binding version requires review")
		}
		body = bytes.Replace(body, []byte(edit[0]), []byte(edit[1]), 1)
	}
	return body, nil
}

// These exact UI-only edits bridge the deployed legacy asset to the owner UI
// change without publishing unrelated backend or frontend working-tree changes.
//
//go:embed model_menu_patch.json
var modelMenuPatch []byte

// Security transformations are shared with direct Hub asset responses.
func adaptHandWaveSecurity(body []byte) ([]byte, error) {
	if !bytes.Contains(body, []byte("function escHtml(s) {")) && !bytes.Contains(body, []byte("function showToast(")) {
		return body, nil
	}
	return websafe.AdaptApp(body)
}

//go:embed handwave_motion.css
var handWaveMotionCSS []byte

//go:embed handwave_motion.js
var handWaveMotionJS []byte

//go:embed handwave_context.css
var handWaveContextCSS []byte

//go:embed handwave_context.js
var handWaveContextJS []byte

//go:embed handwave_suggest.js
var handWaveSuggestJS []byte

//go:embed handwave_memory.js
var handWaveMemoryJS []byte

//go:embed handwave_memory.css
var handWaveMemoryCSS []byte

//go:embed handwave_memory_transport.js
var handWaveMemoryTransportJS []byte

//go:embed handwave_settings.js
var handWaveSettingsJS []byte

//go:embed handwave_settings.css
var handWaveSettingsCSS []byte

//go:embed handwave_links.js
var handWaveLinksJS []byte

//go:embed handwave_links.css
var handWaveLinksCSS []byte

//go:embed handwave_machine_target.js
var handWaveMachineTargetJS []byte

//go:embed handwave_composer_menu.js
var handWaveComposerMenuJS []byte

//go:embed handwave_schedule.js
var handWaveScheduleJS []byte

//go:embed handwave_schedule.css
var handWaveScheduleCSS []byte

//go:embed handwave_queue.js
var handWaveQueueJS []byte

//go:embed handwave_queue.css
var handWaveQueueCSS []byte

//go:embed handwave_recovery.js
var handWaveRecoveryJS []byte

//go:embed handwave_recovery.css
var handWaveRecoveryCSS []byte

//go:embed handwave_composer.css
var handWaveComposerCSS []byte

//go:embed handwave_console.js
var handWaveConsoleJS []byte

//go:embed handwave_console.css
var handWaveConsoleCSS []byte

// MIT-licensed, fixed local bundles. See vendor/xterm/README.md and LICENSE-*.
//
//go:embed vendor/xterm/xterm-6.0.0.js
var handWaveXtermJS []byte

//go:embed vendor/xterm/addon-fit-0.11.0.js
var handWaveXtermFitJS []byte

//go:embed vendor/xterm/xterm-6.0.0.css
var handWaveXtermCSS []byte

//go:embed vendor/xterm/LICENSE-xterm
var handWaveXtermLicense []byte

//go:embed vendor/xterm/LICENSE-addon-fit
var handWaveXtermFitLicense []byte

// Adapt only reviewed stable call sites; never publish the dirty legacy web tree.
func adaptHandWaveRecovery(body []byte) ([]byte, error) {
	if !bytes.Contains(body, []byte("function connectHub() {")) {
		return body, nil
	}
	change := func(old, next string) error {
		if bytes.Count(body, []byte(old)) != 1 {
			return errors.New("HandWave recovery UI version requires review")
		}
		body = bytes.Replace(body, []byte(old), []byte(next), 1)
		return nil
	}
	login := "    location.href = '/login';\n    throw new Error('unauthorized');"
	if bytes.Count(body, []byte(login)) == 0 {
		login = "    location.href = '/handwave/login';\n    throw new Error('unauthorized');"
	}
	if err := change(login, "    if (window.HandwaveRecovery) window.HandwaveRecovery.authRequired();\n    throw new Error('登录已过期；草稿已保留，请完成 Ray 验证。');"); err != nil {
		return nil, err
	}
	edits := [][2]string{
		{"    await readyP;\n    for (let i = 0; i < data.length; i += MAX_CHUNK) {", "    await readyP;\n    if (!toolSess.has(id)) return;\n    for (let i = 0; i < data.length; i += MAX_CHUNK) {\n      if (!toolSess.has(id)) return;"},
		{"      toolSess.get(id).gotReady = () => acked();", "      const transfer = toolSess.get(id);\n      if (!transfer) return;\n      transfer.gotReady = () => acked();"},
		{"  } catch (err) {\n    content = err && err.message ? err.message : String(err); ok = false;", "  } catch (err) {\n    if (err && err.name === 'RecoveryInterrupted') { card.setOut(err.message); card.finish(false, '结果待核对'); throw err; }\n    content = err && err.message ? err.message : String(err); ok = false;"},
		{"async function runOneToolCall(tc, base) {\n  const name", "async function runOneToolCall(tc, base) {\n  if (window.HandwaveRecovery) window.HandwaveRecovery.checkToolFence(base);\n  const name"},
		{"  card.setOut(content);\n  card.finish(ok, ok ? '' : '失败');", "  if (window.HandwaveRecovery) window.HandwaveRecovery.checkToolFence(base, card, content);\n  card.setOut(content);\n  card.finish(ok, ok ? '' : '失败');"},
	}
	for _, edit := range edits {
		if err := change(edit[0], edit[1]); err != nil {
			return nil, err
		}
	}
	// Queued cloud, clarify continuation and direct send share this boundary.
	continueEdits := [][2]string{
		{"      const results = await runToolCalls(asst.tool_calls, toolBase);\n      if (stopRequested)", "      const results = await runToolCalls(asst.tool_calls, toolBase);\n      if (window.HandwaveRecovery) window.HandwaveRecovery.checkContinuation(toolBase);\n      if (stopRequested)"},
	}
	for _, edit := range continueEdits {
		if bytes.Count(body, []byte(edit[0])) != 3 {
			return nil, errors.New("HandWave recovery continuation version requires review")
		}
		body = bytes.ReplaceAll(body, []byte(edit[0]), []byte(edit[1]))
	}
	// Both the legacy queued cloud consumer and direct send own the same catch.
	catchEdits := [][2]string{
		{"    const stopped = e && e.name === 'AbortError';\n    finishAgentRun(stopped ? 'canceled' : 'failed');", "    const stopped = e && e.name === 'AbortError';\n    const interrupted = e && e.name === 'RecoveryInterrupted';\n    finishAgentRun(interrupted ? 'interrupted' : stopped ? 'canceled' : 'failed');"},
		{"    else addBubble('system', '发送失败：' + e.message);", "    else addBubble('system', (interrupted ? '连接中断，结果待核对：' : '发送失败：') + e.message);"},
	}
	for _, edit := range catchEdits {
		if bytes.Count(body, []byte(edit[0])) != 2 {
			return nil, errors.New("HandWave recovery catch version requires review")
		}
		body = bytes.ReplaceAll(body, []byte(edit[0]), []byte(edit[1]))
	}
	if err := change("      addBubble('system', '继续失败：' + (e && e.message));\n      finishAgentRun('failed');", "      const interrupted = e && e.name === 'RecoveryInterrupted';\n      addBubble('system', (interrupted ? '连接中断，结果待核对：' : '继续失败：') + (e && e.message));\n      finishAgentRun(interrupted ? 'interrupted' : 'failed');"); err != nil {
		return nil, err
	}
	start, end := bytes.Index(body, []byte("async function consumeSSE(path, body, stream) {")), bytes.Index(body, []byte("async function sendChat() {"))
	if start < 0 || end <= start {
		return nil, errors.New("HandWave SSE recovery version requires review")
	}
	chunk := body[start:end]
	streamEdits := [][2]string{
		{"  const ctl = new AbortController();", "  let recoveryText = '';\n  const recoveryOwner = window.HandwaveRecovery ? window.HandwaveRecovery.captureOwner() : '';\n  const ctl = new AbortController();"},
		{"                stream.append(text);", "                recoveryText += text;\n                stream.append(text);"},
		{"    if (!resp.ok || !resp.body) {", "    if (!resp.ok || !resp.body) {\n      if (resp.status === 401 && window.HandwaveRecovery) window.HandwaveRecovery.authRequired();"},
		{"              try { asst = JSON.parse(payload); } catch (_) {}", "              try { asst = JSON.parse(payload); } catch (_) { throw new Error('回复完成回执格式无效'); }\n              if (!asst || typeof asst !== 'object' || Array.isArray(asst) || typeof asst.content !== 'string' || typeof asst.turn_id !== 'string' || !asst.turn_id || asst.tool_calls && !Array.isArray(asst.tool_calls) || asst.clarify && !Array.isArray(asst.clarify)) throw new Error('回复完成回执格式无效');"},
		{"    return asst;\n  } finally {", "    if (buf.trim()) throw (window.HandwaveRecovery ? window.HandwaveRecovery.streamIncomplete('回复流尾部不完整，结果待核对。') : new Error('回复流尾部不完整'));\n    if (!asst) throw (window.HandwaveRecovery ? window.HandwaveRecovery.streamIncomplete() : new Error('回复连接提前结束，未收到完成回执'));\n    return asst;\n  } catch (error) {\n    if (window.HandwaveRecovery) window.HandwaveRecovery.preserveStream(recoveryText, recoveryOwner);\n    throw error;\n  } finally {"},
	}
	for _, edit := range streamEdits {
		if bytes.Count(chunk, []byte(edit[0])) != 1 {
			return nil, errors.New("HandWave SSE recovery call site requires review")
		}
		chunk = bytes.Replace(chunk, []byte(edit[0]), []byte(edit[1]), 1)
	}
	body = append(append(append([]byte(nil), body[:start]...), chunk...), body[end:]...)
	start, end = bytes.Index(body, []byte("async function runDelegateAgent(args, agentID, base) {")), bytes.Index(body, []byte("async function runOneToolCall(tc, base) {"))
	if start < 0 || end <= start {
		return nil, errors.New("HandWave delegate recovery version requires review")
	}
	chunk = body[start:end]
	delegateEdits := [][2]string{
		{"    if (!resp.ok || !resp.body) {", "    if (!resp.ok || !resp.body) {\n      if (resp.status === 401 && window.HandwaveRecovery) window.HandwaveRecovery.authRequired();"},
		{"    return result || { agent_id: id, name: body.name, role: body.role, content: '' };", "    if (buf.trim()) throw (window.HandwaveRecovery ? window.HandwaveRecovery.streamIncomplete('子任务回复流尾部不完整，结果待核对。') : new Error('子任务回复流尾部不完整'));\n    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.content !== 'string') throw (window.HandwaveRecovery ? window.HandwaveRecovery.streamIncomplete() : new Error('子任务回复提前结束，未收到有效完成回执'));\n    return result;"},
	}
	for _, edit := range delegateEdits {
		if bytes.Count(chunk, []byte(edit[0])) != 1 {
			return nil, errors.New("HandWave delegate recovery call site requires review")
		}
		chunk = bytes.Replace(chunk, []byte(edit[0]), []byte(edit[1]), 1)
	}
	return append(append(append([]byte(nil), body[:start]...), chunk...), body[end:]...), nil
}

//go:embed handwave_context_patch.json
var handWaveContextPatch []byte

// Remove the legacy answer-as-reasoning heuristic only at the reviewed SSE
// consumer. The context view consumes public trace receipts instead of prose.
func adaptHandWaveContext(body []byte) ([]byte, error) {
	if !bytes.Contains(body, []byte("async function consumeSSE(path, body, stream) {")) {
		return body, nil
	}
	var edits []struct {
		Old   string `json:"old"`
		New   string `json:"new"`
		Count int    `json:"count"`
	}
	if err := json.Unmarshal(handWaveContextPatch, &edits); err != nil {
		return nil, errors.New("invalid HandWave context patch")
	}
	for _, edit := range edits {
		if edit.Old == "" || edit.Count < 1 || bytes.Count(body, []byte(edit.Old)) != edit.Count {
			return nil, errors.New("HandWave context UI version requires review")
		}
		body = bytes.ReplaceAll(body, []byte(edit.Old), []byte(edit.New))
	}
	return body, nil
}

func compactModelMenu(body []byte) ([]byte, error) {
	if !bytes.Contains(body, []byte("function bindModelPicker() {")) {
		return body, nil
	}
	var edits []struct {
		Old   string `json:"old"`
		New   string `json:"new"`
		Count int    `json:"count"`
	}
	if err := json.Unmarshal(modelMenuPatch, &edits); err != nil {
		return nil, errors.New("invalid HandWave model menu patch")
	}
	for _, edit := range edits {
		if edit.Old == "" || edit.Count < 1 || bytes.Count(body, []byte(edit.Old)) != edit.Count {
			return nil, errors.New("HandWave model menu version requires review")
		}
		body = bytes.ReplaceAll(body, []byte(edit.Old), []byte(edit.New))
	}
	return body, nil
}

// The deployed Host UI groups events by agent identity. A tool's status belongs
// to the timeline, while the local Agent remains running until its own terminal.
// Preserve every event/status field and limit this adapter to the pinned UI site.
func adaptHandWaveUI(response *http.Response) error {
	if response.Request == nil || response.Request.Method != "GET" {
		return nil
	}
	path := response.Request.URL.Path
	if path == "/handwave/download" || path == "/download" {
		return adaptSourceDownloadCard(response)
	}
	composerStyle := path == "/handwave/style.css" || path == "/style.css"
	if !composerStyle && path != "/handwave/app.js" && path != "/app.js" {
		return nil
	}
	if composerStyle && response.StatusCode != http.StatusOK {
		return nil
	}
	media, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if (composerStyle && media != "text/css") || (!composerStyle && media != "application/javascript" && media != "text/javascript") {
		return nil
	}
	reader := io.Reader(response.Body)
	if encoding := strings.ToLower(response.Header.Get("Content-Encoding")); encoding != "" && encoding != "identity" {
		if encoding != "gzip" {
			return errors.New("unsupported HandWave script encoding")
		}
		gz, err := gzip.NewReader(response.Body)
		if err != nil {
			return errors.New("invalid HandWave script encoding")
		}
		defer gz.Close()
		reader = gz
	}
	body, err := io.ReadAll(io.LimitReader(reader, 4<<20+1))
	if err != nil || len(body) > 4<<20 {
		return errors.New("HandWave script unavailable")
	}
	if err = response.Body.Close(); err != nil {
		return err
	}
	if composerStyle {
		body = append(body, '\n')
		body = append(body, handWaveMotionCSS...)
		body = append(body, '\n')
		body = append(body, handWaveContextCSS...)
		body = append(body, '\n')
		body = append(body, handWaveMemoryCSS...)
		body = append(body, '\n')
		body = append(body, handWaveScheduleCSS...)
		body = append(body, '\n')
		body = append(body, handWaveSettingsCSS...)
		body = append(body, '\n')
		body = append(body, handWaveLinksCSS...)
		body = append(body, '\n')
		body = append(body, handWaveQueueCSS...)
		body = append(body, '\n')
		body = append(body, handWaveRecoveryCSS...)
		body = append(body, '\n')
		body = append(body, handWaveComposerCSS...)
		body = append(body, handWaveXtermCSS...)
		body = append(body, handWaveConsoleCSS...)
		body = append(body, []byte(composerFocusCSS)...)
	} else {
		if bytes.Count(body, []byte(oldAgentStatus)) != 1 {
			return errors.New("HandWave UI version requires review")
		}
		body = bytes.Replace(body, []byte(oldAgentStatus), []byte(rayAgentStatus), 1)
		body, err = adaptHandWaveSecurity(body)
		if err != nil {
			return err
		}
		body, err = compactModelMenu(body)
		if err != nil {
			return err
		}
		body, err = adaptHandWaveContext(body)
		if err != nil {
			return err
		}
		body, err = adaptHandWaveNodeBinding(body)
		if err != nil {
			return err
		}
		body, err = adaptHandWaveRecovery(body)
		if err != nil {
			return err
		}
		body = append(body, []byte("\n;\n")...)
		body = append(body, handWaveMotionJS...)
		body = append(body, []byte("\n;\n")...)
		body = append(body, handWaveContextJS...)
		// The minified upstream JS omits notices; distribute the full MIT notices
		// alongside the unmodified bundles in the actual served script as well.
		body = append(body, []byte("\n/* @license\n")...)
		body = append(body, handWaveXtermLicense...)
		body = append(body, '\n')
		body = append(body, handWaveXtermFitLicense...)
		body = append(body, []byte("\n*/\n")...)
		for _, module := range [][]byte{handWaveSuggestJS, handWaveMemoryJS, handWaveMemoryTransportJS, handWaveSettingsJS, handWaveLinksJS, handWaveComposerMenuJS, handWaveScheduleJS, handWaveMachineTargetJS, handWaveQueueJS, handWaveXtermJS, handWaveXtermFitJS, handWaveConsoleJS, handWaveRecoveryJS} {
			body = append(body, []byte("\n;\n")...)
			body = append(body, module...)
		}
	}
	response.Body = io.NopCloser(bytes.NewReader(body))
	response.ContentLength = int64(len(body))
	response.Header.Set("Content-Length", strconv.Itoa(len(body)))
	response.Header.Set("Cache-Control", "no-store")
	for _, key := range []string{"Content-Encoding", "ETag", "Last-Modified", "Content-MD5", "Digest"} {
		response.Header.Del(key)
	}
	return nil
}
