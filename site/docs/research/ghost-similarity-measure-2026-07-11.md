# Ghost 相似度量測研究

> 日期：2026-07-11
>
> 狀態：研究建議，尚未完成使用者校準
>
> 範圍：`site/public/ghost.html` 的即時「與幽靈對齊」量測

## 結論先行

目前的 32×32 灰階 L1 差異不能支撐「使用者有多少照著 AI 擺」的說法。它主要反映亮度與大面積色塊，無法可靠分辨姿勢、人物位置、裁切或遮擋，也沒有經過人類判斷校準。

建議改成兩層證據：

1. **當下匹配**：以人體關節點計算「姿勢形狀」與「取景位置」兩個可解釋分數。
2. **行為改變**：記錄幽靈出現時的 baseline、快門時的 final、兩者差值、達標時間與有效偵測率。

最重要的產品修正不是換一條公式，而是停止把單一相似度說成因果或作者占比。最終文案應描述可觀察到的過程，例如：

> 你的匹配分數從 42 提升到 78；幽靈出現後 8.4 秒，你的姿勢與取景更接近它。

而不是：

> 這張照片有 78% 是照著生成影像擺出來的。

## 設計依據

- 最新 [OpenHCI 第六組 FigJam](https://www.figma.com/board/IeTkaeLfwpMnPKISECEBoE/OpenHCI-26%EF%BD%9C%E7%AC%AC%E5%85%AD%E7%B5%84?node-id=0-1) 已確認為目前團隊看板。這次可取得看板識別與公開縮圖，但互動 canvas 在 Brave 與 Firefox 都未成功渲染，因此本文件不宣稱讀到了特定 frame 的細節。
- 本機設計規格已明確定案「統計只呈現過程證據，不算假 %」，並認為 `time_to_action` 比任何單點百分比更有研究意義；本報告將這項原則完整轉寫，讓 GitHub 協作者不必依賴未發布的研究資料夾。
- 本機技術草案已提出 MediaPipe 33 點、正規化關節與 cosine similarity；方向正確，但固定 `>0.85` 仍需校準，且沒有把姿勢與取景拆開。
- ShutterMuse 的拍攝引導研究也避免直接比較生成影像，因為風格、光線與 image-editing artifacts 會污染評估；它先抽取 keypoints，再用標準化 skeleton 評估 pose。參見 [ShutterMuse, arXiv:2606.25763](https://arxiv.org/abs/2606.25763)。

## 現況稽核

現有程式位於 `site/public/ghost.html`：

- 把 live video 與 ghost image 各縮成 32×32。
- RGB 直接平均成灰階。
- 計算 1,024 個像素的 mean absolute error。
- 乘上手調常數 `2.2`，再映射成 0–100。
- 每 500 ms 更新一次，快門時把結果記為 `align_pct`。

這個方法有六個根本問題：

1. **亮度混淆**：相同姿勢但 AI 改成 golden-hour 色調，分數會下降。
2. **姿勢盲點**：背景面積通常大於人物，手腳明顯錯位仍可能得到高分。
3. **顯示幾何不一致**：UI 使用 `object-fit: cover`，但 metric 直接拉伸到正方形，實際看到的裁切與被量測的影像不同。
4. **無可見度處理**：遮住的手腳、半身照與全身照被放進同一分母。
5. **無信心狀態**：偵測不到人時仍會產生一個看似精確的數字。
6. **因果過度宣稱**：final similarity 不能證明使用者是因為 AI 才做出該姿勢。

## 先定義三種不同的「相似」

| Construct | 問題 | 適合的證據 | 是否應顯示成目前的單一 % |
|---|---|---|---|
| 視覺相似 | 兩張照片整體看起來像不像？ | DreamSim、LPIPS、SSIM 等 | 否；會混入風格、人物外觀與背景 |
| 姿勢/取景匹配 | 使用者是否把身體與位置對進幽靈？ | 人體 landmarks、joint angles、framing geometry | 是，但應稱 match score 並先校準 |
| AI 行為影響 | 使用者是否因幽靈而改變？ | baseline→final 變化、時間軌跡、控制條件 | 否；不能從單一 final score 推論 |

本產品真正需要的是第二項；研究主張需要第三項。

## 候選方法比較

| 方法 | 優點 | 對本產品的問題 | 決策 |
|---|---|---|---|
| 灰階 L1 / MSE | 極快、可離線 | 主要量亮度與像素位置 | 移除 |
| SSIM | 比單純 L1 更重視局部結構 | 本質是對齊影像品質指標；生成風格與裁切仍會污染 | 不作 live score |
| LPIPS | 比像素差更接近低階人類感知 | patch/appearance 仍會混入衣服、背景、光線；瀏覽器負擔高 | 僅可離線 baseline |
| DreamSim | 對 pose、layout、viewpoint 等 mid-level similarity 較敏感，並以人類比較資料訓練 | 不是「照做了沒」的專用指標；不透明且會混入語意與風格 | 可作離線比較，不進 v1 |
| Segmentation IoU | 可量人物 silhouette | 會懲罰身形、衣服、頭髮與生成瑕疵，且遮擋敏感 | 暫不納入 |
| Landmark distance / OKS | 可見度與人物尺度可納入，容易解釋 | COCO 的 sigma 是 annotation uncertainty，不等於本產品的感知權重 | 用作 placement 基礎並重新校準 |
| Joint angles / limb vectors | 對平移、距離、身材較穩健；直接對應「姿勢」 | 2D angle 受視角與遮擋影響 | 作為 pose 主體 |
| Pose + framing hybrid | 可把「姿勢」與「站在哪裡」分開回饋 | 權重必須用人類判斷校準 | **推薦** |

Google 的 pose classification 指南也先用 torso size 與 torso orientation 正規化，再以關節間距離或 joint angles 比較姿勢，而不是比較原始像素：[ML Kit pose classification](https://developers.google.com/ml-kit/vision/pose-detection/classifying-poses)。

DreamSim 的研究顯示，pixel/patch 指標對 layout、object pose 與 semantic content 的 mid-level 差異不足；它以 20K 人類判斷 triplets 校準新的視覺相似度：[DreamSim](https://arxiv.org/abs/2306.09344)。這支持「必須以人類判斷校準」，但不代表 DreamSim 本身適合即時姿勢引導。

## 推薦的 v1 metric

### 1. Landmark extraction

使用 `@mediapipe/tasks-vision` 的 Pose Landmarker：

- ghost image：`IMAGE` mode，只在生成完成後跑一次。
- live camera：`VIDEO` mode，以 4 Hz 偵測；UI 繼續 30/60 fps。
- 使用肩、肘、腕、髖、膝、踝與鼻子等核心點。
- 僅比較 target 與 live 都達可見度門檻的 joint。
- full-body、three-quarter、upper-body 分成不同 coverage class，不跨 class 比較絕對分數。
- 所有 inference 留在裝置端，不上傳 landmarks。

MediaPipe Web API 會輸出 33 個 normalized landmarks、world landmarks、visibility 與 optional segmentation mask；官方也提醒 `detectForVideo()` 是同步呼叫：[Pose Landmarker for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)。目前 `@mediapipe/tasks-vision` 在 module Worker 仍有已知初始化限制（[MediaPipe issue #5257](https://github.com/google-ai-edge/mediapipe/issues/5257)），因此本版先在 main thread 以 4 Hz、idle scheduling 與 lite model 執行，並記錄 p50/p95 inference latency；上游 Worker 支援成熟後再移出 main thread。

### 2. Display-coordinate normalization

不能直接比較原始 image coordinates。先把 target 與 live landmarks 都套用和畫面相同的 `object-fit: cover` scale/crop transform，得到使用者實際看到的 stage coordinates。

前鏡頭 mirror 只允許在一個地方處理：

- 若 inference 使用未鏡像來源，target 與 live 都維持未鏡像。
- 若比較 display coordinates，兩者一起做 `x = 1 - x`。
- 不可只鏡像其中一方。

### 3. Pose-shape score

對共同可見的 limb vectors 計算 angular difference：

```text
theta_e = acos(clamp(dot(unit(target_e), unit(live_e)), -1, 1))
S_pose = weighted_mean(exp(-0.5 * (theta_e / sigma_e)^2))
```

建議 edges：左右 upper/lower arms、左右 upper/lower legs、shoulder line、hip line、shoulder-to-hip torso vectors。

這個分數忽略整體平移與人物大小，回答「身體形狀是否相似」。`sigma_e` 不應憑感覺固定，需由 calibration dataset 估計。

### 4. Framing score

另外比較 visible-person bounding box：

```text
center_error = distance(target_center, live_center) / stage_diagonal
scale_error  = abs(log(live_height / target_height))
S_frame = exp(-0.5 * (center_error / sigma_center)^2)
        * exp(-0.5 * (scale_error  / sigma_scale)^2)
```

這回答「人物是否站在幽靈的位置與大小」。若需要更細的 joint placement，可加入 visibility-weighted OKS-like score。COCO OKS 的 reference implementation 會依 object area、per-keypoint sigma 與 visibility 正規化：[COCO API `computeOks`](https://github.com/cocodataset/cocoapi/blob/master/PythonAPI/pycocotools/cocoeval.py)。

### 5. Composite and confidence

不要先把 `0.7 * pose + 0.3 * framing` 當真理。先保留 component scores，再用人類 rating fit 一個 monotonic calibration function：

```text
raw_match = w_pose * S_pose + w_frame * S_frame
match_0_100 = monotonic_calibration(raw_match)
confidence = shared_visible_weight * coverage_ratio
```

在完成校準前，UI 用三段狀態即可：`調整中 / 接近 / 對上了`。只有 confidence 足夠時才顯示 score；否則顯示可行動原因：

- `請讓肩膀與髖部入鏡`
- `幽靈姿勢無法辨識`
- `畫面中有多人，暫停評分`

### 6. Temporal behavior

- 對每個 component 使用最近 5 個有效 frame 的 median，再做 EMA。
- matched threshold 需持續 1 秒才算達標，避免抖動。
- pose 暫失時不要瞬間跳到 0；短暫 freeze，超時後切成 unavailable。
- 快門事件記錄 baseline、final、peak、gain、time-to-match 與 valid-frame ratio。

建議 schema：

```json
{
  "align_metric_version": "pose-framing-v1",
  "coverage_class": "upper_body",
  "baseline": {"pose": 44, "framing": 38, "match": 42, "confidence": 0.91},
  "final": {"pose": 81, "framing": 72, "match": 78, "confidence": 0.94},
  "peak_match": 84,
  "match_gain": 36,
  "time_to_match_ms": 8400,
  "valid_frame_ratio": 0.93
}
```

baseline 應取 ghost 首次可見後的第一段穩定 frame，而不是召喚前的舊 frame；同時另外保留 summon 前 frame，供研究分析生成前後差異。

## 為什麼不能只換成 DreamSim 或 SSIM

SSIM、LPIPS、DreamSim 都回答「影像看起來像不像」，不是「使用者的 pose 是否對上」。AI 被 prompt 要求改光線、構圖與攝影風格，因此影像 metric 會同時懲罰或獎勵模型自己的改圖幅度。

ShutterMuse 對 pose recommendation 的評估採用 keypoints 與 standardized skeleton，正是為了排除 rendering style、texture、lighting 與 editing artifacts。對 OpenHCI 而言，這個分離更重要，因為「AI 改了多少」本身就是研究情境，不應偷偷變成使用者分數的一部分。

## 校準與驗證計畫

### Dataset

收集至少 120 組 target/live pairs：

- 12 位參與者，每人至少 10 組。
- front/rear camera 各半。
- full-body、three-quarter、upper-body 都要有。
- 明暗背景、寬鬆衣物、遮擋、坐姿、側身與手臂交叉。
- 至少兩種目標手機；mobile Safari 與 Android Chrome 都測。
- 原始照片存於研究用受控空間，不 commit 到 Git。

### Human labels

每組由至少 3 位 blind raters 分別評 1–7：

1. 姿勢形狀有多接近？
2. 人物在畫面的位置與大小有多接近？
3. 整體而言，使用者有多像在跟隨 ghost？

先檢查 inter-rater reliability；若評審彼此都不同意，「overall similarity」本身就不是穩定 construct，產品不應偽裝成精確百分比。

### Candidate benchmark

同一 dataset 比較：

- current grayscale L1
- SSIM
- normalized joint angles
- OKS-like placement
- pose + framing hybrid
- DreamSim（只作 offline reference）

主要結果：

- 與 human median rating 的 Spearman correlation。
- leave-one-participant-out validation，避免同一人的 body proportions 洩漏到 train/test。
- bootstrap 95% CI，確認 hybrid 確實優於 current L1。
- coverage/failure rate、static-pose jitter、mobile p50/p95 latency。

### 建議 acceptance threshold

- Hybrid 對 overall human rating 的 held-out Spearman `rho >= 0.70`。
- Hybrid 的 bootstrap 95% CI 相對 current L1 有正向改善。
- 只改亮度 ±20% 而 landmarks 不變時，match 變化不超過 5 points。
- 靜止 5 秒時，平滑後 score 的 p95 range 不超過 5 points。
- target phone 上 pose inference + scoring p95 不超過 100 ms；若超標，必須降頻或停用數字回饋，不可拖慢相機操作。
- confidence 不足時不輸出數字，500 ms 內切換成 unavailable reason。

這些門檻是第一版工程 gate，不是已被研究證實的自然常數；pilot 後應連同版本號一起調整。

## 研究主張的額外限制

即使 metric 完美，`final_match` 仍不等於 AI 的因果影響。若要在研究中說「AI 讓人改變」，至少需要：

- baseline→final trajectory，而非 final alone；以及
- no-ghost / delayed-ghost / randomized-target 其中一種對照條件。

此外，continuous score 本身會引導使用者追分，因此它既是 measurement，也是 intervention。研究記錄必須區分「只看 overlay」與「overlay + score」條件，否則無法知道使用者是在跟隨 ghost，還是在跟隨數字。

## Issue-ready implementation scope

### Goal

以 confidence-aware pose + framing metric 取代灰階像素差，並記錄 baseline→final 的行為證據，停止把 final similarity 說成 AI 作者占比。

### Acceptance criteria

- [ ] `site/public/ghost.html` 不再呼叫 `thumbGray()` 或 32×32 grayscale L1。
- [ ] 新增獨立的 pose/framing metric module，target image 只 inference 一次，live video 以受控頻率 inference。
- [ ] metric 只使用共同可見 landmarks，正確處理 `object-fit: cover`、front-camera mirror、partial body 與 pose unavailable。
- [ ] UI 可分別回饋 pose 與 framing；未校準前不把 raw score 顯示成精確百分比。
- [ ] shot log 寫入 metric version、coverage、baseline、final、peak、gain、time-to-match 與 valid-frame ratio。
- [ ] 結果文案不再聲稱「X% 是照著 AI 擺出來的」。
- [ ] 單元測試覆蓋 identical pose、translation-only、scale-only、limb-angle change、mirror、occlusion、low-confidence 與 smoothing。
- [ ] 在指定 mobile devices 完成 latency、jitter、failure-state 與 brightness robustness 驗證。
- [ ] PR 附 calibration/benchmark artifact，或明確標記 score 仍為 uncalibrated three-state guidance。

### Collaboration fields

- **Owner**：Peter
- **Reviewer**：Camera UI reviewer（Joy 或 EJ，不能與 owner 相同）
- **Next check**：2026-07-14 team check-in
- **Artifact paths**：
  - `site/public/pose-similarity.js`
  - `site/tests/pose-similarity.test.mjs`
  - `site/docs/research/ghost-similarity-measure-2026-07-11.md`
  - calibration report path to be added under `site/docs/evaluation/`
- **Suggested branch**：`feature/<issue>-pose-framing-similarity`
- **Dependencies/blockers**：MediaPipe model asset strategy、target mobile device list、human-rated calibration set、privacy/consent plan

## 建議拆分

為避免一張 issue 同時變成研究、演算法與 UI 大包，建議拆成三個 independently reviewable tasks：

1. **修正文案與 log schema**：先移除因果百分比，加入 baseline/final/gain。
2. **實作 pose + framing metric**：MediaPipe、display transform、confidence、tests。
3. **完成人類校準與 mobile benchmark**：dataset、ratings、fit、版本化 thresholds。

## References

- Google AI Edge, [Pose Landmarker for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)
- Google ML Kit, [Pose classification options](https://developers.google.com/ml-kit/vision/pose-detection/classifying-poses)
- COCO API, [`computeOks`](https://github.com/cocodataset/cocoapi/blob/master/PythonAPI/pycocotools/cocoeval.py)
- Fu et al., [DreamSim: Learning New Dimensions of Human Visual Similarity using Synthetic Data](https://arxiv.org/abs/2306.09344)
- Zhang et al., [The Unreasonable Effectiveness of Deep Features as a Perceptual Metric](https://openaccess.thecvf.com/content_cvpr_2018/html/Zhang_The_Unreasonable_Effectiveness_CVPR_2018_paper.html)
- Wang et al., [Image Quality Assessment: From Error Visibility to Structural Similarity](https://ece.uwaterloo.ca/~z70wang/publications/ssim.pdf)
- Li et al., [ShutterMuse: Capture-Time Photography Guidance with MLLMs](https://arxiv.org/abs/2606.25763)
- Blanchet et al., [Enhancing the Educational Potential of Online Movement Videos](https://doi.org/10.1145/3706598.3714062)
