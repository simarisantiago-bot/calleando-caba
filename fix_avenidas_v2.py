"""
fix_avenidas_v2.py — Re-busca TODAS las avenidas/autopistas en OSM con
prefijo correcto ("Avenida X", "Autopista X") y recorta al polígono CABA.

A diferencia de fix_avenidas.py, este script:
  - Procesa TODAS las avenidas/autopistas (no solo las que tienen ≤6 ways)
  - Excepto las que ya fueron resueltas por fix_avenidas (source=fix-avenidas)
  - Aplica recorte al polígono CABA antes de guardar (evita Avellaneda y otros)

Uso:
    python fix_avenidas_v2.py
"""

import json
import time
import unicodedata
from pathlib import Path

import requests
from shapely.geometry import shape, LineString, MultiLineString
from shapely.ops import unary_union

BASE = Path(__file__).parent
CALLES_JSON = BASE / "data" / "calles.json"
GEO_CACHE = BASE / "data" / "geo_cache.json"
BARRIOS = BASE / "data" / "barrios.geojson"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
USER_AGENT = "calleando-caba/1.0 (simarisantiago@gmail.com)"
CABA_BBOX = (-34.706, -58.531, -34.527, -58.335)
DELAY = 1.1


def _norm(s):
    if not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().strip()


def cargar_caba():
    with BARRIOS.open(encoding="utf-8") as f:
        data = json.load(f)
    return unary_union([shape(f["geometry"]) for f in data["features"]]).buffer(0)


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


def ways_a_lineas_recortadas(data, caba):
    """Convierte ways de Overpass a list[coords], recortando al polígono CABA."""
    if not data:
        return []
    ways = [el for el in data.get("elements", [])
            if el.get("type") == "way" and el.get("geometry")]
    lineas = []
    for w in ways:
        coords = [(pt["lon"], pt["lat"]) for pt in w["geometry"]]
        if len(coords) < 2:
            continue
        line = LineString(coords)
        clipped = line.intersection(caba)
        for sub in _a_lineas(clipped):
            lineas.append(sub)
    return lineas


def _a_lineas(geom):
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        if len(geom.coords) < 2:
            return []
        return [list(map(list, geom.coords))]
    if isinstance(geom, MultiLineString):
        return [list(map(list, line.coords)) for line in geom.geoms
                if len(line.coords) >= 2]
    if hasattr(geom, "geoms"):
        out = []
        for g in geom.geoms:
            out.extend(_a_lineas(g))
        return out
    return []


def construir_entry(lineas):
    if not lineas:
        return None
    todos = [pt for ln in lineas for pt in ln]
    lons = [p[0] for p in todos]
    lats = [p[1] for p in todos]
    if len(lineas) == 1:
        geom = {"type": "LineString", "coordinates": lineas[0]}
    else:
        geom = {"type": "MultiLineString", "coordinates": lineas}
    return {
        "tipo": "line",
        "geometry": geom,
        "bbox": [min(lats), max(lats), min(lons), max(lons)],
        "source": "fix-avenidas-v2",
        "ways": len(lineas),
    }


def main():
    caba = cargar_caba()

    with CALLES_JSON.open(encoding="utf-8") as f:
        calles = json.load(f)
    with GEO_CACHE.open(encoding="utf-8") as f:
        cache = json.load(f)

    candidatos = []
    for c in calles:
        if c["tipo"] not in {"avenida", "autopista"}:
            continue
        entry = cache.get(c["clave"])
        # Saltar si ya está arreglada por fix-avenidas
        if entry and entry.get("source") in {"fix-avenidas", "fix-avenidas-v2"}:
            continue
        candidatos.append(c)

    print(f"Avenidas/autopistas a re-buscar: {len(candidatos)}")
    print()

    arregladas = 0
    sin_cambio = 0

    for i, c in enumerate(candidatos, 1):
        nombre_excel = c["nombre_busqueda"]
        prefijo = "Autopista" if c["tipo"] == "autopista" else "Avenida"

        # Sacar prefijo si ya viene en el nombre
        base = nombre_excel
        if _norm(base).startswith(_norm(prefijo) + " "):
            base = base[len(prefijo):].strip()

        candidato_name = f"{prefijo} {base}"
        data = query_overpass(candidato_name)
        time.sleep(DELAY)
        lineas = ways_a_lineas_recortadas(data, caba)
        nueva = construir_entry(lineas)

        ways_actual = (cache.get(c["clave"]) or {}).get("ways", 0)
        ways_nueva = nueva["ways"] if nueva else 0

        if nueva and ways_nueva > ways_actual:
            cache[c["clave"]] = nueva
            arregladas += 1
            estado = f"FIX  {ways_actual:3d} -> {ways_nueva:3d} ways"
        else:
            sin_cambio += 1
            estado = f"     {ways_actual:3d} ways (OSM: {ways_nueva})"

        print(f"  [{i:3d}/{len(candidatos)}] {estado}  -- {nombre_excel}")

        if i % 10 == 0:
            tmp = GEO_CACHE.with_suffix(".json.tmp")
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False)
            tmp.replace(GEO_CACHE)

    tmp = GEO_CACHE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    tmp.replace(GEO_CACHE)

    print()
    print(f"Arregladas: {arregladas}")
    print(f"Sin cambio: {sin_cambio}")
    print(f"Cache total: {len(cache)}")


if __name__ == "__main__":
    main()
