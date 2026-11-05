# CamApp

App web proprio (PWA) para ver, fotografar e gravar cameras IP RTSP locais — sem nuvem, sem app do fabricante.

Feito para uma camera iSeg/IPega (Xiongmai/YGTek, RTSP na porta 8554), mas funciona com qualquer camera que exponha stream H.264 por RTSP.

## Como funciona

```
câmera ──RTSP──> PC (server.js + ffmpeg) ──HTTP──> iPhone / TV / PC
```

O servidor Node fala RTSP com a camera via ffmpeg e entrega:

| rota | o que faz |
|---|---|
| `[http://localhost:8080/](http://localhost:8080/)` | app (dark UI, toca no iPhone 6+) |
| `/stream.mjpg` | video ao vivo (MJPEG, ~100 KB/s) |
| `/snap.jpg?download=1` | foto em JPEG |
| `POST /api/record/start` e `/api/record/stop` | grava em `.ts` e remuxa pra `.mp4` |
| `/api/recordings` | lista de gravações |
| `/api/status` | checa se a câmera está online |

Decisões de engenharia ("por que não X?"):

- **MJPEG em vez de HLS/WebRTC**: funciona em Safari antigo (iOS 12), sem transcodificação de vídeo e sem libs externas.
- **Gravação em `.ts` + remux pra `.mp4`**: no Windows, matar o ffmpeg perde o buffer do MP4 (arquivo de 28 bytes). MPEG-TS grava em streaming e sobrevive a corte; o remux acontece no stop.
- **Um ffmpeg por cliente**: sem estado compartilhado; stream morre, cliente reconecta.
- **Zero dependencias npm**: só Node >= 18 e o binario do ffmpeg.

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
  "streamFps": 12
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
- Telnet na porta 23 habilitado no firmware.
- Senha padrao deve ser trocada.

## Desenvolvimento

```
node server.js
```

Logs de servidor mostram [rec] para gravação e [stream] para vídeo.

## Licença

MIT
