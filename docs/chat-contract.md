# 聊天與確認流程

以 Hermes Android 4.0.1 固定版本的 DecisionCard、ChatScreen、GatewayServerRequests 與 HermesApiClient 為行為參照。

修正：串流只更新訊息／狀態區，固定保留輸入框；確認表單以內容版本保存答案，改版後重新選；多題取消按父 ID 並限定原會話；smart_denied 不提供 session/always；正在提交的確認不可雙按；待確認回執不得當作已執行。對話斷線不重送，依原 client_submission_id 查 BFF 回執。

消息與批准的權威仍是原 Gateway。Web 不創建第二份聊天資料庫。PWA 只快取公開靜態資產，不快取登入、API、對話或 WebSocket。

工程測試使用假資料。測試通過不能代替特定手機的鍵盤、語音、正式模型與工具端到端驗收。
