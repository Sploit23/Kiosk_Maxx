# Sidecar ASK-400 — Status OK ✓

## O que é

Micro sidecar Java independente (77 KB) que substitui o `picgo-kiosk-ws.jar` (160 MB)
para controle da impressora Fujifilm ASK-400. Extrai DLLs do JAR e expõe endpoints REST.

## Como construir

```powershell
cd caminho/para/status_ok
powershell -ExecutionPolicy Bypass -File build.ps1
```
Requer JDK 8+ (encontra em `C:\Program Files\Java\jdk-24`).

## Como executar

```powershell
"C:\Program Files (x86)\Eclipse Adoptium\jre-8.0.472.8-hotspot\bin\java.exe" `
  -jar build/sidecar-ask400.jar
```

## Endpoints

| Método | URL | Descrição |
|--------|-----|-----------|
| GET | `/health` | Status do servidor + conexão com impressora |
| GET | `/kws/v1/kiosk/checkPrinter` | Papéis disponíveis (10x15 e 15x20) |
| GET | `/kws/v1/printer/print2?code=PASTA&media=6x4\|6x8` | Imprime JPEGs de uma pasta |
| POST | `/kws/v1/printer/print` | (não implementado) |

### GET /health
```json
{"status":"OK","retorno":{"connected":true,"printerName":"FUJIFILM ASK-400"}}
```

### GET /checkPrinter
```json
{"status":"OK","retorno":[{"name":"FUJIFILM ASK-400","paperRemain":8,"paperRemainHalfSize":16,"date":"...","lastError":"Sem erros"}]}
```

### GET /print2
Parâmetros:
- `code` — caminho absoluto da pasta com JPEGs
- `media` — `6x4` (10x15cm) ou `6x8` (15x20cm)
- `printerName` — (opcional) nome da impressora

## Estrutura

```
status_ok/
├── build.ps1                    # Script de build
├── build/sidecar-ask400.jar     # JAR pré-compilado (77 KB)
├── src/
│   ├── br/.../driver/
│   │   ├── ASK400.java          # Ponte JNI (3 métodos nativos)
│   │   ├── ASK400Controller.java # Orquestrador do driver
│   │   ├── PrinterInfoASK400.java # DTO de status
│   │   └── LibraryUtil.java     # Extrai e carrega DLLs
│   ├── br/.../enums/
│   │   ├── ASK400PrinterStatus.java # Códigos de erro
│   │   └── ImpressoraEnum.java  # Enum
│   ├── br/.../struts/
│   │   ├── PicgoPrint.java      # DTO de job de impressão
│   │   └── PicgoPrinterInfo.java # DTO de resposta REST
│   └── com/fotoagora/sidecar/
│       └── SidecarMain.java     # Servidor HTTP + endpoints
└── resources/native_libs/picgo-ask400/
    ├── ASK400Stat.dll            # SDK Fujifilm (88 KB)
    └── PicgoAsk400.dll           # Ponte JNI (36 KB)
```

## Testado

- ✅ DLLs extraídas automaticamente para `~/.picgo/sidecar/native_libs/`
- ✅ Driver carregado com JRE 8 32-bit
- ✅ `/health` retorna connected:true
- ✅ `/checkPrinter` retorna papel 10x15=16un, 15x20=8un
