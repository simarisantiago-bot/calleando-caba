# Calleando CABA

App web estática que muestra un mapa interactivo de calles, plazas y avenidas
de la Ciudad de Buenos Aires con su historia y descripción.

## Arquitectura

- **Frontend estático**: `index.html` + `styles.css` + `script.js`. Sin build step.
- **Mapa**: Leaflet 1.9.4 vía CDN, tiles de CartoDB Positron (estilo claro).
- **Datos**: `data/calles.json` (generado desde `calleando.xlsx` con `build_data.py`).
- **Geocoding**: Nominatim de OpenStreetMap en vivo, con cache en `localStorage`.

## Flujo de datos

```
calleando.xlsx  ──build_data.py──>  data/calles.json
                                          │
                                          ▼
                                     script.js  ──fetch──>  Nominatim (geometría)
                                          │                      │
                                          └── Cache localStorage ┘
```

## Workflows

### Actualizar los datos del Excel
```powershell
# Editar calleando.xlsx
python build_data.py
git add data/calles.json calleando.xlsx
git commit -m "actualizar datos"
git push
```

### Desarrollo local
```powershell
python -m http.server 8080
# Abrir http://localhost:8080
```

### Deploy
Push a `main` redeploya automáticamente en Vercel.

### Verificar integridad de los datos
Chequea ids duplicados en `calles.json` y entradas huérfanas en `geo_cache.json`/
`fotos.json` (restos de renombres o eliminaciones). No modifica nada, solo informa.
Conviene correrlo después de una tanda grande de ediciones manuales.
```powershell
python verificar_integridad.py
```

### Verificar que las geometrías caigan dentro de CABA
Valida cada coordenada de `geo_cache.json` contra el polígono administrativo real
de la Ciudad (`data/limite_caba.json`, bajado de OSM). Existe porque hay calles
homónimas en el Conurbano —cinco "Emilio Castro" distintas en el AMBA— y un bbox
suelto no las distingue: la del partido equivocado cae en el mismo rectángulo.
Correrlo junto con `verificar_integridad.py` antes de pushear.
```powershell
python verificar_caba.py
```
Para regenerar el límite desde OpenStreetMap (rara vez hace falta):
```powershell
python verificar_caba.py --actualizar-limite
```

## Convenciones

- Las 27 hojas del Excel se organizan por letra inicial (A-Z + Ñ).
- Columnas esperadas: `NOMBRE`, `CATEGORÍA`, `TIPO DE ODÓNIMO`, `DESCRIPCIÓN`.
- Los nombres en formato `"APELLIDO, NOMBRE"` se normalizan a `"Nombre Apellido"`
  antes de geocodificar (Nominatim no entiende el formato apellido,nombre).
- Tipos clasificados como línea (polyline azul): `calle, avenida, pasaje peatonal,
  autopista, sendero, paseo, puente, túnel, sendero peatonal, puente peatonal`.
- El resto (plaza, plazoleta, parque, jardín, barrio, cantero, espacio verde…)
  se dibuja como marcador (pin).

## Limitaciones conocidas

- Nominatim tiene rate limit (~1 req/seg). Si el sitio tiene mucho tráfico
  conviene migrar a pre-geocoding (Fase 2: ver README).
- Algunos nombres del Excel no existen en OpenStreetMap o están con otro nombre.
  La tasa de aciertos esperada ronda 50-70%.
- El cache de geocoding está por navegador; cada visitante reconstruye el suyo.
