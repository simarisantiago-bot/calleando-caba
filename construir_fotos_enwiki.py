"""
construir_fotos_enwiki.py — Integra las fotos recuperadas por en.wikipedia
(fotos_enwiki.json) al data/fotos.json existente.

- Solo se quedan las imágenes alojadas en Wikimedia Commons (licencia libre).
  Las que son fair-use local de en.wikipedia (/wikipedia/en/...) se DESCARTAN.
- Recupera atribución (Artist + LicenseShortName) de Commons en lotes.
"""

import json
import re
import time
import urllib.parse
from pathlib import Path

import requests

BASE = Path(__file__).parent
IN = BASE / "data" / "fotos_enwiki.json"
FOTOS = BASE / "data" / "fotos.json"

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
UA = "calleando-caba/1.0 (simarisantiago@gmail.com) fotos-enwiki-merge"
session = requests.Session()
session.headers.update({"User-Agent": UA})


def parse_commons(url):
    """Devuelve el filename si la imagen está en Commons, si no None."""
    if "/wikipedia/commons/" not in url:
        return None
    parts = url.split("/")
    if "thumb" in parts:
        i = parts.index("thumb")
        fn = parts[i + 3]              # thumb/a/ab/<Filename>/<size>px-...
    else:
        # .../commons/a/ab/<Filename>
        fn = parts[-1]
    return urllib.parse.unquote(fn).replace("_", " ")


def strip_html(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def atribucion_lote(filenames):
    titles = "|".join(f"File:{f}" for f in filenames)
    params = {"action": "query", "format": "json", "titles": titles,
              "prop": "imageinfo", "iiprop": "extmetadata",
              "iiextmetadatafilter": "Artist|LicenseShortName"}
    for intento in range(3):
        try:
            r = session.get(COMMONS_API, params=params, timeout=40)
            if r.status_code == 200:
                break
            time.sleep(1 + intento)
        except Exception:
            time.sleep(1 + intento)
    else:
        return {}
    pages = (r.json().get("query") or {}).get("pages") or {}
    out = {}
    for p in pages.values():
        title = p.get("title", "").replace("File:", "")
        ii = (p.get("imageinfo") or [{}])[0].get("extmetadata") or {}
        out[title] = {"autor": strip_html((ii.get("Artist") or {}).get("value", "")),
                      "licencia": strip_html((ii.get("LicenseShortName") or {}).get("value", ""))}
    return out


def main():
    en = json.load(open(IN, encoding="utf-8"))
    fotos = json.load(open(FOTOS, encoding="utf-8"))

    commons_items = []   # (clave, filename, url, pageUrl, titulo)
    descartadas = 0
    for clave, r in en.items():
        if clave in fotos:       # ya tiene foto (no debería, pero por las dudas)
            continue
        fn = parse_commons(r["url"])
        if not fn:
            descartadas += 1     # fair-use local de en.wiki -> no la usamos
            continue
        commons_items.append((clave, fn, r["url"], r.get("pageUrl", ""), r.get("titulo", "")))

    fnames = list({fn for _, fn, _, _, _ in commons_items})
    attr = {}
    for i in range(0, len(fnames), 50):
        attr.update(atribucion_lote(fnames[i:i + 50]))
        time.sleep(0.4)
        print(f"  atribucion {min(i+50, len(fnames))}/{len(fnames)}", flush=True)

    agregadas = 0
    for clave, fn, url, page, titulo in commons_items:
        a = attr.get(fn, {})
        fotos[clave] = {
            "thumbUrl": url,
            "pageUrl": page or f"https://commons.wikimedia.org/wiki/File:{urllib.parse.quote(fn.replace(' ', '_'))}",
            "autor": a.get("autor", ""),
            "licencia": a.get("licencia", ""),
            "titulo": titulo,
        }
        agregadas += 1

    json.dump(fotos, open(FOTOS, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(f"\nAgregadas (Commons): {agregadas}")
    print(f"Descartadas (fair-use en.wiki, no libres): {descartadas}")
    print(f"Total en fotos.json ahora: {len(fotos)}")


if __name__ == "__main__":
    main()
