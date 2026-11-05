# CamApp

> App web próprio para câmeras IP RTSP locais — substitui o app do fabricante e **o painel de administração** dele. Zero nuvem, zero vendor lock-in.

![screenshot](docs/screenshot.jpg)

CamApp é um servidor Node de zero dependências que conversa com a câmera por **RTSP** (vídeo) e **PSIA/YG HTTP** (configuração) e entrega tudo numa interface web que roda em qualquer navegador — inclusive o Safari velho do iPhone 6 (iOS 12).

Tudo nasceu de uma câmera iSeg/IPega "Smart Cam" (HD-IPC, firmware `AJL33PC0801 v210427.1130`) que só funcionava pelo app CareCam + nuvem chinesa. Hoje ela é 100% controlada desta web app na LAN.

## Motivação

O painel de fábrica só abre com plugin ActiveX/NPAPI (obsoleto) e acaba de morrer em qualquer navegador moderno. O app do celular depende de conta, nuvem e portas de fabricante. Este projeto inverte: **o PC da própria casa é o servidor**, e o app inteiro foi montado sem o app original.

## Recursos

### Ao vivo
- vídeo MJPEG direto da câmera — sem transcodificação, funciona até no iOS 12
- 4 presets de qualidade no flux (**banda real medida**: Ultra ~907 KB/3s ↔ Economia ~41 KB/3s, 22× menos) — o preset limita `fps` + largura + qualidade MJPEG no ffmpeg
- bitrate **real da câmera** no header (lido de `/PSIA/YG/curBitrate`)
- fullscreen kiosk com snap, auto-reconexão com backoff e retoma após background
- gravação por toque: H.264 stream-copy em `.ts` incremental (`-flush_packets 1`) e remux para `.mp4` no stop

### Controle PTZ
- pan/tilt em 9 direções com press-to-move (o firmware envia `continuous?pan=x&tilt=y` e precisa do stop)
- velocidade 1–7 (persistida na câmera)
- zoom, foco (+ auto-foco), íris — press-to-move
- varredura automática (autopan) on/off
- 16 presets: ir, salvar posição, apagar
- mini-preview opcional durante o controle

### Painel de administração (usurpa o painel de fábrica)
- **Hora & NTP** — sincroniza o relógio da câmera com o PC e troca servidor NTP (o de fábrica apontava para `cn.ntp.org.cn`, inacessível — o relógio da câmera vivia errado)
- **Perfil de vídeo** — resolução, FPS, modo CBR/VBR, qualidade fixa, bitrate alvo, GovLength, vencSmart — por perfil (0 e 1), **validado contra as capabilities do firmware** antes de escrever
- **OSD** — nome exibido no vídeo, mostrar nome/data/hora/bitrate, tamanho da fonte
- **Áudio** — volume do microfone e mute
- **Detecção de movimento** — tipo (desligado/área/humano), sensibilidade, área "tela inteira", alertas (e-mail/buzina). O firmware recebe isso por **query string**, não XML
- **Segurança** — exigir auth no RTSP e ONVIF, lista de usuários (senha ofuscada até tocar), **troca de senha** com atualização automática do `config.json` do servidor (o RTSP do app continua funcionando)
- **Ações** — reiniciar a câmera

### Fotos e vídeos
- fotos capturadas e arquivadas no servidor com galeria e delete
- gravações listadas com tamanho/data, play por streaming, delete

## Arquitetura

```
câmera (LAN)
   ├── RTSP :8554  ──▶ ffmpeg (stream de MPJPEG / snapshot / gravação H.264 copy)
   └── HTTP :80    ──▶ server.js (proxy PSIA/YG com allowlist) ──▶ config da câmera
                          │
iPhone / TV / PC ◀────────┘  HTTP :8080  (web app PWA, ícone na home do iPhone)
```

| rota | o que faz |
|---|---|
| `GET /stream.mjpg?q=alta` | vídeo ao vivo (MJPEG, preset de qualidade) |
| `GET /snap.jpg` | snapshot JPEG |
| `POST /api/photo` / `GET /api/photos` | captura + galeria |
| `POST /api/record/start` e `/stop` | gravação (`.ts` → remux `.mp4`) |
| `POST /api/ptz/<ação>` | pan/tilt/zoom/foco/íris/autopan/velocidade/presets |
| `GET/PUT /api/cam` | **painel de config completo** por allowlist de paths |
| `POST /api/user/password` | troca senha (index 0-based) + auto-update do config |
| `GET /api/device` | nome, modelo, serial, MAC, firmware, portas, telnet check |
| `GET /api/status` | online + bitrate + gravação + sessões |
| `POST /api/reboot` | reinicia a câmera |

## Stack

- **Node.js ≥ 18** — servidor HTTP puro, *zero dependências npm*
- **ffmpeg** — assimila RTSP, gera MJPEG, grava H.264 stream-copy e remuxa pra MP4
- **PSIA/YG** — API HTTP do firmware (Xiongmai/YGTek), descoberta analisando o JS do painel de fábrica
- **PWA** — instalável no iPhone pela tela "Adicionar à Tela de Início"

## Observações de engenharia

Os detalhes que fazem este projeto não ser trivial:

1. **O painel de fábrica usa ActiveX/NPAPI** para gerar preview — o vídeo não vem da Web. O caminho de stream correcto (`rtsp://.../profile0`) estava escondido no `Plugin.js` do próprio firmware: `/profile0`, `profile1` e `/PSIA/streaming/channels/101`.
2. **Windows não entrega SIGINT** ao processo filho — matar o ffmpeg perde o buffer de saída. Primeiro tentativa (MP4 fragmentado) resultou em arquivos de 28 bytes; a solução final: grava em **MPEG-TS** (formato de streaming, à prova de corte) com `-flush_packets 1`, e no stop remux para MP4 (`stream copy`, ~1s).
3. **Config do firmware não aceita XML completo** em todos os endpoints:
   - `motionDetection` exige **query string** (`PUT ?MotionType=..&mdCell0=...`), cada célula da área uma string `0/1` por linha
   - `ntpServers` espera elemento `NTPServer` (maiúsculo) com `hostname` minúsculo, diferente do que o GET devolve
   - **troca de senha** usa o **índice na lista (0-based)**, não o `<id>` do XML — testar com o `<id>` falha com `Device Error`
4. **Desduplicação de sessão RTSP**: cada cliente de stream abre um ffmpeg próprio (a câmera tolera múltiplas sessões curtas, mas as gravadoras às vezes "empacam" quando a sessão está em uso)
5. **Allowlist de paths** no proxy `/api/cam` — nenhum path arbitrário chega à câmera; e cada aplicação é validada tag a tag contra `capabilities` antes do PUT
6. **MJPEG em vez de HLS/WebRTC**: iOS 12 não tem gestão de mídia moderna e HLS teria exigido segmentação; MJPEG é antigo, confiável e leve

## Segurança (isto que descobri na câmera)

Estas observações valem para várias câmeras Xiongmai/YGTek similares:

- `GET /PSIA/Security/AAA/users` responde **sem autenticação** e traz **usuário e senha em texto puro**
- **Telnet (porta 23)** habilitado, prompt de login do Linux exposto na rede
- senha padrão de fábrica (`admin123456`) até que troque manualmente
- todo PUT de configuração (PTZ, OSD, áudio...) funciona **sem autenticação** — qualquer dispositivo na rede pode mover a câmera ou hackear as configs
- `DEV_MANAGE :6688` (porta proprietária Xiongmai) aberto

Recomendações práticas: trocar a senha admin (o próprio app faz isso agora na aba Painel), bloquear a internet da câmera no roteador pelo MAC, e usar este app como única interface (que dispensa o telnet/DEV_MANAGE? não — vale desativar ou restringir no roteador).

O próprio app expõe **checklist dinâmico de segurança** na aba Painel (detecta telnet aberto, mostra os riscos PSIA).

⚠️ **Este app não tem autenticação entre você e o servidor.** Use só em rede confiável. (Roadmap: auth básica + HTTPS.)

## Instalar

1. **Node.js ≥ 18**
2. **ffmpeg** — baixe [ffmpeg-release-essentials.zip](https://www.gyan.dev/ffmpeg/builds/) e copie `bin/ffmpeg.exe` para `camapp/bin/ffmpeg.exe`
3. Copie `config.example.json` → `config.json` e edite:

```json
{
  "port": 8080,
  "rtsp": "rtsp://USUARIO:SENHA@IP-DA-CAMERA:8554/profile0",
  "cameraName": "Câmera da Sala",
  "httpBase": "http://IP-DA-CAMERA"
}
```

4. Rode `iniciar.cmd` (Windows) ou `node server.js`
5. No iPhone: Safari → IP do PC → **Adicionar à Tela de Início**

## Estrutura

```
camapp/
├── server.js            # HTTP + ffmpeg + proxies PSIA (zero deps)
├── public/              # web app (uma página, 5 abas)
├── config.json          # config local (gitignored — tem senha!)
├── config.example.json  # template
├── bin/ffmpeg.exe       # binário (gitignored)
├── recordings/          # gravações (gitignored)
├── photos/              # fotos (gitignored)
└── docs/                # screenshot
```

## Roadmap

- [ ] autenticação no app (Basic + HTTPS)
- [ ] áudio no stream (PCM 8 kHz da câmera já é visível no RTSP)
- [ ] gravação contínua com rotação de arquivo
- [ ] detecção de movimento com IA local (ONNX/OpenCV no PC)
- [ ] descoberta automática de câmeras na rede

## Licença

MIT
