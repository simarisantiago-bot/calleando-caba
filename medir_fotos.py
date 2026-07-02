"""
medir_fotos.py — Mide cuántos odónimos consiguen foto de Wikipedia,
replicando EXACTAMENTE la lógica de la app (terminosBusqueda + fetchStreetImage
con generator=search en es.wikipedia).

Salida:
  data/fotos_baseline.json  {clave: {tiene_foto, termino_ok, thumb, titulo}}
  data/fotos_report.txt     resumen por categoría + lista de los SIN foto

Uso:
    python medir_fotos.py
"""

import json
import re
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

import requests

BASE = Path(__file__).parent
CALLES = BASE / "data" / "calles.json"
OUT_JSON = BASE / "data" / "fotos_baseline.json"
OUT_TXT = BASE / "data" / "fotos_report.txt"

WIKI_API = "https://es.wikipedia.org/w/api.php"
UA = "calleando-caba/1.0 (simarisantiago@gmail.com) foto-baseline"
WORKERS = 8

# Copiado 1:1 de script.js (BUSQUEDA_OVERRIDES).
BUSQUEDA_OVERRIDES = {
    "independencia|avenida": "Congreso de Tucumán",
    "catamarca|calle": "Provincia de Catamarca",
    "chaco|calle": "Provincia del Chaco",
    "chubut|calle": "Provincia del Chubut",
    "cordoba|avenida": "Provincia de Córdoba (Argentina)",
    "corrientes|avenida": "Provincia de Corrientes",
    "entre rios|avenida": "Provincia de Entre Ríos",
    "formosa|calle": "Provincia de Formosa",
    "jujuy|calle": "Provincia de Jujuy",
    "la pampa|calle": "Provincia de La Pampa",
    "la rioja|calle": "Provincia de La Rioja (Argentina)",
    "mendoza|calle": "Provincia de Mendoza",
    "misiones|calle": "Provincia de Misiones",
    "neuquen|calle": "Provincia del Neuquén",
    "rio negro|calle": "Provincia de Río Negro",
    "salta|calle": "Provincia de Salta",
    "san juan|avenida": "Provincia de San Juan",
    "san luis|calle": "Provincia de San Luis",
    "santa cruz|calle": "Provincia de Santa Cruz",
    "santa fe|avenida": "Provincia de Santa Fe",
    "santiago del estero|calle": "Provincia de Santiago del Estero",
    "tierra del fuego|calle": "Provincia de Tierra del Fuego, Antártida e Islas del Atlántico Sur",
    "tucuman|calle": "Provincia de Tucumán",
}


def nombre_desde_descripcion(desc):
    if not desc:
        return ""
    n = desc.split("(")[0]
    if n == desc:
        n = re.split(r"[:;,]", desc)[0]
    n = re.sub(r"\s+", " ", n).strip()
    return n.strip(" :;,")


def terminos_busqueda(entrada, override):
    nombre = (entrada.get("nombre_busqueda") or entrada.get("nombre_original") or "").strip()
    cat = (entrada.get("categoria") or "").strip().upper()
    desc = nombre_desde_descripcion(entrada.get("descripcion"))
    if override:
        orden = [override, nombre]
    elif cat.startswith("PERSONA"):
        orden = [desc, nombre]
    else:
        orden = [nombre, desc]
    vistos, out = set(), []
    for t in orden:
        k = (t or "").lower()
        if k and k not in vistos:
            vistos.add(k)
            out.append(t)
    return out


_term_cache = {}
_cache_lock = Lock()
_session = requests.Session()
_session.headers.update({"User-Agent": UA})


def fetch_image(term):
    """Replica fetchStreetImage: generator=search, thumbnail, sin desambiguación."""
    key = term.strip().lower()
    if not key:
        return None
    with _cache_lock:
        if key in _term_cache:
            return _term_cache[key]
    params = {
        "action": "query", "format": "json",
        "generator": "search", "gsrsearch": term, "gsrlimit": "1", "gsrnamespace": "0",
        "prop": "pageimages|info|pageprops", "piprop": "thumbnail|name",
        "pithumbsize": "480", "ppprop": "disambiguation", "inprop": "url",
    }
    res = None
    for intento in range(3):
        try:
            r = _session.get(WIKI_API, params=params, timeout=30)
            if r.status_code == 200:
                j = r.json()
                pages = (j.get("query") or {}).get("pages") or {}
                page = next(iter(pages.values()), None)
                thumb = page and (page.get("thumbnail") or {}).get("source")
                desamb = page and "disambiguation" in (page.get("pageprops") or {})
                if thumb and not desamb:
                    res = {"thumb": thumb, "titulo": page.get("title", term)}
                break
            time.sleep(1 + intento)
        except Exception:
            time.sleep(1 + intento)
    with _cache_lock:
        _term_cache[key] = res
    return res


def resolver(entrada, override):
    for t in terminos_busqueda(entrada, override):
        data = fetch_image(t)
        if data:
            return {"tiene_foto": True, "termino_ok": t, **data}
    return {"tiene_foto": False, "termino_ok": None, "thumb": None, "titulo": None}


def main():
    calles = json.load(open(CALLES, encoding="utf-8"))
    # Un representante por clave (odónimo único). Guardamos ids para overrides.
    por_clave = {}
    for c in calles:
        por_clave.setdefault(c["clave"], {"rep": c, "ids": [], "cat": c.get("categoria", "")})
        por_clave[c["clave"]]["ids"].append(c["id"])
    claves = list(por_clave.items())
    print(f"Midiendo {len(claves)} odónimos únicos con {WORKERS} hilos...")

    inicio = time.time()
    resultados = {}
    done = [0]

    def trabajo(item):
        clave, info = item
        override = None
        for i in info["ids"]:
            if i in BUSQUEDA_OVERRIDES:
                override = BUSQUEDA_OVERRIDES[i]
                break
        r = resolver(info["rep"], override)
        r["categoria"] = info["cat"]
        r["nombre"] = info["rep"].get("nombre_busqueda")
        resultados[clave] = r
        done[0] += 1
        if done[0] % 100 == 0:
            el = time.time() - inicio
            eta = (len(claves) - done[0]) / (done[0] / el) / 60 if el else 0
            print(f"  {done[0]}/{len(claves)}  ETA {eta:.1f}m", flush=True)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(trabajo, claves))

    json.dump(resultados, open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False)

    # Reporte
    from collections import Counter
    total = len(resultados)
    con = sum(1 for r in resultados.values() if r["tiene_foto"])
    por_cat_total = Counter(r["categoria"] for r in resultados.values())
    por_cat_con = Counter(r["categoria"] for r in resultados.values() if r["tiene_foto"])

    lines = []
    lines.append(f"FOTOS — baseline (replica exacta de la app)")
    lines.append(f"Total odónimos: {total}")
    lines.append(f"Con foto: {con} ({100*con/total:.1f}%)")
    lines.append(f"Sin foto: {total-con} ({100*(total-con)/total:.1f}%)")
    lines.append("")
    lines.append("Por categoría:")
    for cat, n in por_cat_total.most_common():
        c = por_cat_con.get(cat, 0)
        lines.append(f"  {cat:22s} {c:4d}/{n:<4d} ({100*c/n:.0f}%)")
    lines.append("")
    lines.append("=== SIN FOTO (para curar) ===")
    sin = [(r["categoria"], r["nombre"]) for r in resultados.values() if not r["tiene_foto"]]
    for cat, nombre in sorted(sin):
        lines.append(f"  [{cat}] {nombre}")

    txt = "\n".join(lines)
    OUT_TXT.write_text(txt + "\n", encoding="utf-8")
    print()
    print(txt[:1200])
    print()
    print(f"Reporte: {OUT_TXT}  |  JSON: {OUT_JSON}")


if __name__ == "__main__":
    main()
