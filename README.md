# CamApp

App web proprio (PWA) para ver e controlar cameras IP RTSP locais — sem nuvem, sem app do fabricante.

Feito para uma camera iSeg/IPega (Xiongmai/YGTek, RTSP na porta 8554), mas funciona com qualquer camera que exponha stream H.264 por RTSP e (opcionalmente) PTZ via PSIA.

```
câmera ──RTSP──> PC (server.js + ffmpeg) ──HTTP──> iPhone / TV / PC
```

## Recursos

### Ao vivo
- 4 presets de qualidade (banda real medida): **Ultra** (~300 KB/s), **Alta**, **Media**, **Economia** (~13 KB/s) — cada preset limita fps + resolucao + qualidade MJPEG
- TX real da camera no header (`curBitrate` do firmware)
- Fullscreen "kiosk", auto-reconexão, retoma depois de app em background
- grava com 1 toque (H.264 copy → `.ts` à prova de corte → `.mp4` no stop)

### Controle PTZ
- Pan/tilt por células com press-to-move (9 direções)
- Velocidade 1–7 (wrapper `/PSIA/YG/PTZCtrl/speed`)
- Zoom, foco (+ auto-foco), íris — press-to-move
- Varredura automática (autopan) on/off
- 16 presets: ir, salvar posição, apagar
- Mini-preview (snapshot citrus) enquanto controla

### Fotos e vídeos
- Foto capturada no servidor + galeria com delete
- Lista de gravações com tamanho/data/delete/download

### Sistema (painel próprio)
- Info do dispositivo via PSIA sem login: nome, modelo, serial, MAC, firmware
- Portas expostas pelo firmware (HTTP 80, DEV_MANAGE 6688, RTSP 8554, HTTPS 443, ...)
- Detecção de rosto (ligada/desligada)
- Checklist de segurança dinâmico: telnet aberto?, senha vazia?, PSIA sem auth?
- Link pro **painel de fábrica** original e reinício remoto da câmera

## Como funciona

| rota | o que faz |
|---|---|
| `GET /` | app (dark UI, 5 abas tastáveis) |
| `GET /stream.mjpg?q=alta` | vídeo ao vivo (MJPEG, preset de qualidade) |
| `GET /snap.jpg` | foto em JPEG |
| `POST /api/photo` | captura e salva no servidor (`photos/`) |
| `POST /api/record/start` e `/api/record/stop` | grava (`.ts` → remux `.mp4`) |
| `GET /api/recordings` / `DELETE /api/recording/:f` | lista/remove gravações |
| `POST /api/ptz/<ação>` | pan/tilt/zoom/foco/íris/autopan/velocidade/presets |
| `GET /api/device` | info do dispositivo + portas + detecção + telnet check |
| `GET /api/status` | online + bitrate + gravação + sessões |
| `POST /api/reboot` | reinicia a câmera (com dupla confirmação no UI) |

Decisões de engenharia:

- **MJPEG em vez de HLS/WebRTC**: funciona em Safari antigo (iOS 12), sem transcodificação de vídeo e sem libs externas.
- **Gravação em `mpegts` + `-flush_packets 1` + remux pra mp4**: no Windows, matar o ffmpeg perde o buffer do MP4 (arquivo de 28 bytes); a combinação garante gravação incremental sólida no disco.
- **Um ffmpeg por cliente** de stream; preset só muda fps/escala/qualidade.
- **PTZ proxies transparantementes pra `PSIA/YG` do firmware**, que fica escondido (a câmera não sai do LAN).
- **Zero dependencias npm**: só Node >= 18 e o binário do ffmpeg.

## Instalar

1. Node.js >= 18
2. ffmpeg (build "essentials" do gyan.dev): baixe `ffmpeg-release-essentials.zip`,
   copie `bin/ffmpeg.exe` para `camapp/bin/ffmpeg.exe`
3. Copie `config.example.json` para `config.json` e edite seus dados:

```json
{
  "port": 8080,
  "rtsp": "rtsp://USUARIO:SENHA@IP-DA-CAMERA:8554/profile0",
  "cameraName": "Câmera da Sala",
  "httpBase": "http://IP-DA-CAMERA"
}
```

4. `iniciar.cmd` (Windows) ou `node server.js`

## Instalar no iPhone

1. iPhone e PC na mesma rede (ou ZeroTier / Tailscale pra acesso remoto).
2. Safari abre `http://IP-DO-PC:8080`
3. Compartilhar → **Adicionar à Tela de Início** → vira app com ícone, fullscreen, sem barra do Safari.

## Segurança

Este app **não** tem autenticação. Use somente em rede confiável.

Avisos sobre a camera usada no desenvolvimento (aplicam-se a varias Xiongmai/YGTek):

- `GET /PSIA/Security/AAA/users` expoe usuario e senha em texto puro SEM autenticacao.
- Telnet na porta 23 habilitado no firmware (o app detecta e avisa).
- Senha padrao deve ser trocada.

## Licença

MIT
