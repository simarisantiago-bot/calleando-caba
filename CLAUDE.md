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

### Revisar las fotos sin verificar

Las entradas que no están en `data/fotos.json` resuelven su foto buscando en
Wikipedia en vivo, y nadie verificó que esa foto sea la correcta. El flujo para
revisarlas, de punta a punta:

```powershell
python medir_fotos.py       # qué foto resuelve hoy cada odónimo (~20 min)
python auditar_fotos.py     # marca las sospechosas (instantáneo con caché)
python -m http.server 8080  # abrir http://localhost:8080/revisar_fotos.html
# revisar, y exportar revision_fotos.json desde la página
python aplicar_revision.py revision_fotos.json            # informe
python aplicar_revision.py revision_fotos.json --aplicar  # escribe
```

`medir_fotos.py` replica exactamente la lógica de búsqueda de `script.js`, así
que su salida es lo que la app muestra de verdad. **Ojo con la concurrencia**:
la cuota de Wikimedia es por IP y la comparten es.wikipedia y Wikidata, así que
no conviene subir `WORKERS` ni correr dos de estos scripts a la vez. Están
hechos para distinguir "no hay imagen" de "no pude preguntar" y abortar antes
que escribir datos a medias.

`auditar_fotos.py` chequea coherencia entre la entrada y el artículo del que
sale la foto: que una PERSONA sea una persona (`P31 = Q5`), que sea *esa*
persona (nombre esperado contra título del artículo) y que una entrada de LUGAR
dé un lugar y una que no lo es, no. Cachea Wikidata en
`data/_wikidata_cache.json` (ignorado por git, regenerable).

`revisar_fotos.html` es una hoja de contactos: todo arranca pendiente, se
marcan solo las que están mal y al confirmar un bloque de 24 las pendientes
pasan a correctas. Las marcas se guardan en `localStorage`.

Confirmar una foto como correcta la **congela** en `fotos.json` con su
atribución de Commons. Vale la pena aunque ya se vea bien: la búsqueda en vivo
no es determinista —dos corridas del mismo día dan artículos distintos para un
puñado de entradas— y además cada visitante la repite contra Wikipedia.

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

### Fotos (`data/fotos.json`)

Archivo **curado a mano**: ~930 fotos elegidas una por una + ~470 marcas
`sinFoto`, sobre un padrón de 3139 entradas. No lo genera ningún script de
forma completa. Los conteos exactos los imprime `verificar_integridad.py`.

- Clave: la `clave` de la entrada, o `clave|tipo` cuando dos odónimos con el
  mismo nombre necesitan fotos distintas (`el pampero|calle` = el viento,
  `el pampero|cantero` = el globo aerostático). `script.js` busca primero por
  id completo y después por clave.
- `{"sinFoto": true}` significa "esta entrada no tiene retrato adecuado y la
  búsqueda en vivo traía una imagen equivocada": se muestra el isotipo de
  marca. Borrarlas no es neutro: hace reaparecer fotos de personas que no
  son (el detector `detectar_fotos_no_persona.py` encontró 305 casos así).
- Las entradas que no están en el archivo (~1665) caen en la búsqueda en vivo
  de Wikipedia, con los overrides de `BUSQUEDA_OVERRIDES` en `script.js`.

**Nunca reescribir el archivo entero.** Para agregar o corregir una foto hay
que cargar el JSON, tocar la clave y volver a escribirlo completo — nunca
armar un diccionario nuevo desde cero. En septiembre de 2026 se perdieron
1399 entradas justamente así, al regenerarlo para agregar una sola foto; como
el JSON estaba minificado en una línea, el diff mostró `1 insertion(+),
1 deletion(-)` y nadie lo vio. Por eso ahora va pretty-printed con una clave
por línea: un borrado masivo salta a la vista en el diff.

## Limitaciones conocidas

- Nominatim tiene rate limit (~1 req/seg). Si el sitio tiene mucho tráfico
  conviene migrar a pre-geocoding (Fase 2: ver README).
- Algunos nombres del Excel no existen en OpenStreetMap o están con otro nombre.
  La tasa de aciertos esperada ronda 50-70%.
- El cache de geocoding está por navegador; cada visitante reconstruye el suyo.
