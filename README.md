# Hermes Web

可自行部署的繁體中文 Hermes 網頁／PWA 客戶端。參照 Hermes Android 4.0.1 的操作契約：聊天、歷史、文件、任務與設定。這是社群客戶端，不是 NousResearch 或 Android 作者的官方產品。

版本 **0.4.0**。聊天記錄獨立捲動、輸入框固定在底部；串流不會重建輸入框或清掉回答。批准採「選擇 → 確認並繼續」，澄清支援多題、多選及補充文字；取消與過期會撤下問題。斷線後查原操作回執，不自動重送訊息。

0.4.0 同步手機頁面分層、三種外觀、對話工具面板、模型搜尋、附件預覽與排隊發送；補上 iOS 鍵盤可見區域的位置同步。詳見 [手機介面更新與驗證](docs/mobile-ui-0.4.0.md)。iPhone 真機鍵盤結果仍需部署者驗證。

這個倉庫只有通用程式、假資料測試和安裝文件。沒有個人帳號、部署地址、對話、模型金鑰、執行資料庫或舊私人倉庫的 Git 歷史。角色圖改為本專案原創 SVG。

## 使用範圍

- 適合 **一位 Gateway 管理者**。不是多人隔離的 SaaS，登入者可以操作其被允許的 Hermes Profile、工具和工作區。
- 需要既有 Hermes Agent Gateway；目前以 `v0.22.0` 的 HTTP/JSON-RPC 介面接線。Gateway 必須啟用原生 `basic` 帳密登入，並在同一 Linux 主機的 `127.0.0.1:9119` 運行。
- 不會幫你安装模型服務、提供免費 API 額度、建立新 Gateway 帳號或轉存模型金鑰。
- 語音依浏览器／既有服務支援；Android 端側模型與角色影片未移植。不是 Android 全功能複製品。

## Linux Docker 安裝

```sh
git clone https://github.com/arumwu/Hermes-Web-Community.git
cd Hermes-Web-Community
cp .env.example .env
# 編輯 .env，填入自己的 HTTPS 網域、既有 Gateway 帳號、Profile、Hermes home 路徑。
docker compose up -d --build
curl http://127.0.0.1:9180/mobile/health
```

`.env` 只填接線設定，**不要填 Gateway 密碼或 provider token**。瀏覽器登入時使用自己 Gateway 的既有密碼；密碼不存到網頁 localStorage。`.env`、執行狀態和憑證一律忽略，不要提交 Git。

請將 HTTPS 反向代理的來源設為 `http://127.0.0.1:9180`，保留路徑、WebSocket Upgrade 和 Origin。網站根路徑會轉到 `/mobile/`。Cloudflare Tunnel 亦可使用此來源；帳號授權、DNS 和 Tunnel credential 由安裝者自行管理，不在這個倉庫裡。`HERMES_MOBILE_ORIGIN` 必須與瀏覽器使用的 HTTPS Origin 完全相同。

Docker 使用 Linux `network_mode: host`，因此僅監聽 host loopback，不直接開放公網 port。此配方適用 Linux；不能直接把 Docker Desktop 的 host network 或 LAN Gateway 當成已驗證支援。Web state volume 只保存操作去重與 scope salt，**不要掛載整個 Hermes home 或憑證檔**。

## 不用 Docker

需要 Python 3.12+、Node.js 24 及 npm：

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.lock
npm ci --ignore-scripts
npm run build
cp .env.example .env
# 編輯 .env 後，在同一主機的非 root 專用帳號執行。
set -a; . ./.env; set +a
export HERMES_MOBILE_STATE="$PWD/.state"
# 用已編譯的 web 取代執行目錄的 web。原始碼另保留在 Git。
mkdir -p run
cp server.py run/server.py
cp -R build/web run/web
.venv/bin/python -m uvicorn server:app --app-dir run --host 127.0.0.1 --port 9180 --no-access-log
```

開啟服務不等於完成 HTTPS。以反向代理公開前，必須確認匿名 API 拒絕、自己帳號可登入、WebSocket 可接續原對話、確認卡可回答。

## 更新與備份

先備份 `.env` 和 `web-state` volume，保留前一版 image，再更新固定 Git tag／commit、重新建置。切換 Web 會要求重新登入；Hermes 原對話仍在自己的 Gateway。volume 裡的資料不可上傳 Git。前一版若未支援新資料表，回退前先停新版並備份狀態。

## 開發與驗證

```sh
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
npm run build
```

測試只使用假後端與合成資料，不會登入任何私人主機或提交真實任務。依賴版本由 lock 固定，但 base image 未固定 digest，不宣稱跨日期 byte-for-byte 可重現。Docker 安裝、真手機鍵盤／語音和所有 Gateway 版本仍應由部署者驗證。

來源與授權見 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，聊天變更與已驗證範圍見 [docs/chat-contract.md](docs/chat-contract.md)。
