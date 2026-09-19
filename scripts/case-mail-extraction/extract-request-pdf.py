"""依頼PDFをローカルで全文抽出。欠落ページを成功扱いにせず、元の位置とハッシュを残す。"""
import argparse
import hashlib
import json
from pathlib import Path
import pdfplumber


def extract_pdf(filename):
    path = Path(filename)
    if path.stat().st_size > 25 * 1024 * 1024:
        raise ValueError("PDFが25MBを超えています")
    raw = path.read_bytes()
    if not raw.startswith(b"%PDF-"):
        raise ValueError("ファイルの実体がPDFではありません")
    with pdfplumber.open(path) as pdf:
        if not 1 <= len(pdf.pages) <= 100:
            raise ValueError("PDFのページ数が対象範囲外です")
        pages = []
        for number, page in enumerate(pdf.pages, 1):
            words = page.extract_words(x_tolerance=2, y_tolerance=3)
            text = page.extract_text(x_tolerance=2, y_tolerance=3) or ""
            pages.append({"number": number, "width": page.width, "height": page.height,
                          "text": text, "words": [{k: w[k] for k in ["text", "x0", "x1", "top", "bottom"]} for w in words]})
    return {"version": 1, "format": "pdf", "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw), "pageCount": len(pages), "complete": all(p["text"].strip() for p in pages),
            "issues": [f'{p["number"]}ページの文字を取得できません。画像/OCR確認が必要です' for p in pages if not p["text"].strip()], "pages": pages}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("output")
    args = parser.parse_args()
    result = extract_pdf(args.input)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"pages": result["pageCount"], "complete": result["complete"], "issues": result["issues"]}, ensure_ascii=False))
