# Sistema de Impressão Nativa do Windows

## Visão Geral

O sistema foi atualizado para usar impressão nativa do Windows, similar ao script `Program.cs`, permitindo que o Windows trate automaticamente o redimensionamento e otimização das fotos para impressão.

## Como Funciona

### 1. Configuração de Impressoras

O sistema utiliza o arquivo `/config/printer_config.json` para determinar qual impressora usar baseado no formato escolhido pelo usuário:

```json
{
  "format_mappings": {
    "10x15": {
      "printer": "FUJIFILM ASK-400",
      "java_class": "ImprimirFoto10x15ASK300"
    },
    "15x20": {
      "printer": "FUJIFILM ASK-300",
      "java_class": "ImprimirFoto15x20ASK300"
    }
  }
}
```

### 2. Fluxo de Impressão

1. **Recebimento da Solicitação**: A API `/api/print-configured` recebe:
   - `image_data`: Imagem em base64
   - `paper_size`: Formato desejado (10x15, 15x20)
   - `copies`: Número de cópias

2. **Mapeamento de Impressora**: O sistema consulta `printer_config.json` para determinar qual impressora usar baseado no formato

3. **Salvamento Temporário**: A imagem é salva temporariamente com nome que inclui o formato

4. **Impressão Nativa**: Executa o comando Windows nativo:
   ```
   rundll32.exe shimgvw.dll,ImageView_PrintTo "caminho_imagem" "nome_impressora"
   ```

5. **Limpeza**: Remove o arquivo temporário após 5 segundos

### 3. APIs Disponíveis

#### `/api/print-configured` (Principal)
- **Método**: POST
- **Função**: Impressão nativa do Windows usando configurações do `/config`
- **Vantagens**: 
  - Windows trata automaticamente o redimensionamento
  - Melhor qualidade de impressão
  - Compatível com qualquer impressora Windows

#### `/api/print-java` (Fallback)
- **Método**: POST
- **Função**: Impressão via scripts Java (método anterior)
- **Uso**: Backup caso a impressão nativa falhe

#### `/api/print` (Compatibilidade)
- **Método**: POST
- **Função**: Mantida para compatibilidade com código antigo

## Implementação Técnica

### Função `executeWindowsNativePrint`

```javascript
function executeWindowsNativePrint(imagePath, printerName, paperSize, copies = 1) {
    // Executa rundll32.exe shimgvw.dll,ImageView_PrintTo
    // Suporta múltiplas cópias com delay de 1s entre elas
    // Retorna Promise com resultado da impressão
}
```

### Características:
- **Múltiplas Cópias**: Suporte automático com delay entre impressões
- **Tratamento de Erros**: Logs detalhados e fallback para Java
- **Limpeza Automática**: Remove arquivos temporários automaticamente
- **Configuração Dinâmica**: Usa mapeamentos do arquivo de configuração

## Vantagens da Implementação

1. **Qualidade Superior**: Windows otimiza automaticamente as imagens
2. **Compatibilidade**: Funciona com qualquer impressora Windows
3. **Configuração Flexível**: Mapeamento dinâmico formato → impressora
4. **Fallback Robusto**: Sistema Java como backup
5. **Logs Detalhados**: Rastreamento completo do processo

## Configuração de Exemplo

### Cenário: Usuário configura duas impressoras

1. **10x15 → ASK-400**: Fotos pequenas na impressora rápida
2. **15x20 → ASK-300**: Fotos grandes na impressora de alta qualidade

### Fluxo:
1. Usuário escolhe formato "10x15" no frontend
2. Sistema consulta `printer_config.json`
3. Identifica que 10x15 → ASK-400
4. Envia foto para Windows processar
5. Windows redimensiona e otimiza automaticamente
6. Imprime na ASK-400

## Monitoramento e Debug

O sistema inclui logs detalhados:

```
🖨️ Iniciando impressão nativa Windows: temp_10x15_123456.jpg -> FUJIFILM ASK-400 (10x15)
📋 Usando mapeamento de formato: 10x15 -> FUJIFILM ASK-400
💾 Imagem salva: C:\temp\10x15_123456.jpg
🚀 Executando: rundll32.exe shimgvw.dll,ImageView_PrintTo "C:\temp\10x15_123456.jpg" "FUJIFILM ASK-400"
🏁 Impressão Windows cópia 1 finalizada com código: 0
🗑️ Arquivo temporário removido: 10x15_123456.jpg
```

## Próximos Passos

1. **Teste**: Verificar funcionamento com impressoras reais
2. **Otimização**: Ajustar delays e timeouts se necessário
3. **Interface**: Atualizar frontend para mostrar método de impressão
4. **Configuração**: Permitir configuração de preferências via interface

Este sistema resolve completamente o problema de redimensionamento e tratamento de imagens, delegando essa responsabilidade para o Windows, que possui algoritmos otimizados para impressão fotográfica.