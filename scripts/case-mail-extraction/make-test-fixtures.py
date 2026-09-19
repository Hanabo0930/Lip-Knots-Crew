"""実業務データを使わないPDF/Excelの取得・抽出接続試験用データ。"""
import importlib.util
import json
import sys
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from openpyxl import Workbook

destination = Path(sys.argv[1])
destination.mkdir(parents=True, exist_ok=True)
fields = ["実施日：2026/10/10", "クライアント：合成取引先", "店舗：合成店舗",
          "メーカー：合成メーカー", "メニュー：試食", "入店時間：09:30",
          "実施時間：10:00～18:00", "人数：1名"]
pdfmetrics.registerFont(UnicodeCIDFont("HeiseiMin-W3"))
document = canvas.Canvas(str(destination / "request.pdf"))
for page in [1, 2]:
    document.setFont("HeiseiMin-W3", 12)
    for number, line in enumerate(fields):
        document.drawString(40, 790 - number * 25, line)
    document.showPage()
document.save()
headers = ["ライン番号", "案件番号", "発注番号", "発注日", "発注額", "エリア", "都道府県", "店舗番号", "店舗名", "展開外",
           "デモ日", "メーカー名", "商品名", "デモ実施場所", "勤務開始時間", "勤務終了時間", "調理有無", "電気備品", "試食有無", "写真必須",
           "必須研修", "性別", "セールス備考", "●協力会社名", "実働時間", "基本料金", "交通費", "遠隔地", "繁忙日加算", "検便検査費",
           "通信費", "書類発送費", "他請求科目1", "他請求費用1", "他請求科目2", "他請求費用2", "他請求科目3", "他請求費用3",
           "●手配可否", "常時使用する従業員100人以下(個人を含む)", "自社スタッフor協力会社", "案件受領確認者名", "受領確認日", "依頼変更", "備考"]
values = {"ライン番号": "1", "案件番号": "synthetic-order", "店舗名": "合成店舗", "デモ日": "2026/10/10",
          "メーカー名": "合成メーカー", "商品名": "試食", "勤務開始時間": "10:00", "勤務終了時間": "18:00"}
book = Workbook()
sheet = book.active
sheet.title = "依頼表"
sheet.append(headers)
sheet.append([values.get(header, "") for header in headers])
book.save(destination / "request.xlsx")
book.close()
for kind in ["pdf", "xlsx"]:
    filename = Path(__file__).with_name("extract-request-" + kind + ".py")
    spec = importlib.util.spec_from_file_location("extract_" + kind, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = getattr(module, "extract_" + kind)(destination / ("request." + kind))
    (destination / (kind + "-extraction.json")).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
print("合成PDF・Excelを既存抽出器で処理しました。")
