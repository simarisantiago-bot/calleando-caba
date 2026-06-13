"""
geocode_nuevas.py — Geocodifica las entradas de calles.json que aún no
tienen geometría en geo_cache.json (las 177 homónimas recuperadas).

Estrategia por tipo:
  - calle/avenida/pasaje/autopista → Overpass con name + clip CABA
  - plaza/plazoleta/parque/jardín  → Overpass áreas (way con leisure/place)
  - barrio                         → barrios.geojson
  - resto                          → Nominatim como fallback (point)

Uso:
    python geocode_nuevas.py
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

OVERPASS = "https://overpass-api.de/api/interpreter"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "calleando-caba/1.0 (simarisantiago@gmail.com)"
CABA_BBOX = (-34.706, -58.531, -34.527, -58.335)
VIEWBOX = "-58.531,-34.706,-58.335,-34.527"
DELAY = 1.1

TIPOS_LINEA = {
    "calle", "avenida", "pasaje peatonal", "pasaje", "autopista",
    "sendero", "paseo", "puente", "túnel", "tunel",
    "sendero peatonal", "puente peatonal",
}
TIPOS_AREA = {
    "plaza", "plazoleta", "parque", "jardín", "jardin", "jardín botánico",
    "espacio verde", "espacio público", "espacio publico",
    "cantero central", "canteros centrales", "cantero",
    "patio de recreación", "patio",
}


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


def overpass(query):
    try:
        r = requests.post(
            OVERPASS, data={"data": query},
            timeout=45, headers={"User-Agent": USER_AGENT}
        )
        if r.status_code != 200:
            return None
        return r.json()
    except Exception:
        return None


def buscar_linea(nombre, caba):
    """Intenta encontrar geometría tipo línea. Devuelve dict o None."""
    prefijos = ["", "Avenida ", "Pasaje "]
    mejor = None
    for prefijo in prefijos:
        cand = f"{prefijo}{nombre}".strip()
        cand_safe = cand.replace('"', '\\"')
        s, w, n, e = CABA_BBOX
        q = (
            '[out:json][timeout:30];'
            f'(way["highway"]["name"="{cand_safe}"]({s},{w},{n},{e}););'
            'out geom;'
        )
        data = overpass(q)
        time.sleep(DELAY)
        if not data:
            continue
        ways = [el for el in data.get("elements", [])
                if el.get("type") == "way" and el.get("geometry")]
        lineas = []
        for way in ways:
            coords = [(pt["lon"], pt["lat"]) for pt in way["geometry"]]
            if len(coords) < 2:
                continue
            line = LineString(coords)
            clipped = line.intersection(caba)
            if clipped.is_empty:
                continue
            if isinstance(clipped, LineString):
                if len(clipped.coords) >= 2:
                    lineas.append(list(map(list, clipped.coords)))
            elif isinstance(clipped, MultiLineString):
                for ln in clipped.geoms:
                    if len(ln.coords) >= 2:
                        lineas.append(list(map(list, ln.coords)))
        if lineas and (not mejor or len(lineas) > mejor[1]):
            todos = [pt for ln in lineas for pt in ln]
            lons = [p[0] for p in todos]
            lats = [p[1] for p in todos]
            geom = ({"type": "MultiLineString", "coordinates": lineas}
                    if len(lineas) > 1 else {"type": "LineString", "coordinates": lineas[0]})
            mejor = ({
                "tipo": "line",
                "geometry": geom,
                "bbox": [min(lats), max(lats), min(lons), max(lons)],
                "source": "geocode-nuevas",
                "ways": len(lineas),
            }, len(lineas))
    return mejor[0] if mejor else None


def buscar_area(nombre):
    """Para plazas/parques: Overpass de áreas con name. Devuelve dict o None."""
    nombre_safe = nombre.replace('"', '\\"')
    s, w, n, e = CABA_BBOX
    q = (
        '[out:json][timeout:30];'
        '('
        f'  way["leisure"]["name"="{nombre_safe}"]({s},{w},{n},{e});'
        f'  way["place"="square"]["name"="{nombre_safe}"]({s},{w},{n},{e});'
        f'  node["place"="square"]["name"="{nombre_safe}"]({s},{w},{n},{e});'
        f'  way["landuse"~"recreation_ground|grass"]["name"="{nombre_safe}"]({s},{w},{n},{e});'
        ');'
        'out center geom;'
    )
    data = overpass(q)
    if not data:
        return None
    for el in data.get("elements", []):
        et = el.get("type")
        if et == "way" and el.get("geometry"):
            coords = [[pt["lon"], pt["lat"]] for pt in el["geometry"]]
            if len(coords) >= 3:
                if coords[0] != coords[-1]:
                    coords.append(coords[0])
                lats = [p[1] for p in coords]
                lons = [p[0] for p in coords]
                return {
                    "tipo": "point",
                    "center": [sum(lats)/len(lats), sum(lons)/len(lons)],
                    "geometry": {"type": "Polygon", "coordinates": [coords]},
                    "bbox": [min(lats), max(lats), min(lons), max(lons)],
                    "source": "geocode-nuevas",
                }
        if et == "node":
            return {
                "tipo": "point",
                "center": [el["lat"], el["lon"]],
                "bbox": [el["lat"]-0.001, el["lat"]+0.001, el["lon"]-0.001, el["lon"]+0.001],
                "source": "geocode-nuevas",
            }
    return None


def buscar_nominatim(nombre):
    """Fallback: Nominatim devuelve point."""
    params = {
        "q": f"{nombre}, Ciudad Autónoma de Buenos Aires, Argentina",
        "format": "json", "limit": "3",
        "viewbox": VIEWBOX, "bounded": "1", "countrycodes": "ar",
    }
    try:
        r = requests.get(NOMINATIM, params=params, timeout=30,
                         headers={"User-Agent": USER_AGENT, "Accept-Language": "es"})
        if r.status_code != 200:
            return None
        data = r.json()
    except Exception:
        return None
    if not data:
        return None
    best = data[0]
    return {
        "tipo": "point",
        "center": [float(best["lat"]), float(best["lon"])],
        "bbox": [float(x) for x in best["boundingbox"]],
        "source": "geocode-nuevas-nominatim",
    }


def main():
    caba = cargar_caba()

    with CALLES_JSON.open(encoding="utf-8") as f:
        calles = json.load(f)
    with GEO_CACHE.open(encoding="utf-8") as f:
        cache = json.load(f)

    pendientes = [c for c in calles if c["id"] not in cache]
    print(f"Entradas pendientes de geocoding: {len(pendientes)}")

    arregladas = 0
    fallos = []
    inicio = time.time()

    for i, c in enumerate(pendientes, 1):
        nombre = c["nombre_busqueda"]
        tipo = c["tipo"]
        geo = None

        if tipo in TIPOS_LINEA:
            geo = buscar_linea(nombre, caba)
            if not geo:
                geo = buscar_nominatim(nombre)
                time.sleep(DELAY)
        elif tipo in TIPOS_AREA:
            geo = buscar_area(nombre)
            time.sleep(DELAY)
            if not geo:
                geo = buscar_nominatim(nombre)
                time.sleep(DELAY)
        else:
            geo = buscar_nominatim(nombre)
            time.sleep(DELAY)

        if geo:
            cache[c["id"]] = geo
            arregladas += 1
            estado = f"OK {geo['source'][:20]}"
        else:
            fallos.append(c)
            estado = "FAIL"

        if i % 10 == 0 or i <= 3:
            elapsed = time.time() - inicio
            rate = i / elapsed if elapsed > 0 else 0
            eta_min = (len(pendientes) - i) / rate / 60 if rate > 0 else 0
            print(f"  [{i:3d}/{len(pendientes)}] {estado:25s} {nombre[:40]:40s} ETA {eta_min:.1f}m")

        if i % 20 == 0:
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
    print(f"Fallos: {len(fallos)}")
    print(f"Cache total: {len(cache)}")


if __name__ == "__main__":
    main()
