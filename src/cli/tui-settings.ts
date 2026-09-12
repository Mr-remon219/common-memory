import * as clack from './prompt-runtime.js';
import { isDeepStrictEqual } from 'node:util';
import { MemoryModelError } from '../memory-manager/contracts/errors.js';
import { describeConfiguredNetwork } from '../config/runtime.js';
import { localApiKey, readPrivateEnv } from '../config/private-env.js';
import { PRIVATE_PROXY_KEY, PRIVATE_CA_KEY, resolveRoute, type ProxyConfig } from '../memory-manager/network/route.js';
import { defaultConfig, envFilePath, loadConfig, saveNetworkSecret, saveApiKeyToEnvFile, saveConfig, validateConfig, type CommonMemoryConfig } from '../config/config.js';
import { normalizeOpenAICompatibleBaseUrl } from '../memory-manager/openai/openai-responses-adapter.js';
import { REASONING_EFFORTS, type ReasoningEffort } from '../memory-manager/openai/options.js';
import { SESSION_CACHE_DEFAULTS } from '../v2/session.js';
import { storagePathLines } from './storage-paths.js';
import { listProjects } from './operations.js';
import { confirm, expandPath, menu, note, numberInput, requireInteractive, terminalText, text, unwrap, UserCancelled } from './tui-prompts.js';

type Provenance = CommonMemoryConfig['disclosure']['allowedProvenance'][number];
export const PROVENANCE_OPTIONS: { value: Provenance; label: string; hint: string }[] = [
  { value: 'user_explicit', label: '我在对话中表达的内容', hint: '包括纠正和忘记请求' },
  { value: 'agent_observation', label: '其他 AI 整理的理解', hint: '仅初始化导入，保留 AI 来源' },
  { value: 'conversation_context', label: '助手回复与工具上下文', hint: '仅供理解，不作为你的声明' },
  { value: 'document_import', label: '我选择导入的 Markdown', hint: '保留文件来源，不等于你逐句确认' },
];

/** Detect edits made while a form was open rather than silently overwriting them. */
export function checkConfigUnchanged(previous: CommonMemoryConfig | null): void {
  if (!isDeepStrictEqual(loadConfig(), previous)) throw new Error('配置已被其他操作修改，请重新打开表单后再试。');
}
export function saveSettings(next: CommonMemoryConfig, previous: CommonMemoryConfig): void {
  checkConfigUnchanged(previous);
  saveConfig(next);
  clack.log.success('设置已保存。请重启正在运行的助手，新权限不会即时撤销旧会话中的访问。');
}

export async function runSetupWizard(existing: CommonMemoryConfig | null = loadConfig()): Promise<CommonMemoryConfig> {
  requireInteractive();
  const current = existing ?? defaultConfig();
  note('填写维护记忆所用的模型。保存不会调用模型；后续可单独测试连接。\nAPI Key 可以暂时不填，之后仍能读取已有记忆。', existing ? '更换模型' : '第 1 步 · 配置模型');
  const baseUrl = unwrap(await clack.text({ message: 'API 地址（兼容 OpenAI，通常以 /v1 结尾）', initialValue: current.remote.baseUrl,
    validate: value => { try { normalizeOpenAICompatibleBaseUrl(value ?? ''); } catch (error) { return error instanceof Error ? error.message : 'Invalid URL'; } } }));
  const model = await text('模型名称（按服务商提供的名称填写）', current.remote.model);
  const api = unwrap(await clack.select({ message: '服务商支持哪种接口？（不会自动切换）', initialValue: current.remote.api ?? 'responses', options: [
    { value: 'responses' as const, label: 'Responses', hint: '严格结构化输出，需要服务商支持' },
    { value: 'chat_completions' as const, label: 'Chat Completions', hint: '兼容聊天接口，JSON 模式' },
  ] }));
  const apiKeyEnv = current.remote.apiKeyEnv;
  const changeKey = await confirm(hasApiKey(current) ? '要更换已配置的 API Key 吗？' : '现在填写 API Key？（可暂不填写）');
  const apiKey = changeKey ? await keyInput() : undefined;
  const dataRoot = current.dataRoot;
  // Preserve every unrelated setting, including optional sessionCache and legacy proxy absence.
  const { reasoningEffort, thinking, enableThinking, ...remote } = current.remote;
  const sameApi = api === (current.remote.api ?? 'responses');
  const next: CommonMemoryConfig = { ...current, dataRoot, remote: {
    ...remote, baseUrl: normalizeOpenAICompatibleBaseUrl(baseUrl), model, apiKeyEnv: apiKeyEnv.trim(),
    ...(sameApi && current.remote.api === undefined ? {} : { api }),
    ...(sameApi && reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(sameApi && thinking !== undefined ? { thinking } : {}),
    ...(sameApi && enableThinking !== undefined ? { enableThinking } : {}),
  } };
  note([`模型：${model} · ${api}`, `地址：${next.remote.baseUrl}`, `存储：${dataRoot}`, `密钥：${apiKey !== undefined ? '保存新密钥（不回显）' : hasApiKey(current) ? '保留已有密钥' : '暂未设置，可只读'}`, !sameApi ? '切换接口会清除不兼容的思考选项。' : '其他设置保持不变。', ...(!existing ? ['默认只授权个人记忆和你在对话中表达的内容；项目与导入可稍后单独授权。'] : [])].join('\n'), '确认模型设置');
  if (!await confirm('保存以上设置？')) throw new UserCancelled();
  validateConfig(next);
  checkConfigUnchanged(existing);
  // Validate everything before the first write. Secret and config are separate private files.
  if (apiKey !== undefined) saveApiKeyToEnvFile(next.remote.apiKeyEnv, apiKey);
  saveConfig(next);
  clack.log.success('模型设置已保存。正在运行的助手需要重启后生效。');
  return loadConfig()!;
}

export function hasApiKey(config: CommonMemoryConfig): boolean {
  try { return Boolean(localApiKey(config.remote.apiKeyEnv, config.remote.apiKeySource === 'private-env' ? {} : process.env, readPrivateEnv(envFilePath()))); } catch { return false; }
}
function networkStatus(config: CommonMemoryConfig): string {
  try { const route = describeConfiguredNetwork(config); return `Network: ${route.mode} → ${route.route} (${route.reason}${route.protocol ? `, ${route.protocol}` : ''}); connection not tested`; }
  catch (error) { return `Network: ${error instanceof MemoryModelError ? error.message : 'invalid local configuration'}; connection not tested`; }
}
export function statusLines(config: CommonMemoryConfig): string[] {
  return [`Base URL: ${config.remote.baseUrl}`, `Model: ${config.remote.model}`, `API key: ${hasApiKey(config) ? 'configured' : `missing (${config.remote.apiKeyEnv}); reading still available`}`, `API: ${config.remote.api ?? 'responses'}`, ...storagePathLines(config), networkStatus(config),
    `Disclosure scopes: ${config.disclosure.allowedScopes.join(', ')}`, `Writable scopes: ${config.writableScopes.join(', ') || '(none)'}`, `Provenance: ${config.disclosure.allowedProvenance.join(', ')}`];
}
export function showStatus(config: CommonMemoryConfig): void { note(statusLines(config).join('\n'), 'Common Memory status'); }
export function printStatus(): void {
  const config = loadConfig();
  console.log(config ? statusLines(config).join('\n') : 'Common Memory is not configured. Run: common-memory');
}

export async function runCredentialsWizard(current: CommonMemoryConfig): Promise<void> {
  note(`当前：${hasApiKey(current) ? '已找到密钥（未测试）' : '未找到密钥'}\n变量：${current.remote.apiKeyEnv}\n密钥只保存在私有 .env，不写进助手配置。`, 'API Key');
  const action = await menu('要怎样设置密钥？', [
    { value: 'set', label: '填写 / 更换 API Key' },
    { value: 'env', label: '使用其他环境变量', hint: '适合已有外部凭据配置' },
    { value: 'back', label: '返回' },
  ]);
  if (action === 'back') return;
  if (action === 'env') {
    const name = unwrap(await clack.text({ message: '环境变量名称', initialValue: current.remote.apiKeyEnv,
      validate: value => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value?.trim() ?? '') ? undefined : '请填写合法的环境变量名，例如 OPENAI_API_KEY' })).trim();
    if (await confirm(`改用 ${name}？现有私有密钥不会被删除。`)) {
      const { apiKeySource: _source, ...remote } = current.remote;
      saveSettings({ ...current, remote: { ...remote, apiKeyEnv: name } }, current);
    }
    return;
  }
  const key = await keyInput();
  if (!await confirm('保存新密钥？模型和其他设置保持不变。')) return;
  checkConfigUnchanged(current);
  saveApiKeyToEnvFile(current.remote.apiKeyEnv, key);
  clack.log.success('密钥已保存。请重启助手，并用「测试模型连接」检查。');
}

async function keyInput(): Promise<string> {
  return unwrap(await clack.password({ message: 'API Key（隐藏输入，只存本机私有 .env）', validate: value => value?.trim() && !/[\r\n\0]/u.test(value) ? undefined : '请填写非空、单行的 API Key' }));
}

export async function runPermissionsWizard(current: CommonMemoryConfig): Promise<void> {
  const projects = listProjects(current);
  const known = ['global', ...projects.map(p => `project:${p.id}`), ...current.disclosure.allowedScopes, ...current.writableScopes];
  const scopeName = (value: string): string => value === 'global' ? '个人记忆（背景与偏好）' : projects.find(p => `project:${p.id}` === value)?.name ?? `未登记范围：${value}`;
  const options = [...new Set(known)].map(value => ({ value, label: terminalText(scopeName(value)) }));
  note('空格勾选，Enter 继续。读取和写入分别选择；不勾选写入即可只读。\n获授权的材料可能发送给配置的模型。保存后请重启助手。', '决定助手能接触什么');
  const allowedScopes = unwrap(await clack.multiselect({ message: '1/3 · 哪些记忆允许助手读取、模型处理？', options, initialValues: [...current.disclosure.allowedScopes], required: true }));
  const writableScopes = unwrap(await clack.multiselect({ message: '2/3 · 哪些记忆允许更新？（可全部取消）', options, initialValues: current.writableScopes, required: false }));
  const allowedProvenance = unwrap(await clack.multiselect<Provenance>({ message: '3/3 · 哪些材料允许发送给模型？', options: PROVENANCE_OPTIONS, initialValues: [...current.disclosure.allowedProvenance], required: true }));
  note(`允许读取：${allowedScopes.map(scopeName).join('、')}\n允许更新：${writableScopes.map(scopeName).join('、') || '无（只读）'}\n可发送材料：${allowedProvenance.map(p => PROVENANCE_OPTIONS.find(o => o.value === p)!.label).join('、')}`, '确认权限');
  if (await confirm('保存这些权限？')) saveSettings({ ...current, writableScopes, disclosure: { ...current.disclosure, allowedScopes, allowedProvenance } }, current);
}

export async function runNetworkWizard(existing: CommonMemoryConfig | null = loadConfig()): Promise<CommonMemoryConfig> {
  requireInteractive();
  if (!existing) throw new Error('请先配置模型，再设置网络。');
  const mode = unwrap(await clack.select({ message: '怎样连接模型？', initialValue: existing.remote.proxy?.mode ?? 'env', options: [
    { value: 'env' as const, label: '跟随环境代理', hint: '使用 HTTPS_PROXY 等变量和 NO_PROXY' },
    { value: 'direct' as const, label: '直接连接', hint: '不使用应用代理；系统 VPN/TUN 仍可能生效' },
    { value: 'custom' as const, label: '指定代理地址', hint: 'HTTP / HTTPS，SOCKS5 为实验支持' },
  ] }));
  let proxy: ProxyConfig = { mode: mode === 'custom' ? 'env' : mode };
  let secret: string | undefined;
  if (mode === 'custom') {
    secret = unwrap(await clack.password({ message: '代理地址（隐藏输入，私有保存）', validate: value => {
      try { resolveRoute(existing.remote.baseUrl, { mode: 'custom', urlEnv: PRIVATE_PROXY_KEY }, { [PRIVATE_PROXY_KEY]: value }); } catch { return '请填写有效的 HTTP、HTTPS 或 SOCKS5 代理地址'; }
    } }));
    const noProxy = unwrap(await clack.text({ message: '哪些主机不走代理？（可留空，逗号分隔）', defaultValue: '', initialValue: existing.remote.proxy?.mode === 'custom' ? existing.remote.proxy.noProxy ?? '' : '', validate: value => {
      try { resolveRoute(existing.remote.baseUrl, { mode: 'custom', urlEnv: PRIVATE_PROXY_KEY, noProxy: value ?? '' }, { [PRIVATE_PROXY_KEY]: secret }); } catch { return '请检查不走代理的主机列表'; }
    } }));
    proxy = { mode: 'custom', urlEnv: PRIVATE_PROXY_KEY, ...(noProxy.trim() ? { noProxy: noProxy.trim() } : {}) };
  }
  const caAction = await menu('需要额外的 CA 证书吗？', [{ value: 'keep', label: '保持当前设置', hint: '通常选这个' }, { value: 'set', label: '选择 PEM 证书文件' }, { value: 'remove', label: '仅使用 Node 默认信任证书' }]);
  const ca = caAction === 'set' ? expandPath(await text('CA 证书文件路径（PEM）')) : undefined;
  const { caFileEnv, ...remote } = existing.remote;
  const next: CommonMemoryConfig = { ...existing, remote: { ...remote, proxy, ...(ca ? { caFileEnv: PRIVATE_CA_KEY } : caAction === 'keep' && caFileEnv ? { caFileEnv } : {}) } };
  note(`连接方式：${{ env: '跟随环境代理', direct: '直接连接', custom: '指定代理' }[mode]}\n证书：${{ keep: '保持当前设置', set: '使用所选 PEM 文件', remove: '仅使用默认信任' }[caAction]}\n只影响 Common Memory 的模型请求；保存不会测试连接。`, '确认网络设置');
  if (!await confirm('保存网络设置？')) throw new UserCancelled();
  validateConfig(next);
  checkConfigUnchanged(existing);
  if (secret !== undefined) saveNetworkSecret(PRIVATE_PROXY_KEY, secret);
  if (ca) saveNetworkSecret(PRIVATE_CA_KEY, ca);
  saveConfig(next);
  clack.log.success('网络设置已保存。请重启助手；可用「测试模型连接」检查。');
  return loadConfig()!;
}

/** Edit one setting per visit; validate the complete result with Core's existing schema. */
export async function runAdvancedWizard(current: CommonMemoryConfig): Promise<void> {
  const kind = await menu('高级设置 · 不确定时保留当前值', [
    { value: 'tuning', label: '输出长度与思考方式' },
    { value: 'limits', label: '处理节奏与容量限制' },
    { value: 'storage', label: '切换存储目录', hint: '不搬迁、不删除原数据' },
    { value: 'back', label: '返回' },
  ]);
  if (kind === 'back') return;
  let next: CommonMemoryConfig;
  let review: string;
  if (kind === 'storage') {
    note('请先停止所有助手和后台处理器。切换只选择另一份存储，不会搬迁或合并数据。\n原 Markdown 和 SQLite 保留；切换后需要重新生成助手接入配置。', '切换存储前');
    next = { ...current, dataRoot: expandPath(await text('新的存储目录', current.dataRoot)) };
    review = `原目录：${current.dataRoot}\n新目录：${next.dataRoot}`;
  } else if (kind === 'tuning') {
    const field = await menu('要调整哪一项？', [
      { value: 'tokens', label: '最大输出长度', hint: `${current.remote.maxOutputTokens ?? '接口默认'} tokens` },
      { value: 'thinking', label: '思考方式', hint: '只选择服务商支持的参数' },
      { value: 'back', label: '返回' },
    ]);
    if (field === 'back') return;
    const remote = { ...current.remote };
    if (field === 'tokens') {
      const n = await numberInput('最大输出 tokens（1–16384；留空恢复接口默认）', remote.maxOutputTokens, 1, 16384, true);
      if (n === undefined) delete remote.maxOutputTokens;
      else remote.maxOutputTokens = n;
      review = `最大输出：${current.remote.maxOutputTokens ?? '接口默认'} → ${n ?? '接口默认'}`;
    } else {
      delete remote.reasoningEffort; delete remote.thinking; delete remote.enableThinking;
      if ((remote.api ?? 'responses') === 'responses') {
        const effort = await menu('思考强度（Responses，需要模型支持）', [
          { value: 'default', label: '使用接口默认', hint: '不发送 reasoningEffort' },
          ...REASONING_EFFORTS.map(value => ({ value, label: value })),
          { value: 'back', label: '返回' },
        ], current.remote.reasoningEffort ?? 'default');
        if (effort === 'back') return;
        if (effort !== 'default') remote.reasoningEffort = effort as ReasoningEffort;
        review = `思考强度：${current.remote.reasoningEffort ?? '接口默认'} → ${effort === 'default' ? '接口默认' : effort}`;
      } else {
        const initial = current.remote.thinking ? `thinking:${current.remote.thinking.type}` : current.remote.enableThinking !== undefined ? `enableThinking:${current.remote.enableThinking}` : 'default';
        const mode = await menu('思考方式（Chat Completions，按服务商文档选择）', [
          { value: 'default', label: '使用接口默认', hint: '不发送思考参数' },
          { value: 'thinking:enabled', label: '开启思考', hint: 'thinking.type = enabled' },
          { value: 'thinking:disabled', label: '关闭思考', hint: 'thinking.type = disabled' },
          { value: 'enableThinking:true', label: '开启思考（布尔参数）', hint: 'enableThinking = true' },
          { value: 'enableThinking:false', label: '关闭思考（布尔参数）', hint: 'enableThinking = false' },
          { value: 'back', label: '返回' },
        ], initial);
        if (mode === 'back') return;
        if (mode.startsWith('thinking:')) remote.thinking = { type: mode === 'thinking:enabled' ? 'enabled' : 'disabled' };
        else if (mode.startsWith('enableThinking:')) remote.enableThinking = mode === 'enableThinking:true';
        review = `思考参数：${initial} → ${mode}`;
      }
    }
    next = { ...current, remote };
  } else {
    const group = await menu('哪一类限制？', [
      { value: 'scheduler', label: '队列处理节奏', hint: '不改变会话每 10 次交互封批的规则' },
      { value: 'sessionCache', label: '会话暂存容量' },
      { value: 'disclosure', label: '发送给模型的内容上限', hint: '单位为字节' },
      { value: 'back', label: '返回' },
    ]);
    if (group === 'back') return;
    const fields = group === 'scheduler' ? [
      { value: 'turnThreshold', label: '普通队列批量阈值', unit: '条' },
      { value: 'byteThreshold', label: '普通队列大小阈值', unit: '字节' },
      { value: 'idleMs', label: '空闲后开始处理', unit: '毫秒' },
      { value: 'maxWaitMs', label: '最长等待时间', unit: '毫秒' },
      { value: 'leaseMs', label: '任务占用期限', unit: '毫秒' },
      { value: 'maxAttempts', label: '最多尝试次数', unit: '次' },
    ] : group === 'sessionCache' ? [
      { value: 'maxSessionBytes', label: '单个会话暂存上限', unit: '字节' },
      { value: 'maxTotalBytes', label: '所有会话暂存上限', unit: '字节' },
      { value: 'contextTailTurns', label: '保留上下文轮数', unit: '轮' },
    ] : [
      { value: 'maxExcerptBytes', label: '单条材料上限', unit: '字节' },
      { value: 'maxCandidateBytes', label: '候选材料上限', unit: '字节' },
      { value: 'maxTotalBytes', label: '总内容上限', unit: '字节' },
    ];
    const values: Record<string, unknown> = group === 'scheduler' ? current.scheduler : group === 'sessionCache' ? { ...SESSION_CACHE_DEFAULTS, ...current.sessionCache } : { ...current.disclosure };
    const field = await menu('选择要修改的值', [
      ...fields.map(f => ({ ...f, hint: `当前 ${values[f.value]} ${f.unit}` })),
      ...(group === 'sessionCache' ? [{ value: 'reset', label: '恢复会话暂存默认值' }] : []),
      { value: 'back', label: '返回' },
    ]);
    if (field === 'back') return;
    if (field === 'reset') {
      next = { ...current }; delete next.sessionCache;
      review = '会话暂存将使用内置默认值，其他设置不变。';
    } else {
      const option = fields.find(f => f.value === field)!;
      const n = await numberInput(`${option.label}（${option.unit}）`, Number(values[field]), field === 'contextTailTurns' ? 0 : 1);
      const previous = group === 'scheduler' ? current.scheduler : group === 'sessionCache' ? current.sessionCache : current.disclosure;
      next = validateConfig({ ...current, [group]: { ...previous, [field]: n } });
      review = `${option.label}：${values[field]} → ${n} ${option.unit}\n其他设置保持不变。`;
    }
  }
  validateConfig(next);
  note(review, '确认修改');
  if (await confirm('保存这项修改？')) saveSettings(next, current);
}
