export interface SafetyRule { id: string; pattern: RegExp }
export const ALWAYS_REJECT_RULES: readonly SafetyRule[] = [
  { id: "secret.private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu },
  { id: "secret.credential", pattern: /(?<![\p{L}\p{N}])(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|cookie|session[_ -]?secret|recovery code|助记词|密码|私钥)\s*[:=：]\s*\S+/iu },
  { id: "secret.authorization_header", pattern: /\bAuthorization\s*:\s*(?:Bearer\s+[A-Za-z0-9._~+\/-]{12,}|Basic\s+[A-Za-z0-9+/]{12,}={0,2})/iu },
  { id: "secret.credential_url", pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/iu },
  { id: "secret.token_prefix", pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/u },
  { id: "identity.government_id", pattern: /\b\d{17}[0-9Xx]\b|\b身份证(?:号)?\s*[:：]?\s*[0-9Xx]{8,}/u },
  { id: "identity.email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu },
  { id: "identity.phone", pattern: /(?:电话|手机号|mobile|phone)\s*[:：]?\s*\+?[0-9][0-9 ()-]{6,18}/iu },
  { id: "payment.card", pattern: /\b(?:\d[ -]*?){13,19}\b/u },
  { id: "address.full", pattern: /(?:完整住址|家庭地址|home address)\s*[:：]/iu },
  { id: "content.private_conversation", pattern: /(?:完整私聊|完整私人对话|full private (?:chat|conversation))/iu },
  { id: "content.transient", pattern: /(?:临时情绪|仅本次任务|只在这次任务|temporary mood|this task only)/iu },
  { id: "content.repository_code_fact", pattern: /(?:仓库中可直接读取|directly readable from (?:the )?repository)/iu }
];
export const INFERENCE_REJECT_RULES: readonly SafetyRule[] = [
  { id: "inference.health", pattern: /(?:健康|疾病|诊断|抑郁|焦虑|health|diagnosis|depression)/iu },
  { id: "inference.politics", pattern: /(?:政治|党派|投票|politic|party affiliation)/iu },
  { id: "inference.personality", pattern: /(?:人格|性格类型|personality|mbti)/iu },
  { id: "inference.finance", pattern: /(?:财务状况|收入|债务|financial status|income|debt)/iu }
];
