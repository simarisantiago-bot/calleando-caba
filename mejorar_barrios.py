"""
mejorar_barrios.py — Para cada entrada tipo barrio del Excel, guarda en el
cache la GEOMETRÍA POLIGONAL del barrio (no un punto).

Resultado: cuando el usuario busca "Belgrano", "Palermo", "Vélez Sársfield",
etc., el mapa dibuja el CONTORNO ENTERO del barrio con relleno azul tenue,
en vez de un pin.

Uso:
    python mejorar_barrios.py
"""

import json
import unicodedata
from pathlib import Path

BASE = Path(__file__).parent
CALLES_JSON = BASE / "data" / "calles.json"
GEO_CACHE = BASE / "data" / "geo_cache.json"
BARRIOS = BASE / "data" / "barrios.geojson"


def _norm(s):
    if not isinstance(s, str):
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.lower().replace(".", "").replace(",", "").strip()


def calcular_bbox(geom):
    """Calcula bbox de un Polygon o MultiPolygon."""
    coords_list = []
    if geom["type"] == "Polygon":
        for ring in geom["coordinates"]:
            coords_list.extend(ring)
    elif geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            for ring in poly:
                coords_list.extend(ring)
    lons = [c[0] for c in coords_list]
    lats = [c[1] for c in coords_list]
    return [min(lats), max(lats), min(lons), max(lons)]


def main():
    with CALLES_JSON.open(encoding="utf-8") as f:
        calles = json.load(f)
    with GEO_CACHE.open(encoding="utf-8") as f:
        cache = json.load(f)
    with BARRIOS.open(encoding="utf-8") as f:
        bg = json.load(f)

    # Índice barrio normalizado -> feature
    idx_barrio = {}
    for feat in bg["features"]:
        nombre = feat["properties"]["nombre"]
        idx_barrio[_norm(nombre)] = feat
        # Variantes: con "La" delante
        idx_barrio[_norm("la " + nombre)] = feat

    # Variantes manuales conocidas (Excel <-> GeoJSON)
    alias_extra = {
        "boca": "la boca",
        "constitucion": "constitucion",
        "montserrat": "monserrat",
        "villa general mitre": "villa gral mitre",
    }
    for k, v in alias_extra.items():
        if _norm(v) in idx_barrio and _norm(k) not in idx_barrio:
            idx_barrio[_norm(k)] = idx_barrio[_norm(v)]

    asignados = 0
    sin_match = []

    for c in calles:
        if c["tipo"] != "barrio":
            continue
        key = _norm(c["nombre_busqueda"])
        feat = idx_barrio.get(key)
        if not feat:
            sin_match.append(c["nombre_busqueda"])
            continue

        geom = feat["geometry"]
        # Centro: centroide aproximado del bbox
        bbox = calcular_bbox(geom)
        lat_c = (bbox[0] + bbox[1]) / 2
        lon_c = (bbox[2] + bbox[3]) / 2

        cache[c["clave"]] = {
            "tipo": "area",
            "geometry": geom,
            "bbox": bbox,
            "center": [lat_c, lon_c],
            "source": "barrios-geojson",
            "barrio_oficial": feat["properties"]["nombre"],
        }
        asignados += 1

    # Guardar
    tmp = GEO_CACHE.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    tmp.replace(GEO_CACHE)

    print(f"Barrios asignados a su polígono: {asignados}")
    if sin_match:
        print(f"Sin match: {len(sin_match)}")
        for n in sin_match:
            print(f"  - {n}")


if __name__ == "__main__":
    main()
