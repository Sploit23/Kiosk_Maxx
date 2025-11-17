const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');
const os = require('os');

// Configurações
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

// --- LÓGICA DE CAMINHOS REFINADA ---

// Obter o caminho 'userData' de forma segura. Como o servidor roda no processo principal do Electron,
// podemos acessar o módulo 'app' diretamente.
const electronApp = require('electron').app;
const isPackaged = electronApp.isPackaged || process.env.KIOSK_FORCE_PACKAGED === '1';
const userDataPath = electronApp.getPath('userData');

// Função única e confiável para obter o caminho de um arquivo de configuração.
// Todos os arquivos de configuração DEVEM estar em 'userDataPath/config'.
function getConfigPath(filename) {
    // Garante que subdiretórios como 'temas' sejam resolvidos corretamente.
    return path.join(userDataPath, 'config', filename);
}

console.log(`[INFO] Usando diretório de dados do usuário: ${userDataPath}`);

// --- FIM DA LÓGICA DE CAMINHOS ---

function getResourcePath(relativePath) {
    if (path.isAbsolute(relativePath)) return relativePath;
    return path.join(__dirname, relativePath);
}

// Carregar configurações
let config = {};
let sessions = new Map();

// Sistema de monitoramento de arquivos
let fileWatcher = null;
let connectedClients = new Set();
let lastImagesList = {};

// Função para carregar arquivos JSON
function loadJSON(filePath, defaultValue = {}) {
    try {
        let fullPath = filePath;
        if (!path.isAbsolute(fullPath)) {
            fullPath = getResourcePath(fullPath);
        }
        if (fs.existsSync(fullPath)) {
            const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            return data;
        }
        const userConfigRoot = path.join(userDataPath, 'config');
        if (fullPath.startsWith(userConfigRoot)) {
            const rel = path.relative(userConfigRoot, fullPath);
            const fallback = getResourcePath(path.join('../../config', rel));
            if (fs.existsSync(fallback)) {
                const data = JSON.parse(fs.readFileSync(fallback, 'utf8'));
                return data;
            }
        }
        return defaultValue;
    } catch (error) {
        console.error(`❌ Erro ao carregar ${filePath}:`, error.message);
        return defaultValue;
    }
}

// Função para salvar JSON
function saveJSON(filePath, data) {
    try {
        const fullPath = path.resolve(filePath);
        const dir = path.dirname(fullPath);
        
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        const jsonContent = JSON.stringify(data, null, 2);
        fs.writeFileSync(fullPath, jsonContent);
        
        console.log(`✅ Arquivo JSON salvo com sucesso: ${fullPath}`);
        return true;
    } catch (error) {
        console.error(`❌ Erro ao salvar ${filePath}:`, error.message);
        console.error(`❌ Stack trace:`, error.stack);
        return false;
    }
}

// Carregar configurações iniciais
console.log('🔧 Carregando configurações do sistema...');
config.settings = loadJSON(getConfigPath('settings.json'), { admin_password: '869407' });
config.pricing = loadJSON(getConfigPath('pricing.json'), { formats: { '10x15': 15.00, '15x21': 25.00 } });
config.version = loadJSON(getConfigPath('version.json'), { version: '2.0.0' });
config.image_settings = loadJSON(getConfigPath('image_settings.json'), { base_path: '', allowed_extensions: ['.jpg', '.jpeg', '.png', '.gif'] });

console.log(`[INFO] Pasta de imagens configurada: ${config.image_settings.base_path}`);
if (!config.image_settings.base_path || !fs.existsSync(config.image_settings.base_path)) {
    console.warn(`[AVISO] A pasta de imagens configurada não foi encontrada. Por favor, verifique o caminho em "Configurações > Imagens".`);
}

// Utilitários de formato de data para nome de pasta
function getDateFormat() {
    return (config.settings?.date_format?.folder_format) || 'DDMMYYYY';
}

function buildDateFolderName(date) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const yy = String(yyyy).slice(-2);
    const format = getDateFormat();
    switch (format) {
        case 'DDMMYY':
            return `${dd}${mm}${yy}`;
        case 'YYMMDD':
            return `${yy}${mm}${dd}`;
        case 'YYYYMMDD':
            return `${yyyy}${mm}${dd}`;
        case 'DDMMYYYY':
        default:
            return `${dd}${mm}${yyyy}`;
    }
}

function getFolderRegexForFormat() {
    const format = getDateFormat();
    const sixDigit = format === 'DDMMYY' || format === 'YYMMDD';
    return new RegExp(`^\\d{${sixDigit ? 6 : 8}}$`);
}

// Função global para encontrar pasta de imagens (obedece configuração do admin)
function getImagesFolderPath() {
    const basePath = config.image_settings?.base_path || path.join(appPath, 'imagens');
    if (!fs.existsSync(basePath)) {
        console.log(`❌ ERRO: Pasta base de imagens não encontrada: ${basePath}`);
        console.log(`⚠️  Configure o caminho correto em config/image_settings.json`);
        return basePath;
    }
    const hoje = new Date();
    const dataFormatada = buildDateFolderName(hoje);
    const imagesDir = path.join(basePath, dataFormatada);
    if (fs.existsSync(imagesDir)) {
        console.log(`✅ Pasta do dia encontrada: ${imagesDir} (formato: ${getDateFormat()})`);
        return imagesDir;
    }
    try {
        fs.mkdirSync(imagesDir, { recursive: true });
        console.log(`🆕 Pasta do dia criada: ${imagesDir}`);
    } catch (error) {
        console.error(`❌ Falha ao criar pasta do dia: ${imagesDir}`, error);
    }
    return imagesDir;
}

// Função para gerar ID de sessão
function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

// Função para verificar autenticação
function isAuthenticated(req) {
    return true;
}

// Função para parsear cookies
function parseCookies(cookieHeader) {
    const cookies = {};
    cookieHeader.split(';').forEach(cookie => {
        const [name, value] = cookie.trim().split('=');
        if (name && value) {
            cookies[name] = decodeURIComponent(value);
        }
    });
    return cookies;
}

// Função para servir arquivos estáticos
function serveStatic(filePath, res) {
    try {
        if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Arquivo não encontrado');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.svg': 'image/svg+xml'
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const content = fs.readFileSync(filePath);

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Erro interno do servidor');
    }
}

// Função para listar imagens
function listImages() {
    const basePath = config.image_settings?.base_path;
    const grupos = {};

    try {
        // Verificar se o usuário selecionou uma pasta
        if (!basePath || !fs.existsSync(basePath)) {
            return {
                erro: 'Nenhuma pasta de imagens selecionada',
                solucao: 'Por favor, selecione uma pasta de imagens nas configurações',
                status: 'no_folder_selected'
            };
        }

        const todayDir = getImagesFolderPath();
        const today = new Date();
        const dia = String(today.getDate()).padStart(2, '0');
        const mes = String(today.getMonth() + 1).padStart(2, '0');
        const ano = today.getFullYear();
        
        // Obter formato de data das configurações
        const todayFormatted = buildDateFolderName(today);
        
        // Verificar se a pasta do dia existe
        if (!fs.existsSync(todayDir)) {
            return {
                erro: `Pasta do dia ${todayFormatted} não encontrada`,
                solucao: `Crie a pasta: ${todayDir}`,
                status: 'daily_folder_not_found',
                expected_folder: todayFormatted,
                expected_path: todayDir,
                base_path: basePath
            };
        }

        // Listar imagens da pasta do dia
        const files = fs.readdirSync(todayDir)
            .filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file))
            .sort()
            .reverse();

        if (files.length === 0) {
            console.log(`ℹ️ Nenhuma imagem na pasta do dia (${todayFormatted}). Enviando grupos vazios.`);
            return {};
        }

        // Agrupar imagens por ID
        files.forEach(file => {
            const parts = file.split('_');
            if (parts.length >= 3) {
                // Usar formato_data_hora como ID (ex: 10x15_20250808_102124)
                const id = parts[0] + '_' + parts[1] + '_' + parts[2].split('.')[0];
                if (!grupos[id]) {
                    grupos[id] = [];
                }
                grupos[id].push(file);
            }
        });

        console.log(`✅ Encontradas ${files.length} imagens em ${Object.keys(grupos).length} grupos`);
        return grupos;

    } catch (error) {
        console.error('Erro ao listar imagens:', error);
        return {
            erro: 'Erro interno ao listar imagens',
            solucao: 'Verifique as permissões da pasta e tente novamente',
            status: 'internal_error',
            details: error.message
        };
    }
}

// Função para iniciar o monitoramento da pasta de imagens
// Variáveis para otimização do monitoramento
let debounceTimer = null;
let pendingChanges = new Set();
let isProcessingChanges = false;

// Configurações otimizadas para alto volume (2000+ fotos/dia)
const HIGH_VOLUME_CONFIG = {
    debounceDelay: 800, // mais responsivo
    processingDelay: 400, // reduzir atraso de processamento
    maxPendingChanges: 100, // Processar em lotes de até 100 arquivos
    batchProcessing: true // Ativar processamento em lote
};

function startFileWatcher() {
    const imagesDir = getImagesFolderPath();
    
    if (!imagesDir || !fs.existsSync(imagesDir)) {
        console.log('⚠️ Pasta de imagens não encontrada, monitoramento não iniciado');
        return;
    }
    
    // Parar watcher anterior se existir
    if (fileWatcher) {
        fileWatcher.close();
    }
    
    console.log(`🔍 Iniciando monitoramento otimizado da pasta: ${imagesDir}`);
    
    // Obter lista inicial de imagens
    lastImagesList = listImages();
    
    try {
        // Usar fs.watch com configurações otimizadas
        fileWatcher = fs.watch(imagesDir, { 
            persistent: true,
            recursive: false // Monitorar apenas a pasta principal para melhor performance
        }, (eventType, filename) => {
            if (!filename) return;
            
            // Filtrar apenas arquivos de imagem
            const allowedExtensions = config.image_settings?.allowed_extensions || ['.jpg', '.jpeg', '.png', '.gif'];
            const isImageFile = allowedExtensions.some(ext => 
                filename.toLowerCase().endsWith(ext.toLowerCase())
            );
            
            if (!isImageFile) return;
            
            // Adicionar à lista de mudanças pendentes
            pendingChanges.add(filename);
            
            console.log(`📁 Arquivo ${eventType}: ${filename} (${pendingChanges.size} pendentes)`);
            
            // Processamento inteligente baseado no volume
            const shouldProcessImmediately = pendingChanges.size >= HIGH_VOLUME_CONFIG.maxPendingChanges;
            
            if (shouldProcessImmediately) {
                console.log(`🚀 Processamento imediato: ${pendingChanges.size} arquivos pendentes`);
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                }
                processImageChanges();
            } else {
                // Usar debouncing otimizado para alto volume
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                }
                
                debounceTimer = setTimeout(() => {
                    processImageChanges();
                }, HIGH_VOLUME_CONFIG.debounceDelay);
            }
        });
        
        fileWatcher.on('error', (error) => {
            console.error('❌ Erro no monitoramento de arquivos:', error);
            // Tentar reiniciar o watcher após um erro
            setTimeout(() => {
                startFileWatcher();
            }, 5000);
        });
        
    } catch (error) {
        console.error('❌ Erro ao iniciar monitoramento:', error);
    }
}

// Função para verificar mudanças nas imagens e notificar clientes
// Função otimizada para processar mudanças em lote
function processImageChanges() {
    if (isProcessingChanges) {
        console.log('⏳ Processamento já em andamento, aguardando...');
        return;
    }
    
    isProcessingChanges = true;
    const changedFiles = Array.from(pendingChanges);
    pendingChanges.clear();
    
    console.log(`🔄 Processando ${changedFiles.length} mudanças de arquivos...`);
    
    try {
        // Aguardar tempo otimizado para garantir que todos os arquivos foram escritos
        setTimeout(() => {
            const currentImagesList = listImages();
            
            // Verificar se houve mudanças reais na lista
            const currentKeys = Object.keys(currentImagesList).sort();
            const lastKeys = Object.keys(lastImagesList).sort();
            
            const hasChanges = JSON.stringify(currentKeys) !== JSON.stringify(lastKeys) ||
                              JSON.stringify(currentImagesList) !== JSON.stringify(lastImagesList);
            
            if (hasChanges) {
                console.log(`✅ Mudanças confirmadas: ${changedFiles.join(', ')}`);
                
                // Calcular diferenças para otimizar notificação
                const newImages = currentKeys.filter(key => !lastKeys.includes(key));
                const removedImages = lastKeys.filter(key => !currentKeys.includes(key));
                
                console.log(`📊 Estatísticas: +${newImages.length} novas, -${removedImages.length} removidas`);
                
                lastImagesList = currentImagesList;
                
                // Notificar clientes com informações detalhadas
                notifyClients('images-updated', {
                    ...currentImagesList,
                    _metadata: {
                        newImages: newImages.length,
                        removedImages: removedImages.length,
                        totalImages: currentKeys.length,
                        timestamp: Date.now()
                    }
                });
            } else {
                console.log('ℹ️ Nenhuma mudança real detectada após verificação');
            }
            
            isProcessingChanges = false;
        }, HIGH_VOLUME_CONFIG.processingDelay);
        
    } catch (error) {
        console.error('❌ Erro ao processar mudanças:', error);
        isProcessingChanges = false;
    }
}

// Função legada mantida para compatibilidade
function checkForImageChanges() {
    processImageChanges();
}

// Função para notificar todos os clientes conectados
function notifyClients(event, data) {
    const clientsToRemove = [];
    
    connectedClients.forEach(client => {
        try {
            if (client.send && typeof client.send === 'function') {
                client.send(event, data);
            } else {
                clientsToRemove.push(client);
            }
        } catch (error) {
            console.error('Erro ao enviar mensagem para cliente:', error);
            clientsToRemove.push(client);
        }
    });
    
    // Remover clientes inválidos
    clientsToRemove.forEach(client => {
        connectedClients.delete(client);
    });
    
    console.log(`📡 Notificação '${event}' enviada para ${connectedClients.size} clientes`);
}

// Função para parar o monitoramento
function stopFileWatcher() {
    if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = null;
        console.log('🛑 Monitoramento de arquivos parado');
    }
}

// Função para executar script Java
// Função executePythonPrinter removida - dependência Python não existe

// Função executeJavaScript removida - dependências Java não existem

// Função para executar impressão nativa do Windows (exatamente como Program.cs)
function executeWindowsNativePrint(imagePath, printerName, paperSize, copies = 1) {
    return new Promise((resolve, reject) => {
        console.log(`🖨️ ===== INICIANDO IMPRESSÃO NATIVA WINDOWS =====`);
        console.log(`🖨️ Arquivo: ${imagePath}`);
        console.log(`🖨️ Impressora: ${printerName}`);
        console.log(`🖨️ Tamanho papel: ${paperSize}`);
        console.log(`🖨️ Cópias: ${copies}`);
        console.log(`🖨️ ===============================================`);
        
        let completedCopies = 0;
        const results = [];
        const printerCfg = loadJSON(getConfigPath('printer_config.json'), {});
        const formatMapping = (printerCfg.format_mappings && printerCfg.format_mappings[paperSize]) ? printerCfg.format_mappings[paperSize] : {};
        const masterOverride = !!printerCfg?.paper_override_enabled;
        const enableOverride = masterOverride && !!formatMapping?.enable_paper_override;
        const forcedPaperSize = formatMapping?.force_paper_size;

        const runPaperOverrideIfEnabled = (done) => {
            if (!enableOverride || !forcedPaperSize || !printerName) {
                done();
                return;
            }
            const psCmd = `Set-PrintConfiguration -PrinterName \"${printerName}\" -PaperSize \"${forcedPaperSize}\"`;
            exec(psCmd, { shell: 'powershell.exe' }, (error, stdout, stderr) => {
                if (error) {
                    console.warn(`⚠️ Erro ao ajustar tamanho de papel para ${printerName}: ${String(error.message || stderr || '').trim()}`);
                } else {
                    console.log(`✅ Tamanho de papel ajustado para '${forcedPaperSize}' em ${printerName}`);
                }
                done();
            });
        };
        


        // Executar para cada cópia enviando direto para a impressora configurada
        const buildPrintToCommand = (img, printer) => {
            const winDir = process.env['WINDIR'] || 'C:/Windows';
            const sysnative = path.join(winDir, 'Sysnative', 'rundll32.exe');
            const system32 = path.join(winDir, 'System32', 'rundll32.exe');
            const exe = fs.existsSync(sysnative) ? sysnative : system32;
            const dllEntry = `${path.join(winDir, 'System32', 'shimgvw.dll')},ImageView_PrintTo`;
            return { exe, args: [dllEntry, img, printer] };
        };

        const executeCopy = (copyNumber) => {
            console.log(`🚀 Executando cópia ${copyNumber}/${copies} com método Program.cs`);
            
            const { exe, args } = buildPrintToCommand(imagePath, printerName);
            console.log(`DEBUG: rundll32: ${exe}`);
            console.log(`DEBUG: args: ${JSON.stringify(args)}`);

            const printProcess = spawn(exe, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });
            
            let output = '';
            let errorOutput = '';
            
            printProcess.stdout.on('data', (data) => {
                const message = data.toString();
                console.log(`📄 Print Output (cópia ${copyNumber}): ${message}`);
                output += message;
            });
            
            printProcess.stderr.on('data', (data) => {
                const message = data.toString();
                console.error(`⚠️ Print Error (cópia ${copyNumber}): ${message}`);
                errorOutput += message;
            });
            
            printProcess.on('close', (code) => {
                console.log(`🏁 Print cópia ${copyNumber} finalizada com código: ${code}`);
                
                completedCopies++;
                results.push({
                    copy: copyNumber,
                    success: code === 0, // Código 0 indica sucesso
                    output: output,
                    error: errorOutput,
                    code: code
                });
                
                if (completedCopies === copies) {
                    resolve({
                        success: true,
                        message: `Impressão rundll32 concluída (${copies} cópia${copies > 1 ? 's' : ''}) para ${printerName}`,
                        results: results
                    });
                }
            });
            
            printProcess.on('error', (error) => {
                // Include stderr in the error message for better debugging
                const fullErrorMessage = `Erro ao executar impressão (cópia ${copyNumber}): ${error.message}. Stderr: ${errorOutput}. Comando: ${exe} ${args.join(' ')}`;
                console.error(`❌ ${fullErrorMessage}`);
                console.log(`🔄 Tentando método alternativo para cópia ${copyNumber}...`);
                
                // Fallback: usar método alternativo como no Program.cs
                try {
                    const { spawn } = require('child_process');
                    const fallbackProcess = spawn('cmd', ['/c', 'start', '/min', imagePath], {
                        stdio: ['pipe', 'pipe', 'pipe'],
                        windowsHide: true
                    });
                    
                    fallbackProcess.on('close', (fallbackCode) => {
                        console.log(`🔄 Método alternativo cópia ${copyNumber} finalizada com código: ${fallbackCode}`);
                        completedCopies++;
                        results.push({
                            copy: copyNumber,
                            success: fallbackCode === 0,
                            output: 'Método alternativo usado',
                            error: fallbackCode !== 0 ? `Código de saída: ${fallbackCode}` : null,
                            code: fallbackCode,
                            method: 'fallback'
                        });
                        
                        if (completedCopies === copies) {
                            const successfulCopies = results.filter(r => r.success).length;
                            if (successfulCopies > 0) {
                                resolve({
                                     success: true,
                                     message: `Impressão parcialmente concluída (${successfulCopies}/${copies} cópias)`,
                                     results: results
                                 });
                             } else {
                                 reject(new Error('Todas as cópias falharam'));
                             }
                         }
                     });
                     
                     fallbackProcess.on('error', (fallbackError) => {
                         console.error(`❌ Erro no método alternativo (cópia ${copyNumber}): ${fallbackError.message}`);
                         completedCopies++;
                         results.push({
                             copy: copyNumber,
                             success: false,
                             error: fallbackError.message,
                             method: 'fallback'
                         });
                         
                         if (completedCopies === copies) {
                             const successfulCopies = results.filter(r => r.success).length;
                             if (successfulCopies > 0) {
                                 resolve({
                                     success: true,
                                     message: `Impressão parcialmente concluída (${successfulCopies}/${copies} cópias)`,
                                     results: results
                                 });
                             } else {
                                 reject(new Error('Todas as cópias falharam'));
                             }
                         }
                     });
                     
                 } catch (fallbackError) {
                     console.error(`❌ Erro ao iniciar método alternativo (cópia ${copyNumber}): ${fallbackError.message}`);
                     completedCopies++;
                     results.push({
                         copy: copyNumber,
                         success: false,
                         error: fallbackError.message
                     });
                     
                     if (completedCopies === copies) {
                         const successfulCopies = results.filter(r => r.success).length;
                         if (successfulCopies > 0) {
                             resolve({
                                 success: true,
                                 message: `Impressão parcialmente concluída (${successfulCopies}/${copies} cópias)`,
                                 results: results
                             });
                         } else {
                             reject(new Error('Todas as cópias falharam'));
                         }
                     }
                 }
             });
        };
        
        runPaperOverrideIfEnabled(() => {
            for (let i = 1; i <= copies; i++) {
                setTimeout(() => executeCopy(i), (i - 1) * 2000);
            }
        });
    });
}

// Helper para encontrar arquivos da UI, que não são arquivos de configuração
function getUiPath(relativePath) {
    // __dirname em um app empacotado aponta para dentro do asar,
    // ex: /path/to/app.asar/src/server
    // Então, subir um nível para /path/to/app.asar/src nos dá acesso à pasta 'ui'
    return path.join(__dirname, '..', relativePath);
}

// Servidor HTTP
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const normalizedPath = (pathname || '').replace(/\/+$/, '').toLowerCase();
    const method = req.method;
    
    // Log de todas as requisições
    console.log(`📡 ${method} ${pathname} - ${new Date().toLocaleTimeString()}`);

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Rotas estáticas da UI
    if (pathname === '/' || pathname === '/index.html') {
        serveStatic(getUiPath('ui/app/index.html'), res);
        return;
    }

    if (pathname === '/login') {
        res.writeHead(302, { 'Location': '/config' });
        res.end();
        return;
    }

    if (normalizedPath === '/config' || normalizedPath === '/configuracao') {
        serveStatic(getUiPath('ui/app/config.html'), res);
        return;
    }

    if (pathname === '/dashboard') {
        serveStatic(getUiPath('ui/app/dashboard.html'), res);
        return;
    }

    // Arquivos estáticos (CSS, JS, etc. da UI)
    if (normalizedPath.startsWith('/static/') || normalizedPath.startsWith('/app/')) {
        const filePath = getUiPath(`ui${pathname}`);
        serveStatic(filePath, res);
        return;
    }

    // Arquivos de configuração (exclusivamente via getConfigPath)
    if (pathname.startsWith('/config/')) {
        const configFileName = pathname.substring(8); // Remove '/config/'
        const filePath = getConfigPath(configFileName);
        
        if (fs.existsSync(filePath)) {
            serveStatic(filePath, res);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Arquivo de configuração não encontrado' }));
        }
        return;
    }

    // Servir imagens individuais
    if (pathname.startsWith('/imagens/')) {
        const imagePath = decodeURIComponent(pathname.substring(9)); // Remove '/imagens/'
        const imagesDir = getImagesFolderPath();
        
        if (!imagesDir || !fs.existsSync(imagesDir)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: `Pasta de imagens não encontrada ou não configurada.`,
                solucao: `Verifique o caminho da pasta de imagens nas configurações.`
            }));
            return;
        }
        
        const fullImagePath = path.join(imagesDir, imagePath);
        
        if (fs.existsSync(fullImagePath)) {
            const ext = path.extname(fullImagePath).toLowerCase();
            const contentType = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.svg': 'image/svg+xml'
            }[ext] || 'application/octet-stream';
            
            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(fullImagePath).pipe(res);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                erro: `Imagem '${imagePath}' não encontrada.`,
                pasta_procurada: imagesDir,
                arquivo_completo: fullImagePath
            }));
        }
        return;
    }

    // APIs
    if (pathname.startsWith('/api/')) {
        // API de imagens
        if (pathname === '/api/images' && method === 'GET') {
            const basePath = config.image_settings?.base_path;
            
            const imagesDir = getImagesFolderPath();
            
            if (!imagesDir || !fs.existsSync(imagesDir)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    erro: `Pasta de imagens não encontrada ou não configurada.`,
                    pasta_base: basePath,
                    solucao: `Verifique o caminho da pasta de imagens nas configurações.`
                }));
                return;
            }
            
            try {
                const arquivos = fs.readdirSync(imagesDir).sort();
                const allowedExtensions = config.image_settings?.allowed_extensions || ['.jpg', '.jpeg', '.png', '.gif'];
                const arquivosImagem = arquivos.filter(f => 
                    allowedExtensions.some(ext => f.toLowerCase().endsWith(ext.toLowerCase()))
                );
                
                if (arquivosImagem.length === 0) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'empty_today_folder',
                        pasta_atual: imagesDir,
                        grupos: {}
                    }));
                    return;
                }
                
                const imagensAgrupadas = {};
                arquivosImagem.forEach(f => {
                    const partes = f.split('_');
                    if (partes.length >= 3) {
                        // Usar formato_data_hora como ID (ex: 10x15_20250808_102124)
                        const idFoto = partes[0] + '_' + partes[1] + '_' + partes[2].split('.')[0];
                        if (!imagensAgrupadas[idFoto]) {
                            imagensAgrupadas[idFoto] = [];
                        }
                        imagensAgrupadas[idFoto].push(f);
                    } else {
                        // Para imagens que não seguem o padrão de nomenclatura
                        const nomeBase = path.parse(f).name;
                        if (!imagensAgrupadas[nomeBase]) {
                            imagensAgrupadas[nomeBase] = [];
                        }
                        imagensAgrupadas[nomeBase].push(f);
                    }
                });
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(imagensAgrupadas));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    erro: `Erro ao processar as imagens: ${error.message}`,
                    pasta_base: basePath,
                    pasta_atual: imagesDir,
                    solucao: 'Verifique as permissões da pasta ou se o formato das imagens é suportado.'
                }));
            }
            return;
        }

        if (pathname === '/api/print-stats/increment' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const date = String(data.date || '').trim();
                    const format = String(data.format || '').trim().toLowerCase();
                    const qty = Number.isFinite(parseInt(data.qty)) ? parseInt(data.qty) : 1;
                    if (!date || !format) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Dados inválidos' }));
                        return;
                    }
                    const statsPath = getConfigPath('print_stats.json');
                    const stats = loadJSON(statsPath, { days: {}, updated_at: new Date().toISOString() });
                    if (!stats.days[date]) stats.days[date] = {};
                    stats.days[date][format] = (stats.days[date][format] || 0) + qty;
                    stats.updated_at = new Date().toISOString();
                    const ok = saveJSON(statsPath, stats);
                    if (ok) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true }));
                    } else {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false }));
                    }
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Dados inválidos' }));
                }
            });
            return;
        }

        if (pathname === '/api/print-stats' && method === 'GET') {
            const d = parsedUrl.query?.date ? String(parsedUrl.query.date) : '';
            const statsPath = getConfigPath('print_stats.json');
            const stats = loadJSON(statsPath, { days: {} });
            if (d && stats.days[d]) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ date: d, totals: stats.days[d] }));
            } else if (d) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ date: d, totals: {} }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ days: stats.days }));
            }
            return;
        }

        if (pathname === '/api/print-stats/dates' && method === 'GET') {
            const statsPath = getConfigPath('print_stats.json');
            const stats = loadJSON(statsPath, { days: {} });
            const dates = Object.keys(stats.days || {}).sort().reverse();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ dates }));
            return;
        }

        if (pathname === '/api/print-stats/all' && method === 'GET') {
            const statsPath = getConfigPath('print_stats.json');
            const stats = loadJSON(statsPath, { days: {} });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats));
            return;
        }

        // API Server-Sent Events para atualizações em tempo real
        if (pathname === '/api/events' && method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Cache-Control'
            });
            
            // Adicionar cliente à lista de conectados
            const clientId = Date.now() + Math.random();
            const client = {
                id: clientId,
                response: res,
                send: function(event, data) {
                    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
                    try {
                        this.response.write(message);
                    } catch (error) {
                        console.error('Erro ao enviar SSE:', error);
                        connectedClients.delete(this);
                    }
                }
            };
            
            connectedClients.add(client);
            console.log(`📡 Cliente SSE conectado. Total: ${connectedClients.size}`);
            
            // Enviar evento inicial
            client.send('connected', { message: 'Conectado ao sistema de atualizações', timestamp: Date.now() });
            
            // Enviar lista atual de imagens
            const currentImages = listImages();
            if (currentImages && !currentImages.erro) {
                client.send('images-updated', currentImages);
            }
            
            // Remover cliente quando a conexão for fechada
            req.on('close', () => {
                connectedClients.delete(client);
                console.log(`📡 Cliente SSE desconectado. Total: ${connectedClients.size}`);
            });
            
            req.on('error', () => {
                connectedClients.delete(client);
            });
            
            return;
        }

        // API de versão
        if (pathname === '/api/version' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config.version));
            return;
        }

        // API para verificar atualizações
        if (pathname === '/api/system/check-updates' && method === 'GET') {
            if (!isAuthenticated(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Não autorizado' }));
                return;
            }
            
            try {
                const currentVersion = config.version.version || '2.0.0';
                const githubApiUrl = 'https://api.github.com/repos/Sploit23/kiosk-updates/releases/latest';
                
                const https = require('https');
                const request = https.get(githubApiUrl, { timeout: 10000 }, (response) => {
                    let data = '';
                    
                    response.on('data', (chunk) => {
                        data += chunk;
                    });
                    
                    response.on('end', () => {
                        try {
                            if (response.statusCode !== 200) {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    status: 'error',
                                    message: 'Erro ao verificar atualizações no GitHub',
                                    current_version: currentVersion
                                }));
                                return;
                            }
                            
                            const releaseData = JSON.parse(data);
                            const latestVersion = releaseData.tag_name.replace('v', '');
                            const releaseDate = releaseData.published_at.substring(0, 10);
                            const latestChanges = releaseData.body || 'Sem informações de mudanças disponíveis.';
                            
                            // Função simples para comparar versões
                            function compareVersions(v1, v2) {
                                const parts1 = v1.split('.').map(Number);
                                const parts2 = v2.split('.').map(Number);
                                
                                for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
                                    const part1 = parts1[i] || 0;
                                    const part2 = parts2[i] || 0;
                                    
                                    if (part1 > part2) return 1;
                                    if (part1 < part2) return -1;
                                }
                                return 0;
                            }
                            
                            const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
                            
                            if (hasUpdate) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    update_available: true,
                                    current_version: currentVersion,
                                    latest_version: latestVersion,
                                    release_date: releaseDate,
                                    changes: latestChanges,
                                    download_url: releaseData.html_url || ''
                                }));
                            } else {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    update_available: false,
                                    current_version: currentVersion,
                                    latest_version: latestVersion
                                }));
                            }
                        } catch (parseError) {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                status: 'error',
                                message: 'Erro ao processar resposta do GitHub',
                                current_version: currentVersion
                            }));
                        }
                    });
                });
                
                request.on('error', (error) => {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'error',
                        message: 'Erro de conexão ao verificar atualizações',
                        current_version: currentVersion,
                        error_details: error.message
                    }));
                });
                
                request.on('timeout', () => {
                    request.destroy();
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'error',
                        message: 'Timeout ao verificar atualizações',
                        current_version: currentVersion
                    }));
                });
                
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: 'Erro interno ao verificar atualizações',
                    current_version: config.version.version || '2.0.0',
                    error_details: error.message
                }));
            }
            return;
        }
        
        // API para verificar atualizações (rota legada sem autenticação)
        if (pathname === '/api/check-update' && method === 'GET') {
            try {
                const currentVersion = config.version.version || '2.0.0';
                const githubApiUrl = 'https://api.github.com/repos/Sploit23/kiosk-updates/releases/latest';
                
                const https = require('https');
                const request = https.get(githubApiUrl, { timeout: 10000 }, (response) => {
                    let data = '';
                    
                    response.on('data', (chunk) => {
                        data += chunk;
                    });
                    
                    response.on('end', () => {
                        try {
                            if (response.statusCode !== 200) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({
                                    update_available: false,
                                    current_version: currentVersion,
                                    error: 'Não foi possível verificar atualizações'
                                }));
                                return;
                            }
                            
                            const releaseData = JSON.parse(data);
                            const latestVersion = releaseData.tag_name.replace('v', '');
                            
                            // Função simples para comparar versões
                            function compareVersions(v1, v2) {
                                const parts1 = v1.split('.').map(Number);
                                const parts2 = v2.split('.').map(Number);
                                
                                for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
                                    const part1 = parts1[i] || 0;
                                    const part2 = parts2[i] || 0;
                                    
                                    if (part1 > part2) return 1;
                                    if (part1 < part2) return -1;
                                }
                                return 0;
                            }
                            
                            const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
                            
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                update_available: hasUpdate,
                                current_version: currentVersion,
                                latest_version: latestVersion
                            }));
                        } catch (parseError) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                update_available: false,
                                current_version: currentVersion,
                                error: 'Erro ao processar informações de atualização'
                            }));
                        }
                    });
                });
                
                request.on('error', () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        update_available: false,
                        current_version: currentVersion,
                        error: 'Erro de conexão'
                    }));
                });
                
                request.on('timeout', () => {
                    request.destroy();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        update_available: false,
                        current_version: currentVersion,
                        error: 'Timeout na verificação'
                    }));
                });
                
            } catch (error) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    update_available: false,
                    current_version: config.version.version || '2.0.0',
                    error: 'Erro interno'
                }));
            }
            return;
        }


        // API de login
        if (pathname === '/api/login' && method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, redirect: '/config' }));
            return;
        }

        // API de impressoras - carrega diretamente do sistema
        if (pathname === '/api/printers' && method === 'GET') {
            try {
                const { spawn } = require('child_process');
                // Usar spawn com PowerShell para melhor controle
                const child = spawn('powershell.exe', ['-Command', 'Get-Printer | Select-Object Name, PrinterStatus, DriverName, PortName | ConvertTo-Json'], {
                    stdio: ['pipe', 'pipe', 'pipe']
                });
                
                let stdout = '';
                let stderr = '';
                
                child.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                
                child.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                
                child.on('error', (error) => {
                    console.error('🚫 Erro ao executar PowerShell:', error);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Erro ao executar comando PowerShell' }));
                });
                
                child.on('close', (code) => {
                    if (code !== 0) {
                        console.error('🚫 Erro ao carregar impressoras do sistema:', stderr);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Erro ao acessar impressoras do sistema' }));
                        return;
                    }
                    
                    try {
                        let systemPrinters = [];
                        
                        if (stdout.trim()) {
                            const printerData = JSON.parse(stdout);
                            const printerArray = Array.isArray(printerData) ? printerData : [printerData];
                            
                            systemPrinters = printerArray.map(printer => {
                                // Mapear status da impressora
                                let status = 'ready';
                                if (printer.PrinterStatus && printer.PrinterStatus !== 0) {
                                    status = 'offline';
                                }
                                
                                // Determinar tipo baseado na porta
                                let type = 'local';
                                if (printer.PortName && (printer.PortName.includes('IP_') || printer.PortName.includes('TCP') || printer.PortName.includes('WSD'))) {
                                    type = 'network';
                                }
                                
                                // Extrair IP se for impressora de rede
                                let ip = '';
                                if (type === 'network' && printer.PortName) {
                                    const ipMatch = printer.PortName.match(/IP_([0-9.]+)/);
                                    if (ipMatch) {
                                        ip = ipMatch[1];
                                    }
                                }
                                
                                return {
                                    name: printer.Name,
                                    status: status,
                                    type: type,
                                    ip: ip,
                                    driver: printer.DriverName || 'Driver desconhecido',
                                    port: printer.PortName || 'Porta desconhecida',
                                    description: `${printer.DriverName || 'Impressora'} (${printer.PortName || 'Porta desconhecida'})`
                                };
                            });
                        }
                        
                        console.log(`🖨️ Carregadas ${systemPrinters.length} impressoras do sistema:`);
                        systemPrinters.forEach(printer => {
                            console.log(`   - ${printer.name} (${printer.status}) - ${printer.type}`);
                        });
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(systemPrinters));
                        
                    } catch (parseError) {
                        console.error('Erro ao processar dados das impressoras:', parseError);
                        console.error('Saída do PowerShell:', stdout);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Erro ao processar dados das impressoras' }));
                    }
                });
                
            } catch (error) {
                console.error('Erro na API de impressoras:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Erro interno do servidor' }));
            }
            return;
        }
        
        // API para adicionar/editar impressoras
        if (pathname === '/api/printers' && method === 'POST') {
            if (!isAuthenticated(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Não autenticado' }));
                return;
            }
            
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const newPrinter = JSON.parse(body);
                    
                    // Validar dados da impressora
                    if (!newPrinter.name || !newPrinter.type) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Nome e tipo da impressora são obrigatórios' }));
                        return;
                    }
                    
                    // Carregar lista atual
                    let printersList;
                    try {
                        const data = fs.readFileSync(getConfigPath('printers_list.json'), 'utf8');
                        printersList = JSON.parse(data);
                    } catch (error) {
                        printersList = { "printers": [] };
                    }
                    
                    // Verificar se já existe uma impressora com o mesmo nome
                    const existingIndex = printersList.printers.findIndex(p => p.name === newPrinter.name);
                    
                    if (existingIndex >= 0) {
                        // Atualizar impressora existente
                        printersList.printers[existingIndex] = {
                            name: newPrinter.name,
                            status: newPrinter.status || 'ready',
                            type: newPrinter.type,
                            ip: newPrinter.ip || '',
                            port: newPrinter.port || '',
                            description: newPrinter.description || ''
                        };
                    } else {
                        // Adicionar nova impressora
                        printersList.printers.push({
                            name: newPrinter.name,
                            status: newPrinter.status || 'ready',
                            type: newPrinter.type,
                            ip: newPrinter.ip || '',
                            port: newPrinter.port || '',
                            description: newPrinter.description || ''
                        });
                    }
                    
                    // Salvar lista atualizada
                    fs.writeFileSync(getConfigPath('printers_list.json'), JSON.stringify(printersList, null, 2));
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        message: 'Impressora salva com sucesso',
                        printer: newPrinter.name
                    }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Dados inválidos' }));
                }
            });
            return;
        }
        
        // API para remover impressora
        if (pathname === '/api/printers' && method === 'DELETE') {
            if (!isAuthenticated(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Não autenticado' }));
                return;
            }
            
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const { printer_name } = JSON.parse(body);
                    
                    if (!printer_name) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Nome da impressora é obrigatório' }));
                        return;
                    }
                    
                    // Carregar lista atual
                    let printersList;
                    try {
                        const data = fs.readFileSync(getConfigPath('printers_list.json'), 'utf8');
                        printersList = JSON.parse(data);
                    } catch (error) {
                        printersList = { "printers": [] };
                    }
                    
                    // Remover impressora
                    printersList.printers = printersList.printers.filter(p => p.name !== printer_name);
                    
                    // Salvar lista atualizada
                    fs.writeFileSync(getConfigPath('printers_list.json'), JSON.stringify(printersList, null, 2));
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        message: 'Impressora removida com sucesso'
                    }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Dados inválidos' }));
                }
            });
            return;
        }
        
        // API para descobrir impressoras no sistema
        if (pathname === '/api/discover-printers' && method === 'POST') {
            if (!isAuthenticated(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Não autenticado' }));
                return;
            }
            
            try {
                const { exec } = require('child_process');
                
                // Comando PowerShell para listar impressoras instaladas com status detalhado
                const command = 'powershell -Command "Get-Printer | Select-Object Name, DriverName, PortName, PrinterStatus, WorkflowPolicy | ConvertTo-Json"';
                
                exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
                    if (error) {
                        console.error('Erro ao descobrir impressoras:', error);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: false, 
                            error: 'Erro ao acessar impressoras do sistema',
                            message: 'Falha ao executar comando de descoberta'
                        }));
                        return;
                    }
                    
                    try {
                        let printers = [];
                        
                        if (stdout.trim()) {
                            const printerData = JSON.parse(stdout);
                            const printerArray = Array.isArray(printerData) ? printerData : [printerData];
                            
                            printers = printerArray.map(printer => {
                                // Verificar status real da impressora
                                let status = 'unknown';
                                if (printer.PrinterStatus === 0) {
                                    status = 'ready';
                                } else if (printer.PrinterStatus === 1 || printer.PrinterStatus === 2) {
                                    status = 'offline';
                                } else {
                                    status = 'unknown';
                                }
                                
                                return {
                                    name: printer.Name || 'Impressora Desconhecida',
                                    type: printer.PortName && printer.PortName.includes('IP_') ? 'network' : 'local',
                                    ip: printer.PortName && printer.PortName.includes('IP_') ? printer.PortName.replace('IP_', '') : '',
                                    port: '',
                                    status: status,
                                    driver: printer.DriverName || 'Driver Desconhecido',
                                    description: `${printer.DriverName || 'Driver Desconhecido'} - ${printer.PortName || 'Porta Desconhecida'}`
                                };
                            });
                        }
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: true, 
                            printers: printers,
                            message: `Encontradas ${printers.length} impressoras no sistema`
                        }));
                        
                    } catch (parseError) {
                        console.error('Erro ao processar dados das impressoras:', parseError);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: false, 
                            error: 'Erro ao processar dados das impressoras',
                            message: 'Falha ao interpretar resposta do sistema'
                        }));
                    }
                });
                
            } catch (error) {
                console.error('Erro geral na descoberta de impressoras:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: false, 
                    error: 'Erro interno do servidor',
                    message: 'Falha na descoberta de impressoras'
                }));
            }
            return;
        }


        // API de configuração de impressoras
        if (pathname === '/api/printer-config' && method === 'GET') {
            const cfg = loadJSON(getConfigPath('printer_config.json'), {});
            const normalized = { ...cfg };
            // Construir "formats" a partir de "format_mappings" se necessário
            if (!normalized.formats && normalized.format_mappings) {
                normalized.formats = {};
                Object.keys(normalized.format_mappings).forEach(k => {
                    const m = normalized.format_mappings[k] || {};
                    normalized.formats[k] = {
                        printer: m.printer,
                        paperSize: m.paperSize || k,
                        printSize: m.paperSize === '6x8' ? '6x8' : (m.paperSize === '6x4' ? '6x4' : (m.printSize || 'custom'))
                    };
                });
            }
            // Construir "format_mappings" a partir de "formats" se necessário
            if (!normalized.format_mappings && normalized.formats) {
                normalized.format_mappings = {};
                Object.keys(normalized.formats).forEach(k => {
                    const f = normalized.formats[k] || {};
                    normalized.format_mappings[k] = {
                        printer: f.printer,
                        paperSize: f.paperSize || k
                    };
                });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(normalized));
            return;
        }

        // API para salvar configuração de impressoras
        if (pathname === '/api/printer-config' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const printerConfig = JSON.parse(body);
                    const configPath = getConfigPath('printer_config.json');
                    
                    console.log('💾 Salvando configuração de impressora:', configPath);
                    console.log('📋 Dados:', JSON.stringify(printerConfig, null, 2));
                    
                    const saved = saveJSON(configPath, printerConfig);
                    
                    if (saved) {
                        console.log('✅ Configuração de impressora salva com sucesso');
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Configuração de impressora salva com sucesso' }));
                    } else {
                        console.error('❌ Falha ao salvar configuração de impressora');
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Falha ao salvar configuração' }));
                    }
                } catch (error) {
                    console.error('❌ Erro ao processar configuração:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Dados inválidos' }));
                }
            });
            return;
        }

        // API para tamanhos de papel da impressora usando PowerShell
        if (pathname.startsWith('/api/printer-paper-sizes/') && method === 'GET') {
            const printerName = decodeURIComponent(pathname.split('/api/printer-paper-sizes/')[1]);
            
            try {
                // Comando PowerShell para abrir as preferências de impressão da impressora
                const command = `rundll32 printui.dll,PrintUIEntry /e /n "${printerName}"`;
                
                // Primeiro, vamos tentar obter informações básicas da impressora
                const infoCommand = `Get-Printer -Name "${printerName}" | Select-Object Name, DriverName, PortName`;
                
                exec(infoCommand, { shell: 'powershell.exe' }, (error, stdout, stderr) => {
                    let paperSizes = [];
                    
                    if (error) {
                        console.error('Erro ao obter informações da impressora:', error);
                    } else {
                        console.log('Informações da impressora:', stdout);
                    }
                    
                    // Tamanhos de papel baseados no tipo de impressora
                    if (printerName.includes('ASK-300') || printerName.includes('ASK-400')) {
                        paperSizes = [
                            { value: '6x4', name: '6x4 polegadas (15x10 cm)' },
                            { value: '4x6', name: '4x6 polegadas (10x15 cm)' },
                            { value: '6x8', name: '6x8 polegadas (15x20 cm)' },
                            { value: '8x10', name: '8x10 polegadas (20x25 cm)' }
                        ];
                    } else if (printerName.toLowerCase().includes('photo')) {
                        paperSizes = [
                            { value: '4x6', name: '4x6 polegadas (10x15 cm)' },
                            { value: '5x7', name: '5x7 polegadas (13x18 cm)' },
                            { value: '6x8', name: '6x8 polegadas (15x20 cm)' },
                            { value: '8x10', name: '8x10 polegadas (20x25 cm)' }
                        ];
                    } else {
                        // Tamanhos padrão para impressoras comuns
                        paperSizes = [
                            { value: 'A4', name: 'A4 (21x29.7 cm)' },
                            { value: 'A5', name: 'A5 (14.8x21 cm)' },
                            { value: 'A6', name: 'A6 (10.5x14.8 cm)' },
                            { value: '4x6', name: '4x6 polegadas (10x15 cm)' },
                            { value: '6x8', name: '6x8 polegadas (15x20 cm)' }
                        ];
                    }
                     
                     res.writeHead(200, { 'Content-Type': 'application/json' });
                     res.end(JSON.stringify({
                         printer: printerName,
                         paper_sizes: paperSizes
                     }));
                 });
            } catch (error) {
                console.error('Erro ao executar comando PowerShell:', error);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Erro interno do servidor' }));
            }
            return;
        }

        if (pathname === '/api/printer-windows-config' && method === 'GET') {
            try {
                let target = String(parsedUrl.query?.name || '').trim();
                if (!target) {
                    const printerCfg = loadJSON(getConfigPath('printer_config.json'), {});
                    target = printerCfg.user_preferences?.default_printer || printerCfg.last_used_printer || '';
                }
                if (!target) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Nome da impressora não fornecido' }));
                    return;
                }
                const cmd = `Get-PrintConfiguration -PrinterName "${target}" | ConvertTo-Json -Depth 4`;
                exec(cmd, { shell: 'powershell.exe' }, (error, stdout, stderr) => {
                    if (error) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Falha ao obter configuração', details: String(error.message || stderr || '').trim() }));
                        return;
                    }
                    let cfg = {};
                    try { cfg = JSON.parse(stdout); } catch (_) {}
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ printer: target, configuration: cfg }));
                });
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Erro interno' }));
            }
            return;
        }











        // API de impressão com Windows nativo (substituindo Java)
        // API /api/print-batch-java removida - dependia de scripts Java ausentes



        // API de configuração
         if (pathname === '/api/config' && method === 'GET') {
             if (!isAuthenticated(req)) {
                 res.writeHead(401, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ error: 'Não autenticado' }));
                 return;
             }
             
             const configData = {
                 server_config: config.server,
                 image_settings: config.image_settings,
                 themes: loadJSON('../../config/themes.json', { current_theme: 'default', available_themes: [] })
             };
             
             res.writeHead(200, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify(configData));
             return;
         }
         
         if (pathname === '/api/config/update' && method === 'POST') {
             if (!isAuthenticated(req)) {
                 res.writeHead(401, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ error: 'Não autenticado' }));
                 return;
             }
             
             let body = '';
             req.on('data', chunk => body += chunk.toString());
             req.on('end', () => {
                 try {
                     const data = JSON.parse(body);
                     if (data.image_path) {
                         // Atualiza apenas a configuração relevante
                         config.image_settings.base_path = data.image_path;
                         
                         // Salva o arquivo de configuração correto usando o helper
                         const saved = saveJSON(getConfigPath('image_settings.json'), config.image_settings);
                         
                         if (saved) {
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'success', message: 'Configurações atualizadas com sucesso' }));
                         } else {
                            res.writeHead(500, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ status: 'error', message: 'Falha ao salvar o arquivo de configuração de imagens.' }));
                         }
                     } else {
                         res.writeHead(400, { 'Content-Type': 'application/json' });
                         res.end(JSON.stringify({ status: 'error', message: 'Caminho da pasta de imagens não fornecido' }));
                     }
                 } catch (error) {
                     res.writeHead(500, { 'Content-Type': 'application/json' });
                     res.end(JSON.stringify({ status: 'error', message: `Erro ao atualizar configurações: ${error.message}` }));
                 }
             });
             return;
         }
         
         // API para salvar formato de data
        if (pathname === '/api/config/date-format' && method === 'POST') {
             if (!isAuthenticated(req)) {
                 res.writeHead(401, { 'Content-Type': 'application/json' });
                 res.end(JSON.stringify({ error: 'Não autenticado' }));
                 return;
             }
             
             let body = '';
             req.on('data', chunk => body += chunk.toString());
             req.on('end', () => {
                 try {
                     const data = JSON.parse(body);
                     
                    if (!data.folder_format || !['DDMMYY', 'DDMMYYYY', 'YYMMDD', 'YYYYMMDD'].includes(data.folder_format)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Formato de data inválido. Use DDMMYY, DDMMYYYY, YYMMDD ou YYYYMMDD.' }));
                        return;
                    }
                     
                     // Atualizar configuração de formato de data
                    if (!config.settings.date_format) {
                        config.settings.date_format = {};
                    }
                    config.settings.date_format.folder_format = data.folder_format;
                    config.settings.date_format.description = 'Formato de pasta de data para busca de imagens (DDMMYY, DDMMYYYY, YYMMDD ou YYYYMMDD)';
                     
                     // Salvar configurações atualizadas
                     saveJSON(getConfigPath('settings.json'), config.settings);
                     
                     console.log(`📅 Formato de data alterado para: ${data.folder_format}`);
                     
                     res.writeHead(200, { 'Content-Type': 'application/json' });
                     res.end(JSON.stringify({ 
                         status: 'success', 
                         message: `Formato de data alterado para ${data.folder_format} com sucesso!`,
                         folder_format: data.folder_format
                     }));
                 } catch (error) {
                     console.error('Erro ao salvar formato de data:', error);
                     res.writeHead(500, { 'Content-Type': 'application/json' });
                     res.end(JSON.stringify({ error: `Erro ao salvar formato de data: ${error.message}` }));
                 }
             });
             return;
         }
         
         // API de informações do sistema
        if (pathname === '/api/system/info' && method === 'GET') {
            if (!isAuthenticated(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Não autenticado' }));
                return;
            }
            
            const systemInfo = {
                version: config.version.version || '2.0.0',
                build_date: config.version.build_date || new Date().toISOString().split('T')[0],
                build_number: config.version.build_number || '1',
                status: 'Operacional',
                java_integration: 'Ativo',
                platform: process.platform,
                node_version: process.version,
                uptime: process.uptime(),
                memory_usage: process.memoryUsage(),
                timestamp: new Date().toISOString()
            };
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(systemInfo));
            return;
        }

        if (pathname === '/api/system/network' && method === 'GET') {
            try {
                const nets = os.networkInterfaces();
                const ipv4 = [];
                Object.keys(nets).forEach(name => {
                    nets[name].forEach(net => {
                        if (net.family === 'IPv4' && !net.internal) {
                            ipv4.push(net.address);
                        }
                    });
                });
                const port = PORT;
                const urls = [];
                urls.push(`http://localhost:${port}`);
                urls.push(`http://127.0.0.1:${port}`);
                ipv4.forEach(ip => urls.push(`http://${ip}:${port}`));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ port, host: HOST, ips: ipv4, urls }));
            } catch (error) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ port: PORT, host: HOST, ips: [], urls: [`http://localhost:${PORT}`] }));
            }
            return;
        }

         // API para obter tema atual
        if (pathname === '/api/current-theme' && method === 'GET') {
            try {
                const themeConfigPath = getConfigPath('current_theme.json');
                let currentTheme = loadJSON(themeConfigPath, {});
                if (!currentTheme || !currentTheme.theme_id) {
                    currentTheme = { theme_id: 'default', updated_at: new Date().toISOString() };
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(currentTheme));
            } catch (error) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ theme_id: 'default' }));
            }
            return;
        }


        if (pathname === '/api/personalization' && method === 'GET') {
            try {
                const pPath = getConfigPath('personalization.json');
                const defaults = {
                    header_text: 'Fotos Mágicas',
                    header_bg_color: '#2c3e50',
                    header_text_color: '#ffffff',
                    accent_color: '#8b0000',
                    header_font_size: 20,
                    header_height: 80,
                    sidebar_width: 260,
                    thumb_border_radius: 5,
                    thumb_gap: 8,
                    sidebar_thumb_height: 120,
                    clear_background_mode: false,
                    enable_premium_theme: false,
                    disable_photo_shadow: false,
                    enable_snow_effect: false,
                    logo_text: '',
                    logo_image_url: '',
                    default_variant: '10x15',
                    main_photo_max_width: 900,
                    main_photo_max_height: 700,
                    sidebar_bg_color: '#8b0000',
                    body_bg_color: '#2c3e50',
                    enable_vignette: false,
                    vignette_intensity: 0.12,
                    enable_glow: false
                };
                const data = loadJSON(pPath, defaults);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            } catch (error) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    header_text: 'Fotos Mágicas',
                    header_bg_color: '#2c3e50',
                    header_text_color: '#ffffff',
                    accent_color: '#8b0000',
                    header_font_size: 20,
                    header_height: 80,
                    sidebar_width: 260,
                    thumb_border_radius: 5,
                    thumb_gap: 8,
                    sidebar_thumb_height: 120,
                    clear_background_mode: false,
                    enable_premium_theme: false,
                    disable_photo_shadow: false,
                    enable_snow_effect: false,
                    logo_text: '',
                    logo_image_url: '',
                    default_variant: '10x15',
                    main_photo_max_width: 900,
                    main_photo_max_height: 700,
                    sidebar_bg_color: '#8b0000',
                    body_bg_color: '#2c3e50',
                    enable_vignette: false,
                    vignette_intensity: 0.12,
                    enable_glow: false
                }));
            }
            return;
        }

        if (pathname === '/api/save-personalization' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const pPath = getConfigPath('personalization.json');
                    const payload = {
                        header_text: String(data.header_text || 'Fotos Mágicas'),
                        header_bg_color: String(data.header_bg_color || '#2c3e50'),
                        header_text_color: String(data.header_text_color || '#ffffff'),
                        accent_color: String(data.accent_color || '#3498db'),
                        header_font_size: Number.isFinite(parseInt(data.header_font_size)) ? parseInt(data.header_font_size) : 20,
                        header_height: Number.isFinite(parseInt(data.header_height)) ? parseInt(data.header_height) : 80,
                        sidebar_width: Number.isFinite(parseInt(data.sidebar_width)) ? parseInt(data.sidebar_width) : 260,
                        thumb_border_radius: Number.isFinite(parseInt(data.thumb_border_radius)) ? parseInt(data.thumb_border_radius) : 5,
                        thumb_gap: Number.isFinite(parseInt(data.thumb_gap)) ? parseInt(data.thumb_gap) : 8,
                        sidebar_thumb_height: Number.isFinite(parseInt(data.sidebar_thumb_height)) ? parseInt(data.sidebar_thumb_height) : 120,
                        clear_background_mode: !!data.clear_background_mode,
                        enable_premium_theme: !!data.enable_premium_theme,
                        disable_photo_shadow: !!data.disable_photo_shadow,
                        enable_snow_effect: !!data.enable_snow_effect,
                        logo_text: String(data.logo_text || ''),
                        logo_image_url: String(data.logo_image_url || ''),
                        default_variant: String(data.default_variant || '10x15'),
                        main_photo_max_width: Number.isFinite(parseInt(data.main_photo_max_width)) ? parseInt(data.main_photo_max_width) : 900,
                        main_photo_max_height: Number.isFinite(parseInt(data.main_photo_max_height)) ? parseInt(data.main_photo_max_height) : 700,
                        sidebar_bg_color: String(data.sidebar_bg_color || '#1f2a35'),
                        body_bg_color: String(data.body_bg_color || '#10161b'),
                        enable_vignette: !!data.enable_vignette,
                        vignette_intensity: Number.isFinite(parseFloat(data.vignette_intensity)) ? Math.max(0, Math.min(0.5, parseFloat(data.vignette_intensity))) : 0.12,
                        enable_glow: !!data.enable_glow,
                        updated_at: new Date().toISOString()
                    };
                    const ok = saveJSON(pPath, payload);
                    if (ok) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, personalization: payload }));
                    } else {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Falha ao salvar' }));
                    }
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Dados inválidos' }));
                }
            });
            return;
        }

        if (pathname === '/api/reset-personalization' && method === 'POST') {
            try {
                const pPath = getConfigPath('personalization.json');
                const defaults = {
                    header_text: 'Fotos Mágicas',
                    header_bg_color: '#2c3e50',
                    header_text_color: '#ffffff',
                    accent_color: '#8b0000',
                    header_font_size: 20,
                    header_height: 80,
                    sidebar_width: 260,
                    thumb_border_radius: 5,
                    thumb_gap: 8,
                    sidebar_thumb_height: 120,
                    enable_snow_effect: false,
                    logo_text: '',
                    logo_image_url: '',
                    default_variant: '10x15',
                    main_photo_max_width: 900,
                    main_photo_max_height: 700,
                    sidebar_bg_color: 'linear-gradient(135deg, #c41e3a 0%, #8b0000 100%)',
                    body_bg_color: 'radial-gradient(ellipse at center, #1e3c72, #0f4c75)',
                    enable_vignette: false,
                    enable_glow: false,
                    updated_at: new Date().toISOString()
                };
                saveJSON(pPath, defaults);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, personalization: defaults }));
            } catch (error) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false }));
            }
            return;
        }

        // API de impressão com impressora configurada (Windows nativo)
        if (pathname === '/api/print-configured' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const printData = JSON.parse(body);
                    const { image_data, printer_name, paper_size, copies = 1 } = printData;
                    
                    console.log('Solicitação de impressão configurada:', { printer_name, paper_size, copies });
                    
                    // Carregar configuração de impressoras
                    const printerConfigPath = getConfigPath('printer_config.json');
                    const printerConfig = loadJSON(printerConfigPath, {});
                    
                    // Determinar impressora baseada no formato configurado
                    let targetPrinter = printer_name;
                    let targetFormat = paper_size;
                    
                    // Verificar se existe mapeamento de formato para impressora
                    if (printerConfig.format_mappings && printerConfig.format_mappings[paper_size]) {
                        const formatMapping = printerConfig.format_mappings[paper_size];
                        if (formatMapping.printer) {
                            targetPrinter = formatMapping.printer;
                            console.log(`📋 Usando mapeamento de formato: ${paper_size} -> ${targetPrinter}`);
                        }
                    }
                    
                    // Fallback: usar configuração padrão se não houver mapeamento
                    if (!targetPrinter && printerConfig.user_preferences) {
                        targetPrinter = printerConfig.user_preferences.default_printer;
                        console.log(`📋 Usando impressora padrão: ${targetPrinter}`);
                    }
                    
                    // Salvar imagem temporária
                    const tempDir = path.join(userDataPath, 'temp');
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }
                    
                    const tempFileName = `${paper_size}_${Date.now()}.jpg`;
                    const tempFilePath = path.join(tempDir, tempFileName);
                    
                    // Converter base64 para arquivo
                    const base64Data = image_data.replace(/^data:image\/[a-z]+;base64,/, '');
                    fs.writeFileSync(tempFilePath, base64Data, 'base64');
                    
                    console.log(`💾 Imagem salva: ${tempFilePath}`);
                    console.log(`🖨️ Impressora alvo: ${targetPrinter}`);
                    console.log(`📏 Formato: ${targetFormat}`);
                    
                    try {
                        // Usar impressão nativa do Windows (como Program.cs)
                        const result = await executeWindowsNativePrint(tempFilePath, targetPrinter, targetFormat, copies);
                        
                        // Limpar arquivo temporário após impressão
                        setTimeout(() => {
                            try {
                                if (fs.existsSync(tempFilePath)) {
                                    fs.unlinkSync(tempFilePath);
                                    console.log(`🗑️ Arquivo temporário removido: ${tempFileName}`);
                                }
                            } catch (cleanupError) {
                                console.error('Erro ao limpar arquivo temporário:', cleanupError);
                            }
                        }, 5000);
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            message: `Impressão enviada via Windows nativo para ${targetPrinter}`,
                            printer: targetPrinter,
                            paper_size: targetFormat,
                            copies: copies,
                            method: 'windows_native',
                            results: result.results
                        }));
                        
                    } catch (error) {
                        console.error('Erro na impressão Windows nativa:', error);
                        
                        // Limpar arquivo temporário em caso de erro
                        try {
                            if (fs.existsSync(tempFilePath)) {
                                fs.unlinkSync(tempFilePath);
                            }
                        } catch (cleanupError) {
                            console.warn('Erro ao limpar arquivo temporário:', cleanupError);
                        }
                        
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            message: 'Erro na impressão via Windows nativo',
                            error: error.error || error.message,
                            printer: targetPrinter,
                            paper_size: targetFormat
                        }));
                    }
                    
                } catch (error) {
                    console.error('Erro na API de impressão configurada:', error);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        message: 'Dados inválidos',
                        error: error.message 
                    }));
                }
            });
            return;
        }

        if (pathname === '/api/mover-config' && method === 'GET') {
            const moveCfgPath = getConfigPath('move_settings.json');
            const defaultSrc = getImagesFolderPath();
            const cfg = loadJSON(moveCfgPath, { src: defaultSrc, dst: path.join(userDataPath, 'moved') });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(cfg));
            return;
        }

        if (pathname === '/api/mover-config' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const moveCfgPath = getConfigPath('move_settings.json');
                    const defaultSrc = getImagesFolderPath();
                    const payload = {
                        src: String(data.src || defaultSrc || ''),
                        dst: String(data.dst || path.join(userDataPath, 'moved'))
                    };
                    const ok = saveJSON(moveCfgPath, payload);
                    if (ok) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, config: payload }));
                    } else {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false }));
                    }
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Dados inválidos' }));
                }
            });
            return;
        }

        if (pathname === '/api/move-today' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const data = body ? JSON.parse(body) : {};
                    const moveCfgPath = getConfigPath('move_settings.json');
                    const moveCfg = loadJSON(moveCfgPath, { src: getImagesFolderPath(), dst: path.join(userDataPath, 'moved') });
                    const srcRoot = data.src || moveCfg.src || getImagesFolderPath();
                    if (!srcRoot || !fs.existsSync(srcRoot)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Pasta de imagens não configurada' }));
                        return;
                    }
                    const today = new Date();
                    const todayName = buildDateFolderName(today);
                    const regex = getFolderRegexForFormat();
                    let srcSub = '';
                    let effectiveFolderName = '';
                    // Caso 1: usuário escolheu diretamente a pasta do dia
                    try {
                        const baseName = path.basename(srcRoot);
                        if (regex.test(baseName) && fs.statSync(srcRoot).isDirectory()) {
                            srcSub = srcRoot;
                            effectiveFolderName = baseName;
                        }
                    } catch (_) {}
                    // Caso 2: existe subpasta do dia dentro da origem
                    if (!srcSub) {
                        const candidate = path.join(srcRoot, todayName);
                        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
                            srcSub = candidate;
                            effectiveFolderName = todayName;
                        }
                    }
                    // Caso 3: fallback para pasta de data mais recente disponível
                    if (!srcSub) {
                        try {
                            const entries = fs.readdirSync(srcRoot, { withFileTypes: true });
                            const datedDirs = entries
                                .filter(e => e.isDirectory() && regex.test(e.name))
                                .map(e => {
                                    const p = path.join(srcRoot, e.name);
                                    const stat = fs.statSync(p);
                                    return { name: e.name, path: p, mtimeMs: stat.mtimeMs };
                                })
                                .sort((a, b) => b.mtimeMs - a.mtimeMs);
                            if (datedDirs.length) {
                                srcSub = datedDirs[0].path;
                                effectiveFolderName = datedDirs[0].name;
                            }
                        } catch (_) {}
                    }
                    // Caso 4: mover diretamente o conteúdo da pasta escolhida
                    if (!srcSub) {
                        srcSub = srcRoot;
                        effectiveFolderName = path.basename(srcRoot) || todayName;
                    }
                    const dstRoot = data.dst || moveCfg.dst || path.join(userDataPath, 'moved');
                    if (!fs.existsSync(dstRoot)) fs.mkdirSync(dstRoot, { recursive: true });
                    const dstSub = path.join(dstRoot, effectiveFolderName);
                    if (!fs.existsSync(dstSub)) fs.mkdirSync(dstSub, { recursive: true });
                    let files = [];
                    const walk = (dir, relBase) => {
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const e of entries) {
                            const p = path.join(dir, e.name);
                            const rel = path.join(relBase, e.name);
                            if (e.isDirectory()) walk(p, rel);
                            else files.push({ full: p, rel });
                        }
                    };
                    walk(srcSub, '');
                    let moved = 0;
                    notifyClients('move-progress', { moved: 0, total: files.length, pct: files.length ? 0 : 100, src: srcSub, dst: dstSub });
                    for (const f of files) {
                        const target = path.join(dstSub, f.rel);
                        const dir = path.dirname(target);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                        try {
                            fs.renameSync(f.full, target);
                            moved++;
                        } catch (err) {
                            try {
                                fs.copyFileSync(f.full, target);
                                fs.unlinkSync(f.full);
                                moved++;
                            } catch {}
                        }
                        notifyClients('move-progress', { moved, total: files.length, pct: files.length ? Math.round((moved / files.length) * 100) : 100, src: srcSub, dst: dstSub });
                    }
                    let remaining = 0;
                    try { remaining = fs.readdirSync(srcSub).length; } catch {}
                    notifyClients('move-progress', { moved, total: files.length, pct: files.length ? Math.round((moved / files.length) * 100) : 100, src: srcSub, dst: dstSub });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, moved, total: files.length, src: srcSub, dst: dstSub, remaining }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Erro ao mover' }));
                }
            });
            return;
        }

        if (normalizedPath === '/api/ui/thumbnail-size' && method === 'GET') {
            const imageConfigPath = getConfigPath('image_settings.json');
            const cfg = loadJSON(imageConfigPath, {});
            const sizeArr = cfg.thumbnail_size || [100, 100];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ size: parseInt(sizeArr[0] || 100, 10) }));
            return;
        }

        if (normalizedPath === '/api/ui/thumbnail-size' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    const size = parseInt(data.size, 10);
                    if (!size || size < 40 || size > 400) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Tamanho inválido' }));
                        return;
                    }
                    const imageConfigPath = getConfigPath('image_settings.json');
                    const cfg = loadJSON(imageConfigPath, {});
                    cfg.thumbnail_size = [size, size];
                    saveJSON(imageConfigPath, cfg);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, size }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Dados inválidos' }));
                }
            });
            return;
        }

        // API /api/print-java removida - dependia de scripts Java ausentes
        
        // API de impressão (mantida para compatibilidade)
        if (pathname === '/api/print' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const printData = JSON.parse(body);
                    const { imagePath, printerName, paperSize, copies } = printData;
                    
                    console.log('🖨️ Solicitação de impressão recebida:', { imagePath, printerName, paperSize, copies });
                    
                    // Construir caminho completo da imagem
                    const today = new Date();
                    const todayFormatted = buildDateFolderName(today);
                    
                    const imagesDir = getImagesFolderPath();
                    const basePath = config.image_settings?.base_path || imagesDir;
                    let fullImagePath = imagePath;

                    // Se vier absoluto, usar direto
                    if (!path.isAbsolute(fullImagePath)) {
                        fullImagePath = path.join(imagesDir, imagePath);
                    }
                    const allowedExtensions = (config.image_settings?.allowed_extensions) || ['.jpg', '.jpeg', '.png', '.gif'];
                    
                    // Resolver extensão ausente automaticamente (ex.: '10x15_20251115_115517')
                    if (!fs.existsSync(fullImagePath) && !path.extname(imagePath)) {
                        for (const ext of allowedExtensions) {
                            const candidate = path.join(imagesDir, imagePath + ext);
                            if (fs.existsSync(candidate)) {
                                console.log(`🔎 Extensão resolvida automaticamente: ${candidate}`);
                                fullImagePath = candidate;
                                break;
                            }
                        }
                    }
                    
                    console.log('📁 Pasta do dia:', todayFormatted);
                    console.log('📄 Arquivo solicitado:', imagePath);
                    
                    console.log('🔍 Verificando arquivo:', fullImagePath);
                    
                    if (!fs.existsSync(fullImagePath)) {
                        console.error('❌ Arquivo não encontrado:', fullImagePath);
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: false, 
                            message: 'Imagem não encontrada',
                            path: fullImagePath
                        }));
                        return;
                    }
                    
                    try {
                        console.log('🚀 Executando impressão nativa do Windows...');
                        // Resolver impressora padrão se necessário
                        let targetPrinter = printerName;
                        if (!targetPrinter || targetPrinter === 'default') {
                            const printerConfigPath = getConfigPath('printer_config.json');
                            const printerConfig = loadJSON(printerConfigPath, {});
                            targetPrinter = printerConfig.user_preferences?.default_printer || printerConfig.last_used_printer || targetPrinter;
                            console.log(`📋 Impressora resolvida: ${targetPrinter || 'não definida'}`);
                        }
                        const result = await executeWindowsNativePrint(fullImagePath, targetPrinter, paperSize, copies || 1);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            message: 'Impressão enviada com sucesso',
                            printer: targetPrinter,
                            paperSize: paperSize,
                            copies: copies || 1,
                            imagePath: fullImagePath
                        }));
                    } catch (error) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            message: 'Erro na impressão',
                            error: error.error
                        }));
                    }
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: false, 
                        message: 'Dados inválidos',
                        error: error.message 
                    }));
                }
            });
            return;
        }

        if (pathname === '/api/print-dialog' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body || '{}');
                    const { imagePath } = data;
                    if (!imagePath) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'imagePath ausente' }));
                        return;
                    }
                    const imagesDir = getImagesFolderPath();
                    let fullImagePath = path.join(imagesDir, imagePath);
                    const allowedExtensions = (config.image_settings?.allowed_extensions) || ['.jpg', '.jpeg', '.png', '.gif'];
                    if (!fs.existsSync(fullImagePath) && !path.extname(imagePath)) {
                        for (const ext of allowedExtensions) {
                            const candidate = path.join(imagesDir, imagePath + ext);
                            if (fs.existsSync(candidate)) {
                                fullImagePath = candidate;
                                break;
                            }
                        }
                    }
                    // Tentativa extra: tentar na basePath diretamente
                    if (!fs.existsSync(fullImagePath)) {
                        const direct = path.join(basePath, imagePath);
                        if (fs.existsSync(direct)) fullImagePath = direct;
                    }
                    // Tentativa extra: busca recursiva por nome exato
                    if (!fs.existsSync(fullImagePath)) {
                        try {
                            const { execSync } = require('child_process');
                            const searchCmd = `powershell -NoProfile -Command "Get-ChildItem -Path \"${basePath}\" -Recurse -File | Where-Object { $_.Name -eq \"${path.basename(imagePath)}\" } | Select-Object -First 1 -ExpandProperty FullName"`;
                            const found = String(execSync(searchCmd, { stdio: ['pipe', 'pipe', 'ignore'] }).toString()).trim();
                            if (found) fullImagePath = found;
                        } catch (_) {}
                    }
                    if (!fs.existsSync(fullImagePath)) {
                        res.writeHead(404, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Imagem não encontrada', path: fullImagePath }));
                        return;
                    }
                    const tryRundllPrint = () => {
                        const cmd = `${process.env['WINDIR'] || 'C:/Windows'}/System32/rundll32.exe ${process.env['WINDIR'] || 'C:/Windows'}/System32/shimgvw.dll,ImageView_Print \"${fullImagePath}\"`;
                        exec(cmd, { shell: 'cmd.exe' }, (err) => {
                            if (!err) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: true, method: 'rundll32_ImageView_Print' }));
                                return;
                            }
                            tryStartProcessVerbPrint();
                        });
                    };

                    const tryStartProcessVerbPrint = () => {
                        const ps = `Start-Process -FilePath \"${fullImagePath}\" -Verb Print`;
                        exec(ps, { shell: 'powershell.exe' }, (err, stdout, stderr) => {
                            if (!err) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: true, method: 'start_process_verb_print' }));
                                return;
                            }
                            tryMsPhotosPrint();
                        });
                    };

                    const tryMsPhotosPrint = () => {
                        const uri = `ms-photos:print?input=\"${fullImagePath}\"`;
                        const cmd = `start "" "${uri}"`;
                        exec(cmd, { shell: 'cmd.exe' }, (err) => {
                            if (!err) {
                                res.writeHead(200, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: true, method: 'ms_photos' }));
                                return;
                            }
                            tryPhotoViewerFullscreen();
                        });
                    };

                    const tryPhotoViewerFullscreen = () => {
                        const photoViewerDll = path.join(process.env['ProgramFiles'] || 'C:/Program Files', 'Windows Photo Viewer', 'PhotoViewer.dll');
                        const args = `\"${photoViewerDll}\", ImageView_Fullscreen \"${fullImagePath}\"`;
                        exec(`${process.env['WINDIR'] || 'C:/Windows'}/System32/rundll32.exe ${args}`, { shell: 'cmd.exe' }, (err2) => {
                            if (err2) {
                                res.writeHead(500, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ success: false, error: 'Falha ao abrir diálogo de impressão', details: 'Todos os métodos falharam' }));
                                return;
                            }
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true, fallback: 'photo_viewer_fullscreen' }));
                        });
                    };

                    tryRundllPrint();
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: 'Dados inválidos' }));
                }
            });
            return;
        }

        // API para seleção de pasta de imagens
        if (pathname === '/api/select-image-folder' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const { folder_path } = JSON.parse(body);
                    
                    if (!folder_path || !fs.existsSync(folder_path)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            error: 'Pasta não encontrada ou inválida'
                        }));
                        return;
                    }

                    // Verificar se é um diretório
                    const stats = fs.statSync(folder_path);
                    if (!stats.isDirectory()) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            error: 'Caminho especificado não é uma pasta'
                        }));
                        return;
                    }

                    // Atualizar configuração
                    config.image_settings.base_path = folder_path;
                    
                    // Salvar configuração
                    const configPath = getConfigPath('image_settings.json');
                    const success = saveJSON(configPath, config.image_settings);
                    
                    if (success) {
                        // Verificar pastas de data disponíveis
                        const availableFolders = [];
                        try {
                            const regex = getFolderRegexForFormat();
                            const folders = fs.readdirSync(folder_path)
                                .filter(item => {
                                    const fullPath = path.join(folder_path, item);
                                    return fs.statSync(fullPath).isDirectory() && regex.test(item);
                                })
                                .sort().reverse();
                            
                            availableFolders.push(...folders);
                        } catch (error) {
                            console.error('Erro ao verificar pastas de data:', error);
                        }

                        // Reiniciar monitoramento com a nova pasta
                        console.log('🔄 Reiniciando monitoramento para nova pasta:', folder_path);
                        startFileWatcher();

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            message: 'Pasta de imagens atualizada com sucesso',
                            folder_path: folder_path,
                            available_date_folders: availableFolders
                        }));
                    } else {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            error: 'Erro ao salvar configuração'
                        }));
                    }
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        error: 'Dados inválidos'
                    }));
                }
            });
            return;
        }

        // API para obter pasta atual
        if (pathname === '/api/current-image-folder' && method === 'GET') {
            const currentPath = config.image_settings?.base_path || '';
            const exists = currentPath && fs.existsSync(currentPath);

            // Determinar pasta ativa usada pelo Kiosk
            const today = new Date();
            const expectedFolderName = buildDateFolderName(today);
            const expectedDailyPath = currentPath ? path.join(currentPath, expectedFolderName) : '';
            const activeDir = getImagesFolderPath();
            const activeExists = activeDir && fs.existsSync(activeDir);
            let activeOrigin = 'unknown';
            if (activeDir === expectedDailyPath) {
                activeOrigin = 'daily';
            } else if (activeDir === currentPath) {
                activeOrigin = 'base';
            } else {
                activeOrigin = 'fallback';
            }

            let availableFolders = [];
            if (exists) {
                try {
                    const regex = getFolderRegexForFormat();
                    availableFolders = fs.readdirSync(currentPath)
                        .filter(item => {
                            const fullPath = path.join(currentPath, item);
                            return fs.statSync(fullPath).isDirectory() && regex.test(item);
                        })
                        .sort().reverse();
                } catch (error) {
                    console.error('Erro ao listar pastas de data:', error);
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                current_path: currentPath,
                exists: exists,
                available_date_folders: availableFolders,
                current_format: getDateFormat(),
                active_images_dir: activeDir,
                active_exists: activeExists,
                active_origin: activeOrigin,
                today_expected_folder: expectedFolderName
            }));
            return;
        }

        // API de teste de impressão
        if (pathname === '/api/test-print' && method === 'POST') {
            if (!isAuthenticated(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Não autenticado' }));
                return;
            }
            
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const testData = JSON.parse(body);
                    console.log('Teste de impressão solicitado:', testData);
                    
                    // Simular teste de impressão
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true, 
                        message: 'Teste de impressão enviado com sucesso',
                        printer: testData.printer || 'FUJIFILM ASK-300'
                    }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Dados inválidos' }));
                }
            });
            return;
        }
    }



    // 404 - Não encontrado
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Página não encontrada', path: pathname }));
});



// Compilar scripts Java na inicialização
// Função compileJavaScripts removida - dependências Java não existem

// Iniciar servidor
// Função para detectar impressoras funcionais automaticamente
function detectWorkingPrinters() {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        const command = 'powershell -Command "Get-Printer | Select-Object Name, PrinterStatus | ConvertTo-Json"';
        
        exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
            if (error) {
                console.log('⚠️ Não foi possível detectar impressoras automaticamente');
                resolve([]);
                return;
            }
            
            try {
                let workingPrinters = [];
                if (stdout.trim()) {
                    const printerData = JSON.parse(stdout);
                    const printerArray = Array.isArray(printerData) ? printerData : [printerData];
                    
                    workingPrinters = printerArray
                        .filter(printer => printer.PrinterStatus === 0) // Status 0 = Normal/Ready
                        .map(printer => printer.Name)
                        .filter(name => name && name.includes('FUJIFILM')); // Filtrar apenas impressoras FUJIFILM
                }
                resolve(workingPrinters);
            } catch (parseError) {
                console.log('⚠️ Erro ao processar dados das impressoras');
                resolve([]);
            }
        });
    });
}

// Função para atualizar configuração com impressora funcional
function updatePrinterConfig(workingPrinters) {
    if (workingPrinters.length === 0) {
        console.log('⚠️ Nenhuma impressora FUJIFILM funcional detectada');
        return;
    }
    
    const configPath = getConfigPath('printer_config.json');
    const currentConfig = loadJSON(configPath, {});
    
    // Encontrar a melhor impressora disponível
    let selectedPrinter = null;
    let selected15x20Printer = null;
    
    // Prioridade: ASK-400 > ASK-300 > outras
    if (workingPrinters.includes('FUJIFILM ASK-400')) {
        selectedPrinter = 'FUJIFILM ASK-400';
    } else if (workingPrinters.includes('FUJIFILM ASK-300')) {
        selectedPrinter = 'FUJIFILM ASK-300';
    } else {
        selectedPrinter = workingPrinters[0]; // Primeira disponível
    }
    
    // Para 15x20, verificar se existe impressora específica
    if (workingPrinters.includes('FUJIFILM ASK-400 (15x20)')) {
        selected15x20Printer = 'FUJIFILM ASK-400 (15x20)';
    } else {
        selected15x20Printer = selectedPrinter;
    }
    
    // Atualizar configuração
    const updatedConfig = {
        ...currentConfig,
        last_used_printer: selectedPrinter,
        user_preferences: {
            ...currentConfig.user_preferences,
            default_printer: selectedPrinter
        },
        format_mappings: {
            "10x15": {
                printer: selectedPrinter,
                java_class: selectedPrinter.includes('ASK-400') ? 'ImprimirFoto10x15ASK400' : 'ImprimirFoto10x15ASK300'
            },
            "15x20": {
                printer: selected15x20Printer,
                java_class: selected15x20Printer.includes('ASK-400') ? 'ImprimirFoto15x20ASK400' : 'ImprimirFoto15x20ASK300'
            },
            "bolas": {
                printer: selectedPrinter,
                java_class: selectedPrinter.includes('ASK-400') ? 'ImprimirFotoBolasASK400' : 'ImprimirFotoBolasASK300'
            }
        }
    };
    
    // Salvar configuração atualizada
    if (saveJSON(configPath, updatedConfig)) {
        console.log(`🖨️ Configuração atualizada automaticamente:`);
        console.log(`   - Impressora principal: ${selectedPrinter}`);
        console.log(`   - Impressora 15x20: ${selected15x20Printer}`);
    }
}

server.listen(PORT, HOST, async () => {
    console.log(`\n=== KIOSK DE FOTOS PROFISSIONAL ===`);
    console.log(`🚀 Servidor rodando em: http://${HOST}:${PORT}`);
    console.log(`📁 Diretório: ${__dirname}`);
    console.log(`⚡ Integração Java: Ativa`);
    console.log(`=====================================`);
    
    // Detectar impressoras funcionais automaticamente
    console.log('🔍 Detectando impressoras funcionais...');
    const workingPrinters = await detectWorkingPrinters();
    
    if (workingPrinters.length > 0) {
        console.log(`✅ Impressoras funcionais detectadas:`);
        workingPrinters.forEach(printer => {
            console.log(`   - ${printer} (ready)`);
        });
        updatePrinterConfig(workingPrinters);
    } else {
        console.log('⚠️ Nenhuma impressora FUJIFILM funcional detectada');
        console.log('   Usando configuração atual do printer_config.json');
    }
    
    console.log(`📱 Iniciando interface automaticamente...\n`);
    
    // Compilação Java removida - dependências não existem
    
    // Iniciar monitoramento de arquivos
    console.log('🔍 Iniciando monitoramento de imagens...');
    startFileWatcher();
    
    // Servidor pronto - interface será aberta pelo Electron
    console.log('🖥️ Servidor pronto para uso com Electron');
    console.log('📡 Sistema de atualizações em tempo real ativo');
});

// Tratamento de erros
process.on('uncaughtException', (error) => {
    console.error('Erro não capturado:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Promise rejeitada:', reason);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Encerrando servidor...');
    
    // Parar monitoramento de arquivos
    stopFileWatcher();
    
    // Fechar conexões SSE
    connectedClients.forEach(client => {
        try {
            if (client.response && !client.response.destroyed) {
                client.response.end();
            }
        } catch (error) {
            console.error('Erro ao fechar conexão SSE:', error);
        }
    });
    connectedClients.clear();
    
    server.close(() => {
        console.log('✅ Servidor encerrado com sucesso!');
        process.exit(0);
    });
});