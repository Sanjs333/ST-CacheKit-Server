# ST-CacheKit-Server · 提示词缓存优化服务端

[提示词缓存优化](https://github.com/Sanjs333/ST-CacheKit) 的配套后端，提供请求转发、用量记录与提示词记录。

## 后端安装

先停止酒馆，按实际安装位置修改命令中的路径。TauriTavern 无需安装后端。

**Termux**

```bash
pkg install -y nodejs-lts git && cd "$HOME/SillyTavern" && sed -i 's/enableServerPlugins: false/enableServerPlugins: true/' config.yaml && mkdir -p plugins && cd plugins && git clone https://github.com/Sanjs333/ST-CacheKit-Server.git && cd ST-CacheKit-Server && npm install && cd ../.. && echo "安装完成！请重启 SillyTavern"
```

**Windows**

安装 Node.js 20+、Git 和 PowerShell 7+，在 `SillyTavern` 文件夹的上一级运行：

```powershell
cd SillyTavern && ((Get-Content config.yaml -Encoding utf8) -replace 'enableServerPlugins: false', 'enableServerPlugins: true') | Set-Content config.yaml -Encoding utf8 && New-Item -ItemType Directory -Path plugins -Force | Out-Null && cd plugins && git clone https://github.com/Sanjs333/ST-CacheKit-Server.git && cd ST-CacheKit-Server && npm install && cd ../.. && echo "安装完成！请重启 SillyTavern"
```

完成后重启酒馆，刷新页面即可。

Google 认证沿用酒馆现有设置。缓存命中以 Google 返回用量为准，费用为估算。

## 开发验证

在本目录运行 `npm test`，验证账本并发加载、请求查询、分页快照、记录恢复，以及账本异常或连接断开时的生成准备流程。修改后端后需重启酒馆才能生效。

基于 [Mana Nekoha 的 ST-Vertex-PayGo-Server](https://github.com/mananekoha114/ST-Vertex-PayGo-Server) 修改，采用 [MPL-2.0](LICENSE)。第三方依赖声明见 [vendor/THIRD_PARTY_NOTICES.txt](vendor/THIRD_PARTY_NOTICES.txt)。
