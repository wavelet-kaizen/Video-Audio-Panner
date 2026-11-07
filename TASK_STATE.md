# Task state

## Goal and current behavior

- Edge Canaryの全画面PWAでHolodex multiviewの音声振り分けを自動化。現在のmanifest.versionは1.3。
- 自動監視は https://holodex.net/multiview とその配下のみ。初回注入直後から監視。SPAでの出入り、動画/iframe追加削除・読み込み、レイアウト祖先の属性、サイズ変更、play/playing/loadedmetadata、ページ復帰・ユーザー操作で更新をまとめる。定期ポーリング、完了メッセージはなし。他サイトは手動実行。
- 実際の表示座標を優先。各iframe内の矩形と親iframeの位置/拡大率を合成する。非表示動画・iframeは自動集計から除外。
- 1動画は中央。2動画は左→右に±0.8。縦一列の2～3動画は上→下に[-0.8, 0.8, 0]を適用（横中心の差2 CSS px以内は同列とする）。
- それ以外の3～4動画は左列/右列、上側80%・下側65%、中央配置は中央。5以上は従来の[-1, 1, 0]を繰り返す。
- 他サイトの手動/座標取得不可時のパターンは1:[0]、2:[-0.8,0.8]、3:[-0.8,0,0.8]、4:[-0.8,-0.65,0.8,0.65]、5以上:[-1,1,0]。

## Implementation and constraints

- background.js: タブ単位の更新キュー、全フレームのスナップショット、座標合成、パン計算、ドキュメントID指定の適用。カウンターのタブ間共有なし。自動初期化の失敗/フレーム不足は遅延を増やして最大3回再試行。一部フレームが準備中でも取得済み動画には適用する。runtime.onStartupで復元されたmultiviewタブも初期化。
- content.js: 再注入防止、限定監視、矩形収集、WeakMapで音声ノードを再利用。各文書で最大1つのAudioContext。同じvideoのソースを再作成せず、datasetに音声オブジェクトを保存しない。停止中のcontextへ接続せず元の音声を維持し、再生/操作で再開する。
- manifest.json: Holodexトップフレームに宣言的注入。権限追加なし。既存min.jsはランタイムから参照されず未変更。
- README/CLAUDEは現行動作・開発/パック手順に更新済み。AGENTS.mdの内容は維持してコミットする。ユーザー指示に従い単独作業。

## Packaging

- pack-crx.cmdをダブルクリック。scripts/pack-extension.ps1が既存env/Video Audio Panner.pemを再利用し、Edge Canary/通常版を検出する。-KeyPath/-BrowserPath/EDGE_PATHにも対応。Nodeは不要。
- 3つの実行ファイルだけをenv/pack-<GUID>に一時コピーし、CRX3/ZIP内容とSHA256を検証してからcrx/Video Audio Panner-<version>.crxへ保存。成功時のみ既存出力を置換。失敗時は既存CRXを維持してログを残す。キーの自動生成なし。
- 移動/再帰削除前に絶対パスがワークスペース内の予定ディレクトリか確認。env/とcrx/はGit管理外。リポジトリ全体をパックしない（gitignoreはパックの除外設定ではない）。
- パック処理はcmd起動、連続実行、別cwd/空白入りパス、キー不足、ブラウザー不足、実際の署名失敗を確認済み。失敗時のCRXハッシュは不変。

## Latest checks and outcome

- 最新要望: PWAを終了/再表示、通常タブをリロードした後も、既存動画の再生開始で自動適用する。配置変更はユーザーも動作を確認したため、既存処理を維持して回帰確認のみ行った。
- テストで初回監視の遅れ、動画準備前の集計後に再生しても再集計されない経路、注入失敗/取得不足時の再試行欠落、復元タブの起動処理欠落を確認して修正した。
- node --test tests/extension.test.cjs: 20件成功。初期化・復元・有限再試行・一部フレーム不足の回帰を追加。構文、manifest参照、git diff --checkも成功。
- node tests/edge-smoke.cjs: Edge本体(Edg/156.0.4314.58)で12シナリオ成功。自動再生制限解除フラグを廃止し、生成したWAVを実再生。再生中のmediaとrunningのAudioContextのみをパン値検証の対象とする。リロード/ページ終了後の再表示、既存の配置交換・縦一列・リサイズ・SPA出入り、ダイアログ/console.errorなしを確認。専用プロファイルとローカルHTML応答を使用。DevTools通信は承認済みの制限外実行が必要。
- パックスクリプトでcrx/Video Audio Panner-1.3.crxを作成済み。Pythonでもversion 1.3、現行3ファイルとの完全一致、秘密キーなし、旧CRXと同じ拡張IDを確認。
- 作業完了。次はユーザー環境でCRXを更新し、PWAを終了して開き直す。実際のCanary/PWAをタスク終了した際の復帰・聴感は未検証（実機テストはEdgeのテスト用ページ）。旧CRXは保持している。

## Commit organization

- 開発ガイド、自動振り分け、CRX作成、縦一列、リロード/復帰の5件に分割。各機能の実装・テスト・説明を対応させる。最終ソースの内容を保持し、秘密キー・CRX・env/の作業ファイルは含めない。
- 分割時点の11件/13件と最終版20件の回帰テスト・構文確認がすべて成功。cmdをCRLFで扱う.gitattributesをパック機能のコミットに追加。
