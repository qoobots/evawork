/* 端到端测试夹具：一个"永远不回应 initialize"的伪 MCP 服务。
 *
 * 用途：逼出 installMcpTools 的"预算内返回、不被慢服务拖垮就绪"分支。
 * 它启动后只保持 stdin 打开、绝不发任何 JSON-RPC 帧，并在 10s 后自行退出
 * （避免测试结束后留下孤儿进程）。真实 MCP 握手超时是 90s，远长于本夹具存活时间，
 * 所以测试里 5s 预算必然先返回，慢服务不会阻塞就绪。 */
process.stdin.resume();
process.stdout.write(''); // 不开任何帧
setTimeout(() => process.exit(0), 10000);
