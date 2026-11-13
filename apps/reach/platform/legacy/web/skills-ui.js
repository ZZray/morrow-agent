'use strict';

function positionAttachMenu() {
  const menu = $('attachMenu'), r = $('btnAttach').getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, r.top - menu.offsetHeight - 8) + 'px';
  if (skillMenuOpen) positionSkillMenu();
}

function openAttachMenu() {
  closeModelMenu();
  closeAccountMenu();
  attachMenuOpen = true;
  $('attachMenu').classList.remove('hide');
  $('btnAttach').setAttribute('aria-expanded', 'true');
  positionAttachMenu();
  $('attachFileItem').focus();
}

function closeAttachMenu() {
  closeSkillMenu();
  attachMenuOpen = false;
  $('attachMenu').classList.add('hide');
  $('btnAttach').setAttribute('aria-expanded', 'false');
}

function renderSelectedSkills() {
  const bar = $('skillBar');
  bar.replaceChildren();
  bar.classList.toggle('hide', !selectedSkills.length);
  $('attachSkillCount').textContent = (selectedSkills.length ? selectedSkills.length + ' 项 · ' : '') + '›';
  for (const skill of selectedSkills) {
    const chip = el('button', 'chip skill-chip', '@' + skill.name + ' ×');
    chip.type = 'button';
    chip.title = skill.description || skill.name;
    chip.setAttribute('aria-label', '移除技能 ' + skill.name);
    chip.onclick = () => {
      selectedSkills = selectedSkills.filter((s) => s.id !== skill.id);
      renderSelectedSkills();
      renderSkills();
      $('input').focus();
    };
    bar.appendChild(chip);
  }
}

function selectSkill(skill) {
  if (!selectedSkills.some((s) => s.id === skill.id)) {
    if (selectedSkills.length >= 8) return;
    selectedSkills.push(skill);
  }
  renderSelectedSkills();
  closeAttachMenu();
  $('input').focus();
}

function renderSkills() {
  const list = $('skillList');
  list.replaceChildren();
  const q = $('skillSearch').value.trim().toLowerCase();
  const rows = skillCatalog.filter((s) => (s.name + ' ' + s.description).toLowerCase().includes(q));
  $('skillStatus').textContent = skillLoading ? '加载中…' : skillError || (!rows.length ? (q ? '没有匹配的技能' : '暂无技能，点击「管理技能」创建') : '仅用于本条消息 · 最多选择 8 项');
  for (const skill of rows) {
    const selected = selectedSkills.some((s) => s.id === skill.id);
    const btn = el('button', 'skill-option' + (selected ? ' on' : ''));
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(selected));
    btn.disabled = skillLoading || (!selected && selectedSkills.length >= 8);
    btn.appendChild(el('b', '', (selected ? '✓ ' : '⚒ ') + skill.name));
    btn.appendChild(el('span', '', skill.description || '无描述'));
    btn.title = skill.name + (skill.description ? ' — ' + skill.description : '');
    btn.onclick = () => {
      if (selected) {
        selectedSkills = selectedSkills.filter((s) => s.id !== skill.id);
        renderSelectedSkills();
        renderSkills();
      } else selectSkill(skill);
    };
    list.appendChild(btn);
  }
  if (skillMenuOpen) positionSkillMenu();
  if ($('skillManager').open) renderSkillManager();
}

async function loadSkills() {
  const seq = ++skillLoadSeq;
  skillLoading = true;
  skillError = '';
  renderSkills();
  try {
    const catalog = await api('/skills');
    if (seq !== skillLoadSeq) return;
    skillCatalog = catalog.sort((a, b) => a.name.localeCompare(b.name));
    selectedSkills = selectedSkills.map((s) => skillCatalog.find((item) => item.id === s.id)).filter(Boolean);
    renderSelectedSkills();
  } catch (err) {
    if (seq !== skillLoadSeq) return;
    skillError = '加载失败：' + err.message + '，请点击刷新';
  } finally {
    if (seq === skillLoadSeq) {
      skillLoading = false;
      renderSkills();
    }
  }
}

function positionSkillMenu() {
  const menu = $('skillMenu');
  const r = (attachMenuOpen ? $('attachMenu') : $('btnAttach')).getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let left = r.right + 6;
  let top = r.bottom - h;
  if (!attachMenuOpen || left + w > window.innerWidth - 8) {
    left = Math.min(r.left, window.innerWidth - w - 8);
    top = r.top - h - 6;
  }
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + 'px';
}

async function openSkillMenu() {
  closeModelMenu();
  closeAccountMenu();
  skillMenuOpen = true;
  $('skillMenu').classList.remove('hide');
  $('attachSkillItem').setAttribute('aria-expanded', 'true');
  $('skillSearch').value = '';
  positionSkillMenu();
  $('skillSearch').focus();
  await loadSkills();
}

function closeSkillMenu() {
  skillMenuOpen = false;
  $('skillMenu').classList.add('hide');
  $('attachSkillItem').setAttribute('aria-expanded', 'false');
}

function skillEditorDirty() {
  return $('skillName').value !== (editingSkill ? editingSkill.name : '') ||
    $('skillDescription').value !== (editingSkill ? editingSkill.description : '') ||
    $('skillContent').value !== (editingSkill ? editingSkill.content : '');
}

function discardSkillEdits() {
  return !skillEditorDirty() || window.confirm('放弃尚未保存的技能修改？');
}

function setSkillEditor(skill) {
  editingSkill = skill;
  $('skillName').value = skill ? skill.name : '';
  $('skillDescription').value = skill ? skill.description : '';
  $('skillContent').value = skill ? skill.content : '';
  $('skillEditorTitle').textContent = skill ? '编辑技能' : '新建技能';
  $('skillEditorStatus').textContent = '';
  $('skillDelete').disabled = !skill || !skill.id;
  renderSkillManager();
}

function renderSkillManager() {
  const list = $('skillManagerList');
  list.replaceChildren();
  const q = $('skillManagerSearch').value.trim().toLowerCase();
  const rows = skillCatalog.filter((s) => (s.name + ' ' + s.description).toLowerCase().includes(q));
  $('skillManagerStatus').textContent = skillLoading ? '加载中…' : skillError || '已保存 ' + skillCatalog.length + ' 个技能';
  if (!rows.length) list.appendChild(el('p', 'hint', q ? '没有匹配的技能' : '还没有技能，填写右侧表单创建第一个。'));
  for (const skill of rows) {
    const btn = el('button', 'skill-option' + (editingSkill && editingSkill.id === skill.id ? ' on' : ''));
    btn.type = 'button';
    btn.disabled = skillSaving || skillLoading;
    btn.appendChild(el('b', '', skill.name));
    btn.appendChild(el('span', '', skill.description || '无描述'));
    btn.onclick = async () => {
      if (!discardSkillEdits()) return;
      const seq = ++skillEditSeq;
      $('skillEditorStatus').textContent = '读取中…';
      try {
        const detail = await api('/skills/' + encodeURIComponent(skill.id));
        if (seq !== skillEditSeq || !$('skillManager').open) return;
        setSkillEditor(detail);
      } catch (err) {
        if (seq === skillEditSeq) $('skillEditorStatus').textContent = '读取失败：' + err.message;
      }
    };
    list.appendChild(btn);
  }
}

async function openSkillManager() {
  closeAttachMenu();
  $('skillManager').showModal();
  $('skillManagerSearch').value = '';
  renderSkillManager();
  await loadSkills();
}

function closeSkillManager() {
  if (skillSaving || skillGenerating || !discardSkillEdits()) return;
  ++skillEditSeq;
  $('skillManager').close();
  setSkillEditor(null);
  $('btnAttach').focus();
}

function setSkillSaving(busy) {
  skillSaving = busy;
  for (const id of ['skillName', 'skillDescription', 'skillContent', 'skillSave', 'skillNew', 'skillManagerClose']) $(id).disabled = busy || skillGenerating;
  $('skillGenerate').disabled = busy || skillGenerating;
  $('skillAIPrompt').disabled = busy || skillGenerating;
  $('skillDelete').disabled = busy || skillGenerating || !editingSkill || !editingSkill.id;
  renderSkillManager();
}

// ---------- 网关模型配置（共享网关；令牌只来自环境变量，永不进表单） ----------
const gatewayProtocolList = ['openai-completions', 'openai-responses', 'anthropic-messages',
  'azure-openai-responses', 'openrouter-chat', 'google-generative-ai', 'ollama-chat'];

// 服务端错误是固定英文文案；这里补中文说明 + 下一步，原文用 textContent 原样展示。
const gatewayErrorText = {
  'invalid gateway configuration': '网关配置校验未通过：gateway_root / gateway_token_env / default_model / default_protocol 的组合不合法。',
  'gateway target is not allowed': '网关地址不在允许的网络边界内：公网目标必须 HTTPS，本机回环地址需勾选「允许本机回环地址」。',
  'gateway is not configured': 'Hub 还没有配置网关：请填写 gateway_root 并选择默认模型后保存。',
  'gateway is unavailable': '网关不可达：确认网关进程在跑、地址与端口正确，然后点「刷新目录」重试。',
  'gateway model returned an invalid skill draft': '网关模型返回的技能草稿不合规：换一句更具体的描述后重试。',
  'gateway request timed out': '网关请求超时：稍后重试，或检查网关负载。',
  'gateway request failed': '网关请求失败：见下方服务端原文。',
  'method not allowed': '接口方法不被允许。',
};

function gatewayErrText(err) {
  const raw = err && err.message ? String(err.message) : '未知错误';
  const mapped = gatewayErrorText[raw.trim().toLowerCase()];
  return mapped ? mapped + '（服务端原文：' + raw + '）' : raw;
}

function gatewayCatalog() {
  return (gatewayPublic && Array.isArray(gatewayPublic.models)) ? gatewayPublic.models.slice() : [];
}

function gatewayProtocols(modelID) {
  const hit = gatewayCatalog().find((m) => m && m.id === modelID);
  return (hit && Array.isArray(hit.protocols) && hit.protocols) || [];
}

function gatewaySelectOption(select, value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  select.appendChild(option);
}

function gatewayTokenStatus(pub) {
  // gatewayPublic 里的字段名是 gateway_token_env；只报变量名与是否存在，永不读取/回显值。
  const name = pub.gateway_token_env || 'HW_GATEWAY_TOKEN';
  if (pub.has_token) {
    return '令牌环境变量 ' + name + '：已检测到值。令牌只在 Hub 进程内存中使用，不写盘、不返回浏览器。';
  }
  return '令牌环境变量 ' + name + '：未检测到值。请在 Hub 的环境变量里设置它；本界面不接收、不读取密钥值。';
}

// 只有输入的 root 与令牌环境变量名都和已保存配置一致时，服务器目录才是“可信候选来源”。
// 否则那只是旧地址的目录，不能当作候选证明，也不能拿来限制协议。
function gatewayCatalogTrusted() {
  const pub = gatewayPublic || {};
  if (!pub.configured) return false;
  const norm = (value) => String(value || '').trim().replace(/\/+$/, '');
  const rootMatches = norm($('gwRoot').value) === norm(pub.gateway_root);
  const envMatches = (String($('gwTokenEnv').value).trim() || 'HW_GATEWAY_TOKEN') === (pub.gateway_token_env || 'HW_GATEWAY_TOKEN');
  return rootMatches && envMatches;
}

function renderGatewayModels(pub) {
  const input = $('gwModel');
  const list = $('gwModelOptions');
  if (!input.value && pub.default_model) input.value = pub.default_model;
  const typed = input.value;
  list.replaceChildren();
  const trusted = gatewayCatalogTrusted();
  if (trusted) {
    for (const model of gatewayCatalog().sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
      const option = document.createElement('option');
      option.value = model.id;
      const protocols = Array.isArray(model.protocols) && model.protocols.length ? model.protocols.join(' / ') : '未标注协议（按 chat）';
      option.textContent = (model.name ? model.name + ' · ' : '') + model.id + ' · ' + protocols;
      list.appendChild(option);
    }
  }
  return { requested: typed, kept: !!typed, trusted: trusted, listed: trusted && gatewayCatalog().some((m) => m && m.id === typed) };
}

function renderGatewayProtocols(pub, preferred) {
  const select = $('gwProtocol');
  const modelID = String($('gwModel').value).trim();
  const trusted = gatewayCatalogTrusted();
  const protocols = trusted ? gatewayProtocols(modelID) : [];
  const want = preferred !== undefined ? preferred : (select.value || (trusted ? pub.default_protocol || '' : ''));
  select.replaceChildren();
  if (!modelID) {
    gatewaySelectOption(select, '', '（先填默认模型 ID）');
    select.value = '';
    return select.value;
  }
  if (trusted && protocols.length) {
    if (protocols.length > 1) gatewaySelectOption(select, '', '（请选择协议）');
    for (const protocol of protocols) gatewaySelectOption(select, protocol, protocol);
    select.value = protocols.includes(want) ? want : (protocols.length === 1 ? protocols[0] : '');
    return select.value;
  }
  // 无可信目录（首次配置 / 候选地址 / 目录读取失败）：可显式选 7 种受支持协议，或留空由服务器按目录唯一解析；界面不自动猜。
  gatewaySelectOption(select, '', trusted ? '（目录未标注协议 · 留空按 openai-completions）' : '（留空：由服务器目录唯一解析）');
  for (const protocol of gatewayProtocolList) gatewaySelectOption(select, protocol, protocol);
  select.value = gatewayProtocolList.includes(want) ? want : '';
  return select.value;
}

function renderGatewayAlerts(pub) {
  const catalogError = $('gwCatalogError');
  catalogError.replaceChildren();
  catalogError.classList.toggle('hide', !pub.catalog_error);
  if (pub.catalog_error) {
    catalogError.appendChild(el('b', '', '模型目录读取失败'));
    catalogError.appendChild(el('p', '', pub.catalog_error + '（保留当前选择，不会回退到 auto 或第一个模型）'));
  }
  const migration = $('gwMigration');
  migration.replaceChildren();
  const notes = Array.isArray(pub.migration) ? pub.migration : [];
  migration.classList.toggle('hide', !notes.length);
  if (notes.length) {
    migration.appendChild(el('b', '', '需要迁移的旧配置'));
    const list = document.createElement('ul');
    for (const note of notes) list.appendChild(el('li', '', note));
    migration.appendChild(list);
  }
  const hint = $('gwModelHint');
  if (!pub.configured) {
    hint.textContent = '首次配置：填 gateway_root、令牌环境变量名与准确的 default_model ID（协议可留空，由服务器目录唯一解析），再用「保存并测试目录连通」做实际目录验证。此时聊天与 Skills 生成都会返回「网关未配置」。';
  } else if (!gatewayCatalogTrusted()) {
    hint.textContent = '输入的 gateway_root 或 gateway_token_env 与已保存配置不同：已保存目录不再作为候选或协议约束。请填准确 model ID，并「保存并测试目录连通」验证新地址；「刷新已保存配置的目录」不会验证未保存的地址。';
  } else if (pub.catalog_error) {
    hint.textContent = '网关已配置，但目录不可用（' + pub.catalog_error + '）：可直接填写 default_model ID 与协议，或修正后点「刷新已保存配置的目录」。';
  } else {
    hint.textContent = '已保存配置的目录内有 ' + gatewayCatalog().length + ' 个模型（仅作建议）。多协议模型必须显式选择协议，Hub 不会替你猜。';
  }
}

function renderGatewayForm(applyFields) {
  const pub = gatewayPublic || {};
  if (applyFields) {
    $('gwRoot').value = pub.gateway_root || '';
    $('gwTokenEnv').value = pub.gateway_token_env || '';
    $('cloudAllowLoopback').checked = !!pub.allow_loopback;
    gatewayDirty = false;
  }
  $('gwTokenStatus').textContent = gatewayTokenStatus(pub);
  const models = renderGatewayModels(pub);
  renderGatewayProtocols(pub);
  renderGatewayAlerts(pub);
  if (applyFields) return;
  if (models.requested && models.trusted && !models.listed) {
    gatewayDirty = true;
    $('cloudModelStatus').textContent = '当前网关目录里没有 ' + models.requested + '：已保留你的选择，请确认后再保存，不会自动换成别的模型。';
  }
}

function gatewayPayload() {
  return {
    gateway_root: $('gwRoot').value.trim(),
    gateway_token_env: $('gwTokenEnv').value.trim(),
    default_model: String($('gwModel').value).trim(),
    default_protocol: $('gwProtocol').value,
    allow_loopback: $('cloudAllowLoopback').checked,
  };
}

function gatewayValidationError(payload) {
  const root = payload.gateway_root;
  const cleared = !root && !payload.gateway_token_env && !payload.default_model && !payload.default_protocol;
  if (cleared) return '';
  if (!root) return '请填写 gateway_root（网关根地址）；要清空整份配置，请同时清空令牌环境变量名、默认模型与默认协议。';
  let parsed = null;
  try { parsed = new URL(root); } catch (_) { return 'gateway_root 不是合法 URL：需要形如 https://host 或 http://127.0.0.1:端口。'; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'gateway_root 只支持 http / https。';
  if (!parsed.hostname) return 'gateway_root 缺少主机名。';
  if (parsed.username || parsed.password) return 'gateway_root 不能内嵌用户名或密码；令牌只走环境变量。';
  if (parsed.search || parsed.hash) return 'gateway_root 不能带查询串或锚点；只填根地址（不含 /v1）。';
  if (payload.gateway_token_env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(payload.gateway_token_env)) {
    return 'gateway_token_env 必须是合法的环境变量名，例如 HW_GATEWAY_TOKEN。';
  }
  if (!payload.default_model) return '请填写 default_model：准确的模型 ID。无可信目录时先填 gateway_root，再「保存并测试目录连通」验证；协议可留空由服务器目录唯一解析。';
  const protocols = gatewayCatalogTrusted() ? gatewayProtocols(payload.default_model) : [];
  if (protocols.length > 1 && !payload.default_protocol) return '该模型在已保存配置的目录里支持多个协议，请显式选择 default_protocol（不会自动挑一个）。';
  if (payload.default_protocol && !gatewayProtocolList.includes(payload.default_protocol)) return 'default_protocol 不是网关支持的协议名：' + gatewayProtocolList.join(' / ') + '。';
  if (payload.default_protocol && protocols.length && !protocols.includes(payload.default_protocol)) return '所选协议不在该模型（已保存配置目录）的协议列表里，请重新选择。';
  return '';
}

function markCloudModelDirty() {
  gatewayDirty = true;
  if (!cloudModelBusy) $('cloudModelStatus').textContent = '配置已修改，尚未保存';
}

function setCloudModelBusy(busy) {
  cloudModelBusy = busy;
  for (const id of ['gwRoot', 'gwTokenEnv', 'gwModel', 'gwProtocol', 'gwCatalogRefresh', 'cloudAllowLoopback', 'cloudModelSave', 'cloudModelTest', 'cloudModelClose']) $(id).disabled = busy;
}

function gatewaySavedText(pub) {
  const model = pub.default_model || '（未设置）';
  const protocol = pub.default_protocol || (gatewayProtocols(pub.default_model).length === 1 ? gatewayProtocols(pub.default_model)[0] : '未指定');
  return '配置已保存：' + (pub.configured ? '网关 ' + model + ' · ' + protocol + '（目录 ' + (pub.models || []).length + ' 个模型）' : '网关配置已清空');
}

async function loadGatewayConfig(statusTarget) {
  const pub = await api('/model-config');
  gatewayPublic = pub;
  renderGatewayForm(true);
  if (statusTarget) $('cloudModelStatus').textContent = statusTarget;
  return pub;
}

async function openCloudModelDialog() {
  closeAccountMenu();
  $('cloudModelStatus').textContent = '读取网关配置与模型目录…';
  $('cloudModelDialog').showModal();
  setCloudModelBusy(true);
  gatewayDirty = false;
  try {
    await loadGatewayConfig();
    $('cloudModelStatus').textContent = (gatewayPublic && gatewayPublic.configured)
      ? '已载入当前配置；可直接测试目录连通或点「刷新目录」重读模型。'
      : '还没有可用的网关配置：填写 gateway_root 与默认模型后保存。';
  } catch (err) {
    $('cloudModelStatus').textContent = '读取失败：' + gatewayErrText(err);
  } finally {
    setCloudModelBusy(false);
  }
}

async function refreshGatewayCatalog() {
  if (cloudModelBusy) return;
  if (!gatewayCatalogTrusted()) {
    $('cloudModelStatus').textContent = '「刷新已保存配置的目录」只按服务器上的 gateway_root / gateway_token_env 重读目录，不能验证未保存的候选地址：请先点「保存并测试目录连通」。';
    return;
  }
  setCloudModelBusy(true);
  $('cloudModelStatus').textContent = '刷新网关模型目录…';
  try {
    gatewayPublic = await api('/model-config');
    renderGatewayForm(false);
    const pub = gatewayPublic;
    if (pub.catalog_error) {
      $('cloudModelStatus').textContent = '目录仍然不可用：' + pub.catalog_error;
    } else {
      $('cloudModelStatus').textContent = '目录已刷新：' + (pub.models || []).length + ' 个模型。当前选择保持不变。';
    }
    if (typeof loadModels === 'function') await loadModels();
  } catch (err) {
    $('cloudModelStatus').textContent = '刷新失败：' + gatewayErrText(err) + '；当前选择保持不变。';
  } finally {
    setCloudModelBusy(false);
  }
}

function closeCloudModelDialog() {
  if (cloudModelBusy) return;
  $('cloudModelDialog').close();
  gatewayDirty = false;
  $('accountTrigger').focus();
}

async function saveCloudModel(testAfterSave) {
  if (cloudModelBusy) return;
  const payload = gatewayPayload();
  const invalid = gatewayValidationError(payload);
  if (invalid) {
    $('cloudModelStatus').textContent = '未提交：' + invalid;
    return;
  }
  setCloudModelBusy(true);
  $('cloudModelStatus').textContent = testAfterSave ? '保存配置并测试目录连通…' : '保存配置…';
  try {
    gatewayPublic = await api('/model-config', { method: 'PUT', body: JSON.stringify(payload) });
    gatewayDirty = false;
    renderGatewayForm(true);
    $('cloudModelStatus').textContent = gatewaySavedText(gatewayPublic || {});
    if (typeof loadModels === 'function') await loadModels();
    if (testAfterSave) {
      $('cloudModelStatus').textContent = '配置已保存，正在测试网关目录连通…';
      try {
        const result = await api('/model-config/test', { method: 'POST' });
        $('cloudModelStatus').textContent = '目录鉴权与连通通过：网关返回 ' + result.models + ' 个模型，解析到默认模型 '
          + result.model + ' · 协议 ' + result.protocol + '。这只验证目录，没有调用模型生成。';
      } catch (err) {
        $('cloudModelStatus').textContent = '配置已保存，但目录连通测试失败：' + gatewayErrText(err);
      }
    }
  } catch (err) {
    $('cloudModelStatus').textContent = '保存失败，服务端未改动配置：' + gatewayErrText(err);
  } finally {
    setCloudModelBusy(false);
  }
}

async function generateSkillDraft() {
  if (skillSaving || skillGenerating) return;
  const prompt = $('skillAIPrompt').value.trim();
  if (!prompt) {
    $('skillAIStatus').textContent = '先描述想创建的技能';
    $('skillAIPrompt').focus();
    return;
  }
  if (skillEditorDirty() && !window.confirm('AI 草稿会覆盖当前名称、描述和技能指令，继续？')) return;
  skillGenerating = true;
  setSkillSaving(false);
  $('skillAIStatus').textContent = '正在用已保存的网关默认模型生成草稿…（最长约 2 分钟）';
  try {
    const draft = await api('/skills/generate', { method: 'POST', body: JSON.stringify({ prompt }) });
    setSkillEditor(null);
    $('skillName').value = draft.name;
    $('skillDescription').value = draft.description;
    $('skillContent').value = draft.content;
    $('skillEditorTitle').textContent = 'AI 草稿';
    $('skillDelete').disabled = true;
    $('skillAIStatus').textContent = '草稿已回填，请检查后点击「保存技能」';
    $('skillContent').focus();
  } catch (err) {
    const detail = gatewayErrText(err);
    $('skillAIStatus').textContent = /not configured|未配置/.test(detail)
      ? '还没配置网关：请在左下角账户菜单打开「网关模型配置」，保存 gateway_root 与默认模型后重试。（服务端原文：' + err.message + '）'
      : '生成失败：' + detail;
  } finally {
    skillGenerating = false;
    setSkillSaving(false);
  }
}

function bindSkillPicker() {
  const item = $('attachSkillItem');
  item.setAttribute('aria-haspopup', 'dialog');
  item.setAttribute('aria-controls', 'skillMenu');
  item.setAttribute('aria-expanded', 'false');
  $('attachFileItem').onclick = () => { closeAttachMenu(); $('fileInput').click(); };
  item.onclick = () => { if (!skillMenuOpen) openSkillMenu(); };
  item.onmouseenter = () => { if (!isCoarsePointer() && !skillMenuOpen) openSkillMenu(); };
  item.onkeydown = (event) => { if (event.key === 'ArrowRight') { event.preventDefault(); openSkillMenu(); } };
  $('skillClose').onclick = () => { closeSkillMenu(); item.focus(); };
  $('skillRefresh').onclick = () => loadSkills();
  $('skillSearch').oninput = () => renderSkills();
  $('skillManage').onclick = () => openSkillManager();
  $('skillManagerClose').onclick = closeSkillManager;
  $('skillManager').addEventListener('cancel', (event) => { event.preventDefault(); closeSkillManager(); });
  $('skillManagerSearch').oninput = renderSkillManager;
  $('skillManagerRefresh').onclick = () => loadSkills();
  $('skillGenerate').onclick = generateSkillDraft;
  $('btnCloudModel').onclick = openCloudModelDialog;
  $('btnSkillManager').onclick = openSkillManager;
  $('cloudModelClose').onclick = closeCloudModelDialog;
  $('cloudModelDialog').addEventListener('cancel', (event) => { event.preventDefault(); closeCloudModelDialog(); });
  // 换模型必须重新确认协议；输入过程中保留已选协议（root/env 改动会立即撤销旧目录约束）。
  $('gwModel').onchange = () => {
    renderGatewayModels(gatewayPublic || {});
    renderGatewayProtocols(gatewayPublic || {}, '');
    renderGatewayAlerts(gatewayPublic || {});
    markCloudModelDirty();
  };
  $('gwCatalogRefresh').onclick = refreshGatewayCatalog;
  for (const id of ['gwProtocol', 'cloudAllowLoopback']) $(id).onchange = markCloudModelDirty;
  for (const id of ['gwRoot', 'gwTokenEnv']) {
    $(id).onchange = () => { renderGatewayForm(false); markCloudModelDirty(); };
    $(id).oninput = () => { renderGatewayForm(false); markCloudModelDirty(); };
  }
  $('cloudModelForm').onsubmit = (event) => { event.preventDefault(); saveCloudModel(false); };
  $('cloudModelTest').onclick = () => saveCloudModel(true);
  $('skillNew').onclick = () => {
    if (!discardSkillEdits()) return;
    ++skillEditSeq;
    setSkillEditor(null);
    $('skillAIPrompt').value = '';
    $('skillAIStatus').textContent = '';
    $('skillName').focus();
  };
  $('skillForm').onsubmit = async (event) => {
    event.preventDefault();
    if (skillSaving) return;
    ++skillEditSeq;
    const body = { name: $('skillName').value.trim(), description: $('skillDescription').value.trim(), content: $('skillContent').value };
    if (!body.name || !body.content.trim()) {
      $('skillEditorStatus').textContent = '名称和技能指令不能为空';
      return;
    }
    if (enc.encode(body.name).length > 128 || enc.encode(body.description).length > 1024 || enc.encode(body.content).length > 65536) {
      $('skillEditorStatus').textContent = '内容过长：名称最多 128 字节、描述 1024 字节、指令 64 KiB';
      return;
    }
    const id = editingSkill && editingSkill.id;
    setSkillSaving(true);
    try {
      const saved = await api('/skills' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setSkillEditor({ ...body, id: saved.id || id });
      await loadSkills();
      $('skillEditorStatus').textContent = '已保存';
    } catch (err) { $('skillEditorStatus').textContent = '保存失败：' + err.message; }
    finally { setSkillSaving(false); }
  };
  $('skillDelete').onclick = async () => {
    if (!editingSkill || skillSaving || !window.confirm('删除技能「' + editingSkill.name + '」？已发送的消息不受影响。')) return;
    ++skillEditSeq;
    const id = editingSkill.id;
    setSkillSaving(true);
    try {
      await api('/skills/' + encodeURIComponent(id), { method: 'DELETE' });
      selectedSkills = selectedSkills.filter((s) => s.id !== id);
      renderSelectedSkills();
      setSkillEditor(null);
      await loadSkills();
      $('skillEditorStatus').textContent = '已删除';
    } catch (err) { $('skillEditorStatus').textContent = '删除失败：' + err.message; }
    finally { setSkillSaving(false); }
  };
  document.addEventListener('mousedown', (event) => {
    if (!$('attachMenu').contains(event.target) && !$('skillMenu').contains(event.target) && !$('btnAttach').contains(event.target)) closeAttachMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (attachMenuOpen || skillMenuOpen)) {
      event.preventDefault();
      if (skillMenuOpen) { closeSkillMenu(); item.focus(); }
      else { closeAttachMenu(); $('btnAttach').focus(); }
    }
  });
  for (const id of ['attachMenu', 'skillMenu']) {
    $(id).addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...$(id).querySelectorAll('button:not(:disabled)')];
      if (!buttons.length) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement);
      let next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    });
  }
  window.addEventListener('resize', () => { if (attachMenuOpen) positionAttachMenu(); else if (skillMenuOpen) positionSkillMenu(); });
  window.addEventListener('scroll', (event) => {
    if (event.target instanceof Element && event.target.closest('#attachMenu, #skillMenu')) return;
    if (attachMenuOpen) positionAttachMenu();
  }, true);
  renderSelectedSkills();
}
