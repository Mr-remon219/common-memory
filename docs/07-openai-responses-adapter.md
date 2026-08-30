# OpenAI Responses Adapter

生产请求使用用户配置的 OpenAI-compatible Base URL，并固定追加 `/responses`。默认 Base URL 是 `https://api.openai.com/v1`。Base URL 必须是无 credentials、query 和 fragment 的绝对 HTTP(S) URL，保留代理或网关路径前缀；用户不能把完整 `/responses` endpoint 当成 Base URL。Body 必含 `model`、`store:false`、有界 `max_output_tokens`、provider-neutral input，以及：

```json
{"text":{"format":{"type":"json_schema","name":"memory_analysis_v1","strict":true,"schema":{}}}}
```

Authorization 只在 header。Adapter 构造时必须注入显式启用的 `RemoteDisclosurePolicy`，先构造唯一序列化 wire body，再在 fetch 前对该 body 的全部键和值及精确总字节执行 preflight；直接 adapter 调用不能绕过安全门。禁止 SDK、previous_response_id、metadata、tools 和文件上传。兼容服务必须实现 Responses API 和 strict JSON Schema Structured Outputs；仅兼容 Chat Completions 的 endpoint 不在当前支持范围。

Decoder 只接受 completed response、null incomplete/error、可忽略 reasoning，以及恰好一个 completed assistant message；content 恰好一个 output_text 或 refusal。Tool/unknown/multiple/mixed/malformed/oversize 全部 INVALID_RESPONSE。

响应体与输出 token 配置受不可突破的有限整数硬上限约束。网络、429、5xx 最多额外重试两次并受总 deadline 限制；Retry-After 支持秒数和 HTTP-date 且封顶。401/403、其他 4xx、refusal、incomplete 和解码错误不重试。显式取消与内部 timeout 分别映射 CANCELLED/TIMEOUT。
