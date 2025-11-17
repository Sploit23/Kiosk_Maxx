let grupos = {};
let fotoSelecionada = null;
let variacoesAtuais = [];
let seenPhotos = new Set();

function loadSeenPhotos() {
    try {
        const raw = localStorage.getItem('seen_photos');
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) seenPhotos = new Set(arr);
        }
    } catch (_) {}
}

function saveSeenPhotos() {
    try {
        localStorage.setItem('seen_photos', JSON.stringify(Array.from(seenPhotos)));
    } catch (_) {}
}
let appVersion = "1.0.0";
let updateAvailable = false;

// Sistema de atualizações em tempo real
let eventSource = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
let reconnectTimeout = null;

// Lazy Loading System
class LazyImageLoader {
    constructor() {
        this.observer = new IntersectionObserver(this.handleIntersection.bind(this), {
            root: null,
            rootMargin: '50px',
            threshold: 0.1
        });
        this.loadedImages = new Set();
    }
    
    handleIntersection(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting && !this.loadedImages.has(entry.target)) {
                this.loadImage(entry.target);
                this.loadedImages.add(entry.target);
                this.observer.unobserve(entry.target);
            }
        });
    }
    
    loadImage(img) {
        const src = img.dataset.src;
        if (src) {
            img.src = src;
            img.classList.add('loading');
            
            img.onload = () => {
                img.classList.remove('loading');
                img.classList.add('loaded');
                img.style.opacity = '1';
            };
            
            img.onerror = () => {
                img.classList.remove('loading');
                img.classList.add('error');
                img.alt = 'Erro ao carregar imagem';
            };
        }
    }
    
    observe(img) {
        this.observer.observe(img);
    }
    
    disconnect() {
        this.observer.disconnect();
        this.loadedImages.clear();
    }
}



// Função para atualização incremental da sidebar
function atualizarSidebarIncremental(oldGroups, newGroups) {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    
    const oldKeys = new Set(Object.keys(oldGroups));
    const newKeys = new Set(Object.keys(newGroups));
    
    // Remover fotos que não existem mais
    oldKeys.forEach(key => {
        if (!newKeys.has(key)) {
            const element = document.querySelector(`[data-foto-id="${key}"]`);
            if (element) {
                element.remove();
                console.log(`🗑️ Removida foto: ${key}`);
            }
        }
    });
    
    // Adicionar novas fotos
    newKeys.forEach(key => {
        if (!oldKeys.has(key)) {
            adicionarFotoNaSidebar(key, newGroups[key]);
            console.log(`➕ Adicionada nova foto: ${key}`);
        }
    });
    
    // Atualizar contador
    atualizarContadorFotos();
}

// Função para adicionar uma foto específica na sidebar
function adicionarFotoNaSidebar(fotoId, fotoData) {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    
    const fotoElement = document.createElement('div');
    fotoElement.className = 'foto-sidebar';
    fotoElement.setAttribute('data-foto-id', fotoId);
    
    const img = document.createElement('img');
    img.src = `/api/image/${encodeURIComponent(fotoId)}`;
    img.alt = fotoId;
    img.loading = 'lazy'; // Lazy loading para performance
    
    const overlay = document.createElement('div');
    overlay.className = 'foto-overlay';
    overlay.textContent = fotoId;
    
    fotoElement.appendChild(img);
    fotoElement.appendChild(overlay);
    if (!seenPhotos.has(fotoId)) {
        fotoElement.classList.add('unseen');
    }
    
    // Adicionar event listener
    fotoElement.addEventListener('click', function() {
        selecionarFoto(fotoId, this);
    });
    
    // Inserir na posição correta (ordenada)
    const existingPhotos = Array.from(sidebar.querySelectorAll('.foto-sidebar'));
    let inserted = false;
    
    for (let i = 0; i < existingPhotos.length; i++) {
        const existingId = existingPhotos[i].getAttribute('data-foto-id');
        if (fotoId > existingId) {
            sidebar.insertBefore(fotoElement, existingPhotos[i]);
            inserted = true;
            break;
        }
    }
    
    if (!inserted) {
        sidebar.appendChild(fotoElement);
    }
}

// Função para notificação otimizada
function mostrarNotificacaoNovasFotosOtimizada(novasFotos, totalFotos) {
    // Remover notificação anterior se existir
    const notificacaoExistente = document.querySelector('.notificacao-novas-fotos');
    if (notificacaoExistente) {
        notificacaoExistente.remove();
    }
    
    const notificacao = document.createElement('div');
    notificacao.className = 'notificacao-novas-fotos';
    notificacao.innerHTML = `
        <div class="notificacao-content">
            <span class="notificacao-icon">📸</span>
            <span class="notificacao-text">
                ${novasFotos} nova${novasFotos > 1 ? 's' : ''} foto${novasFotos > 1 ? 's' : ''} adicionada${novasFotos > 1 ? 's' : ''}!
                <br><small>Total: ${totalFotos} fotos</small>
            </span>
        </div>
    `;
    
    // Adicionar estilos inline para a notificação
    notificacao.style.cssText = `
        position: fixed;
        top: 20px;
        left: 20px;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(10px);
        color: white;
        padding: 15px 20px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        box-shadow: 0 4px 15px rgba(0,0,0,0.3);
        z-index: 10000;
        animation: slideInLeft 0.3s ease-out;
        max-width: 300px;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    `;
    
    document.body.appendChild(notificacao);
    
    // Remover após 4 segundos
    setTimeout(() => {
        if (notificacao.parentNode) {
            notificacao.style.animation = 'slideOutRight 0.3s ease-in';
            setTimeout(() => {
                if (notificacao.parentNode) {
                    notificacao.remove();
                }
            }, 300);
        }
    }, 4000);
}

// Função para atualizar contador de fotos
function atualizarContadorFotos() {
    const totalFotos = Object.keys(grupos).length;
    const contadorElement = document.querySelector('.contador-fotos');
    
    if (contadorElement) {
        contadorElement.textContent = `${totalFotos} foto${totalFotos !== 1 ? 's' : ''}`;
    }
    
    // Atualizar título da página
    document.title = `Kiosk Fotos - ${totalFotos} foto${totalFotos !== 1 ? 's' : ''}`;
}

// Instância global do lazy loader
const lazyLoader = new LazyImageLoader();

// Sistema de Paginação Virtual para grandes volumes
class VirtualScrollManager {
    constructor() {
        this.itemHeight = 120;
        this.containerHeight = 0;
        this.visibleItems = 0;
        this.bufferSize = 5; // Itens extras para buffer
        this.scrollTop = 0;
        this.totalItems = 0;
        this.startIndex = 0;
        this.endIndex = 0;
        this.isEnabled = false;
        this.threshold = 100; // Ativar apenas com mais de 100 fotos
    }
    
    init(container) {
        this.container = container;
        this.containerHeight = container.clientHeight;
        this.visibleItems = Math.ceil(this.containerHeight / this.itemHeight);
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue('--sidebar-thumb-height');
            const px = parseInt(String(v || '').replace('px','').trim(), 10);
            if (!isNaN(px) && px > 0) this.itemHeight = px;
        } catch (_) {}
        
        // Adicionar listener de scroll otimizado
        let scrollTimeout;
        container.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                this.handleScroll();
            }, 16); // ~60fps
        });
    }
    
    shouldEnable(totalItems) {
        return totalItems > this.threshold;
    }
    
    enable(totalItems) {
        this.isEnabled = true;
        this.totalItems = totalItems;
        this.updateVisibleRange();
    }
    
    disable() {
        this.isEnabled = false;
    }
    
    handleScroll() {
        if (!this.isEnabled) return;
        
        this.scrollTop = this.container.scrollTop;
        this.updateVisibleRange();
    }
    
    updateVisibleRange() {
        const startIndex = Math.floor(this.scrollTop / this.itemHeight);
        const endIndex = Math.min(
            startIndex + this.visibleItems + this.bufferSize * 2,
            this.totalItems
        );
        
        this.startIndex = Math.max(0, startIndex - this.bufferSize);
        this.endIndex = endIndex;
    }
    
    isItemVisible(index) {
        return !this.isEnabled || (index >= this.startIndex && index <= this.endIndex);
    }
    
    getVisibleRange() {
        return { start: this.startIndex, end: this.endIndex };
    }
}

// Instância global do virtual scroll
const virtualScroll = new VirtualScrollManager();

// Sistema de Cache Inteligente para Performance
class ImageCacheManager {
    constructor() {
        this.cache = new Map();
        this.maxCacheSize = 500; // Máximo de imagens em cache
        this.preloadQueue = [];
        this.isPreloading = false;
        this.preloadBatchSize = 10;
    }
    
    // Adicionar imagem ao cache
    addToCache(imageId, imageData) {
        if (this.cache.size >= this.maxCacheSize) {
            // Remover item mais antigo (LRU)
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        
        this.cache.set(imageId, {
            data: imageData,
            timestamp: Date.now(),
            accessed: Date.now()
        });
    }
    
    // Obter imagem do cache
    getFromCache(imageId) {
        const cached = this.cache.get(imageId);
        if (cached) {
            cached.accessed = Date.now();
            return cached.data;
        }
        return null;
    }
    
    // Pré-carregar imagens em lote
    preloadImages(imageIds) {
        const newIds = imageIds.filter(id => !this.cache.has(id));
        this.preloadQueue.push(...newIds);
        
        if (!this.isPreloading && this.preloadQueue.length > 0) {
            this.processPreloadQueue();
        }
    }
    
    async processPreloadQueue() {
        if (this.isPreloading || this.preloadQueue.length === 0) return;
        
        this.isPreloading = true;
        const batch = this.preloadQueue.splice(0, this.preloadBatchSize);
        
        const promises = batch.map(async (imageId) => {
            try {
                const img = new Image();
                img.src = `/api/image/${encodeURIComponent(imageId)}`;
                
                return new Promise((resolve) => {
                    img.onload = () => {
                        this.addToCache(imageId, img.src);
                        resolve();
                    };
                    img.onerror = () => resolve(); // Continuar mesmo com erro
                });
            } catch (error) {
                console.warn(`Erro ao pré-carregar imagem ${imageId}:`, error);
            }
        });
        
        await Promise.all(promises);
        
        this.isPreloading = false;
        
        // Processar próximo lote se houver
        if (this.preloadQueue.length > 0) {
            setTimeout(() => this.processPreloadQueue(), 100);
        }
    }
    
    // Limpar cache antigo
    cleanOldCache() {
        const now = Date.now();
        const maxAge = 30 * 60 * 1000; // 30 minutos
        
        for (const [key, value] of this.cache.entries()) {
            if (now - value.accessed > maxAge) {
                this.cache.delete(key);
            }
        }
    }
    
    // Obter estatísticas do cache
    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxCacheSize,
            queueSize: this.preloadQueue.length,
            isPreloading: this.isPreloading
        };
    }
}

// Instância global do cache
const imageCache = new ImageCacheManager();

// Limpar cache periodicamente
setInterval(() => {
    imageCache.cleanOldCache();
}, 5 * 60 * 1000); // A cada 5 minutos

// Sistema de atualizações em tempo real via Server-Sent Events
function conectarEventSource() {
    if (eventSource) {
        eventSource.close();
    }
    
    console.log('🔌 Conectando ao sistema de atualizações em tempo real...');
    
    eventSource = new EventSource('/api/events');
    
    eventSource.onopen = function(event) {
        console.log('✅ Conectado ao sistema de atualizações');
        reconnectAttempts = 0;
        
        // Limpar timeout de reconexão se existir
        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }
    };
    
    eventSource.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            console.log('📡 Evento recebido:', event.type, data);
        } catch (error) {
            console.error('Erro ao processar evento:', error);
        }
    };
    
    // Evento específico para atualizações de imagens
    eventSource.addEventListener('images-updated', function(event) {
        try {
            const newImages = JSON.parse(event.data);
            const metadata = newImages._metadata;
            
            // Remover metadata dos dados de imagens
            delete newImages._metadata;
            
            console.log('🖼️ Imagens atualizadas detectadas');
            
            if (metadata) {
                console.log(`📊 Estatísticas: +${metadata.newImages} novas, -${metadata.removedImages} removidas, total: ${metadata.totalImages}`);
            }
            
            // Verificar se realmente houve mudanças
            const currentKeys = Object.keys(grupos).sort();
            const newKeys = Object.keys(newImages).sort();
            
            const hasChanges = JSON.stringify(currentKeys) !== JSON.stringify(newKeys) ||
                              JSON.stringify(grupos) !== JSON.stringify(newImages);
            
            if (hasChanges) {
                console.log('🔄 Atualizando interface com novas imagens de forma otimizada...');
                
                // Atualização otimizada que preserva o estado atual
                atualizarImagensOtimizado(newImages, metadata);
                // Atualizar indicador de pasta ativo
                atualizarIndicadorPasta();
            } else {
                console.log('ℹ️ Nenhuma mudança real detectada no frontend');
            }
        } catch (error) {
            console.error('Erro ao processar atualização de imagens:', error);
        }
    });
    
    eventSource.addEventListener('connected', function(event) {
        try {
            const data = JSON.parse(event.data);
            console.log('🎉 Conectado:', data.message);
        } catch (error) {
            console.error('Erro ao processar evento de conexão:', error);
        }
    });
    
    eventSource.onerror = function(event) {
        console.error('❌ Erro na conexão SSE:', event);
        
        if (eventSource.readyState === EventSource.CLOSED) {
            console.log('🔄 Conexão SSE fechada, tentando reconectar...');
            tentarReconectar();
        }
    };
}

// Função para tentar reconectar ao SSE
function tentarReconectar() {
    if (reconnectAttempts >= maxReconnectAttempts) {
        console.error('❌ Máximo de tentativas de reconexão atingido');
        return;
    }
    
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000); // Backoff exponencial, máximo 30s
    
    console.log(`🔄 Tentativa de reconexão ${reconnectAttempts}/${maxReconnectAttempts} em ${delay/1000}s...`);
    
    reconnectTimeout = setTimeout(() => {
        conectarEventSource();
    }, delay);
}

// Função para atualizar a interface com novas imagens
// Função otimizada para atualizações incrementais
function atualizarImagensOtimizado(newImages, metadata) {
    const oldGroups = { ...grupos };
    const fotoAnteriormenteSelecionada = fotoSelecionada;
    
    // Reagrupar dados por ID base (sem formato)
    grupos = reagruparPorIdBase(newImages);
    
    // Se não há imagens, mostrar tela de boas-vindas
    if (Object.keys(grupos).length === 0) {
        mostrarTelaBoasVindas();
        return;
    }
    
    // Se estava na tela de boas-vindas, restaurar interface principal
    const welcomeContainer = document.querySelector('.welcome-container');
    if (welcomeContainer) {
        restaurarInterfacePrincipal();
    }
    
    // Atualização incremental da sidebar
    atualizarSidebarIncremental(oldGroups, newImages);
    
    // Atualizar lista principal de fotos
    atualizarListaFotos();
    
    // Mostrar notificação otimizada
    if (metadata && metadata.newImages > 0) {
        mostrarNotificacaoNovasFotosOtimizada(metadata.newImages, metadata.totalImages);
    }
    
    // Preservar seleção da foto anterior de forma mais eficiente
    if (fotoAnteriormenteSelecionada && grupos[fotoAnteriormenteSelecionada]) {
        // Foto ainda existe, manter seleção sem reprocessar
        console.log(`✅ Mantendo seleção da foto: ${fotoAnteriormenteSelecionada}`);
    } else if (Object.keys(grupos).length > 0 && !fotoSelecionada) {
        // Selecionar primeira foto disponível apenas se não há seleção
        const primeiraFoto = Object.keys(grupos)[0];
        setTimeout(() => {
            const element = document.querySelector(`[data-foto-id="${primeiraFoto}"]`);
            if (element) {
                selecionarFoto(primeiraFoto, element);
            }
        }, 100);
    }
}

// Função para reagrupar imagens por ID base (sem formato)
function reagruparPorIdBase(imagensOriginais) {
    console.log('🔍 Grupos originais:', imagensOriginais);
    const gruposReagrupados = {};
    
    // Coletar todas as imagens primeiro
    const todasImagens = [];
    Object.keys(imagensOriginais).forEach(chaveCompleta => {
        console.log('🔑 Processando chave:', chaveCompleta);
        imagensOriginais[chaveCompleta].forEach(imagem => {
            todasImagens.push(imagem);
        });
    });
    
    console.log('📋 Todas as imagens coletadas:', todasImagens);
    
    // Reagrupar por ID base (data_hora)
    todasImagens.forEach(imagem => {
        const partes = imagem.split('_');
        if (partes.length >= 3) {
            const idBase = partes[1] + '_' + partes[2]; // data_hora
            console.log('📝 ID base extraído de', imagem, ':', idBase);
            
            if (!gruposReagrupados[idBase]) {
                gruposReagrupados[idBase] = [];
            }
            
            gruposReagrupados[idBase].push(imagem);
        }
    });
    
    console.log('🎯 Grupos reagrupados:', gruposReagrupados);
    console.log(`📊 Reagrupadas ${todasImagens.length} imagens em ${Object.keys(gruposReagrupados).length} grupos base`);
    return gruposReagrupados;
}

// Função legada mantida para compatibilidade
function atualizarInterfaceComNovasImagens() {
    atualizarImagensOtimizado(grupos, null);
    
    // Fallback para reconstrução completa se necessário
    const fotosAnteriores = document.querySelectorAll('.foto-sidebar').length;
    atualizarListaFotos();
    const fotosAtuais = Object.keys(grupos).length;
    const novasFotosCount = fotosAtuais - fotosAnteriores;
    
    if (novasFotosCount > 0) {
        mostrarNotificacaoNovasFotos(novasFotosCount);
    }
    const primeiroId = Object.keys(grupos)[0];
    if (primeiroId) {
        setTimeout(() => {
            const element = document.querySelector('.foto-sidebar');
            if (element) {
                selecionarFoto(primeiroId, element);
            }
        }, 100);
    }
    
    console.log(`✅ Interface atualizada - ${fotosAtuais} fotos (${novasFotosCount > 0 ? '+' + novasFotosCount : 'sem novas'})`);
}

// Função para mostrar tela de boas-vindas
function mostrarTelaBoasVindas() {
    const mainDiv = document.getElementById("main");
    let telaInicial = `<div class="welcome-container">`;
    telaInicial += `<div class="welcome-content">`;
    telaInicial += `<h1 class="welcome-title">🎄 Bem-vindo ao Kiosk de Fotos 🎅</h1>`;
    telaInicial += `<div class="welcome-icon">📸</div>`;
    telaInicial += `<p class="welcome-message">Sistema pronto para uso!</p>`;
    telaInicial += `<p class="welcome-instructions">Para começar, configure a pasta de imagens nas configurações.</p>`;
    telaInicial += `<button class="config-button welcome-button" onclick="window.location.href='/login'">⚙️ Configurar Sistema</button>`;
    telaInicial += `</div>`;
    telaInicial += `</div>`;
    
    mainDiv.innerHTML = telaInicial;
    
    // Ocultar elementos da interface
    const elementsToHide = [
        '#sidebar',
        '#config-button', 
        '#fullscreen-button',
        '#lista-fotos',
        '#miniaturas',
        '#ask300-panel'
    ];
    
    elementsToHide.forEach(selector => {
        const element = document.querySelector(selector);
        if (element) {
            element.style.display = 'none';
        }
    });
    
    // Animação de entrada
    setTimeout(() => {
        const welcomeContainer = document.querySelector('.welcome-container');
        if (welcomeContainer) {
            welcomeContainer.style.opacity = '1';
            welcomeContainer.style.transform = 'translateY(0)';
        }
    }, 100);
}

// Função para restaurar interface principal
function restaurarInterfacePrincipal() {
    const mainDiv = document.getElementById("main");
    
    // Restaurar conteúdo original do main preservando o HTML original
    mainDiv.innerHTML = `
        <div id="foto-grande">
            <h2>Selecione uma foto</h2>
            
            <!-- Resumo da Impressora -->
            <div id="printer-summary" class="printer-summary">
                <div class="summary-header">
                    <h3>🖨️ Resumo da Impressora</h3>
                </div>
                <div class="summary-content">
                    <div class="printer-info">
                        <span class="info-label">Impressora:</span>
                        <span id="current-printer" class="info-value">Carregando...</span>
                    </div>
                    <div class="format-mappings">
                        <div class="format-item">
                            <span class="format-label">10x15:</span>
                            <span id="printer-10x15" class="printer-name">-</span>
                        </div>
                        <div class="format-item">
                            <span class="format-label">15x20:</span>
                            <span id="printer-15x20" class="printer-name">-</span>
                        </div>
                        <div class="format-item">
                            <span class="format-label">Bolas:</span>
                            <span id="printer-bolas" class="printer-name">-</span>
                        </div>
                    </div>
                    
                    <div class="last-preferences">
                        <h4>🕒 Última Sessão do Cliente</h4>
                        <div class="preference-item">
                            <span class="preference-label">Formato:</span>
                            <span class="preference-value" id="last-format">Carregando...</span>
                        </div>
                        <div class="preference-item">
                            <span class="preference-label">Impressora:</span>
                            <span class="preference-value" id="last-printer">Carregando...</span>
                        </div>
                        <div class="preference-item">
                            <span class="preference-label">Papel:</span>
                            <span class="preference-value" id="last-paper">Carregando...</span>
                        </div>
                        <div class="preference-item">
                            <span class="preference-label">Data:</span>
                            <span class="preference-value" id="last-session-date">Carregando...</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Painel de Controle ASK-300 -->
            <div id="ask300-panel" class="ask300-panel" style="display: none;">
                <div class="panel-header">
                    <h3>🖨️ Controle ASK-300</h3>
                    <button id="toggle-ask300" class="btn-toggle">Mostrar/Ocultar</button>
                </div>
                <div class="panel-content">
                    <div id="paper-size-container"></div>
                    <div id="test-buttons-container"></div>
                    <div class="print-actions">
                        <button id="print-current-photo" class="btn-print" disabled>
                            📸 Imprimir Foto Atual
                        </button>
                        <div class="copies-control">
                            <label for="copies-input">Cópias:</label>
                            <input type="number" id="copies-input" min="1" max="10" value="1">
                        </div>
                    </div>
                </div>
            </div>
        </div>
        <div id="miniaturas"></div>
    `;
    
    // Mostrar elementos da interface
    const elementsToShow = [
        '#sidebar',
        '#config-button', 
        '#fullscreen-button',
        '#lista-fotos',
        '#miniaturas',
        '#ask300-panel'
    ];
    
    elementsToShow.forEach(selector => {
        const element = document.querySelector(selector);
        if (element) {
            element.style.display = '';
        }
    });
}

// Função otimizada para atualizar lista de fotos com suporte a grandes volumes
function atualizarListaFotos() {
    const listaDiv = document.getElementById("lista-fotos");
    if (!listaDiv) return;
    
    const fotosAtuais = Object.keys(grupos);
    const totalFotos = fotosAtuais.length;
    
    // Inicializar virtual scroll se necessário
    if (!virtualScroll.container) {
        virtualScroll.init(listaDiv);
    }
    
    // Verificar se deve usar paginação virtual
    if (virtualScroll.shouldEnable(totalFotos)) {
        console.log(`🚀 Ativando paginação virtual para ${totalFotos} fotos`);
        virtualScroll.enable(totalFotos);
        atualizarListaFotosVirtual();
        return;
    } else {
        virtualScroll.disable();
    }
    
    // Fallback para método tradicional com menos fotos
    atualizarListaFotosTradicional();
}

// Função para atualização virtual (grandes volumes)
function atualizarListaFotosVirtual() {
    const listaDiv = document.getElementById("lista-fotos");
    const fotosAtuais = Object.keys(grupos);
    const { start, end } = virtualScroll.getVisibleRange();
    
    // Limpar container e criar estrutura virtual
    listaDiv.innerHTML = '';
    
    // Criar spacer superior
    const topSpacer = document.createElement('div');
    topSpacer.style.height = `${start * virtualScroll.itemHeight}px`;
    topSpacer.className = 'virtual-spacer-top';
    listaDiv.appendChild(topSpacer);
    
    // Renderizar apenas itens visíveis
    for (let i = start; i < end && i < fotosAtuais.length; i++) {
        const num = fotosAtuais[i];
        const primeira = grupos[num][0];
        
        const div = document.createElement("div");
        div.className = "foto-sidebar";
        div.dataset.fotoId = num;
        div.dataset.index = i;
        if (!seenPhotos.has(num)) {
            div.classList.add('unseen');
        }
        
        const img = document.createElement("img");
        
        // Verificar cache primeiro
        const cachedSrc = imageCache.getFromCache(num);
        if (cachedSrc) {
            img.src = cachedSrc;
            img.className = 'loaded';
        } else {
            img.dataset.src = "/imagens/" + primeira;
            img.className = 'lazy-image';
            img.loading = 'lazy';
            
            // Registrar para lazy loading
            lazyLoader.observe(img);
        }
        
        img.alt = `Foto ${num}`;
        
        img.onclick = () => selecionarFoto(num, div);

        const numeroDiv = document.createElement("div");
        numeroDiv.className = "foto-numero";
        numeroDiv.textContent = "ID " + num;
        
        div.appendChild(img);
        div.appendChild(numeroDiv);
        listaDiv.appendChild(div);
        
        // Destacar foto selecionada
        if (num === fotoSelecionada) {
            div.classList.add('selected');
        }
    }
    
    // Criar spacer inferior
    const bottomSpacer = document.createElement('div');
    const remainingItems = Math.max(0, fotosAtuais.length - end);
    bottomSpacer.style.height = `${remainingItems * virtualScroll.itemHeight}px`;
    bottomSpacer.className = 'virtual-spacer-bottom';
    listaDiv.appendChild(bottomSpacer);
    
    console.log(`📊 Renderizados ${end - start} de ${fotosAtuais.length} itens (${start}-${end})`);
    
    // Pré-carregar imagens próximas para melhor UX
    const preloadStart = Math.max(0, start - 10);
    const preloadEnd = Math.min(fotosAtuais.length, end + 10);
    const imagesToPreload = fotosAtuais.slice(preloadStart, preloadEnd);
    
    // Pré-carregar em background
    setTimeout(() => {
        imageCache.preloadImages(imagesToPreload);
    }, 100);
}

// Função tradicional para volumes menores
function atualizarListaFotosTradicional() {
    const listaDiv = document.getElementById("lista-fotos");
    
    // Salvar referência da foto selecionada e sua posição
    const fotoSelecionadaElement = fotoSelecionada ? 
        listaDiv.querySelector(`[data-foto-id="${fotoSelecionada}"]`) : null;
    const fotoSelecionadaRect = fotoSelecionadaElement ? 
        fotoSelecionadaElement.getBoundingClientRect() : null;
    const listaRect = listaDiv.getBoundingClientRect();
    
    // Obter IDs das fotos existentes na lista
    const fotosExistentes = new Set();
    const elementosExistentes = new Map();
    
    listaDiv.querySelectorAll('.foto-sidebar').forEach(el => {
        const numeroDiv = el.querySelector('.foto-numero');
        if (numeroDiv) {
            const id = numeroDiv.textContent.replace('ID ', '');
            fotosExistentes.add(id);
            elementosExistentes.set(id, el);
        }
    });
    
    // Identificar novas fotos
    const novasFotos = [];
    const fotosAtuais = Object.keys(grupos);
    
    fotosAtuais.forEach(num => {
        if (!fotosExistentes.has(num)) {
            novasFotos.push(num);
        }
    });
    
    // Remover fotos que não existem mais
    fotosExistentes.forEach(id => {
        if (!grupos[id]) {
            const elemento = elementosExistentes.get(id);
            if (elemento) {
                elemento.style.opacity = '0';
                elemento.style.transform = 'translateX(-30px)';
                setTimeout(() => {
                    if (elemento.parentNode) {
                        elemento.parentNode.removeChild(elemento);
                    }
                }, 300);
            }
        }
    });
    
    // Adicionar novas fotos no TOPO da lista, preservando visualização atual
    novasFotos.forEach((num, index) => {
        const primeira = grupos[num][0];
        const div = document.createElement("div");
        div.className = "foto-sidebar nova-foto";
        div.dataset.fotoId = num;
        if (!seenPhotos.has(num)) {
            div.classList.add('unseen');
        }
        
        // Animação de entrada discreta
        div.style.opacity = '0';
        div.style.transform = 'translateY(20px)';
        
        const img = document.createElement("img");
        img.dataset.src = "/imagens/" + primeira;
        img.alt = `Foto ${num}`;
        img.className = 'lazy-image';
        
        // Placeholder inicial
        img.style.opacity = '0';
        img.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
        img.style.minHeight = '80px';
        
        // Registrar para lazy loading
        lazyLoader.observe(img);
        
        img.onclick = () => selecionarFoto(num, div);

        const numeroDiv = document.createElement("div");
        numeroDiv.className = "foto-numero";
        numeroDiv.textContent = "ID " + num;

        // Badge para indicar nova foto (mais discreto)
        const novaBadge = document.createElement("div");
        novaBadge.className = "nova-badge";
        novaBadge.textContent = "NOVA";
        novaBadge.style.cssText = `
            position: absolute;
            top: 5px;
            right: 5px;
            background: linear-gradient(45deg, #4CAF50, #45a049);
            color: white;
            font-size: 9px;
            padding: 2px 5px;
            border-radius: 8px;
            font-weight: bold;
            z-index: 10;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
            animation: pulseGreen 2s infinite;
        `;

        div.appendChild(img);
        div.appendChild(numeroDiv);
        div.appendChild(novaBadge);
        
        // Inserir nova foto no TOPO da lista
        const first = listaDiv.querySelector('.foto-sidebar');
        if (first) {
            listaDiv.insertBefore(div, first);
        } else {
            listaDiv.appendChild(div);
        }
        
        // Animação de entrada suave
        setTimeout(() => {
            div.style.opacity = '1';
            div.style.transform = 'translateY(0)';
        }, 100 + (index * 100));
        
        // Badge permanece até a foto ser clicada
    });
    
    // Manter a foto selecionada sempre visível e destacada
    if (fotoSelecionada) {
        const elementoSelecionado = listaDiv.querySelector(`[data-foto-id="${fotoSelecionada}"]`);
        if (elementoSelecionado) {
            // Garantir que a foto selecionada permaneça destacada
            setTimeout(() => {
                elementoSelecionado.classList.add('selected');
                elementoSelecionado.style.transform = 'scale(1.05) translateY(-5px)';
                elementoSelecionado.style.border = '3px solid #FFD700';
                elementoSelecionado.style.boxShadow = '0 0 15px rgba(255, 215, 0, 0.8)';
                
                // Manter a foto selecionada na mesma posição visual relativa
                if (fotoSelecionadaRect && listaRect) {
                    const currentRect = elementoSelecionado.getBoundingClientRect();
                    const desiredTop = fotoSelecionadaRect.top - listaRect.top;
                    const currentTop = currentRect.top - listaRect.top;
                    const scrollAdjustment = currentTop - desiredTop;
                    
                    if (Math.abs(scrollAdjustment) > 10) {
                        listaDiv.scrollTop += scrollAdjustment;
                    }
                }
            }, 100);
        }
    }
    
    // Mostrar notificação discreta de novas fotos
    if (novasFotos.length > 0) {
        mostrarNotificacaoNovasFotos(novasFotos.length);
    }
}

// Função para mostrar notificação de novas fotos
function mostrarNotificacaoNovasFotos(quantidade) {
    // Remover notificação anterior se existir
    const notificacaoExistente = document.querySelector('.notificacao-novas-fotos');
    if (notificacaoExistente) {
        notificacaoExistente.remove();
    }
    
    // Criar nova notificação
    const notificacao = document.createElement('div');
    notificacao.className = 'notificacao-novas-fotos';
    notificacao.innerHTML = `
        <div class="notificacao-conteudo">
            <span class="notificacao-icone">📸</span>
            <span class="notificacao-texto">${quantidade} nova${quantidade > 1 ? 's' : ''} foto${quantidade > 1 ? 's' : ''} adicionada${quantidade > 1 ? 's' : ''}!</span>
        </div>
    `;
    
    // Estilos inline para a notificação
    Object.assign(notificacao.style, {
        position: 'fixed',
        top: '20px',
        left: '20px',
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        color: 'white',
        padding: '12px 20px',
        borderRadius: '8px',
        fontSize: '14px',
        fontWeight: '500',
        zIndex: '10000',
        opacity: '0',
        transform: 'translateX(-100px)',
        transition: 'all 0.3s ease',
        backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255, 255, 255, 0.2)',
        boxShadow: '0 4px 15px rgba(0, 0, 0, 0.3)'
    });
    
    // Estilos para o conteúdo
    const conteudo = notificacao.querySelector('.notificacao-conteudo');
    Object.assign(conteudo.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px'
    });
    
    // Estilos para o ícone
    const icone = notificacao.querySelector('.notificacao-icone');
    Object.assign(icone.style, {
        fontSize: '16px'
    });
    
    document.body.appendChild(notificacao);
    
    // Animação de entrada
    setTimeout(() => {
        notificacao.style.opacity = '1';
        notificacao.style.transform = 'translateX(0)';
    }, 100);
    
    // Remover após 4 segundos
    setTimeout(() => {
        notificacao.style.opacity = '0';
        notificacao.style.transform = 'translateX(100px)';
        setTimeout(() => {
            if (notificacao.parentNode) {
                notificacao.parentNode.removeChild(notificacao);
            }
        }, 300);
    }, 4000);
}

// Função para desconectar do SSE
function desconectarEventSource() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
        console.log('🔌 Desconectado do sistema de atualizações');
    }
    
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
}

// Verifica se há atualizações disponíveis
async function verificarAtualizacoes() {
    try {
        const response = await fetch("/api/version");
        if (response.ok) {
            const versionInfo = await response.json();
            appVersion = versionInfo.version;
            
            // Atualiza a versão na interface
            const versionElement = document.getElementById("app-version");
            if (versionElement) {
                versionElement.textContent = `v${appVersion}`;
            }
            
            // Verifica se há atualizações disponíveis
            const updateResponse = await fetch("/api/check-update");
            if (updateResponse.ok) {
                const updateInfo = await updateResponse.json();
                
                if (updateInfo.status === "success" && updateInfo.has_update) {
                    updateAvailable = true;
                    mostrarNotificacaoAtualizacao(updateInfo);
                }
            }
        }
    } catch (error) {
        console.error("Erro ao verificar atualizações:", error);
    }
}

// Mostra notificação de atualização disponível
function mostrarNotificacaoAtualizacao(updateInfo) {
    const notificacao = document.createElement("div");
    notificacao.className = "update-notification";
    
    const titulo = document.createElement("h3");
    titulo.textContent = "Nova versão disponível!";
    
    const versao = document.createElement("p");
    versao.textContent = `Versão ${updateInfo.latest_version} disponível (atual: v${appVersion})`;
    
    const changelog = document.createElement("ul");
    if (updateInfo.changelog && updateInfo.changelog.length > 0) {
        updateInfo.changelog.forEach(item => {
            const li = document.createElement("li");
            li.textContent = item;
            changelog.appendChild(li);
        });
    }
    
    const fecharBtn = document.createElement("button");
    fecharBtn.className = "update-close";
    fecharBtn.textContent = "Fechar";
    fecharBtn.onclick = () => notificacao.remove();
    
    notificacao.appendChild(titulo);
    notificacao.appendChild(versao);
    notificacao.appendChild(changelog);
    notificacao.appendChild(fecharBtn);
    
    document.body.appendChild(notificacao);
}

// Carrega lista de imagens do servidor
async function carregarImagens() {
    // Mostra loading com animação
    const mainDiv = document.getElementById("main");
    const originalContent = mainDiv.innerHTML;
    mainDiv.innerHTML = '<div class="loading-spinner"><div class="spinner"></div><p>Carregando fotos...</p></div>';
    
    try {
        const resp = await fetch("/api/images");
        if (!resp.ok) {
            const erro = await resp.json();
            let titulo = `🎄 Bem-vindo ao Kiosk de Fotos 🎅`;
            let mensagem = `Para começar, configure a pasta de imagens nas configurações.`;
            let detalhes = ``;
            if (erro && erro.status === 'daily_folder_not_found') {
                titulo = `Pasta do dia não encontrada`;
                mensagem = `Crie a pasta do dia e adicione fotos.`;
                detalhes = `<p class="welcome-details">Esperada: <code>${erro.expected_folder || ''}</code></p><p class="welcome-details">Caminho: <code>${erro.expected_path || ''}</code></p><p class="welcome-details">Formato: <code>${erro.current_format || ''}</code></p>`;
            } else if (erro && erro.status === 'no_images_found') {
                titulo = `Nenhuma imagem na pasta do dia`;
                mensagem = `Adicione fotos na pasta do dia.`;
                detalhes = `<p class="welcome-details">Pasta: <code>${erro.folder_path || ''}</code></p><p class="welcome-details">Formato: <code>${erro.current_format || ''}</code></p>`;
            }
            let telaInicial = `<div class="welcome-container">`;
            telaInicial += `<div class="welcome-content">`;
            telaInicial += `<h1 class="welcome-title">${titulo}</h1>`;
            telaInicial += `<div class="welcome-icon">📸</div>`;
            telaInicial += `<p class="welcome-message">${mensagem}</p>`;
            telaInicial += `${detalhes}`;
            telaInicial += `<button class="config-button welcome-button" onclick="window.location.href='/login'">⚙️ Configurar Sistema</button>`;
            telaInicial += `</div>`;
            telaInicial += `</div>`;
            
            mainDiv.innerHTML = telaInicial;
            const listaDiv = document.getElementById("lista-fotos");
            if (listaDiv) {
                listaDiv.innerHTML = "";
            }
            setTimeout(() => {
                const welcomeContainer = document.querySelector('.welcome-container');
                if (welcomeContainer) {
                    welcomeContainer.style.opacity = '1';
                    welcomeContainer.style.transform = 'translateY(0)';
                }
            }, 100);
            return;
        }
        
        const imagensOriginais = await resp.json();
        grupos = reagruparPorIdBase(imagensOriginais);

        if (Object.keys(grupos).length === 0) {
            // Mostra a mesma tela limpa quando não há fotos
            let telaInicial = `<div class="welcome-container">`;
            telaInicial += `<div class="welcome-content">`;
            telaInicial += `<h1 class="welcome-title">🎄 Bem-vindo ao Kiosk de Fotos 🎅</h1>`;
            telaInicial += `<div class="welcome-icon">📸</div>`;
            telaInicial += `<p class="welcome-message">Sistema pronto para uso!</p>`;
            telaInicial += `<p class="welcome-instructions">Para começar, configure a pasta de imagens nas configurações.</p>`;
            telaInicial += `<button class="config-button welcome-button" onclick="window.location.href='/login'">⚙️ Configurar Sistema</button>`;
            telaInicial += `</div>`;
            telaInicial += `</div>`;
            
            document.getElementById("main").innerHTML = telaInicial;
            
            // Oculta todos os elementos da interface
            const elementsToHide = [
                '#sidebar',
                '#config-button', 
                '#fullscreen-button',
                '#lista-fotos',
                '#miniaturas',
                '#ask300-panel'
            ];
            
            elementsToHide.forEach(selector => {
                const element = document.querySelector(selector);
                if (element) {
                    element.style.display = 'none';
                }
            });
            
            // Oculta o botão do carrinho quando não há fotos
            
            // Animação de entrada suave
            setTimeout(() => {
                const welcomeContainer = document.querySelector('.welcome-container');
                if (welcomeContainer) {
                    welcomeContainer.style.opacity = '1';
                    welcomeContainer.style.transform = 'translateY(0)';
                }
            }, 100);
            
            return;
        }
        
        // Restaura o conteúdo original do main quando há fotos
        mainDiv.innerHTML = originalContent;
    } catch (error) {
        console.error("Erro ao processar requisição:", error);
        
        // Mostra tela de boas-vindas em caso de erro
        let telaInicial = `<div class="welcome-container">`;
        telaInicial += `<div class="welcome-content">`;
        telaInicial += `<h1 class="welcome-title">🎄 Bem-vindo ao Kiosk de Fotos 🎅</h1>`;
        telaInicial += `<div class="welcome-icon">📸</div>`;
        telaInicial += `<p class="welcome-message">Sistema pronto para uso!</p>`;
        telaInicial += `<p class="welcome-instructions">Para começar, configure a pasta de imagens nas configurações.</p>`;
        telaInicial += `<button class="config-button welcome-button" onclick="window.location.href='/login'">⚙️ Configurar Sistema</button>`;
        telaInicial += `</div>`;
        telaInicial += `</div>`;
        
        document.getElementById("main").innerHTML = telaInicial;
        
        // Oculta todos os elementos da interface
        const elementsToHide = [
            '#sidebar',
            '#config-button', 
            '#fullscreen-button',
            '#lista-fotos',
            '#miniaturas',
            '#ask300-panel'
        ];
        
        elementsToHide.forEach(selector => {
            const element = document.querySelector(selector);
            if (element) {
                element.style.display = 'none';
            }
        });
        
        // Oculta o botão do carrinho quando há erro
        
        // Animação de entrada suave
        setTimeout(() => {
            const welcomeContainer = document.querySelector('.welcome-container');
            if (welcomeContainer) {
                welcomeContainer.style.opacity = '1';
                welcomeContainer.style.transform = 'translateY(0)';
            }
        }, 100);
        
        return;
    }

    const listaDiv = document.getElementById("lista-fotos");
    listaDiv.innerHTML = "";
    
    let index = 0;
    for (let num in grupos) {
        const primeira = grupos[num][0];
        const div = document.createElement("div");
        div.className = "foto-sidebar";
        div.dataset.fotoId = num; // Adicionar atributo data-foto-id
        
        // Animação de entrada escalonada
        div.style.opacity = '0';
        div.style.transform = 'translateX(-30px)';
        
        setTimeout(() => {
            div.style.opacity = '1';
            div.style.transform = 'translateX(0)';
        }, 100 + (index * 100));

        const img = document.createElement("img");
        img.dataset.src = "/imagens/" + primeira; // Lazy loading
        img.alt = `Foto ${num}`;
        img.className = 'lazy-image';
        
        // Placeholder inicial
        img.style.opacity = '0';
        img.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
        img.style.minHeight = '80px';
        
        // Registra para lazy loading
        lazyLoader.observe(img);
        
        img.onclick = () => selecionarFoto(num, div);

        const numeroDiv = document.createElement("div");
        numeroDiv.className = "foto-numero";
        numeroDiv.textContent = "ID " + num;

        div.appendChild(img);
        div.appendChild(numeroDiv);
        listaDiv.appendChild(div);
        
        index++;
    }
    
    const primeiroId = Object.keys(grupos)[0];
    if (primeiroId) {
        selecionarFoto(primeiroId, document.querySelector('.foto-sidebar'));
    }
    
    // Mostra o botão do carrinho quando há fotos disponíveis
}

function selecionarFoto(num, element) {
    // Remove seleção anterior com animação
    document.querySelectorAll('.foto-sidebar').forEach(el => {
        el.classList.remove('selected');
        el.style.transform = 'scale(1)';
    });
    
    if (element) {
        element.classList.add('selected');
        element.style.transform = 'scale(1.05) translateY(-5px)';
        element.dataset.fotoId = num;
        seenPhotos.add(num);
        saveSeenPhotos();
        element.classList.remove('unseen');
        const badge = element.querySelector('.nova-badge');
        if (badge) {
            badge.remove();
        }
        element.classList.remove('nova-foto');
    }

    fotoSelecionada = num;
    variacoesAtuais = grupos[num] || [];
    const ids = Object.keys(grupos).sort();
    const idx = ids.indexOf(String(num));
    const preloadIds = [];
    if (idx > 0) preloadIds.push(ids[idx - 1]);
    if (idx < ids.length - 1) preloadIds.push(ids[idx + 1]);
    if (preloadIds.length) imageCache.preloadImages(preloadIds);
    
    // Verificar se há variações válidas
    if (variacoesAtuais.length === 0) {
        console.error('Nenhuma variação encontrada para a foto:', num);
        const fotoDiv = document.getElementById("foto-grande");
        if (fotoDiv) {
            fotoDiv.innerHTML = '<p class="error-message">Erro: Nenhuma imagem encontrada para esta foto</p>';
        }
        return;
    }
    
    // Scroll suave para manter a foto selecionada visível
    if (element) {
        element.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
            inline: 'nearest'
        });
    }
    
    // Adiciona fade out antes de trocar a imagem
    const fotoGrande = document.getElementById('foto-grande-img');
    if (fotoGrande) {
        fotoGrande.style.opacity = '0';
        fotoGrande.style.transform = 'scale(0.95)';
        
        setTimeout(() => {
            mostrarFotoGrande(variacoesAtuais[0]);
            mostrarMiniaturas();
        }, 200);
    } else {
        mostrarFotoGrande(variacoesAtuais[0]);
        mostrarMiniaturas();
    }
}

function mostrarFotoGrande(nome) {
    const fotoDiv = document.getElementById("foto-grande");
    if (!fotoDiv) {
        console.error('Elemento foto-grande não encontrado');
        return;
    }
    
    // Validar se o nome da imagem é válido
    if (!nome || nome === 'undefined') {
        console.error('Nome da imagem inválido:', nome);
        fotoDiv.innerHTML = '<p class="error-message">Erro: Imagem não encontrada</p>';
        return;
    }
    
    console.log('🖼️ Carregando imagem:', nome);
    console.log('🔗 URL completa:', "/imagens/" + nome);
    
    fotoDiv.innerHTML = "";

    const img = document.createElement("img");
    img.id = "foto-grande-img";
    img.src = "/imagens/" + nome;
    
    // Adiciona loading state
    img.style.opacity = '0';
    img.style.transform = 'scale(0.9)';
    
    // Animação de entrada quando a imagem carregar
    img.onload = () => {
        console.log('✅ Imagem carregada com sucesso:', nome);
        setTimeout(() => {
            img.style.opacity = '1';
            img.style.transform = 'scale(1)';
        }, 100);
    };
    
    // Adicionar tratamento de erro
    img.onerror = () => {
        console.error('❌ Erro ao carregar imagem:', nome);
        console.error('🔗 URL que falhou:', img.src);
        fotoDiv.innerHTML = '<p class="error-message">Erro: Imagem não encontrada - ' + nome + '</p>';
    };

    const titulo = document.createElement("h2");
    titulo.textContent = "Foto ID " + fotoSelecionada;

    fotoDiv.appendChild(titulo);
    fotoDiv.appendChild(img);
}

function mostrarMiniaturas() {
    const miniDiv = document.getElementById("miniaturas");
    if (!miniDiv) {
        console.error('Elemento miniaturas não encontrado');
        return;
    }
    miniDiv.innerHTML = "";

    // Verificação de segurança para garantir que variacoesAtuais é um array
    if (!Array.isArray(variacoesAtuais)) {
        console.warn('variacoesAtuais não é um array:', variacoesAtuais);
        return;
    }

    variacoesAtuais.forEach((nome, index) => {
        const div = document.createElement("div");
        div.className = "miniatura";
        
        // Animação de entrada escalonada
        div.style.opacity = '0';
        div.style.transform = 'translateY(20px)';
        
        setTimeout(() => {
            div.style.opacity = '1';
            div.style.transform = 'translateY(0)';
        }, 100 + (index * 50));

        const img = document.createElement("img");
        img.dataset.src = "/imagens/" + nome; // Lazy loading
        img.className = 'lazy-image miniatura-img';
        img.alt = `Miniatura ${index + 1}`;
        
        // Placeholder inicial
        img.style.opacity = '0';
        img.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
        img.style.minHeight = '60px';
        
        // Registra para lazy loading
        lazyLoader.observe(img);
        
        // Adiciona efeito hover e clique
        img.onclick = () => {
            // Efeito de clique
            div.style.transform = 'scale(0.95)';
            setTimeout(() => {
                div.style.transform = 'scale(1)';
                mostrarFotoGrande(nome);
            }, 100);
        };
        
        // Efeitos hover
        div.addEventListener('mouseenter', () => {
            div.style.transform = 'translateY(-5px) scale(1.05)';
        });
        
        div.addEventListener('mouseleave', () => {
            div.style.transform = 'translateY(0) scale(1)';
        });

        const nomeDiv = document.createElement("div");
        nomeDiv.className = "miniatura-nome";
        nomeDiv.textContent = nome.split("_")[0];

        const printBtn = document.createElement("button");
        printBtn.className = "print-btn";
        printBtn.textContent = "🖨️ Imprimir";
        printBtn.onclick = async (e) => {
            e.stopPropagation();
            try {
                printBtn.disabled = true;
                printBtn.textContent = '🔄 Imprimindo...';

                const format = nome.split("_")[0];
                const resp = await fetch('/api/print-dialog', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        imagePath: nome,
                        format: format,
                        copies: 1
                    })
                });
                const result = await resp.json();
                if (resp.ok && result.success) {
                    printBtn.textContent = '✅ Enviado';
                } else {
                    printBtn.textContent = '❌ Erro';
                    console.error('Erro ao imprimir:', result);
                    alert(result.error || result.message || 'Erro ao enviar para impressão');
                }
            } catch (err) {
                printBtn.textContent = '❌ Erro';
                console.error('Erro ao imprimir:', err);
                alert('Falha ao imprimir. Verifique a impressora.');
            } finally {
                setTimeout(() => {
                    printBtn.disabled = false;
                    printBtn.textContent = '🖨️ Imprimir';
                }, 2000);
            }
        };


        div.appendChild(img);
        div.appendChild(nomeDiv);
        div.appendChild(printBtn);
        miniDiv.appendChild(div);
    });
}

// Animações de flocos de neve removidas para melhor visualização das imagens

// Função removida - versão já existe no HTML

// Auto-hide cursor e controles profissionais
let cursorTimer;
let inactivityTimer;

function resetCursorTimer() {
    document.body.classList.remove('hide-cursor');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
        document.body.classList.add('hide-cursor');
    }, 10000); // 10 segundos de inatividade
}

function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        // Volta para tela inicial após 5 minutos
        window.location.reload();
    }, 300000);
}

// Event listeners para atividade do usuário
document.addEventListener('mousemove', () => {
    resetCursorTimer();
    resetInactivityTimer();
});

document.addEventListener('click', () => {
    resetCursorTimer();
    resetInactivityTimer();
});

document.addEventListener('touchstart', () => {
    resetCursorTimer();
    resetInactivityTimer();
});

// Controle da sidebar
const sidebar = document.getElementById('sidebar');
let sidebarTimeout;

if (sidebar) {
    sidebar.addEventListener('mouseenter', () => {
        sidebar.classList.add('active');
        clearTimeout(sidebarTimeout);
    });
    
    sidebar.addEventListener('mouseleave', () => {
        sidebarTimeout = setTimeout(() => {
            sidebar.classList.remove('active');
        }, 2000);
    });
}

// Inicializar timers
resetCursorTimer();
resetInactivityTimer();

// Função para adicionar botão de fechar fullscreen
function adicionarBotaoFechar() {
    return;
}

// Função melhorada para toggle fullscreen
async function toggleFullscreen() {
    if (window.electronAPI) {
        const isFs = await window.electronAPI.toggleFullScreen();
        const btn = document.getElementById('close-fullscreen-button');
        if (btn) {
            btn.style.display = isFs ? 'flex' : 'none';
        }
        return;
    }
    if (!document.fullscreenElement && !document.webkitFullscreenElement && 
        !document.mozFullScreenElement && !document.msFullscreenElement) {
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen();
        } else if (document.documentElement.webkitRequestFullscreen) {
            document.documentElement.webkitRequestFullscreen();
        } else if (document.documentElement.mozRequestFullScreen) {
            document.documentElement.mozRequestFullScreen();
        } else if (document.documentElement.msRequestFullscreen) {
            document.documentElement.msRequestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.mozCancelFullScreen) {
            document.mozCancelFullScreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
    }
}

// Auto-fullscreen melhorado na carga da página
window.addEventListener('load', () => {
    adicionarBotaoFechar();
    
    setTimeout(async () => {
        if (window.electronAPI) {
            const isFs = await window.electronAPI.getFullScreen();
            const btn = document.getElementById('close-fullscreen-button');
            if (btn) btn.style.display = isFs ? 'flex' : 'none';
            return;
        }
        if (!document.fullscreenElement && !document.webkitFullscreenElement && 
            !document.mozFullScreenElement && !document.msFullscreenElement) {
            if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else if (document.documentElement.webkitRequestFullscreen) {
                document.documentElement.webkitRequestFullscreen();
            } else if (document.documentElement.mozRequestFullScreen) {
                document.documentElement.mozRequestFullScreen();
            } else if (document.documentElement.msRequestFullscreen) {
                document.documentElement.msRequestFullscreen();
            }
        }
    }, 2000);
});

// Remover controles da sidebar que estavam causando problemas
// (manter apenas o auto-hide cursor e reset de inatividade)
document.addEventListener('fullscreenchange', () => {
    const fullscreenBtn = document.getElementById('fullscreen-button');
    if (document.fullscreenElement) {
        fullscreenBtn.innerHTML = '⛷';
        fullscreenBtn.title = 'Sair da Tela Cheia';
    } else {
        fullscreenBtn.innerHTML = '⛶';
        fullscreenBtn.title = 'Tela Cheia';
    }
});

// Sistema de Temas do Cabeçalho
async function carregarTemaAtual() {
    try {
        const response = await fetch('/api/current-theme');
        if (response.ok) {
            const tema = await response.json();
            aplicarTema(tema);
            carregarPersonalizacao();
        } else {
            console.log('Usando tema padrão');
        }
    } catch (error) {
        console.error('Erro ao carregar tema atual:', error);
    }
}

function aplicarTema(tema) {
    const headerContainer = document.querySelector('.sidebar-header');
    const headerElement = document.querySelector('.sidebar-header h2');
    
    if (headerContainer && headerElement) {
        // Remove classes de tema anteriores do container
        headerContainer.className = headerContainer.className.replace(/\b\w+-header\b/g, '');
        headerContainer.classList.add('sidebar-header'); // Garante que a classe base permaneça
        
        // Aplica o novo tema ao container
        const cssClass = tema.theme_css_class || tema.cssClass;
        headerContainer.classList.add(cssClass);
        
        // Atualiza o texto do elemento h2
        headerElement.textContent = tema.theme_text || tema.text;
        
        console.log(`Tema de cabeçalho aplicado: ${tema.theme_name || tema.name}`);

        // --- NOVO: Carregar CSS completo do tema ---
        const themeId = 'dynamic-theme-style';
        const existingLink = document.getElementById(themeId);
        if (existingLink) {
            existingLink.remove();
        }

        if (cssClass) {
            const folderName = cssClass.replace('-header', '');
            const themePath = `/static/themes/${folderName}/theme.css`;
            const link = document.createElement('link');
            link.id = themeId;
            link.rel = 'stylesheet';
            link.href = themePath;
            link.onerror = () => {
                const fallback = document.createElement('link');
                fallback.id = themeId;
                fallback.rel = 'stylesheet';
                fallback.href = `/static/themes/default/theme.css`;
                document.head.appendChild(fallback);
                link.remove();
            };
            document.head.appendChild(link);
        }
        // --- FIM DO NOVO CÓDIGO ---

    } else {
        console.error('Elemento do cabeçalho não encontrado');
    }
}

// Inicialização da aplicação
// Indicador de pasta ativa
async function atualizarIndicadorPasta() {
    try {
        const resp = await fetch('/api/current-image-folder');
        if (!resp.ok) return;
        const data = await resp.json();
        const el = document.getElementById('folder-indicator');
        if (!el) return;
        const originMap = {
            daily: 'Hoje',
            fallback: 'Mais recente',
            base: 'Base'
        };
        const origin = originMap[data.active_origin] || 'Desconhecida';
        const baseName = (data.active_images_dir || '').split(/\\|\//).pop() || data.active_images_dir || '-';
        el.textContent = `📁 Pasta: ${baseName} • Formato: ${data.current_format} • Origem: ${origin}`;
        // Cores por origem
        if (data.active_origin === 'daily') {
            el.style.background = 'rgba(40,167,69,0.85)';
        } else if (data.active_origin === 'fallback') {
            el.style.background = 'rgba(255,193,7,0.85)';
            el.style.color = '#212529';
        } else {
            el.style.background = 'rgba(0,0,0,0.6)';
            el.style.color = '#fff';
        }
    } catch (_) {}
}

// No final do arquivo, dentro do DOMContentLoaded:
document.addEventListener('DOMContentLoaded', () => {
    loadSeenPhotos();
    carregarImagens();
    verificarAtualizacoes();
    atualizarIndicadorPasta();
    aplicarTamanhoMiniatura();
    aplicarTamanhoMiniaturaSidebar();
    aplicarOpacidadeSidebar();
    
    // Carregar tema atual
    carregarTemaAtual();
    
    // Inicializar sistema de atualizações em tempo real
    console.log('🚀 Inicializando sistema de atualizações em tempo real...');
    conectarEventSource();
    
    // Carrinho removido
    
    // Verifica atualizações a cada 30 minutos
    setInterval(verificarAtualizacoes, 30 * 60 * 1000);
    document.addEventListener('keydown', (e) => {
        const ids = Object.keys(grupos).sort();
        if (ids.length === 0) return;
        let currentIndex = ids.indexOf(String(fotoSelecionada));
        if (currentIndex < 0) currentIndex = 0;
        if (e.key === 'ArrowDown') {
            const next = Math.min(ids.length - 1, currentIndex + 1);
            const id = ids[next];
            const el = document.querySelector(`.foto-sidebar[data-foto-id="${id}"]`);
            if (el) selecionarFoto(id, el);
        } else if (e.key === 'ArrowUp') {
            const prev = Math.max(0, currentIndex - 1);
            const id = ids[prev];
            const el = document.querySelector(`.foto-sidebar[data-foto-id="${id}"]`);
            if (el) selecionarFoto(id, el);
        } else if (e.key === 'Home') {
            const id = ids[0];
            const el = document.querySelector(`.foto-sidebar[data-foto-id="${id}"]`);
            if (el) selecionarFoto(id, el);
        } else if (e.key === 'End') {
            const id = ids[ids.length - 1];
            const el = document.querySelector(`.foto-sidebar[data-foto-id="${id}"]`);
            if (el) selecionarFoto(id, el);
        }
    });
});

// Desconectar SSE quando a página for fechada
window.addEventListener('beforeunload', () => {
    desconectarEventSource();
});

// Reconectar SSE quando a página voltar a ter foco
window.addEventListener('focus', () => {
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        console.log('🔄 Página voltou ao foco, reconectando SSE...');
        conectarEventSource();
    }
    aplicarTamanhoMiniatura();
    aplicarTamanhoMiniaturaSidebar();
    aplicarOpacidadeSidebar();
});

// Pausar SSE quando a página perder o foco (opcional, para economizar recursos)
window.addEventListener('blur', () => {
    // Comentado para manter conexão ativa mesmo quando fora de foco
    // desconectarEventSource();
});
async function aplicarTamanhoMiniatura() {
    try {
        let resp = await fetch('/api/ui/thumbnail-size');
        if (!resp.ok) resp = await fetch('/api/ui/thumbnail-size/');
        if (!resp.ok) {
            const origin = window.location.origin || 'http://localhost:5000';
            resp = await fetch(origin + '/api/ui/thumbnail-size');
        }
        if (resp.ok) {
            const data = await resp.json();
            const size = parseInt(data.size || 100, 10);
            document.documentElement.style.setProperty('--thumb-size', `${size}px`);
            try { localStorage.setItem('thumb_size', String(size)); } catch (_) {}
        } else {
            let s = 100;
            try { s = parseInt(localStorage.getItem('thumb_size') || '100', 10); } catch (_) {}
            document.documentElement.style.setProperty('--thumb-size', `${s}px`);
        }
    } catch (_) {}
}

async function carregarPersonalizacao() {
    try {
        const r = await fetch('/api/personalization');
        if (!r.ok) return;
        const p = await r.json();
        const headerContainer = document.querySelector('.sidebar-header');
        const headerElement = document.querySelector('.sidebar-header h2');
        if (headerContainer) {
            headerContainer.style.background = p.header_bg_color || '';
        }
        if (headerElement) {
            headerElement.style.color = p.header_text_color || '';
            if (p.header_text) headerElement.textContent = p.header_text;
        }
        const activeBorders = document.querySelectorAll('.menu-item.active');
        activeBorders.forEach(el => el.style.borderLeftColor = p.accent_color || '');
        const h2 = document.querySelector('.config-section h2');
        if (h2) h2.style.borderBottomColor = p.accent_color || '';
        if (p.accent_color) {
            document.documentElement.style.setProperty('--christmas-gold', p.accent_color);
            document.documentElement.style.setProperty('--warm-gold', p.accent_color);
        }
        if (p.list_text_color) {
            document.documentElement.style.setProperty('--sidebar-text-color', p.list_text_color);
        }
        if (typeof p.list_border_radius !== 'undefined') {
            const r = parseInt(p.list_border_radius, 10);
            if (!isNaN(r)) document.documentElement.style.setProperty('--sidebar-border-radius', `${r}px`);
        }
    } catch {}
}
function abrirMenuAcoes() {
    const menu = document.getElementById('quick-actions-menu');
    if (!menu) return;
    const visible = menu.style.display !== 'none';
    if (visible) {
        menu.style.display = 'none';
        try { console.log(`[LOG] menu_closed at ${new Date().toISOString()}`); } catch {}
        return;
    }
    menu.style.display = 'block';
    window.__quickMenuLastInteraction = Date.now();
    try { console.log(`[LOG] menu_opened at ${new Date().toISOString()}`); } catch {}
    scheduleQuickMenuHide(3000);
}

async function acaoRapida(action) {
    try {
        window.__quickMenuLastInteraction = Date.now();
        scheduleQuickMenuHide(3000);
        if (action === 'fullscreen') {
            await toggleFullscreen();
        } else if (action === 'config') {
            window.location.href = '/config';
        } else if (action === 'clean') {
            const ok = confirm('Deseja realmente limpar/mover as fotos de hoje?');
            if (!ok) return;
            const btn = document.getElementById('quick-actions-button');
            if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
            const r = await fetch('/api/move-today', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
            if (r.ok) {
                const d = await r.json();
                alert(`Movidos ${d.moved}/${d.total}`);
            } else {
                alert('Erro ao mover');
            }
            if (btn) { btn.textContent = '☰'; btn.disabled = false; }
        } else if (action === 'print_manual') {
            if (!Array.isArray(variacoesAtuais) || variacoesAtuais.length === 0) {
                alert('Selecione uma foto primeiro');
                return;
            }
            const holdMs = Date.now() - (window.__quickMenuTouchStart || 0);
            if (holdMs < (window.__TOUCH_MIN_HOLD_MS || 120)) {
                try { console.log(`[LOG] touch_ignored short_hold=${holdMs}ms at ${new Date().toISOString()}`); } catch {}
                return;
            }
            if (window.__manualPrintCooldown && Date.now() - window.__manualPrintCooldown < 800) {
                try { console.log(`[LOG] manual_print_ignored cooldown at ${new Date().toISOString()}`); } catch {}
                return;
            }
            const imagePath = variacoesAtuais[0];
            const btn = document.getElementById('quick-actions-button');
            if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
            try {
                const t0 = Date.now();
                try { console.log(`[LOG] manual_print_start image=${imagePath} at ${new Date().toISOString()}`); } catch {}
                const resp = await fetch('/api/print-dialog-manual', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ imagePath, keepSeconds: 600 })
                });
                const result = await resp.json();
                if (!resp.ok || !result.success) {
                    alert(result.error || result.message || 'Falha ao abrir diálogo');
                }
                const dt = Date.now() - t0;
                try { console.log(`[LOG] manual_print_end duration=${dt}ms at ${new Date().toISOString()}`); } catch {}
                window.__manualPrintCooldown = Date.now();
            } catch (err) {
                alert('Falha ao abrir diálogo de impressão');
            } finally {
                if (btn) { btn.textContent = '☰'; btn.disabled = false; }
            }
        } else if (action === 'close') {
            if (window.electronAPI && window.electronAPI.quitApp) {
                const ok = confirm('Deseja realmente fechar a aplicação?');
                if (!ok) return;
                await window.electronAPI.quitApp();
            } else {
                alert('Disponível apenas no modo desktop');
            }
        }
    } finally {
        // Em vez de fechar imediatamente, programar fechamento após 3s da última interação
        scheduleQuickMenuHide(3000);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const qaBtn = document.getElementById('quick-actions-button');
    if (qaBtn) qaBtn.addEventListener('click', abrirMenuAcoes);
    const menu = document.getElementById('quick-actions-menu');
    if (menu) {
        menu.addEventListener('click', (e) => {
            const item = e.target.closest('.quick-action-item');
            if (!item) return;
            const action = item.getAttribute('data-action');
            acaoRapida(action);
        });
        // Controle de sensibilidade ao toque
        window.__TOUCH_MIN_HOLD_MS = 120;
        menu.addEventListener('pointerdown', () => { window.__quickMenuTouchStart = Date.now(); window.__quickMenuLastInteraction = Date.now(); scheduleQuickMenuHide(3000); });
        menu.addEventListener('pointerup', () => { window.__quickMenuLastInteraction = Date.now(); scheduleQuickMenuHide(3000); });
    }
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('quick-actions-menu');
        const btn = document.getElementById('quick-actions-button');
        if (!menu || !btn) return;
        if (menu.style.display !== 'none') {
            if (!menu.contains(e.target) && e.target !== btn) {
                const since = Date.now() - (window.__quickMenuLastInteraction || 0);
                if (since >= 3000) {
                    menu.style.display = 'none';
                    try { console.log(`[LOG] menu_closed_outside_click dwell=${since}ms at ${new Date().toISOString()}`); } catch {}
                } else {
                    scheduleQuickMenuHide(3000 - since);
                }
            }
        }
    });
});

function scheduleQuickMenuHide(delayMs) {
    const menu = document.getElementById('quick-actions-menu');
    if (!menu) return;
    if (window.__quickMenuHideTimer) clearTimeout(window.__quickMenuHideTimer);
    window.__quickMenuHideTimer = setTimeout(() => {
        const since = Date.now() - (window.__quickMenuLastInteraction || 0);
        if (since >= (delayMs || 3000)) {
            menu.style.display = 'none';
            try { console.log(`[LOG] menu_closed dwell=${since}ms at ${new Date().toISOString()}`); } catch {}
        }
    }, delayMs || 3000);
}

async function aplicarTamanhoMiniaturaSidebar() {
    try {
        let resp = await fetch('/api/ui/sidebar-thumbnail-size');
        if (!resp.ok) resp = await fetch('/api/ui/sidebar-thumbnail-size/');
        if (!resp.ok) {
            const origin = window.location.origin || 'http://localhost:5000';
            resp = await fetch(origin + '/api/ui/sidebar-thumbnail-size');
        }
        if (resp.ok) {
            const data = await resp.json();
            const size = parseInt(data.size || 120, 10);
            document.documentElement.style.setProperty('--sidebar-thumb-height', `${size}px`);
            try { localStorage.setItem('sidebar_thumb_size', String(size)); } catch (_) {}
        } else {
            let s = 120;
            try { s = parseInt(localStorage.getItem('sidebar_thumb_size') || '120', 10); } catch (_) {}
            document.documentElement.style.setProperty('--sidebar-thumb-height', `${s}px`);
        }
    } catch (_) {}
}

async function aplicarOpacidadeSidebar() {
    try {
        let resp = await fetch('/api/ui/sidebar-opacity');
        if (!resp.ok) resp = await fetch('/api/ui/sidebar-opacity/');
        if (!resp.ok) {
            const origin = window.location.origin || 'http://localhost:5000';
            resp = await fetch(origin + '/api/ui/sidebar-opacity');
        }
        if (resp.ok) {
            const data = await resp.json();
            const v = parseFloat(data.opacity ?? 0.10);
            document.documentElement.style.setProperty('--sidebar-bg-opacity', String(v));
            try { localStorage.setItem('sidebar_bg_opacity', String(v)); } catch (_) {}
        } else {
            let v = 0.10;
            try { v = parseFloat(localStorage.getItem('sidebar_bg_opacity') || '0.10'); } catch (_) {}
            document.documentElement.style.setProperty('--sidebar-bg-opacity', String(v));
        }
    } catch (_) {}
}