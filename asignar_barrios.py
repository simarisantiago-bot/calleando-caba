"""
asignar_barrios.py — Asigna cada entrada del cache a un barrio de CABA.

Para cada entrada en geo_cache.json:
  - Si es 'point': el centro es el punto a testear.
  - Si es 'line': calcula el centroide del bbox.
Hace point-in-polygon contra los 48 polígonos de barrios.

Salida:
  data/calle_barrios.json    { "clave": "Palermo", "otra clave": "Recoleta", ... }
"""

import json
from pathlib import Path

from shapely.geometry import shape, Point

BASE = Path(__file__).parent
GEO_CACHE = BASE / "data" / "geo_cache.json"
BARRIOS_GEOJSON = BASE / "data" / "barrios.geojson"
OUTPUT = BASE / "data" / "calle_barrios.json"


def centro_entrada(entry):
    """Devuelve (lon, lat) del centro representativo de la entrada del cache."""
    tipo = entry.get("tipo")
    if tipo == "point" and "center" in entry:
        # center está como [lat, lon]
        lat, lon = entry["center"]
        return lon, lat
    if tipo == "line" and "bbox" in entry:
        # bbox: [latMin, latMax, lonMin, lonMax]
        latMin, latMax, lonMin, lonMax = entry["bbox"]
        return (lonMin + lonMax) / 2, (latMin + latMax) / 2
    # Fallback: intentar bbox
    if "bbox" in entry and len(entry["bbox"]) == 4:
        a, b, c, d = entry["bbox"]
        return (c + d) / 2, (a + b) / 2
    return None


def main():
    with GEO_CACHE.open(encoding="utf-8") as f:
        cache = json.load(f)
    with BARRIOS_GEOJSON.open(encoding="utf-8") as f:
        barrios = json.load(f)

    # Construir lista de (nombre_barrio, geometría_shapely)
    polys = []
    for feat in barrios["features"]:
        nombre = feat["properties"]["nombre"].strip()
        poly = shape(feat["geometry"])
        polys.append((nombre, poly))
    print(f"Barrios cargados: {len(polys)}")

    asignaciones = {}
    sin_match = 0
    por_barrio = {}

    for clave, entry in cache.items():
        cen = centro_entrada(entry)
        if cen is None:
            sin_match += 1
            continue
        lon, lat = cen
        pt = Point(lon, lat)

        matched = None
        for nombre, poly in polys:
            if poly.contains(pt):
                matched = nombre
                break

        if matched is None:
            # Fallback: barrio más cercano (por si el centroide cae afuera por bbox)
            min_dist = float("inf")
            for nombre, poly in polys:
                d = poly.distance(pt)
                if d < min_dist:
                    min_dist = d
                    matched = nombre
            # Si el punto está a más de ~500m (0.005 grados ~ 555m) de cualquier barrio, descartar
            if min_dist > 0.005:
                matched = None

        if matched:
            asignaciones[clave] = matched
            por_barrio[matched] = por_barrio.get(matched, 0) + 1
        else:
            sin_match += 1

    OUTPUT.write_text(
        json.dumps(asignaciones, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"Entradas asignadas: {len(asignaciones)}")
    print(f"Sin barrio (fuera de CABA): {sin_match}")
    print()
    print("Top 10 barrios con más entradas:")
    for n, c in sorted(por_barrio.items(), key=lambda x: -x[1])[:10]:
        print(f"  {n:25s} {c}")

    print()
    print("Barrios sin entradas:")
    todos_barrios = {n for n, _ in polys}
    sin_entradas = todos_barrios - set(por_barrio.keys())
    for n in sorted(sin_entradas):
        print(f"  {n}")


if __name__ == "__main__":
    main()
