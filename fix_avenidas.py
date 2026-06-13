"""
fix_avenidas.py — Repara avenidas/autopistas con pocos ways en el cache.

Bug original: el bulk download de geocode_all.py buscó por name exacto del
Excel. Pero en OSM las avenidas grandes están bajo "Avenida X", no "X".
Resultado: matches espurios contra calles cortas que casualmente se llamaban
solo "X" (sin prefijo "Avenida").

Este script:
  1. Identifica avenidas/autopistas en el cache con ≤ THRESHOLD ways.
  2. Para cada una, prueba en OSM con prefijos: "Avenida X", "Av. X" para
     avenidas; "Autopista X", "AU X" para autopistas.
  3. Si la variante prefijada tiene MÁS ways que la cacheada, reemplaza.
  4. Reporta cuántas se arreglaron y cuántas quedan iguales.

Uso:
    python fix_avenidas.py
"""

import json
import time
import unicodedata
from pathlib import Path

import requests

BASE = Path(__file__).parent
CALLES_JSON = BASE / "data" / "calles.json"
GEO_CACHE = BASE / "data" / "geo_cache.json"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "calleando-caba/1.0 (simarisantiago@gmail.com)"
CABA_BBOX = (-34.706, -58.531, -34.527, -58.335)
DELAY = 1.1
THRESHOLD_WAYS = 6  # avenidas con ≤ esto se consideran sospechosas

PREFIJOS_AVENIDA = ["Avenida", "Av."]
PREFIJOS_AUTOPISTA = ["Autopista", "AU"]


def _norm(s):
    if not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().strip()


def query_overpass(name):
    name_safe = name.replace('\\', '\\\\').replace('"', '\\"')
    s, w, n, e = CABA_BBOX
    q = (
        '[out:json][timeout:30];'
        f'(way["highway"]["name"="{name_safe}"]({s},{w},{n},{e}););'
        'out geom;'
    )
    try:
        r = requests.post(
            OVERPASS_URL,
            data={"data": q},
            timeout=45,
            headers={"User-Agent": USER_AGENT},
        )
        if r.status_code != 200:
            return None
        return r.json()
    except (requests.RequestException, ValueError):
        return None


def data_a_linea(data):
    if not data:
        return None
    ways = [el for el in data.get("elements", [])
            if el.get("type") == "way" and el.get("geometry")]
    if not ways:
        return None
    lineas = []
    for w in ways:
        coords = [[pt["lon"], pt["lat"]] for pt in w["geometry"]]
        if len(coords) >= 2:
            lineas.append(coords)
    if not lineas:
        return None
    todos = [pt for ln in lineas for pt in ln]
    lons = [p[0] for p in todos]
    lats = [p[1] for p in todos]
    geom = ({"type": "LineString", "coordinates": lineas[0]}
            if len(lineas) == 1
            else {"type": "MultiLineString", "coordinates": lineas})
    return {
        "tipo": "line",
        "geometry": geom,
        "bbox": [min(lats), max(lats), min(lons), max(lons)],
        "source": "fix-avenidas",
        "ways": len(lineas),
    }


def main():
    with CALLES_JSON.open(encoding="utf-8") as f:
        calles = json.load(f)
    with GEO_CACHE.open(encoding="utf-8") as f:
        cache = json.load(f)

    candidatos = []
    for c in calles:
        if c["tipo"] not in {"avenida", "autopista"}:
            continue
        if c["clave"] not in cache:
            continue
        e = cache[c["clave"]]
        if e.get("source") != "overpass-bulk":
            continue
        ways = e.get("ways", 0)
        if ways <= THRESHOLD_WAYS:
            candidatos.append(c)

    print(f"Avenidas/autopistas a re-procesar: {len(candidatos)}")
    print()

    arregladas = 0
    iguales = 0
    sin_cambio = 0

    for i, c in enumerate(candidatos, 1):
        nombre_excel = c["nombre_busqueda"]
        prefijos = PREFIJOS_AUTOPISTA if c["tipo"] == "autopista" else PREFIJOS_AVENIDA
        ways_actual = cache[c["clave"]].get("ways", 0)

        # Si nombre_busqueda ya empieza con "Avenida" o similar, sacar para probar variantes
        base = nombre_excel
        for p in prefijos:
            if _norm(base).startswith(_norm(p) + " "):
                base = base[len(p):].strip()
                break

        mejor_geo = None
        mejor_nombre = None
        for prefijo in prefijos:
            candidato_name = f"{prefijo} {base}"
            data = query_overpass(candidato_name)
            time.sleep(DELAY)
            geo = data_a_linea(data)
            if geo and geo["ways"] > (mejor_geo["ways"] if mejor_geo else 0):
                mejor_geo = geo
                mejor_nombre = candidato_name

        if mejor_geo and mejor_geo["ways"] > ways_actual:
            cache[c["clave"]] = mejor_geo
            arregladas += 1
            estado = f"FIX  {ways_actual:3d} -> {mejor_geo['ways']:3d} ways  ('{mejor_nombre}')"
        elif mejor_geo:
            iguales += 1
            estado = f"     {ways_actual:3d} ways (sin mejora)"
        else:
            sin_cambio += 1
            estado = f"     {ways_actual:3d} ways (OSM sin match)"

        print(f"  [{i:3d}/{len(candidatos)}] {estado}  -- {nombre_excel}")

        # Guardar cada 10
        if i % 10 == 0:
            tmp = GEO_CACHE.with_suffix(".json.tmp")
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False)
            tmp.replace(GEO_CACHE)

    # Guardado final
    tmp = GEO_CACHE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    tmp.replace(GEO_CACHE)

    print()
    print(f"Resumen:")
    print(f"  Arregladas: {arregladas}")
    print(f"  Sin mejora (OSM tampoco encontró más): {iguales}")
    print(f"  OSM sin match: {sin_cambio}")


if __name__ == "__main__":
    main()
