const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const { spawn, exec } = require('child_process');
const crypto = require('crypto');

// Configurações
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

// Função removida - agora usando apenas Electron

// Carregar configurações
let config = {};
let sessions = new Map();

// Sistema de monitoramento de arquivos
let fileWatcher = null;
let connectedClients = new Set();
let lastImagesList = {};

function launchKioskMode() {
    const url = `http://localhost:${PORT}`;
    console.log('🖥️ Abrindo interface em modo kiosk...');
    
    // Tenta diferentes navegadores em ordem de preferência
    const browsers = [
        `start chrome --kiosk --disable-web-security --disable-features=TranslateUI --disable-extensions --no-first-run --disable-infobars "${url}"`,
        `start msedge --kiosk --disable-web-security --disable-features=TranslateUI "${url}"`,
        `start firefox --kiosk "${url}"`
    ];
    
    // Executa o primeiro navegador disponível
    exec(browsers[0], (error) => {
        if (error) {
            console.log('⚠️ Chrome não encontrado, tentando Edge...');
            exec(browsers[1], (error2) => {
                if (error2) {
                    console.log('⚠️ Edge não encontrado, tentando Firefox...');
                    exec(browsers[2]);
                }
            });
        }
    });
}

// Função para carregar arquivos JSON
function loadJSON(filePath, defaultValue = {}) {
    try {
        const fullPath = path.resolve(filePath);
        if (fs.existsSync(fullPath)) {
            const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            return data;
        } else {
            return defaultValue;
        }
    } catch (error) {
        console.error(`❌ Erro ao carregar ${filePath}:`, error.message);
        return defaultValue;
    }
}

// Função para salvar JSON
function saveJSON(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`Erro ao salvar ${filePath}:`, error.message);
        return false;
    }
}

// Carregar configurações iniciais
config.settings = loadJSON(path.join(__dirname, '../../config/settings.json'), { admin_password: '869407' });
config.pricing = loadJSON(path.join(__dirname, '../../config/pricing.json'), { formats: { '10x15': 15.00, '15x21': 25.00 } });
config.version = loadJSON(path.join(__dirname, '../../config/version.json'), { version: '2.0.0' });
config.image_settings = loadJSON(path.join(__dirname, '../../config/image_settings.json'), { base_path: path.join(__dirname, '../../imagens'), allowed_extensions: ['.jpg', '.jpeg', '.png', '.gif'] });

// Função global para encontrar pasta de imagens (obedece configuração do admin)
function getImagesFolderPath() {
    const basePath = config.image_settings?.base_path || './imagens';
    
    if (!fs.existsSync(basePath)) {
        console.log(`❌ ERRO: Pasta base de imagens não encontrada: ${basePath}`);
        console.log(`⚠️  Configure o caminho correto em config/image_settings.json`);
        return basePath;
    }
    
    const hoje = new Date();
    const dia = String(hoje.getDate()).padStart(2, '0');
    const mes = String(hoje.getMonth() + 1).padStart(2, '0');
    const ano = hoje.getFullYear();
    const dataFormatada = `${dia}${mes}${ano}`;
    const imagesDir = path.join(basePath, dataFormatada);
    
    if (!fs.existsSync(imagesDir)) {
        console.log(`❌ AVISO: Pasta do dia ${dataFormatada} não encontrada em: ${basePath}`);
        console.log(`📁 Crie a pasta: ${imagesDir}`);
        console.log(`⚠️  O sistema não irá procurar automaticamente por outras pastas.`);
    } else {
        console.log(`✅ Pasta do dia encontrada: ${imagesDir}`);
    }
    
    return imagesDir;
}

// Função para gerar ID de sessão
function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

// Função para verificar autenticação
function isAuthenticated(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    const sessionId = cookies.session_id;
    return sessionId && sessions.has(sessionId);
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
        const todayFormatted = `${dia}${mes}${ano}`;
        
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
            .sort();

        if (files.length === 0) {
            return {
                erro: `Nenhuma imagem encontrada na pasta ${todayFormatted}`,
                solucao: 'Adicione imagens na pasta do dia atual ou verifique se a pasta existe',
                status: 'no_images_found',
                folder_path: todayDir,
                base_path: basePath
            };
        }

        // Agrupar imagens por ID
        files.forEach(file => {
            const parts = file.split('_');
            if (parts.length >= 3) {
                const id = parts[1] + '_' + parts[2].split('.')[0];
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
    
    console.log(`🔍 Iniciando monitoramento da pasta: ${imagesDir}`);
    
    // Obter lista inicial de imagens
    lastImagesList = listImages();
    
    try {
        fileWatcher = fs.watch(imagesDir, { persistent: true }, (eventType, filename) => {
            if (!filename) return;
            
            // Filtrar apenas arquivos de imagem
            const allowedExtensions = config.image_settings?.allowed_extensions || ['.jpg', '.jpeg', '.png', '.gif'];
            const isImageFile = allowedExtensions.some(ext => 
                filename.toLowerCase().endsWith(ext.toLowerCase())
            );
            
            if (!isImageFile) return;
            
            console.log(`📁 Arquivo ${eventType}: ${filename}`);
            
            // Aguardar um pouco para garantir que o arquivo foi completamente escrito
            setTimeout(() => {
                checkForImageChanges();
            }, 1000);
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
function checkForImageChanges() {
    const currentImagesList = listImages();
    
    // Verificar se houve mudanças
    const currentKeys = Object.keys(currentImagesList).sort();
    const lastKeys = Object.keys(lastImagesList).sort();
    
    const hasChanges = JSON.stringify(currentKeys) !== JSON.stringify(lastKeys) ||
                      JSON.stringify(currentImagesList) !== JSON.stringify(lastImagesList);
    
    if (hasChanges) {
        console.log('🔄 Mudanças detectadas nas imagens, notificando clientes...');
        lastImagesList = currentImagesList;
        notifyClients('images-updated', currentImagesList);
    }
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
function executePythonPrinter(imagePath, paperSize, printerName = null) {
    return new Promise((resolve, reject) => {
        const pythonScript = path.join(__dirname, '../../kioskBase/Controleask300/ask300_paper_controller.py');
        
        // Preparar argumentos para o comando Python
        const args = [pythonScript, imagePath, paperSize, '--real'];
        
        console.log(`Executando controlador Python: python ${args.join(' ')}`);
        console.log(`Impressora: ${printerName || 'ASK-300 (padrão)'}`);

        // Usar spawn com PowerShell no Windows
        const child = spawn('python', args, {
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

        child.on('close', (code) => {
            if (code !== 0) {
                console.error(`Erro ao executar controlador Python:`, stderr);
                reject({ success: false, error: `Processo terminou com código ${code}: ${stderr}` });
            } else {
                console.log(`Controlador Python executado com sucesso:`, stdout);
                resolve({ success: true, output: stdout });
            }
        });

        child.on('error', (error) => {
            console.error(`Erro ao iniciar controlador Python:`, error);
            reject({ success: false, error: error.message });
        });
    });
}

function executeJavaScript(scriptName, imagePath, printerName = null, javaDir = null) {
    return new Promise((resolve, reject) => {
        // Usar diretório padrão se não especificado
        if (!javaDir) {
            javaDir = path.join(__dirname, '../printer/impressora', 'ask300');
        } else {
            javaDir = path.join(__dirname, '../printer/impressora', javaDir);
        }
        
        // Usar caminho absoluto da imagem para evitar problemas com caminhos relativos
        const absoluteImagePath = path.resolve(imagePath);
        
        // Preparar argumentos para o comando Java
        const args = ['-cp', '.', scriptName, absoluteImagePath];
        
        // Adicionar nome da impressora se especificado
        if (printerName) {
            args.push(printerName);
            console.log(`Executando com impressora específica: ${printerName}`);
        }

        console.log(`Executando comando: java ${args.join(' ')}`);
        console.log(`Diretório de execução: ${javaDir}`);
        console.log(`Caminho da imagem: ${absoluteImagePath}`);

        // Usar spawn com PowerShell no Windows
        const child = spawn('powershell.exe', ['-Command', `cd '${javaDir}'; java ${args.map(arg => `'${arg}'`).join(' ')}`], {
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

        child.on('close', (code) => {
            if (code !== 0) {
                console.error(`Erro ao executar ${scriptName}:`, stderr);
                reject({ success: false, error: `Processo terminou com código ${code}: ${stderr}` });
            } else {
                console.log(`${scriptName} executado com sucesso:`, stdout);
                resolve({ success: true, output: stdout });
            }
        });

        child.on('error', (error) => {
            console.error(`Erro ao iniciar processo ${scriptName}:`, error);
            reject({ success: false, error: error.message });
        });
    });
}

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
        
        // Executar para cada cópia usando exatamente o mesmo comando do C#
        const executeCopy = (copyNumber) => {
            console.log(`🚀 Executando cópia ${copyNumber}/${copies} com método Program.cs`);
            
            // Usar exatamente o mesmo comando do Program.cs
            const printProcess = spawn('rundll32.exe', [
                'shimgvw.dll,ImageView_PrintTo',
                '/pt',
                imagePath,
                printerName
            ], {
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
                console.error(`❌ Erro ao executar impressão (cópia ${copyNumber}): ${error.message}`);
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
        
        // Executar todas as cópias com delay
        for (let i = 1; i <= copies; i++) {
            setTimeout(() => executeCopy(i), (i - 1) * 2000); // Delay de 2s entre cópias
        }
    });
}

// Servidor HTTP
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
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

    // Rotas estáticas
    if (pathname === '/' || pathname === '/index.html') {
        serveStatic(path.join(__dirname, '../ui/app/index.html'), res);
        return;
    }

    if (pathname === '/login') {
        serveStatic(path.join(__dirname, '../ui/app/login.html'), res);
        return;
    }

    if (pathname === '/config' || pathname === '/configuracao') {
        if (!isAuthenticated(req)) {
            res.writeHead(302, { 'Location': '/login' });
            res.end();
            return;
        }
        serveStatic(path.join(__dirname, '../ui/app/config.html'), res);
        return;
    }

    if (pathname === '/dashboard') {
        serveStatic(path.join(__dirname, '../ui/app/dashboard.html'), res);
        return;
    }

    // Arquivos estáticos
    if (pathname.startsWith('/static/')) {
        const filePath = path.join(__dirname, '../ui', pathname);
        serveStatic(filePath, res);
        return;
    }

    // Arquivos da aplicação
    if (pathname.startsWith('/app/')) {
        const filePath = path.join(__dirname, '../ui', pathname);
        serveStatic(filePath, res);
        return;
    }

    // Servir imagens individuais
    if (pathname.startsWith('/imagens/')) {
        const basePath = config.image_settings?.base_path || '../../imagens';
        const imagePath = decodeURIComponent(pathname.substring(9)); // Remove '/imagens/'
        
        const imagesDir = getImagesFolderPath();
        
        if (!imagesDir) {
            const today = new Date();
            const dia = String(today.getDate()).padStart(2, '0');
            const mes = String(today.getMonth() + 1).padStart(2, '0');
            const ano = today.getFullYear();
            const todayFormatted = `${dia}${mes}${ano}`;
            
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                error: `Pasta do dia atual '${todayFormatted}' não encontrada`,
                solucao: `Crie a pasta '${todayFormatted}' e adicione as fotos do dia`,
                message: 'Certifique-se de que existe uma pasta com a data de hoje no formato DDMMAAAA'
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
            const basePath = config.image_settings?.base_path || './imagens';
            
            const imagesDir = getImagesFolderPath();
            
            if (!imagesDir) {
                const today = new Date();
                const dia = String(today.getDate()).padStart(2, '0');
                const mes = String(today.getMonth() + 1).padStart(2, '0');
                const ano = today.getFullYear();
                const todayFormatted = `${dia}${mes}${ano}`;
                
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    erro: `Pasta do dia atual '${todayFormatted}' não encontrada.`,
                    pasta_base: basePath,
                    pasta_esperada: path.join(basePath, todayFormatted),
                    solucao: `Crie a pasta '${todayFormatted}' dentro de '${basePath}' e adicione as fotos do dia.`
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
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        erro: `Nenhuma imagem encontrada na pasta '${path.basename(imagesDir)}'.`,
                        pasta_base: basePath,
                        pasta_atual: imagesDir,
                        solucao: 'Verifique se as imagens foram copiadas para a pasta correta.'
                    }));
                    return;
                }
                
                const imagensAgrupadas = {};
                arquivosImagem.forEach(f => {
                    const partes = f.split('_');
                    if (partes.length >= 3) {
                        const idFoto = partes[partes.length - 1].split('.')[0];
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

        // API de preços
        if (pathname === '/api/pricing' && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config.pricing));
            return;
        }

        if (pathname === '/api/pricing' && method === 'POST') {
            if (!isAuthenticated(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Não autenticado' }));
                return;
            }
            
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const pricing = JSON.parse(body);
                    saveJSON('../../config/pricing.json', pricing);
                    config.pricing = pricing;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Dados inválidos' }));
                }
            });
            return;
        }

        // API de login
        if (pathname === '/api/login' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.password === config.settings.admin_password) {
                        const sessionId = generateSessionId();
                        sessions.set(sessionId, { created: Date.now() });
                        
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                            'Set-Cookie': `session_id=${sessionId}; HttpOnly; Path=/`
                        });
                        res.end(JSON.stringify({ success: true, redirect: '/config' }));
                    } else {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, message: 'Senha incorreta' }));
                    }
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Dados inválidos' }));
                }
            });
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
                        const data = fs.readFileSync('../../config/printers_list.json', 'utf8');
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
                    fs.writeFileSync('../../config/printers_list.json', JSON.stringify(printersList, null, 2));
                    
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
                        const data = fs.readFileSync('./config/printers_list.json', 'utf8');
                        printersList = JSON.parse(data);
                    } catch (error) {
                        printersList = { "printers": [] };
                    }
                    
                    // Remover impressora
                    printersList.printers = printersList.printers.filter(p => p.name !== printer_name);
                    
                    // Salvar lista atualizada
                    fs.writeFileSync('../../config/printers_list.json', JSON.stringify(printersList, null, 2));
                    
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
            const printerConfig = loadJSON('config/printer_config.json', {
                "formats": {
                    "10x15": {
                        "printer": "FUJIFILM ASK-300",
                        "printSize": "6x4",
                        "paperSize": "4x6"
                    },
                    "15x21": {
                        "printer": "FUJIFILM ASK-300",
                        "printSize": "6x8",
                        "paperSize": "6x8"
                    },
                    "Bolas": {
                        "printer": "FUJIFILM ASK-300",
                        "printSize": "custom",
                        "paperSize": "A4"
                    }
                },
                "printers": {
                    "FUJIFILM ASK-300": "FUJIFILM ASK-300",
                    "FUJIFILM ASK-400": "FUJIFILM ASK-400"
                }
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(printerConfig));
            return;
        }

        // API para salvar configuração de impressoras
        if (pathname === '/api/printer-config' && method === 'POST') {
            // CORRIGIDO: remover verificação de autenticação para configurações básicas
            // if (!isAuthenticated(req)) {
            //     res.writeHead(401, { 'Content-Type': 'application/json' });
            //     res.end(JSON.stringify({ error: 'Não autenticado' }));
            //     return;
            // }
            
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const printerConfig = JSON.parse(body);
                    const configPath = path.join(__dirname, '../../config/printer_config.json');
                    
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









        // API de dados do dashboard
        if (pathname === '/api/dashboard/stats' && method === 'GET') {
            if (!isAuthenticated(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Não autenticado' }));
                return;
            }
            
            const salesData = loadJSON('../../config/sales_data.json', {
                "sales": [],
                "daily_totals": {},
                "statistics": {
                    "total_sales": 0,
                    "total_photos_sold": 0,
                    "most_popular_format": "10x15"
                }
            });
            
            // Inicializar contadores
            const paymentMethods = {
                dinheiro: { total: 0, count: 0 },
                cartao: { total: 0, count: 0 }
            };
            
            const formatSales = {};
            
            // Processar vendas
            salesData.sales.forEach(sale => {
                // Métodos de pagamento
                if (paymentMethods[sale.payment_method]) {
                    paymentMethods[sale.payment_method].total += sale.total;
                    paymentMethods[sale.payment_method].count += 1;
                }
                
                // Formatos
                sale.items.forEach(item => {
                    if (!formatSales[item.format]) {
                        formatSales[item.format] = { total: 0, count: 0 };
                    }
                    formatSales[item.format].total += item.price * item.quantity;
                    formatSales[item.format].count += item.quantity;
                });
            });
            
            // Preparar vendas recentes com contagem de itens
            const recentSales = salesData.sales.slice(-10).map(sale => ({
                ...sale,
                items_count: sale.items.reduce((sum, item) => sum + item.quantity, 0)
            }));
            
            const stats = {
                total_sales: salesData.statistics.total_sales || 0,
                total_photos: salesData.statistics.total_photos_sold || 0,
                payment_methods: paymentMethods,
                daily_sales: salesData.daily_totals || {},
                format_sales: formatSales,
                recent_sales: recentSales
            };
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats));
            return;
        }

        // API de vendas
        if (pathname === '/api/sales' && method === 'GET') {
            if (!isAuthenticated(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Não autenticado' }));
                return;
            }
            
            const salesData = loadJSON('../../config/sales_data.json', { sales: [], daily_totals: {}, statistics: { total_sales: 0, total_photos_sold: 0 } });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(salesData));
            return;
        }

        if (pathname === '/api/sales' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', () => {
                try {
                    const saleData = JSON.parse(body);
                    const salesData = loadJSON('../../config/sales_data.json', { sales: [], daily_totals: {}, statistics: { total_sales: 0, total_photos_sold: 0 } });
                    
                    // Adicionar nova venda
                    const newSale = {
                        id: Date.now().toString(),
                        timestamp: new Date().toISOString(),
                        ...saleData
                    };
                    
                    salesData.sales.push(newSale);
                    
                    // Atualizar estatísticas
                    const today = new Date().toISOString().split('T')[0];
                    salesData.daily_totals[today] = (salesData.daily_totals[today] || 0) + newSale.total;
                    salesData.statistics.total_sales += newSale.total;
                    salesData.statistics.total_photos_sold += newSale.items.reduce((sum, item) => sum + item.quantity, 0);
                    
                    saveJSON('../../config/sales_data.json', salesData);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, sale_id: newSale.id }));
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Dados inválidos' }));
                }
            });
            return;
        }

        // API de impressão com Windows nativo (substituindo Java)
        if (pathname === '/api/print-batch-java' && method === 'POST') {
            console.log('🔍 Requisição recebida na API /api/print-batch-java (usando impressão nativa)');
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const jobs = data.jobs || [];
                    console.log(`📋 Processando ${jobs.length} jobs de impressão:`, jobs);
                    const results = [];

                    // Carregar configuração de impressoras para mapeamento de formato
                    const printerConfigPath = path.join(__dirname, '../../config/printer_config.json');
                    const printerConfig = loadJSON(printerConfigPath, {});
                    console.log('📋 Configuração de impressora carregada:', JSON.stringify(printerConfig, null, 2));

                    // Obter o diretório de imagens uma vez para todos os jobs
                    const imagesDir = getImagesFolderPath();
                    
                    for (const job of jobs) {
                        const imagePath = path.join(imagesDir, job.photoName);

                        try {
                            // Determinar impressora baseada no formato configurado
                            let targetPrinter = job.printer;
                            const jobFormat = job.format || job.paperSize;
                            
                            // Verificar se existe mapeamento de formato para impressora
                            if (printerConfig.format_mappings && printerConfig.format_mappings[jobFormat]) {
                                const formatMapping = printerConfig.format_mappings[jobFormat];
                                if (formatMapping.printer) {
                                    targetPrinter = formatMapping.printer;
                                    console.log(`📋 Usando mapeamento de formato: ${jobFormat} -> ${targetPrinter}`);
                                }
                            }
                            
                            // Fallback: usar configuração padrão se não houver mapeamento
                            if (!targetPrinter && printerConfig.user_preferences) {
                                targetPrinter = printerConfig.user_preferences.default_printer;
                                console.log(`📋 Usando impressora padrão: ${targetPrinter}`);
                            }
                            
                            console.log(`🖨️ Imprimindo ${job.photoName} na impressora: ${targetPrinter} (formato: ${jobFormat})`);
                            
                            // Usar impressão nativa do Windows em vez de Java
                            const result = await executeWindowsNativePrint(
                                imagePath, 
                                targetPrinter, 
                                job.paperSize || job.format, 
                                1 // uma cópia por job
                            );
                            
                            results.push({
                                photoName: job.photoName,
                                format: job.format,
                                success: true,
                                output: `Impressão enviada para ${targetPrinter}`,
                                printer: targetPrinter
                            });
                            
                            console.log(`✅ Sucesso: ${job.photoName} enviado para ${targetPrinter}`);
                            
                        } catch (error) {
                            console.error(`❌ Erro ao imprimir ${job.photoName}:`, error);
                            results.push({
                                photoName: job.photoName,
                                format: job.format,
                                success: false,
                                error: error.message || 'Erro na impressão',
                                printer: targetPrinter || job.printer
                            });
                        }
                    }

                    const successCount = results.filter(r => r.success).length;
                    const errorCount = results.length - successCount;
                    
                    console.log(`📊 Resultado: ${successCount} sucessos, ${errorCount} erros`);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: true,
                        processed: successCount,
                        total: results.length,
                        results: results,
                        message: `${successCount}/${results.length} impressões processadas com sucesso`
                    }));
                } catch (error) {
                    console.error('❌ Erro na API de impressão em lote:', error);
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
                         config.image_settings.base_path = data.image_path;
                         
                         // Salvar configurações atualizadas
                         saveJSON('../../config/settings.json', config);
                         
                         res.writeHead(200, { 'Content-Type': 'application/json' });
                         res.end(JSON.stringify({ status: 'success', message: 'Configurações atualizadas com sucesso' }));
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
                    const printerConfigPath = path.join(__dirname, '../../config/printer_config.json');
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
                    const tempDir = path.join(__dirname, 'temp');
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

        // API de impressão Java (fallback)
        if (pathname === '/api/print-java' && method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk.toString());
            req.on('end', async () => {
                try {
                    const printData = JSON.parse(body);
                    const { image_data, printer_name, paper_size, copies = 1 } = printData;
                    
                    console.log('Solicitação de impressão Java (fallback):', { printer_name, paper_size, copies });
                    
                    // Salvar imagem temporária
                    const tempDir = path.join(__dirname, 'temp');
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }
                    
                    const tempFileName = `java_print_${Date.now()}.jpg`;
                    const tempFilePath = path.join(tempDir, tempFileName);
                    
                    // Converter base64 para arquivo
                    const base64Data = image_data.replace(/^data:image\/[a-z]+;base64,/, '');
                    fs.writeFileSync(tempFilePath, base64Data, 'base64');
                    
                    // Determinar o script Java baseado no formato e impressora
                    let javaScript = 'ImprimirFoto10x15ASK300';
                    let javaDir = path.join(__dirname, 'impressora', 'ask300');
                    
                    if (printer_name && printer_name.includes('ASK-400')) {
                        javaDir = path.join(__dirname, 'impressora', 'ask400');
                        javaScript = (paper_size === '15x20' || paper_size === '15x21') ? 'ImprimirFoto15x20' : 'ImprimirFoto10x15ASK400';
                    } else if (paper_size === '15x20' || paper_size === '15x21') {
                        javaScript = 'ImprimirFoto15x20ASK300';
                    }
                    
                    console.log(`Selecionado Java: ${javaScript} no diretório ${javaDir}`);
                    
                    try {
                        // Executar impressão múltiplas vezes se necessário
                        let results = [];
                        for (let i = 0; i < copies; i++) {
                            const result = await executeJavaScript(javaScript, tempFilePath, printer_name, javaDir);
                            results.push(result);
                        }
                        
                        // Limpar arquivo temporário
                        try {
                            fs.unlinkSync(tempFilePath);
                        } catch (cleanupError) {
                            console.warn('Erro ao limpar arquivo temporário:', cleanupError);
                        }
                        
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            message: `Impressão Java enviada com sucesso (${copies} cópia${copies > 1 ? 's' : ''})`,
                            printer: printer_name,
                            paper_size: paper_size,
                            copies: copies,
                            method: 'java_fallback',
                            results: results
                        }));
                    } catch (error) {
                        // Limpar arquivo temporário em caso de erro
                        try {
                            fs.unlinkSync(tempFilePath);
                        } catch (cleanupError) {
                            console.warn('Erro ao limpar arquivo temporário:', cleanupError);
                        }
                        
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            message: 'Erro na impressão Java',
                            error: error.error || error.message
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
                    const dia = String(today.getDate()).padStart(2, '0');
                    const mes = String(today.getMonth() + 1).padStart(2, '0');
                    const ano = today.getFullYear();
                    const todayFormatted = `${dia}${mes}${ano}`;
                    const fullImagePath = path.join(__dirname, '../../imagens', todayFormatted, imagePath);
                    
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
                        const result = await executeWindowsNativePrint(fullImagePath, printerName, paperSize, copies || 1);
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: true,
                            message: 'Impressão enviada com sucesso',
                            printer: printerName,
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
                    const configPath = path.join(__dirname, '../../config/image_settings.json');
                    const success = saveJSON(configPath, config.image_settings);
                    
                    if (success) {
                        // Verificar pastas de data disponíveis
                        const availableFolders = [];
                        try {
                            const folders = fs.readdirSync(folder_path)
                                .filter(item => {
                                    const fullPath = path.join(folder_path, item);
                                    return fs.statSync(fullPath).isDirectory() && /^\d{8}$/.test(item);
                                })
                                .sort().reverse();
                            
                            availableFolders.push(...folders);
                        } catch (error) {
                            console.error('Erro ao verificar pastas de data:', error);
                        }

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
            
            let availableFolders = [];
            if (exists) {
                try {
                    availableFolders = fs.readdirSync(currentPath)
                        .filter(item => {
                            const fullPath = path.join(currentPath, item);
                            return fs.statSync(fullPath).isDirectory() && /^\d{8}$/.test(item);
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
                available_date_folders: availableFolders
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
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Página não encontrada');
});



// Compilar scripts Java na inicialização
function compileJavaScripts() {
    const javaDir = './impressora/ask300';
    if (fs.existsSync(javaDir)) {
        exec('javac *.java', { cwd: javaDir }, (error, stdout, stderr) => {
            if (error) {
                console.error('Erro ao compilar scripts Java:', error.message);
            } else {
                console.log('Scripts Java compilados com sucesso!');
            }
        });
    }
}

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
    
    const configPath = path.join(__dirname, '../../config/printer_config.json');
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
    
    // Compilar scripts Java
    compileJavaScripts();
    
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