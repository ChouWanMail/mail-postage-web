# mail-postage-web

中国邮政资费查询网页。资费数据与前端位于同一个仓库，页面运行时直接读取 `postage/` 下的结构化 JSON，因此不需要在浏览器中访问另一个 private 仓库。

## 查询结构

- **国内**
  - **其他**：信函、明信片、印刷品、邮简、义务兵免费信函、盲人读物
  - **包裹**：邮政普通包裹、家乡包裹贴
- **国际**
  - **国际**：根据 `services.json` 自动列出 AIR / SAL / SURFACE 已有寄递业务，并按目的地解析 zone
  - **港澳台**：香港、澳门、台湾基本寄递资费

## 已支持计算

- 国内本埠 / 外埠函件计费
- 国内阶梯重量与固定价计费
- 邮政普通包裹省际路向 + 三个总重量档
- 普通包裹单一优惠凭证（不允许叠加）
- 家乡包裹贴 `≤1kg / ≤3kg / ≤5kg / ≤10kg` 阶梯
- 国际 AIR / SAL / SURFACE 的信函、明信片、印刷品、小包、印刷品专袋等现有业务
- 港澳台基本资费
- 国内、国际、港澳台特别业务附加资费
- 保价金额类特别业务
- special-rates notice；例如寄往台湾的附回执函件不可用

普通包裹优惠只适用于 `DOMESTIC_ORDINARY_PARCEL`，不适用于 `DOMESTIC_HOMETOWN_PARCEL_STICKER`。优惠一次只能选择一个。

需要额外业务条件才能判断的收费（例如部分海关验关费用）会在页面展示说明，但不会在条件未知时自动加入金额。

## 数据入口

网页主要从以下入口读取：

```text
postage/index.json
postage/services.json
postage/domestic/provinces.json
postage/rates/
postage/zones/
postage/special-rates/
postage/spec/
```

当前数据规范版本为 `1.3.0`。

## GitHub Pages

仓库已经包含：

```text
.github/workflows/pages.yml
.nojekyll
```

在 GitHub 仓库 **Settings → Pages** 中，将 **Source** 设置为 **GitHub Actions**。之后推送到 `main` 会由 workflow 发布当前仓库根目录。

> 本项目及数据不是中国邮政官方发布渠道，仅供查询参考；实际收费、可寄达性和收寄条件以中国邮政营业网点及最新规定为准。
