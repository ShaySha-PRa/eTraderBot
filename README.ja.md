<p align="center">
  <img src="./apps/web/public/brand-logo.png" width="120" alt="eTraderBot ロゴ" />
</p>

# eTraderBot

**業務スコープ、専門 Bot、人による承認を中心にした電力取引ワークスペース。**

[简体中文](./README.zh-CN.md) · [English](./README.md) · 日本語

eTraderBot は [Rakazo](https://github.com/elie222/rakazo) を拡張し、小売電気事業者、発電事業者、独立した蓄電設備の取引業務を扱います。業務スコープごとに Bot、会話、資料、インターフェース、意思決定、承認、取引結果をまとめます。

**現在は V1 のシミュレーション段階です。** 組み込みの合成データで処理を確認できます。企業データとの接続や実取引は未実装です。論文アルゴリズムの実装は保留中で、現行の工学的ベースラインについて実データでの戦略改善や収益性は検証されていません。

## Bot テンプレート

| テンプレート | 役割 |
| --- | --- |
| 中長期取引 | 中長期契約とエクスポージャーの分析、承認済みシミュレーション |
| スポット取引 | 前日・当日・リアルタイムの各段階を一つの Bot で扱う |
| リスク | リスク、限度額、承認根拠の確認。発注や取消は不可 |
| 振り返り | 意思決定、約定結果、監査履歴の確認。発注や取消は不可 |

Bot の権限はサーバー側で確認され、名前や指示文を変えても拡張されません。人の承認権限と Bot のツール権限は別です。

## 現在の機能

- 一つの Space を一つの業務スコープとして扱い、Bot の所属とデータを管理。
- 三種類の事業者向けベースライン、固定入力、アルゴリズムの版管理と再実行。
- アルゴリズムの有効化と取引を別々に承認。取引ごとの承認、または期限・限度額付きの権限付与。
- 部分約定、送信タイムアウト、拒否、取消タイムアウト、照合、予約枠の精算と履歴。
- 毎日の学習と手動起動、許可された資料に基づくパラメーター候補、人による有効化。学習処理に取引権限は付与されません。
- 業務ごとの HTTP データ API 設定と利用可能な MCP 接続の選択。天気予測は HTTP 取得と認証付きプッシュに対応し、`pnpm weather:simulator` で社内モデルの出力インターフェースを模擬できます。[天気データ接続ガイド](./docs/integration/eTraderBot-weather-api.md)を参照してください。他の設定の保存だけでは接続やデータ取り込みは始まりません。
- Web／Electron の中国語・英語切り替え。モバイルでは結果の閲覧、承認、照合、人による取消に対応し、詳細設定は Web で行います。

## ソースから起動

V1 は `feat/etraderbot-v1` ブランチにあります。[英語版の起動手順](./README.md#run-from-source)または[中国語版](./README.zh-CN.md#本地启动)に従い、本リポジトリを clone して `.env` を設定し、PostgreSQL と `pnpm dev` を起動してください。

必要環境は `package.json` に対応する Node.js、pnpm 9、Docker と Compose、OpenSSL です。既定の画面は [http://localhost:5173/app](http://localhost:5173/app) で、ポートが使用中の場合は起動時に別の URL が表示されます。Bot との会話やモデルによる学習には、アプリ内でのモデル接続が必要です。

Electron は起動済みの Web インスタンスに **Existing instance** で接続します。上流の公開イメージやアプリストア版は、この V1 ソースの配布物ではありません。モバイルの実機検証は未完了です。互換性のため `rakazo` のパッケージ名と内部識別子は維持しています。

## 検証とドキュメント

[現段階の受け入れ記録](./docs/implementation/eTraderBot-v1-acceptance.md)には、対象を限定したデータベース、分離、単体／モバイルコンポーネント、ブラウザの計 154 テストの結果があります。全リポジトリの CI、実際のモデルによる学習効果、実取引、ネイティブ端末の確認は含みません。

- [V1 spec](./docs/specs/eTraderBot-v1-spec.md)
- [実装状況](./docs/implementation/eTraderBot-v1-progress.md)
- [承認・実行 API](./docs/implementation/eTraderBot-trading-control-api.md)
- [学習 API](./docs/implementation/eTraderBot-learning-api.md)
- [外部インターフェース](./docs/integration/eTraderBot-interface-list.md)

詳細な製品・実装文書は主に中国語です。開発時は [CONTRIBUTING.md](./CONTRIBUTING.md) と [AGENTS.md](./AGENTS.md) を参照してください。

eTraderBot は [Rakazo](https://github.com/elie222/rakazo) を基盤としており、[Apache License 2.0](./LICENSE) を継承しています。上流の運用文書に残る Rakazo の名称と、本プロジェクトの取引機能の実装状況は区別してください。
