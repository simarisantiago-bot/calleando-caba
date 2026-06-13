"""
generar_comunas.py — Crea data/comunas.geojson uniendo barrios por comuna.

CABA está dividida en 15 comunas. Cada barrio en barrios.geojson tiene la
propiedad `comuna` (número 1-15). Este script agrupa los barrios por
ese número y hace UNIÓN de sus polígonos, generando 15 features.

Uso:
    python generar_comunas.py
"""

import json
from collections import defaultdict
from pathlib import Path

from shapely.geometry import shape, mapping
from shapely.ops import unary_union

BASE = Path(__file__).parent
BARRIOS_PATH = BASE / "data" / "barrios.geojson"
OUTPUT_PATH = BASE / "data" / "comunas.geojson"


def main():
    with BARRIOS_PATH.open(encoding="utf-8") as f:
        barrios = json.load(f)

    grupos = defaultdict(list)
    barrios_por_comuna = defaultdict(list)
    for feat in barrios["features"]:
        comuna = feat["properties"]["comuna"]
        grupos[comuna].append(shape(feat["geometry"]))
        barrios_por_comuna[comuna].append(feat["properties"]["nombre"])

    features = []
    for comuna in sorted(grupos.keys()):
        union = unary_union(grupos[comuna])
        # Limpia bordes internos: aplicamos un buffer 0 que normaliza geometría
        if not union.is_valid:
            union = union.buffer(0)
        features.append({
            "type": "Feature",
            "properties": {
                "comuna": int(comuna),
                "nombre": f"Comuna {comuna}",
                "barrios": sorted(barrios_por_comuna[comuna]),
            },
            "geometry": mapping(union),
        })

    out = {"type": "FeatureCollection", "features": features}
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)

    print(f"Generado: {OUTPUT_PATH}")
    print(f"Total comunas: {len(features)}")
    for f in features:
        nombre = f["properties"]["nombre"]
        n_barrios = len(f["properties"]["barrios"])
        print(f"  {nombre}: {n_barrios} barrios -> {', '.join(f['properties']['barrios'])}")


if __name__ == "__main__":
    main()
