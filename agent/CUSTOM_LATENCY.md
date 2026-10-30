# 自定义 Agent 1.0.19-latency.2

上游基线：3e7353c82a25d3845ec5cffa45f053dbc3301559，Go 1.26.8。

复用原有八路探测，额外保存带时间和目标标识的原始延迟/失败；每分钟通过 HTTPS /update/latency 上传闭合的分钟块，最多五块/次。保留最多 30 分钟内存重试，进程重启会丢失未确认队列。原有 WSS、摘要和资源上报保持兼容。

latency.2 修复长期运行时的校时过期隐患：原始记录依赖有效校时，既有校准有效期为 24 小时，而持续健康的 WSS 不一定再次握手。现在复用现有分钟上传成功响应中的 HTTPS Date 续期；在原有 20 秒修正阈值内保持既有时间线，避免 Date 秒级精度造成时间跳动。不新增请求，不提高上传频率，不改 Worker、D1 或 DO。原始上传错误也会在非 debug 模式输出状态，便于定位缺口。

必须先部署配套 Worker、执行新增表 SQL、在 Worker 变量 LATENCY_DETAIL_SERVER_IDS 中加入本机 UUID，才启用本功能。

本机原配置文件添加 LATENCY_DETAIL="1"；建议同时设置 AUTO_UPDATE="0"。启用时程序不启动上游自动更新任务，避免新版本覆盖定制功能。动态配置仍保留本地开关，开关不参与旧协议 MD5。修改本地开关后需重启已有服务。

测试：`go test ./...`

构建：

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags '-s -w -X main.version=1.0.19-latency.2' -o cf-probe-linux-amd64 ./cmd/cf-probe
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags '-s -w -X main.version=1.0.19-latency.2' -o cf-probe-linux-arm64 ./cmd/cf-probe
```

安装前备份现有程序和配置，按已有服务的真实二进制路径替换，保留服务用户/权限和配置路径。不要重跑会下载上游程序的官方安装脚本，否则将覆盖自定义程序。latency.1 已进行单节点真实采样试点；latency.2 完成本机回归后另行升级，不把模拟时间测试当作生产持续运行验收。

校时回归覆盖 26 小时模拟运行（不实际等待）、Date 精度抖动下时间线连续、无效/缺失 Date 与失败响应不续期、校时过期恢复和超阈值修正。真实图表缺口仍需结合 D1 原始记录及 Agent 日志确认，不能仅凭出现时间认定原因。

关闭 LATENCY_DETAIL 并重启可停止额外上传。回退可恢复原程序及配置。本地队列不持久化，停机/重启/长断网须在图中表现为缺口。

以后由用户通知上游更新；在独立分支合并，不重置覆盖本分支。重点回归 agent.go 中原始结果挂接、时间校准、配置本地字段保留、队列闭合与 ACK、TLS/重定向策略。
