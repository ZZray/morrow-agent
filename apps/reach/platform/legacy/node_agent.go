package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
)

const (
	maxNodeAgentStepOutput = 128 << 10
	maxNodeAgentReport     = 512 << 10
)

type nodeTaskSink func(agentEvent)

func (a *nodeAgent) sendAgentEvent(cn *conn, taskID string, e agentEvent) {
	if cn == nil {
		return
	}
	e.TaskID = taskID
	if e.ID == "" {
		e.ID = hexID()
	}
	if e.TS == "" {
		e.TS = newAgentEvent("", "", "", "", "", "", "").TS
	}
	b, err := json.Marshal(dcf{K: "agent-event", ID: taskID, Event: &e})
	if err != nil {
		log.Printf("node agent event marshal failed: task=%s error=%T: %v", taskID, err, err)
		return
	}
	if err := cn.sendMsg(b); err != nil {
		log.Printf("node agent event send failed: task=%s type=%s error=%T: %v", taskID, e.Type, err, err)
	}
}

func (a *nodeAgent) sendAgentReport(cn *conn, taskID, report string, code int, errMsg string) {
	raw := []byte(report)
	for len(raw) > maxChunk {
		a.out(cn, taskID, raw[:maxChunk], false, 0, "")
		raw = raw[maxChunk:]
	}
	a.out(cn, taskID, raw, true, code, errMsg)
}

func validateAgentTask(task *agentTask) error {
	if task == nil || strings.TrimSpace(task.ID) == "" {
		return fmt.Errorf("task id required")
	}
	if len(task.Steps) == 0 || len(task.Steps) > maxAgentSteps {
		return fmt.Errorf("task must contain 1-%d steps", maxAgentSteps)
	}
	for i := range task.Steps {
		s := &task.Steps[i]
		if s.ID == "" {
			s.ID = fmt.Sprintf("step-%d", i+1)
		}
		s.Title = cleanAgentLabel(s.Title, fmt.Sprintf("Step %d", i+1))
		switch s.Kind {
		case "exec":
			if strings.TrimSpace(s.Cmd) == "" {
				return fmt.Errorf("step %d: command required", i+1)
			}
		case "read_file":
			if strings.TrimSpace(s.Path) == "" {
				return fmt.Errorf("step %d: path required", i+1)
			}
		case "write_file":
			if strings.TrimSpace(s.Path) == "" {
				return fmt.Errorf("step %d: path required", i+1)
			}
		default:
			return fmt.Errorf("step %d: unsupported kind %q", i+1, s.Kind)
		}
	}
	return nil
}

func (a *nodeAgent) runAgentTask(cn *conn, f *dcf) {
	task := f.Task
	if task == nil {
		task = &agentTask{ID: f.ID}
	}
	if task.ID == "" {
		task.ID = f.ID
	}
	if err := validateAgentTask(task); err != nil {
		a.sendAgentEvent(cn, task.ID, newAgentEvent("task_finish", "failed", task.AgentID, task.Name, task.Role, "Task rejected", err.Error()))
		a.out(cn, task.ID, nil, true, -1, err.Error())
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	if !a.registerRun(task.ID, cancel, true) {
		cancel()
		a.out(cn, task.ID, nil, true, -1, "duplicate task id")
		return
	}
	defer func() {
		cancel()
		a.unregisterRun(task.ID, true)
	}()

	name := cleanAgentLabel(task.Name, "Node Agent")
	role := cleanAgentLabel(task.Role, "operator")
	emit := func(e agentEvent) { a.sendAgentEvent(cn, task.ID, e) }
	start := newAgentEvent("task_start", "running", task.AgentID, name, role, task.Objective, "")
	start.Total = len(task.Steps)
	emit(start)
	log.Printf("node agent task start: task=%s agent=%s role=%s steps=%d controller=%s", task.ID, task.AgentID, role, len(task.Steps), a.curFP)

	var report strings.Builder
	appendReport := func(title, output string) {
		remaining := maxNodeAgentReport - report.Len()
		if remaining <= 0 {
			return
		}
		section := fmt.Sprintf("## %s\n%s\n", title, output)
		if len(section) > remaining {
			section = section[:remaining]
		}
		report.WriteString(section)
	}
	for i, step := range task.Steps {
		select {
		case <-ctx.Done():
			finish := newAgentEvent("task_finish", "canceled", task.AgentID, name, role, "Task canceled", ctx.Err().Error())
			finish.Index, finish.Total = i, len(task.Steps)
			emit(finish)
			a.sendAgentReport(cn, task.ID, report.String(), -1, "canceled")
			log.Printf("node agent task canceled: task=%s agent=%s completed=%d total=%d", task.ID, task.AgentID, i, len(task.Steps))
			return
		default:
		}
		stepStart := newAgentEvent("step_start", "running", task.AgentID, name, role, step.Title, step.Kind)
		stepStart.StepID, stepStart.Index, stepStart.Total = step.ID, i+1, len(task.Steps)
		emit(stepStart)
		log.Printf("node agent step start: task=%s step=%s index=%d total=%d kind=%s", task.ID, step.ID, i+1, len(task.Steps), step.Kind)

		output, code, errMsg := a.runAgentStep(ctx, cn, task.ID, step, func(chunk []byte) {
			e := newAgentEvent("step_output", "running", task.AgentID, name, role, step.Title, "")
			e.StepID, e.Index, e.Total, e.Output = step.ID, i+1, len(task.Steps), string(chunk)
			emit(e)
		})
		appendReport(step.Title, output)
		status := "completed"
		if errMsg != "" || code != 0 {
			status = "failed"
		}
		stepFinish := newAgentEvent("step_finish", status, task.AgentID, name, role, step.Title, errMsg)
		stepFinish.StepID, stepFinish.Index, stepFinish.Total, stepFinish.Code = step.ID, i+1, len(task.Steps), code
		emit(stepFinish)
		log.Printf("node agent step finish: task=%s step=%s status=%s code=%d output_bytes=%d", task.ID, step.ID, status, code, len(output))
		if status == "failed" {
			finish := newAgentEvent("task_finish", "failed", task.AgentID, name, role, "Task failed", fmt.Sprintf("step=%s error=%s", step.ID, errMsg))
			finish.Index, finish.Total, finish.Code = i+1, len(task.Steps), code
			emit(finish)
			a.sendAgentReport(cn, task.ID, report.String(), code, errMsg)
			return
		}
	}
	finish := newAgentEvent("task_finish", "completed", task.AgentID, name, role, "Task completed", "")
	finish.Index, finish.Total = len(task.Steps), len(task.Steps)
	emit(finish)
	a.sendAgentReport(cn, task.ID, report.String(), 0, "")
	log.Printf("node agent task finish: task=%s agent=%s steps=%d report_bytes=%d", task.ID, task.AgentID, len(task.Steps), report.Len())
}

func (a *nodeAgent) runAgentStep(ctx context.Context, cn *conn, taskID string, step agentStep, onOutput func([]byte)) (string, int, string) {
	var out strings.Builder
	appendOutput := func(raw []byte) {
		remaining := maxNodeAgentStepOutput - out.Len()
		if remaining <= 0 {
			return
		}
		if len(raw) > remaining {
			raw = raw[:remaining]
		}
		out.Write(raw)
		for len(raw) > 0 {
			n := min(maxChunk, len(raw))
			onOutput(raw[:n])
			raw = raw[n:]
		}
	}
	switch step.Kind {
	case "exec":
		code, errMsg := a.execCommand(ctx, cn, taskID+":"+step.ID, step.Cmd, step.Cwd, step.Timeout, "utf8", appendOutput)
		return out.String(), code, errMsg
	case "read_file":
		path, err := expandPath(step.Path)
		if err != nil {
			return "", -1, err.Error()
		}
		fp, err := os.Open(path)
		if err != nil {
			return "", -1, err.Error()
		}
		defer fp.Close()
		buf := make([]byte, maxChunk)
		for out.Len() < maxNodeAgentStepOutput {
			select {
			case <-ctx.Done():
				return out.String(), -1, "canceled"
			default:
			}
			limit := min(len(buf), maxNodeAgentStepOutput-out.Len())
			n, readErr := fp.Read(buf[:limit])
			if n > 0 {
				appendOutput(buf[:n])
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				return out.String(), -1, readErr.Error()
			}
		}
		return out.String(), 0, ""
	case "write_file":
		path, err := expandPath(step.Path)
		if err != nil {
			return "", -1, err.Error()
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return "", -1, err.Error()
		}
		if err := os.WriteFile(path, []byte(step.Content), 0o600); err != nil {
			return "", -1, err.Error()
		}
		msg := fmt.Sprintf("written %s (%d bytes)", path, len(step.Content))
		appendOutput([]byte(msg))
		return out.String(), 0, ""
	default:
		return "", -1, "unsupported step"
	}
}
