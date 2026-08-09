# launcher

Codex Desktop renderer adapter 的只读地基。当前阶段只提供：

- `inspect-install`：读取 `/Applications/ChatGPT.app` 的版本、build、bundle id
  与路径；
- `probe`：连接一个已经存在的 loopback CDP endpoint，读取 renderer 的语义
  锚点与主题 token，并给出 `safe-mode | additive | weft-mode` 兼容等级。

它不会启动、修改、重签名或覆盖官方应用，也还不会注入 UI。`weft-mode` 的
subtractive tier 在模式切换器缺少已验证语义锚点时必定降级为 `additive`。

```sh
pnpm install
pnpm inspect-install
node dist/cli.js probe --endpoint=http://127.0.0.1:9222
```
