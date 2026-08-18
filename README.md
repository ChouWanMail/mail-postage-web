# mail-postage-web

中国邮政资费查询网页。数据与前端位于同一仓库，网页运行时直接读取 `postage/` 下的结构化 JSON。

## 页面结构

- 国内
  - 其他：信函、明信片、印刷品、邮简、义务兵免费信函、盲人读物
  - 包裹：邮政普通包裹、家乡包裹贴
- 国际 / 港澳台
  - 国际：按 `services.json` 列出 AIR / SAL / SURFACE 现有业务
  - 港澳台：香港、澳门、台湾基本寄递资费

普通包裹支持起寄省/寄达省、重量档与单一优惠凭证计算；家乡包裹贴不使用普通包裹优惠。

## GitHub Pages

仓库包含 `.github/workflows/pages.yml`。在 Settings → Pages 中将 Source 设置为 **GitHub Actions** 后即可部署。

> 本项目数据仅供查询参考，实际收费与收寄条件以中国邮政最新规定为准。
