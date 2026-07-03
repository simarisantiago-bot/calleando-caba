"""
construir_fotos_json.py — Arma data/fotos.json (overrides de foto precomputados)
a partir de data/fotos_wikidata.json (las 427 recuperadas por Wikidata).

Para cada una, recupera el nombre del archivo de Commons desde la URL y pide
en LOTES (50 por request) la atribución (Artist + LicenseShortName) a Commons.

Salida: data/fotos.json  {clave: {thumbUrl, pageUrl, autor, licencia, titulo}}
"""

import json
import re
import time
import urllib.parse
from pathlib import Path

import requests

BASE = Path(__file__).parent
IN = BASE / "data" / "fotos_wikidata.json"
OUT = BASE / "data" / "fotos.json"

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
UA = "calleando-caba/1.0 (simarisantiago@gmail.com) fotos-json"
session = requests.Session()
session.headers.update({"User-Agent": UA})


def filename_desde_url(url):
    # url = https://commons.wikimedia.org/wiki/Special:FilePath/<quote(File_Name)>?width=480
    m = re.search(r"Special:FilePath/([^?]+)", url)
    if not m:
        return None
    return urllib.parse.unquote(m.group(1)).replace("_", " ")


def strip_html(s):
    s = re.sub(r"<[^>]+>", "", s or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def atribucion_lote(filenames):
    """Devuelve {filename: {autor, licencia}} para hasta 50 archivos."""
    titles = "|".join(f"File:{f}" for f in filenames)
    params = {
        "action": "query", "format": "json",
        "titles": titles, "prop": "imageinfo",
        "iiprop": "extmetadata", "iiextmetadatafilter": "Artist|LicenseShortName",
    }
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
    j = r.json()
    pages = (j.get("query") or {}).get("pages") or {}
    # Commons normaliza los títulos; mapeamos por título devuelto -> filename.
    out = {}
    for p in pages.values():
        title = p.get("title", "").replace("File:", "")
        ii = (p.get("imageinfo") or [{}])[0].get("extmetadata") or {}
        autor = strip_html((ii.get("Artist") or {}).get("value", ""))
        lic = strip_html((ii.get("LicenseShortName") or {}).get("value", ""))
        out[title] = {"autor": autor, "licencia": lic}
    return out


def main():
    recuperadas = json.load(open(IN, encoding="utf-8"))
    # clave -> (filename, url, titulo)
    items = []
    for clave, r in recuperadas.items():
        fn = filename_desde_url(r["url"])
        if fn:
            items.append((clave, fn, r["url"], r.get("titulo")))
    print(f"{len(items)} fotos; pidiendo atribucion en lotes de 50...")

    # Mapa filename -> atribución (dedup de archivos repetidos)
    fnames = list({fn for _, fn, _, _ in items})
    attr = {}
    for i in range(0, len(fnames), 50):
        lote = fnames[i:i + 50]
        attr.update(atribucion_lote(lote))
        time.sleep(0.5)
        print(f"  {min(i+50, len(fnames))}/{len(fnames)}", flush=True)

    fotos = {}
    for clave, fn, url, titulo in items:
        a = attr.get(fn, {})
        page = f"https://commons.wikimedia.org/wiki/File:{urllib.parse.quote(fn.replace(' ', '_'))}"
        fotos[clave] = {
            "thumbUrl": url,
            "pageUrl": page,
            "autor": a.get("autor", ""),
            "licencia": a.get("licencia", ""),
            "titulo": titulo or "",
        }

    json.dump(fotos, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    con_attr = sum(1 for v in fotos.values() if v["autor"] or v["licencia"])
    print(f"\nEscritas {len(fotos)} en {OUT}")
    print(f"Con atribución (autor/licencia): {con_attr}")


if __name__ == "__main__":
    main()
