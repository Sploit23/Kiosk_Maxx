let grupos = {};
let fotoSelecionada = null;
let variacoesAtuais = [];
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

// Instância global do lazy loader
const lazyLoader = new LazyImageLoader();

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
            console.log('🖼️ Imagens atualizadas detectadas');
            
            // Verificar se realmente houve mudanças
            const currentKeys = Object.keys(grupos).sort();
            const newKeys = Object.keys(newImages).sort();
            
            const hasChanges = JSON.stringify(currentKeys) !== JSON.stringify(newKeys) ||
                              JSON.stringify(grupos) !== JSON.stringify(newImages);
            
            if (hasChanges) {
                console.log('🔄 Atualizando interface com novas imagens...');
                grupos = newImages;
                atualizarInterfaceComNovasImagens();
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
function atualizarInterfaceComNovasImagens() {
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
    
    // Salvar foto atualmente selecionada
    const fotoAnteriormenteSelecionada = fotoSelecionada;
    
    // Contar fotos antes da atualização
    const fotosAnteriores = document.querySelectorAll('.foto-sidebar').length;
    
    // Atualizar lista de fotos na sidebar
    atualizarListaFotos();
    
    // Contar novas fotos
    const fotosAtuais = Object.keys(grupos).length;
    const novasFotosCount = fotosAtuais - fotosAnteriores;
    
    // Mostrar notificação se há novas fotos
    if (novasFotosCount > 0) {
        mostrarNotificacaoNovasFotos(novasFotosCount);
    }
    
    // Preservar seleção da foto anterior
    if (fotoAnteriormenteSelecionada && grupos[fotoAnteriormenteSelecionada]) {
        // Foto ainda existe, restaurar seleção
        setTimeout(() => {
            const element = document.querySelector(`[data-foto-id="${fotoAnteriormenteSelecionada}"]`);
            if (element) {
                selecionarFoto(fotoAnteriormenteSelecionada, element);
                // Scroll suave para a foto selecionada se necessário
                element.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 100);
    } else if (fotosAtuais > 0) {
        // Selecionar primeira foto disponível se não havia seleção anterior
        const primeiroId = Object.keys(grupos)[0];
        if (primeiroId) {
            setTimeout(() => {
                const element = document.querySelector('.foto-sidebar');
                if (element) {
                    selecionarFoto(primeiroId, element);
                }
            }, 100);
        }
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
    
    // Restaurar conteúdo original do main
    mainDiv.innerHTML = `
        <div id="foto-grande">
            <h2>Selecione uma foto</h2>
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

// Função para atualizar apenas a lista de fotos
function atualizarListaFotos() {
    const listaDiv = document.getElementById("lista-fotos");
    if (!listaDiv) return;
    
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
    
    // Adicionar novas fotos no FINAL da lista para não interferir na visualização atual
    novasFotos.forEach((num, index) => {
        const primeira = grupos[num][0];
        const div = document.createElement("div");
        div.className = "foto-sidebar nova-foto";
        div.dataset.fotoId = num;
        
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
        
        // Inserir nova foto no FINAL da lista
        listaDiv.appendChild(div);
        
        // Animação de entrada suave
        setTimeout(() => {
            div.style.opacity = '1';
            div.style.transform = 'translateY(0)';
        }, 100 + (index * 100));
        
        // Remover badge após 8 segundos
        setTimeout(() => {
            if (novaBadge.parentNode) {
                novaBadge.style.opacity = '0';
                setTimeout(() => {
                    if (novaBadge.parentNode) {
                        novaBadge.parentNode.removeChild(novaBadge);
                    }
                    div.classList.remove('nova-foto');
                }, 300);
            }
        }, 8000);
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
        right: '20px',
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        color: 'white',
        padding: '12px 20px',
        borderRadius: '8px',
        fontSize: '14px',
        fontWeight: '500',
        zIndex: '10000',
        opacity: '0',
        transform: 'translateX(100px)',
        transition: 'all 0.3s ease',
        backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)'
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
            console.log("Pasta de imagens não encontrada - mostrando tela inicial limpa");
            
            // Mostra tela inicial limpa e acolhedora
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
            
            // Limpa a sidebar também
            const listaDiv = document.getElementById("lista-fotos");
            if (listaDiv) {
                listaDiv.innerHTML = "";
            }
            
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
        
        grupos = await resp.json();

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
}

function selecionarFoto(num, element) {
    // Remove seleção anterior com animação
    document.querySelectorAll('.foto-sidebar').forEach(el => {
        el.classList.remove('selected');
        el.style.transform = 'scale(1)';
    });
    
    if (element) {
        element.classList.add('selected');
        // Adiciona efeito de seleção
        element.style.transform = 'scale(1.05) translateY(-5px)';
        // Garantir que o elemento tenha o atributo data-foto-id
        element.dataset.fotoId = num;
    }

    fotoSelecionada = num;
    variacoesAtuais = grupos[num] || [];
    
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
    fotoDiv.innerHTML = "";

    const img = document.createElement("img");
    img.id = "foto-grande-img";
    img.src = "/imagens/" + nome;
    
    // Adiciona loading state
    img.style.opacity = '0';
    img.style.transform = 'scale(0.9)';
    
    // Animação de entrada quando a imagem carregar
    img.onload = () => {
        setTimeout(() => {
            img.style.opacity = '1';
            img.style.transform = 'scale(1)';
        }, 100);
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

        const addToCartBtn = document.createElement("button");
        addToCartBtn.className = "add-to-cart-btn";
        addToCartBtn.textContent = "🛒 Adicionar";
        addToCartBtn.onclick = (e) => {
            e.stopPropagation();
            
            // Debug logs
            console.log('🔍 Clique no botão adicionar:', nome);
            console.log('🔍 Window.cart existe:', !!window.cart);
            console.log('🔍 Tipo do cart:', typeof window.cart);
            
            if (window.cart && typeof window.cart.addItem === 'function') {
                console.log('✅ Adicionando foto ao carrinho:', nome);
                window.cart.addItem(nome, e);
            } else {
                console.error('❌ Carrinho não disponível!');
                console.log('🔧 Tentando recriar carrinho...');
                
                // Tentar recriar o carrinho
                if (typeof PrintCart !== 'undefined') {
                    window.cart = new PrintCart();
                    setTimeout(() => {
                        if (window.cart && typeof window.cart.addItem === 'function') {
                            window.cart.addItem(nome, e);
                        }
                    }, 500);
                } else {
                    alert('Erro: Sistema de carrinho não carregado. Recarregue a página.');
                }
            }
        };

        div.appendChild(img);
        div.appendChild(nomeDiv);
        div.appendChild(addToCartBtn);
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
    if (!document.getElementById('close-fullscreen-button')) {
        const closeBtn = document.createElement('button');
        closeBtn.id = 'close-fullscreen-button';
        closeBtn.innerHTML = '✕';
        closeBtn.title = 'Sair do modo tela cheia (ESC)';
        closeBtn.onclick = () => {
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        };
        document.body.appendChild(closeBtn);
    }
}

// Função melhorada para toggle fullscreen
function toggleFullscreen() {
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
    
    // Delay de 2 segundos para auto-fullscreen
    setTimeout(() => {
        if (!document.fullscreenElement && !document.webkitFullscreenElement && 
            !document.mozFullScreenElement && !document.msFullscreenElement) {
            
            if (document.documentElement.requestFullscreen) {
                document.documentElement.requestFullscreen().catch(err => {
                    console.log('Não foi possível entrar em fullscreen automaticamente:', err);
                });
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

// Inicialização da aplicação
// No final do arquivo, dentro do DOMContentLoaded:
document.addEventListener('DOMContentLoaded', () => {
    carregarImagens();
    verificarAtualizacoes();
    
    // Inicializar sistema de atualizações em tempo real
    console.log('🚀 Inicializando sistema de atualizações em tempo real...');
    conectarEventSource();
    
    // Carrinho será inicializado pelo cart.js
    
    // Verifica atualizações a cada 30 minutos
    setInterval(verificarAtualizacoes, 30 * 60 * 1000);
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
});

// Pausar SSE quando a página perder o foco (opcional, para economizar recursos)
window.addEventListener('blur', () => {
    // Comentado para manter conexão ativa mesmo quando fora de foco
    // desconectarEventSource();
});