# nJAV — plugin Kino

Catálogo JAV de [njavtv.com](https://njavtv.com) para [Kino](https://kinotvapp.github.io/).

## Instalación en Kino

Ajustes → Plugins → **+** y escribe:

```
agapito309pro/Kino-ejem3
```

Contenido +18: solo visible con el código parental desbloqueado.

## Reproducción en Android TV (Proxy HLS)

El CDN de video (`surrit.com`) está detrás de Cloudflare. En muchos Android TV el reproductor no reenvía bien Referer / cookie y el stream responde **403**.

Solución: un proxy gratuito en **Deno Deploy** que inyecta los headers y reescribe el m3u8.

### Pasos (una sola vez)

1. Abre **https://dash.deno.com** e inicia sesión con GitHub.
2. Pulsa **New Playground**.
3. Borra el código de ejemplo y pega **todo** el contenido de [`proxy-deno.ts`](./proxy-deno.ts) de este repo.
4. Pulsa **Save & Deploy**.
5. Copia la URL pública, algo como `https://nombre-aleatorio.deno.dev`.
6. En Kino: **Plugins → nJAV → Ajustes → Proxy HLS (Android TV)** y pega esa URL (sin barra final).
7. Reproduce un título. Si el proxy está bien, la etiqueta del stream termina en **· proxy**.

Si dejas el campo vacío, el plugin usa el camino local (`signing: "request"` + cookie `__cf_bm`), que suele bastar en el teléfono.

### Por qué Deno y no Cloudflare Worker

`surrit.com` también está en Cloudflare. Las salidas de un Worker hacia surrit a menudo reciben **403 (CF→CF)**. Deno Deploy no tiene ese problema.

## Versiones

| Versión | Cambio |
|---------|--------|
| 1.0.4 | Setting **Proxy HLS** + `proxy-deno.ts` (Android TV) |
| 1.0.3 | Signing local + cookie `__cf_bm` + multi-host surrit |

## Autor

Hotaru Yume / hotaruyume
