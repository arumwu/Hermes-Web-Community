# 0.4.0 手機介面與 iOS 鍵盤定位

此版同步共用手機介面及回歸修正，保留社群版自己的品牌、原創SVG、瀏覽器儲存名稱與通用安裝設定。

## 更新

- 我的頁改為個人資料、伺服器、記憶／心智、設定及使用說明分層；返回保留來源頁與未存內容。
- CLEAN／GLASS／PAPER各有首頁和底部導覽版型；回看增加模式、專案、時間篩選及滑動／更多操作。
- 聊天採單列48px控制與最多五行輸入；加入檔案／照片／指令／工作區面板、提示詞管理、可搜尋模型選單。
- 批准／澄清一次顯示一張面板，長內容可捲動；保留草稿及二次確認，不因關閉面板自動回答。
- 支援執行中追加、排隊與取消；逾時狀態不自動重送；修正語音晚到寫錯會話及Profile切換殘留狀態。
- 附件預覽與移除分開；完整檔名、大小、同名序號與背景附件折疊。
- 文件與任務改為手機列表和選單；開關失敗恢復原值。
- iOS聊天外框固定於可見區域，依visualViewport的高度與offsetTop同步，監聽resize、scroll、pageshow；不強制重新focus或捲動整頁。

## 驗證

82項Node測試、46項Python測試及獨立HTTP/WebSocket假資料流程通過。前端編譯14個公開版資源。原創圖案保留，未加入Android角色素材。

假資料測試包括Profile隔離、模型讀回、提交去重、批准恢復及完成事件。測試不讀Keychain、不連私人主機、不建立真人任務。

```sh
npm ci --ignore-scripts
npm test
npm run build
python -m unittest discover -s tests -p 'test_*.py'
# 安裝測試用fastapi、uvicorn、httpx、websockets後：
python -m uvicorn mobile_fixture:app --app-dir tests --host 127.0.0.1 --port 18743
# 另一個終端
python tests/mobile_fixture_smoke.py --port 18743
```

截圖位於[畫面證據](mobile-ui-0.4.0/)，只含合成資料。瀏覽器尺寸／事件測試不代表iPhone實體鍵盤、麥克風、系統分享或所有Gateway版本驗收；Docker配方本次未在新的Linux主機重裝。

## 公開版邊界

沒有同步私人站的部署腳本、主機地址、帳號、Keychain測試、資料庫、憑證、真實對話、截圖或Git歷史。Docker、compose、環境變數範本、服務工作者命名及既有原創素材保持公開版版本。server.py僅更新health版本為0.4.0。

iOS可見區域行為依據：[MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)。
